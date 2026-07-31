/**
 * Shared error classification constants and utilities for integration connectors.
 *
 * This module provides the canonical definitions for categorizing errors that occur
 * when communicating with external vendor systems (e.g. AWS, ServiceNow, Jira).
 * It is consumed by:
 *
 * - **task-sdk** (TaskConnector.ts) — to classify errors in task integration handlers
 * - **hypersync-sdk** (hypersyncConnector.ts) — to classify errors in hypersync invoke handlers
 * - **integration-sdk** (throttle.ts) — to determine retryable errors in ExternalAPIError
 * - **integration-api** (errorClassification.ts in hyperproof repo) — the integration-api
 *   service has its own comprehensive classification module that should be kept in sync
 *   with these constants. The integration-api module adds Prometheus metrics and
 *   message-based fallback detection that are specific to the service layer.
 *
 * The goal is to maintain a single source of truth for error code/status sets so that
 * changes (e.g. adding a new network error code) propagate to all consumers without
 * requiring manual synchronization across packages.
 *
 * **Important:** Changes to these constants affect logging levels and retry behavior
 * across all integration connectors. When adding or removing entries:
 * - Verify the change against real production error data
 * - Update the corresponding constants in the hyperproof repo's
 *   errorClassification.ts to stay in sync
 * - Consider whether the change affects retry logic (throttle.ts) vs. logging
 *   level (TaskConnector.ts, hypersyncConnector.ts)
 */

import { StatusCodes } from 'http-status-codes';

/**
 * Network error codes that indicate transient connectivity issues with external
 * vendor systems. These are not code bugs — they represent the external system
 * dropping connections, DNS failures, timeouts, etc.
 *
 * These errors are typically retried at the integration-api layer (up to 4 times
 * with exponential backoff for ECONNRESET). By the time they surface in connector
 * error handlers, retries have been exhausted.
 *
 * Used for:
 * - Logging level decisions: network errors are logged at INFO/WARN, not ERROR
 * - Retry decisions: network errors are candidates for automatic retry
 */
export const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET', // Connection reset by peer
  'ECONNREFUSED', // Connection refused
  'ETIMEDOUT', // Connection timed out
  'ESOCKETTIMEDOUT', // Socket timeout
  'EPIPE', // Broken pipe
  'ECONNABORTED', // Connection aborted
  'EHOSTUNREACH', // Host unreachable
  'ENETUNREACH', // Network unreachable
  'EAI_AGAIN', // DNS temporary failure
  'ENOTFOUND', // DNS lookup failed
  'ENETRESET', // Network dropped connection on reset
  'EHOSTDOWN' // Host is down
]);

/**
 * SSL/TLS error codes that typically indicate certificate or proxy configuration
 * issues in the customer's environment. Often caused by corporate proxies, expired
 * certs, or self-signed certificates on the vendor system.
 *
 * These are customer-side configuration issues, not code bugs.
 */
export const SSL_ERROR_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_NOT_YET_VALID',
  'CERT_SIGNATURE_FAILURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'
]);

/**
 * HTTP status codes that indicate the customer's credentials are invalid, expired,
 * or lack sufficient permissions in the external vendor system.
 *
 * These are customer configuration issues — the customer needs to re-authenticate
 * or fix their permissions. Errors with these status codes are surfaced to customers
 * through connection health (hypersyncs) or per-field sync state (task integrations).
 */
export const AUTH_STATUS_CODES = new Set([
  StatusCodes.UNAUTHORIZED,
  StatusCodes.FORBIDDEN,
  StatusCodes.PROXY_AUTHENTICATION_REQUIRED,
  StatusCodes.NETWORK_AUTHENTICATION_REQUIRED
]);

/**
 * HTTP status codes indicating rate limiting, timeouts, or external service overload.
 * These are transient and typically resolve on retry with backoff.
 */
export const RATE_LIMIT_STATUS_CODES = new Set([
  StatusCodes.REQUEST_TIMEOUT,
  StatusCodes.TOO_MANY_REQUESTS,
  StatusCodes.BAD_GATEWAY,
  StatusCodes.SERVICE_UNAVAILABLE,
  StatusCodes.GATEWAY_TIMEOUT
]);

/**
 * Extracts the error code from an error object, checking common locations where
 * different libraries and SDKs store error codes.
 *
 * @returns The error code string, or undefined if not found.
 */
export function getErrorCode(error: any): string | undefined {
  if (typeof error?.code === 'string') {
    return error.code;
  }
  if (typeof error?.cause?.code === 'string') {
    return error.cause.code;
  }
  if (typeof error?.errno === 'string') {
    return error.errno;
  }
  return undefined;
}

/**
 * Extracts the HTTP status code from an error object, checking multiple locations
 * where different libraries store the status.
 *
 * @returns The numeric HTTP status code, or undefined if not found or invalid.
 */
export function getHttpStatus(error: any): number | undefined {
  const candidates = [error?.status, error?.statusCode, error?.response?.status, error?.response?.statusCode];
  for (const candidate of candidates) {
    const numeric = typeof candidate === 'string' ? Number(candidate) : candidate;
    if (typeof numeric === 'number' && !Number.isNaN(numeric) && numeric >= StatusCodes.CONTINUE && numeric < 600) {
      return numeric;
    }
  }
  return undefined;
}

/**
 * Returns true if the error is a network connectivity issue (ECONNRESET, ETIMEDOUT, etc.)
 */
export function isNetworkError(error: any): boolean {
  const code = getErrorCode(error);
  return typeof code === 'string' && NETWORK_ERROR_CODES.has(code);
}

/**
 * Returns true if the error is an SSL/TLS configuration issue.
 */
export function isSslError(error: any): boolean {
  const code = getErrorCode(error);
  return typeof code === 'string' && SSL_ERROR_CODES.has(code);
}

/**
 * Returns true if the error indicates an authentication/authorization failure
 * (HTTP 401, 403, 407, or 511).
 */
export function isAuthError(error: any): boolean {
  const status = getHttpStatus(error);
  return status !== undefined && AUTH_STATUS_CODES.has(status);
}

/**
 * Returns true if the error indicates rate limiting or external service overload
 * (HTTP 408, 429, 502, 503, or 504).
 */
export function isRateLimitError(error: any): boolean {
  const status = getHttpStatus(error);
  return status !== undefined && RATE_LIMIT_STATUS_CODES.has(status);
}

/**
 * Returns true if the error is a customer-side issue — either a network connectivity
 * problem, an SSL/TLS configuration issue, or a credential/permission failure.
 *
 * Customer-side errors should be logged at INFO/WARN level rather than ERROR, since
 * they require no engineering action. The errors are still propagated in HTTP responses
 * and recorded in the appropriate customer-facing state (connection health for
 * hypersyncs, externalSyncState for task integrations).
 */
export function isCustomerSideError(error: any): boolean {
  return isNetworkError(error) || isSslError(error) || isAuthError(error);
}

/**
 * Returns true if the error is a candidate for automatic retry — either a network
 * error or a rate limit/service overload error.
 *
 * This is used by throttle.ts (ExternalAPIError.canRetry) and can be used by other
 * retry logic throughout the integration connectors.
 */
export function isRetryableError(error: any): boolean {
  return isNetworkError(error) || isRateLimitError(error);
}
