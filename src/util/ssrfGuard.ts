import http from 'http';
import createHttpError from 'http-errors';
import { StatusCodes } from 'http-status-codes';
import https from 'https';
import net from 'net';

import { Logger } from '../hyperproof-api';

// Stable error code tagged on every SSRF-guard rejection so callers (e.g. GitLabDataSource) can distinguish a guard
// block from a generic network error (DNS / TLS / connection-refused / timeout) without matching on the message text.
// node-fetch copies `code` onto the FetchError it raises, so the tag survives even when the block happens at connect
// time (internal-only DNS resolution / IP-literal redirect) rather than as the eager synchronous throw.
//
// The VALUE is deliberately generic (no "SSRF"): it can surface to external callers when the framework serializes the
// error (e.g. hypersyncConnector's `extendedError: err`), and we do not disclose that an SSRF guard exists. The
// identifier keeps "SSRF" for internal clarity - only the string literal reaches callers. Do not reintroduce "SSRF".
export const SSRF_BLOCKED_ERROR_CODE = 'EGRESS_BLOCKED';

// A tenant-supplied connection URL the guard refuses (disallowed scheme, IP-literal host, or a host that only resolves
// internally) is bad client input, not a server fault - surface it as a 400 tagged with SSRF_BLOCKED_ERROR_CODE.
const rejectedUrlError = (reason: string) =>
  createHttpError(StatusCodes.BAD_REQUEST, reason, { code: SSRF_BLOCKED_ERROR_CODE });

/**
 * SSRF egress guard for the shared connector HTTP layer.
 *
 * A tenant-supplied connection URL reaches node-fetch through `getAgent`. Without a guard this allows server-side
 * request forgery: an attacker points a connection at an internal IP (or a name that resolves internally) and the
 * connector dials it. This module closes that by:
 *
 *  1. Enforcing an https-only scheme allowlist at agent-selection time (configurable; see ALLOWED_SCHEMES).
 *  2. Resolving the target hostname on a PUBLIC resolver over DNS-over-HTTPS (DoH) - not the pod's /etc/resolv.conf,
 *     which has Azure private / Private Link zones merged in - so an internal-only name fails to resolve to a usable IP.
 *  3. Rejecting any resolved address in a private / reserved / link-local (IMDS) range.
 *  4. Pinning the socket to the validated public IP. Because each redirect hop opens a fresh connection through the
 *     agent, the resolve-deny-pin check re-runs on every hop, so redirects to internal IPs are blocked too.
 *
 * The DNS-over-HTTPS lookup is sent directly to a pinned public resolver IP and does NOT pass through the guarded
 * agent, avoiding recursion. The guard fails closed: any resolver error, timeout, or unparseable answer denies the
 * connection.
 */

/**
 * URL schemes permitted for tenant-supplied connection URLs. http and https are both allowed: on-prem connectors
 * (GitLab Server, Jira Server, etc.) legitimately target customer hosts over plaintext http, and the actual SSRF
 * defense here is the internal-IP denylist + connection pinning below, not the scheme. Any other scheme (file:,
 * gopher:, ...) is rejected and logged at WARN. Values include the trailing ':' to match URL.protocol. (The backend
 * write-time UrlSafetyValidator remains https-only for the URLs Hyperproof itself persists and fetches.)
 */
const ALLOWED_SCHEMES = new Set(['https:', 'http:']);

interface DohResolver {
  ip: string;
  hostname: string;
  // JSON-API path for this resolver. Cloudflare serves the application/dns-json API at /dns-query; Google serves it at
  // /resolve (Google's /dns-query is RFC 8484 wireformat only and 400s a ?name=&type= GET).
  path: string;
}

// Multiple public resolvers, each addressed by a pinned IP (its SNI hostname is in the cert SAN, so TLS still
// validates) so we never depend on the pod's resolver to find the resolver. Tried in order; the next is used only when
// the previous is unreachable, so a single resolver outage does not take down all guarded egress.
const DOH_RESOLVERS: readonly DohResolver[] = [
  { ip: '1.1.1.1', hostname: 'cloudflare-dns.com', path: '/dns-query' },
  { ip: '1.0.0.1', hostname: 'cloudflare-dns.com', path: '/dns-query' },
  { ip: '8.8.8.8', hostname: 'dns.google', path: '/resolve' }
];
const DOH_TIMEOUT_MS = 2500;

