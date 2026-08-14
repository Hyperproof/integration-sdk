import {
  getAgent,
  getInternalAgent,
  guardedAgentSelector,
  isInternalIp,
  isIpLiteralHost,
  resolveSafeAddresses,
  SSRF_BLOCKED_ERROR_CODE
} from './ssrfGuard';

import http from 'http';
import https from 'https';

describe('ssrfGuard', () => {
  describe('isInternalIp', () => {
    it.each([
      '127.0.0.1',
      '10.0.0.5',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // IMDS
      '100.64.0.1', // CGNAT
      '0.0.0.0',
      '255.255.255.255',
      '198.18.0.1',
      '::1', // IPv6 loopback
      '::', // IPv6 unspecified
      'fe80::1', // link-local
      'fc00::1', // unique local
      'ff02::1', // multicast
      '2001:db8::1', // documentation
      '64:ff9b::1', // NAT64
      '2002:7f00:1::', // 6to4 embedding 127.0.0.1
      '::ffff:127.0.0.1', // IPv4-mapped loopback (dotted)
      '::ffff:7f00:1', // IPv4-mapped loopback (hex form - must also be blocked)
      '0:0:0:0:0:ffff:7f00:1', // IPv4-mapped loopback (fully expanded)
      '::ffff:169.254.169.254', // IPv4-mapped IMDS
      '::ffff:a9fe:a9fe' // IPv4-mapped IMDS (hex form)
    ])('treats %s as internal', address => {
      expect(isInternalIp(address)).toBe(true);
    });

    it.each([
      '8.8.8.8',
      '1.1.1.1',
      '140.82.121.4',
      '2606:4700:4700::1111',
      '2001:4860:4860::8888',
      '::ffff:8.8.8.8' // IPv4-mapped public
    ])('treats %s as public', address => {
      expect(isInternalIp(address)).toBe(false);
    });

    it.each(['not-an-ip', 'example.com', ''])('fails closed for non-IP value %p', value => {
      expect(isInternalIp(value)).toBe(true);
    });
  });

  describe('isIpLiteralHost (HYP-85435)', () => {
    // The helper is fed URL.hostname, which the WHATWG parser has already normalized (decimal/hex/octal -> dotted-quad,
    // IPv6 -> bracketed). Those encodings are exercised end-to-end in the getAgent describe below.
    it.each([
      '127.0.0.1', // dotted-quad
      '169.254.169.254', // IMDS dotted-quad
      '8.8.8.8', // public v4 - still an IP literal, still rejected
      '[::1]', // bracketed IPv6 loopback (URL.hostname form)
      '::1', // bare IPv6 loopback (createConnection options.host form)
      '[::ffff:127.0.0.1]', // bracketed IPv4-mapped
      '[2606:4700:4700::1111]' // bracketed public IPv6 - still rejected
    ])('treats %s as an IP literal', host => {
      expect(isIpLiteralHost(host)).toBe(true);
    });

    it.each(['example.com', 'sub.vendor.io', 'jira.customer.example', ''])(
      'treats %p as a hostname (not an IP literal)',
      host => {
        expect(isIpLiteralHost(host)).toBe(false);
      }
    );
  });

  describe('resolveSafeAddresses (resolve-deny core)', () => {
    it('keeps only public addresses when the resolver returns a mix', async () => {
      const safe = await resolveSafeAddresses('host', async () => ['10.0.0.1', '8.8.8.8', '169.254.169.254']);
      expect(safe).toEqual(['8.8.8.8']);
    });

    it('denies (empty) when the host resolves only to internal IPs', async () => {
      const safe = await resolveSafeAddresses('rebind', async () => ['169.254.169.254', '127.0.0.1']);
      expect(safe).toEqual([]);
    });

    it('fails closed (empty) when resolution yields nothing', async () => {
      const safe = await resolveSafeAddresses('unresolvable', async () => []);
      expect(safe).toEqual([]);
    });
  });

  describe('getAgent scheme allowlist', () => {
    it.each(['https://example.com', 'http://example.com'])('returns an agent for %s', uri => {
      expect(getAgent(uri)).toBeDefined();
    });

    it.each(['ftp://example.com', 'file:///etc/passwd', 'gopher://example.com'])(
      'rejects disallowed scheme %s',
      uri => {
        expect(() => getAgent(uri)).toThrow();
      }
    );

    it('rejects a disallowed scheme with a 400 (not 500) and a reason-only message', () => {
      let caught: any;
      try {
        getAgent('ftp://example.com');
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeDefined();
      expect(caught.status).toBe(400);
      expect(caught.message).not.toMatch(/SSRF guard/);
      expect(caught.message).toMatch(/scheme/);
    });

    it('throws when no uri is provided', () => {
      expect(() => getAgent('')).toThrow();
    });
  });

  describe('getAgent IP-literal rejection (HYP-85435)', () => {
    it.each([
      'https://127.0.0.1', // loopback (the pentest case)
      'https://169.254.169.254', // IMDS
      'https://8.8.8.8', // public v4 - IP literals are rejected regardless of range
      'https://2130706433', // bare-decimal 127.0.0.1
      'https://0x7f000001', // hex 127.0.0.1
      'https://0177.0.0.1', // octal 127.0.0.1
      'https://[::1]', // IPv6 loopback
      'https://[::ffff:127.0.0.1]', // IPv4-mapped loopback
      'http://127.0.0.1' // http scheme is allowed, but the IP literal is still rejected
    ])('rejects IP-literal host %s', uri => {
      expect(() => getAgent(uri)).toThrow(/IP-literal host/);
    });

    it('rejects with a 400 (client error, not 500) and a reason-only message (no "SSRF guard" prefix)', () => {
      let caught: any;
      try {
        getAgent('https://127.0.0.1');
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeDefined();
      expect(caught.status).toBe(400);
      expect(caught.statusCode).toBe(400);
      expect(caught.code).toBe(SSRF_BLOCKED_ERROR_CODE);
      expect(caught.message).not.toMatch(/SSRF guard/);
      expect(caught.message).toMatch(/IP-literal host/);
    });

    it.each(['https://example.com', 'https://sub.vendor.io', 'http://jira.customer.example'])(
      'still returns an agent for hostname %s',
      uri => {
        expect(getAgent(uri)).toBeDefined();
      }
    );
  });

  describe('guardedAgentSelector (redirect-safe agent selection)', () => {
    // node-fetch re-evaluates this per redirect hop, so a protocol-changing redirect picks the right guarded agent.
    it('selects an https.Agent for an https URL', () => {
      expect(guardedAgentSelector(new URL('https://example.com'))).toBeInstanceOf(https.Agent);
    });

    it('selects an http.Agent (not https) for an http URL', () => {
      const agent = guardedAgentSelector(new URL('http://example.com'));
      expect(agent).toBeInstanceOf(http.Agent);
      expect(agent).not.toBeInstanceOf(https.Agent);
    });

    it('re-applies the scheme allowlist per hop (rejects a redirect to a disallowed scheme)', () => {
      expect(() => guardedAgentSelector(new URL('ftp://example.com'))).toThrow();
    });

    it('re-applies the IP-literal rejection per hop (rejects a redirect to an IP literal)', () => {
      expect(() => guardedAgentSelector(new URL('https://169.254.169.254'))).toThrow(/IP-literal host/);
    });
  });

  describe('guarded agent createConnection backstop (superagent redirect path)', () => {
    // superagent uses a fixed agent instance, so a redirect to an IP literal is not re-checked at selection time - it
    // reaches createConnection, where Node would otherwise skip the guarded lookup for the numeric host. The backstop
    // must reject it there without opening a socket.
    it.each(['127.0.0.1', '169.254.169.254', '::1'])('errors the connection callback for IP-literal host %s', host => {
      const agent = getAgent('https://example.com') as any; // guardedHttpsAgent instance
      const callback = jest.fn();
      agent.createConnection({ host, port: 443 }, callback);
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback.mock.calls[0][0]).toBeInstanceOf(Error);
      expect(callback.mock.calls[0][0].status).toBe(400);
      expect(callback.mock.calls[0][0].code).toBe(SSRF_BLOCKED_ERROR_CODE);
      expect(callback.mock.calls[0][0].message).toMatch(/IP-literal host/);
      expect(callback.mock.calls[0][0].message).not.toMatch(/SSRF guard/);
    });

    it('also rejects when the IP literal is only on options.hostname (no options.host)', () => {
      const agent = getAgent('https://example.com') as any;
      const callback = jest.fn();
      agent.createConnection({ hostname: '169.254.169.254', port: 443 }, callback);
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback.mock.calls[0][0]).toBeInstanceOf(Error);
      expect(callback.mock.calls[0][0].status).toBe(400);
      expect(callback.mock.calls[0][0].message).toMatch(/IP-literal host/);
    });
  });

  describe('getInternalAgent (unguarded, for trusted platform calls)', () => {
    it('returns an agent without applying the guard, even for internally-resolved platform hosts', () => {
      // The Hyperproof/Fusebit platform host resolves internally and must NOT be blocked by the tenant SSRF guard.
      expect(getInternalAgent('https://hpip.hyper.blue')).toBeDefined();
      expect(getInternalAgent('http://some-internal-service')).toBeDefined();
    });

    it('does NOT apply the tenant IP-literal rejection (internal platform calls may use IP hosts)', () => {
      // The IP-literal ban is a tenant-egress control; internal platform destinations are trusted.
      expect(getInternalAgent('https://127.0.0.1')).toBeDefined();
      expect(getInternalAgent('http://169.254.169.254')).toBeDefined();
    });

    it('throws only when no uri is provided', () => {
      expect(() => getInternalAgent('')).toThrow();
    });
  });
});
