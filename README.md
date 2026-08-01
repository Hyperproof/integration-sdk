# integration-sdk

SDK for building integrations in Hyperproof.

## Release Notes

### 7.0.0

- **Breaking:** Updated to `@hyperproof/hypersync-models` 7.0.0
- **Breaking:** Outbound requests are now SSRF-guarded — scheme allowlist, public DoH resolution, internal-IP denylist and connection pinning. Targets that are not publicly resolvable are rejected with `EGRESS_BLOCKED`. Trusted Hyperproof platform calls use the new unguarded `getInternalAgent` / `createInternalFetchOptions`
- **Breaking:** `Logger` methods are synchronous and write structured JSON to stdout instead of posting each event to the Hyperproof API. Removed `Logger.init()`
- **Breaking:** Renamed `IExternalUser` → `IExternalUserRef`, `IExternalGroup` → `IExternalGroupRef`, `ExternalPrincipal` → `ExternalPrincipalRef`. The old names now denote richer org-scoped entities, so imports must be reviewed rather than renamed blindly
- **Breaking:** Removed `RecordingManager` and the `@pollyjs/*` dependencies
- **Breaking:** `applyAdditionalAuthorizationConfig` is async and takes an optional `ctx`
- **Breaking:** `validateAccessToken` is a no-op by default instead of throwing `501`; `HealthStatus.NotImplemented` is no longer produced
- **Breaking:** `ApiClient.handleFailedResponse` takes a `method` argument; `ITaskSyncState` fields are optional; removed `ITask.sortOrder`
- Added Prometheus metrics and a `/metrics` endpoint, with `safeMetric` so instrumentation can never fail a request
- Added graceful shutdown — `HttpServer` drains in-flight requests on `SIGTERM`/`SIGINT`
- Added `validateCredentialFields` to enforce declared credential-field constraints server-side
- Added shared error classification helpers (`isRetryableError`, `isRateLimitError`, `isCustomerSideError`, and related sets)
- Added OAuth variant support (`resolveVariant`, `withVariantConfig`, `IOAuthVariant`)
- Added `AuthorizationType.MERGE_LINK` and the `hyperprooftokenhealth` route
- Added task and instance integration models
- Broadened retry coverage, and `Retry-After` now accepts an HTTP-date as well as seconds
- Added `@types/qs` as a runtime dependency because `ParsedQs` appears in the emitted type definitions

### 6.0.0

- Bumped version to 6 to match hypersync-models package. All packages versions will be kept in sync from now on.
- **Breaking:** Updated to Node.js 22
- **Breaking:** Updated to @hyperproof/hypersync-models 6.0.0
- **Breaking:** Removed `ErrorName` enum and `RefreshTokenError` class
- Added `CredentialFieldType` enum (moved from `@hyperproof/hypersync-models`)
- Added HTTP agent management with connection pooling and keep-alive support
- Expanded `HyperproofApiClient` with additional API methods
- Plus other bug fixes and performance enhancements

### 1.2.0

- Update TypeScript to version 5.5.4
- Update node-fetch to version 2.7.0
- Update Express to version 4.21.0
- Update Superagent to version 10.1.0
- Update other dependencies to latest versions
- Improvements to logging and error handling
- Various bug fixes

### 1.1.2

- Add readiness endpoint for new integration execution environment.

### 1.0.2

- Remove SchemaCategory from Integration SDK as it is Hypersyncs only.

### 1.0.1

- Fix issues in package.json

### 1.0.0

- Add support for new integration execution environment
- Add common interfaces and models from Hypersync SDK so that they can be used by other integration types
- Improve logging and monitoring
- Fix various bugs

### 0.9.0

- Add support for Node 18
- Enhance error handling

### 0.8.0

- Initial version