/** DNS record type numbers we care about in the application/dns-json answer set. */
const DNS_TYPE_A = 1;
const DNS_TYPE_AAAA = 28;

const RESOLVE_CACHE_MIN_TTL_MS = 5_000;
const RESOLVE_CACHE_MAX_TTL_MS = 60_000;
// The cache key is tenant-influenced, so bound it to prevent unbounded growth under attacker-supplied hostnames.
const RESOLVE_CACHE_MAX_ENTRIES = 1024;

interface CacheEntry {
  addresses: string[];
  expiresAt: number;
}
// Short positive cache (honoring the DoH TTL, clamped) so a busy connector does not issue two DoH round-trips per
// connection. Caching the already-resolved public addresses is also rebinding-safe: we keep dialing the validated IP.
const s_resolveCache = new Map<string, CacheEntry>();

// Bounds the resolve cache before inserting: drops expired entries, and if still at capacity clears it (a simple,
// allocation-light reset). Keep identical to the hyperproof common-server guard so the two cannot drift.
const evictResolveCacheIfNeeded = (): void => {
  if (s_resolveCache.size < RESOLVE_CACHE_MAX_ENTRIES) {
    return;
  }
  const now = Date.now();
  for (const [key, entry] of s_resolveCache) {
    if (entry.expiresAt <= now) {
      s_resolveCache.delete(key);
    }
  }
  if (s_resolveCache.size >= RESOLVE_CACHE_MAX_ENTRIES) {
    s_resolveCache.clear();
  }
};

const buildInternalIpBlockList = (): net.BlockList => {
  const blockList = new net.BlockList();

  // IPv4 private, loopback, link-local (incl. 169.254.169.254 IMDS), CGNAT, and reserved/special ranges.
  const ipv4Subnets: ReadonlyArray<[string, number]> = [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.88.99.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['240.0.0.0', 4]
  ];
  for (const [address, prefix] of ipv4Subnets) {
    blockList.addSubnet(address, prefix, 'ipv4');
    // Also register the IPv4-mapped IPv6 form (::ffff:a.b.c.d/(prefix+96)) so an internal target encoded as a mapped
    // address is blocked regardless of textual form (e.g. ::ffff:7f00:1 == 127.0.0.1). net.BlockList compares the
    // normalized binary address, so this catches dotted, hex, and fully-expanded encodings alike.
    blockList.addSubnet(`::ffff:${address}`, prefix + 96, 'ipv6');
  }
  blockList.addAddress('255.255.255.255', 'ipv4');
  blockList.addAddress('::ffff:255.255.255.255', 'ipv6');

  // IPv6 loopback, unspecified, unique-local, link-local, multicast, NAT64, and documentation ranges.
  blockList.addAddress('::1', 'ipv6');
  blockList.addAddress('::', 'ipv6');
  blockList.addSubnet('fc00::', 7, 'ipv6');
  blockList.addSubnet('fe80::', 10, 'ipv6');
  blockList.addSubnet('ff00::', 8, 'ipv6');
  blockList.addSubnet('64:ff9b::', 96, 'ipv6'); // NAT64
  blockList.addSubnet('2001:db8::', 32, 'ipv6');
  blockList.addSubnet('2002::', 16, 'ipv6'); // 6to4

  return blockList;
};

const INTERNAL_IP_BLOCK_LIST = buildInternalIpBlockList();

/**
 * Returns true if the address is in a private/reserved/internal range and must not be dialed. Anything that is not a
 * parseable IP literal is treated as internal (fail closed). IPv4-mapped IPv6 addresses (any textual encoding) are
 * covered because their internal ranges are registered in the block list in mapped form.
 */
export const isInternalIp = (address: string): boolean => {
  const ip = address;

  const family = net.isIP(ip);
  if (family === 4) {
    return INTERNAL_IP_BLOCK_LIST.check(ip, 'ipv4');
  }
  if (family === 6) {
    return INTERNAL_IP_BLOCK_LIST.check(ip, 'ipv6');
  }
  return true;
};

