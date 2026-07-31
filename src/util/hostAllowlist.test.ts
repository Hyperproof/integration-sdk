import { isAllowedHost } from './hostAllowlist';

describe('isAllowedHost', () => {
  const opts = { allowedHostSuffixes: ['coupahost.com'] };

  it.each([
    'https://coupahost.com',
    'https://acme.coupahost.com',
    'https://acme.coupahost.com/oauth2/token',
    'https://ACME.CoupaHost.com' // case-insensitive
  ])('allows vendor host %s', url => {
    expect(isAllowedHost(url, opts)).toBe(true);
  });

  it.each([
    'https://evil.example.com', // public attacker host - the case the IP guard can't catch
    'https://coupahost.com.evil.com', // suffix-spoof
    'https://notcoupahost.com', // not a subdomain boundary
    'https://acme.coupacloud.com', // wrong vendor domain
    'http://acme.coupahost.com', // scheme not in default allowlist
    'not a url',
    '' // empty
  ])('rejects %s', url => {
    expect(isAllowedHost(url, opts)).toBe(false);
  });

  it('honors a custom scheme allowlist (http + https)', () => {
    const schemes = { allowedHostSuffixes: ['coupahost.com'], schemes: ['https:', 'http:'] };
    expect(isAllowedHost('http://acme.coupahost.com', schemes)).toBe(true);
    expect(isAllowedHost('ftp://acme.coupahost.com', schemes)).toBe(false);
  });

  it('supports multiple suffixes', () => {
    const multi = { allowedHostSuffixes: ['app.wiz.io', 'app.wiz.us'] };
    expect(isAllowedHost('https://sub.app.wiz.io', multi)).toBe(true);
    expect(isAllowedHost('https://sub.app.wiz.us', multi)).toBe(true);
    expect(isAllowedHost('https://app.wiz.io.evil.com', multi)).toBe(false);
  });
});
