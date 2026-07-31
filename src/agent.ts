/**
 * The shared connector HTTP agent. Implementation lives in ./util/ssrfGuard.
 *
 * - `getAgent` / `createFetchOptions` are SSRF-GUARDED (scheme allowlist, public DoH resolution, internal-IP denylist,
 *   connection pinning) and must be used for all TENANT / vendor destinations. This is the default.
 * - `getInternalAgent` / `createInternalFetchOptions` are UNGUARDED and are ONLY for trusted internal calls to the
 *   Hyperproof / Fusebit platform itself (the add-on SDK, HyperproofApiClient, platform token endpoints), whose hosts
 *   are system-configured and legitimately resolve to internal addresses.
 *
 * Re-exported here to preserve the historical `./agent` import path used across the SDK.
 */
export {
  getAgent,
  createFetchOptions,
  getInternalAgent,
  createInternalFetchOptions,
  SSRF_BLOCKED_ERROR_CODE
} from './util/ssrfGuard';