/**
 * Returns true if `host` is an IP literal in any textual form: dotted-quad, bare-decimal (2130706433), hex
 * (0x7f000001), and octal - the WHATWG URL parser normalizes those to dotted-quad, so `net.isIP` sees a v4 address -
 * or bracketed/bare IPv6 (including IPv4-mapped, e.g. ::ffff:127.0.0.1).
 *
 * Tenant-supplied hosts must be DNS hostnames: an IP-literal host bypasses the resolve-deny-pin egress guard
 * entirely, because Node's net/http layer skips the custom `lookup` whenever the host is already numeric
 * (`net.isIP(host)` truthy) and dials it directly - so `guardedLookup` never runs. Rejecting IP literals up front
 * closes that bypass; hostnames still go through `guardedLookup` and the resolved-IP denylist as before.
 */
export const isIpLiteralHost = (host: string): boolean => {
  if (!host) {
    return false;
  }
  // URL.hostname returns IPv6 bracketed ("[::1]"); net.isIP wants the bare address.
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  return net.isIP(bare) !== 0;
};

interface DohResult {
  addresses: string[];
  ttlMs: number;
}

// Returns null on transport failure (so the caller can fail over to the next resolver); a DohResult (possibly with an
// empty address list) on any successful HTTP response.
const dohQuery = (resolver: DohResolver, hostname: string, type: number): Promise<DohResult | null> =>
  new Promise(resolve => {
    const request = https.request(
      {
        host: resolver.ip,
        servername: resolver.hostname,
        path: `${resolver.path}?name=${encodeURIComponent(hostname)}&type=${type}`,
        method: 'GET',
        headers: { accept: 'application/dns-json', host: resolver.hostname },
        timeout: DOH_TIMEOUT_MS
      },
      response => {
        let body = '';
        response.on('data', chunk => {
          body += chunk;
        });
        response.on('end', () => {
          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
            resolve(null);
            return;
          }
          try {
            const json = JSON.parse(body);
            const answers: Array<{ type?: number; data?: string; TTL?: number }> = Array.isArray(json.Answer)
              ? json.Answer
              : [];
            const matching = answers.filter(answer => answer.type === type && typeof answer.data === 'string');
            const addresses = matching.map(answer => answer.data as string);
            const ttlSeconds = matching.reduce(
              (min, answer) => (typeof answer.TTL === 'number' ? Math.min(min, answer.TTL) : min),
              Number.POSITIVE_INFINITY
            );
            const ttlMs = Number.isFinite(ttlSeconds) ? ttlSeconds * 1000 : RESOLVE_CACHE_MIN_TTL_MS;
            resolve({ addresses, ttlMs });
          } catch {
            resolve({ addresses: [], ttlMs: RESOLVE_CACHE_MIN_TTL_MS });
          }
        });
      }
    );
    request.on('error', () => resolve(null));
    request.on('timeout', () => {
      request.destroy();
      resolve(null);
    });
    request.end();
  });

/**
 * Resolves a hostname to its public A/AAAA addresses via DoH, with a short positive cache and resolver failover. IP
 * literals are returned as-is for denylist checking. Returns an empty list (fail closed) only when every resolver is
 * unreachable.
 */
const resolvePublic = async (hostname: string): Promise<string[]> => {
  if (net.isIP(hostname)) {
    return [hostname];
  }

  const cached = s_resolveCache.get(hostname);
  if (cached) {
    if (cached.expiresAt > Date.now()) {
      return cached.addresses;
    }
    s_resolveCache.delete(hostname);
  }

  for (const resolver of DOH_RESOLVERS) {
    const [a, aaaa] = await Promise.all([
      dohQuery(resolver, hostname, DNS_TYPE_A),
      dohQuery(resolver, hostname, DNS_TYPE_AAAA)
    ]);
    if (a === null && aaaa === null) {
      continue; // resolver unreachable - fail over to the next
    }
    const addresses = [...(a?.addresses ?? []), ...(aaaa?.addresses ?? [])];
    const ttlMs = Math.min(
      RESOLVE_CACHE_MAX_TTL_MS,
      Math.max(RESOLVE_CACHE_MIN_TTL_MS, Math.min(a?.ttlMs ?? Infinity, aaaa?.ttlMs ?? Infinity))
    );
    evictResolveCacheIfNeeded();
    s_resolveCache.set(hostname, { addresses, expiresAt: Date.now() + ttlMs });
    return addresses;
  }

  return []; // every resolver unreachable - fail closed, do not cache
};

/**
 * Resolves a hostname and returns only the addresses that are safe to dial. Exposed (with an injectable resolver) so
 * the deny logic can be unit-tested without network access.
 */
