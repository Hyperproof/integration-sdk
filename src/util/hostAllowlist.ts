export interface AllowedHostOptions {
  /**
   * Allowed host suffixes. A host matches when it equals a suffix exactly or is a subdomain of it
   * (e.g. suffix `coupahost.com` matches `coupahost.com` and `acme.coupahost.com`, but not
   * `coupahost.com.attacker.com` or `notcoupahost.com`).
   */
  allowedHostSuffixes: string[];
  /** Permitted URL schemes (values include the trailing `:`, matching URL.protocol). Defaults to https only. */
  schemes?: string[];
}

/**
 * Returns true if `url` parses, uses a permitted scheme, and its host equals or is a subdomain of one of the allowed
 * suffixes. Returns false for any malformed URL or disallowed scheme/host.
 *
 * This is the shared primitive behind connectors that interpolate a customer-supplied host into a vendor API base URL
 * (Coupa, Paylocity, Wiz, ...). Constraining the host to the vendor's domains prevents credential/data exfiltration to
 * an attacker-controlled *public* host - which the IP-based egress guard cannot catch because it resolves publicly.
 * Callers keep their own connector-specific error handling; this function only answers the allow/deny question so it
 * can be unit-tested in isolation.
 */
export const isAllowedHost = (
  url: string,
  { allowedHostSuffixes, schemes = ['https:'] }: AllowedHostOptions
): boolean => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!schemes.includes(parsed.protocol)) {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  return allowedHostSuffixes.some(suffix => {
    const normalized = suffix.toLowerCase();
    return host === normalized || host.endsWith(`.${normalized}`);
  });
};