export const resolveSafeAddresses = async (
  hostname: string,
  resolve: (host: string) => Promise<string[]> = resolvePublic
): Promise<string[]> => {
  const addresses = await resolve(hostname);
  return addresses.filter(address => !isInternalIp(address));
};

type LookupCallback = (err: NodeJS.ErrnoException | null, address?: any, family?: number) => void;

/**
 * Custom net lookup that resolves on the public resolver, drops internal addresses, and pins the connection to a
 * validated public IP. Fails closed if nothing resolves publicly or everything resolves internal.
 */
const guardedLookup = (hostname: string, options: any, callback: LookupCallback): void => {
  resolveSafeAddresses(hostname)
    .then(safe => {
      if (safe.length === 0) {
        Logger.warn(`SSRF guard: ${hostname} did not resolve to an allowed public IP; blocking request.`);
        callback(rejectedUrlError(`${hostname} did not resolve to an allowed public IP.`));
        return;
      }
      const toEntry = (address: string) => ({ address, family: net.isIPv6(address) ? 6 : 4 });
      if (options && options.all) {
        callback(null, safe.map(toEntry));
      } else {
        const entry = toEntry(safe[0]);
        callback(null, entry.address, entry.family);
      }
    })
    .catch(err => callback(err instanceof Error ? (err as NodeJS.ErrnoException) : new Error(String(err))));
};

// Socket-level backstop for the IP-literal rejection. `guardedAgentForUrl` rejects an IP-literal host at
// agent-selection time, which covers node-fetch (the selector re-runs per redirect hop). But superagent takes a fixed
// Agent instance, so a redirect to an IP literal is never re-checked at selection - it lands here in createConnection,
// the exact spot where Node skips the custom `lookup` for numeric hosts. Rejecting here closes that path too. Returns
// true (having errored the callback, or thrown when no callback is given) when the target is an IP literal; false
// otherwise so the caller proceeds to the guarded lookup. Hostnames (net.isIP === 0) fall through unchanged.
//
// Node's http/https layer populates both `host` and `hostname` (equal) on these options, but `net` dials `host`;
// checking both is defensive so no textual field can slip an IP literal past the guard.
const rejectIpLiteralConnect = (options: any, callback: any): boolean => {
  const target = [options?.host, options?.hostname].find(value => isIpLiteralHost(value));
  if (target === undefined) {
    return false;
  }
  Logger.warn(`SSRF guard: rejected IP-literal host '${target}' at connect; a DNS hostname is required.`);
  const err = rejectedUrlError(`IP-literal host '${target}' is not permitted; use a DNS hostname.`);
  if (typeof callback === 'function') {
    callback(err);
    return true;
  }
  throw err;
};

// http(s).Agent expose createConnection at runtime but it is not in the @types/node Agent type, so we invoke the base
// implementation via the prototype. Injecting `lookup` makes every socket - including each redirect hop - resolve and
// pin through the SSRF guard.
class GuardedHttpsAgent extends https.Agent {
  createConnection(options: any, callback: any): any {
    if (rejectIpLiteralConnect(options, callback)) {
      return;
    }
    return (https.Agent.prototype as any).createConnection.call(this, { ...options, lookup: guardedLookup }, callback);
  }
}

class GuardedHttpAgent extends http.Agent {
  createConnection(options: any, callback: any): any {
    if (rejectIpLiteralConnect(options, callback)) {
      return;
    }
    return (http.Agent.prototype as any).createConnection.call(this, { ...options, lookup: guardedLookup }, callback);
  }
}

const httpAgentDefaults: https.AgentOptions = {
  keepAlive: true,
  maxSockets: 1000, // per host
  maxTotalSockets: 5000, // total sockets across all hosts
  maxFreeSockets: 10,
  timeout: 60_000 // Destroy idle sockets after 1 min, well before NAT Gateway's 4 min idle timeout
};
const httpsAgentDefaults = {
  ...httpAgentDefaults
};

const guardedHttpAgent = new GuardedHttpAgent(httpAgentDefaults);
const guardedHttpsAgent = new GuardedHttpsAgent(httpsAgentDefaults);

// Plain, UNGUARDED agents for trusted internal calls to the Hyperproof / Fusebit platform itself (the add-on SDK,
// HyperproofApiClient, platform OAuth/token endpoints). Those hosts are system-configured - not tenant-supplied - and
// legitimately resolve to internal/Private-Link addresses, so the SSRF guard must NOT be applied to them or it would
// block the connector from talking to its own platform. Only TENANT/vendor destinations go through the guarded agent.
const internalHttpAgent = new http.Agent(httpAgentDefaults);
const internalHttpsAgent = new https.Agent(httpsAgentDefaults);

const guardedAgentForUrl = (parsedUrl: URL): http.Agent | https.Agent => {
  const protocol = parsedUrl.protocol;
  if (!ALLOWED_SCHEMES.has(protocol)) {
    Logger.warn(
      `SSRF guard: rejected disallowed URL scheme '${protocol}'. Allowed schemes: ${Array.from(ALLOWED_SCHEMES).join(
        ', '
      )}.`
    );
    throw rejectedUrlError(`URL scheme '${protocol}' is not permitted; only http and https are allowed.`);
  }
  // Reject IP-literal hosts: they bypass the resolve-deny-pin guard because Node skips the custom `lookup`
  // for numeric hosts. Tenant destinations must be DNS hostnames. Re-applied per redirect hop by guardedAgentSelector.
  if (isIpLiteralHost(parsedUrl.hostname)) {
    Logger.warn(`SSRF guard: rejected IP-literal host '${parsedUrl.hostname}'; a DNS hostname is required.`);
    throw rejectedUrlError(`IP-literal host '${parsedUrl.hostname}' is not permitted; use a DNS hostname.`);
  }
  return protocol === 'https:' ? guardedHttpsAgent : guardedHttpAgent;
};

/**
 * Returns the guarded agent for the URI after enforcing the scheme allowlist and rejecting IP-literal hosts. Throws
 * (and logs at WARN) for a disallowed scheme or an IP-literal host. The returned agent pins every connection to a
 * validated public IP. For node-fetch callers prefer the redirect-safe `createFetchOptions`; this fixed-agent form is
 * for clients that take an Agent instance (superagent).
 */
export const getAgent = (uri: string): http.Agent | https.Agent => {
  if (!uri) {
    throw new Error('No URI provided to getAgent.');
  }
  return guardedAgentForUrl(new URL(uri));
};

/**
 * node-fetch `agent` selector. node-fetch re-evaluates a function-valued `agent` for every request - including each
 * redirect hop - against that hop's parsed URL, so a protocol-changing redirect (http<->https) picks the correctly
 * guarded agent and re-applies the scheme allowlist and IP-literal rejection. A fixed Agent would reuse the original
 * protocol's agent across a redirect and break (e.g. an http.Agent on an https hop).
 */
export const guardedAgentSelector = (parsedUrl: URL): http.Agent | https.Agent => guardedAgentForUrl(parsedUrl);

/**
 * Creates node-fetch options with the redirect-safe guarded agent selector. The initial URL's scheme is validated
 * eagerly (throws on a disallowed scheme); each redirect hop is re-validated and re-pinned by the selector.
 *
 * @param uri - The URI for which to get the agent
 * @param baseOptions - Base fetch options to extend
 * @returns Fetch options with the guarded agent selector included
 */
export const createFetchOptions = (uri: string, baseOptions: RequestInit = {}): any => {
  getAgent(uri); // eager fail-fast on the initial URL's scheme
  const options = { ...baseOptions } as any;
  options.agent = guardedAgentSelector;
  return options;
};

/**
 * Returns an UNGUARDED agent for the URI. For trusted internal Hyperproof / Fusebit platform calls only - never for
 * tenant or vendor destinations. No scheme allowlist, no DNS resolution, no IP denylist, no pinning.
 */
export const getInternalAgent = (uri: string): http.Agent | https.Agent => {
  if (!uri) {
    throw new Error('No URI provided to getInternalAgent.');
  }
  return internalAgentForProtocol(new URL(uri).protocol);
};

const internalAgentForProtocol = (protocol: string): http.Agent | https.Agent =>
  protocol === 'https:' ? internalHttpsAgent : internalHttpAgent;

// node-fetch selector for the unguarded internal agent (redirect-safe across schemes, same rationale as the guarded one).
const internalAgentSelector = (parsedUrl: URL): http.Agent | https.Agent =>
  internalAgentForProtocol(parsedUrl.protocol);

/** Creates fetch options with the UNGUARDED internal agent. For trusted Hyperproof / Fusebit platform calls only. */
export const createInternalFetchOptions = (uri: string, baseOptions: RequestInit = {}): any => {
  const options = { ...baseOptions } as any;
  options.agent = internalAgentSelector;
  return options;
};
