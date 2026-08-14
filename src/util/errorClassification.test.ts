import {
  getErrorCode,
  getHttpStatus,
  isAuthError,
  isCustomerSideError,
  isNetworkError,
  isRateLimitError,
  isRetryableError,
  isSslError
} from './errorClassification';

describe('errorClassification', () => {
  describe('getErrorCode', () => {
    it('should return error.code when present', () => {
      expect(getErrorCode({ code: 'ECONNRESET' })).toBe('ECONNRESET');
    });

    it('should return error.cause.code when error.code is absent', () => {
      expect(getErrorCode({ cause: { code: 'ETIMEDOUT' } })).toBe('ETIMEDOUT');
    });

    it('should return error.errno when code and cause.code are absent', () => {
      expect(getErrorCode({ errno: 'ENOTFOUND' })).toBe('ENOTFOUND');
    });

    it('should prefer error.code over error.cause.code', () => {
      expect(getErrorCode({ code: 'ECONNRESET', cause: { code: 'ETIMEDOUT' } })).toBe('ECONNRESET');
    });

    it('should return undefined for null/undefined', () => {
      expect(getErrorCode(null)).toBeUndefined();
      expect(getErrorCode(undefined)).toBeUndefined();
    });

    it('should return undefined when no code is present', () => {
      expect(getErrorCode({ message: 'something failed' })).toBeUndefined();
    });

    it('should return undefined when code is not a string', () => {
      expect(getErrorCode({ code: 42 })).toBeUndefined();
    });
  });

  describe('getHttpStatus', () => {
    it('should return error.status', () => {
      expect(getHttpStatus({ status: 401 })).toBe(401);
    });

    it('should return error.statusCode', () => {
      expect(getHttpStatus({ statusCode: 403 })).toBe(403);
    });

    it('should return error.response.status', () => {
      expect(getHttpStatus({ response: { status: 502 } })).toBe(502);
    });

    it('should return error.response.statusCode', () => {
      expect(getHttpStatus({ response: { statusCode: 504 } })).toBe(504);
    });

    it('should prefer error.status over error.statusCode', () => {
      expect(getHttpStatus({ status: 401, statusCode: 500 })).toBe(401);
    });

    it('should return undefined for null/undefined', () => {
      expect(getHttpStatus(null)).toBeUndefined();
      expect(getHttpStatus(undefined)).toBeUndefined();
    });

    it('should return undefined when no status is present', () => {
      expect(getHttpStatus({ message: 'error' })).toBeUndefined();
    });

    it('should return undefined for out-of-range status codes', () => {
      expect(getHttpStatus({ status: 0 })).toBeUndefined();
      expect(getHttpStatus({ status: 600 })).toBeUndefined();
      expect(getHttpStatus({ status: -1 })).toBeUndefined();
    });

    it('should coerce numeric string status to a number', () => {
      expect(getHttpStatus({ status: '401' })).toBe(401);
    });

    it('should return undefined when status is a non-numeric string', () => {
      expect(getHttpStatus({ status: 'error' })).toBeUndefined();
    });
  });

  describe('isNetworkError', () => {
    it.each(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE', 'EAI_AGAIN'])(
      'should return true for %s',
      code => {
        expect(isNetworkError({ code })).toBe(true);
      }
    );

    it('should return true when code is in error.cause', () => {
      expect(isNetworkError({ cause: { code: 'ECONNRESET' } })).toBe(true);
    });

    it('should return false for non-network error codes', () => {
      expect(isNetworkError({ code: 'CERT_HAS_EXPIRED' })).toBe(false);
    });

    it('should return false for errors without a code', () => {
      expect(isNetworkError({ message: 'connection failed' })).toBe(false);
    });
  });

  describe('isSslError', () => {
    it.each([
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'CERT_HAS_EXPIRED',
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'SELF_SIGNED_CERT_IN_CHAIN',
      'ERR_TLS_CERT_ALTNAME_INVALID'
    ])('should return true for %s', code => {
      expect(isSslError({ code })).toBe(true);
    });

    it('should return false for network error codes', () => {
      expect(isSslError({ code: 'ECONNRESET' })).toBe(false);
    });

    it('should return false for errors without a code', () => {
      expect(isSslError({ message: 'cert error' })).toBe(false);
    });
  });

  describe('isAuthError', () => {
    it.each([401, 403, 407, 511])('should return true for status %d', status => {
      expect(isAuthError({ status })).toBe(true);
    });

    it('should return true when status is in statusCode', () => {
      expect(isAuthError({ statusCode: 401 })).toBe(true);
    });

    it('should return true when status is in response.status', () => {
      expect(isAuthError({ response: { status: 403 } })).toBe(true);
    });

    it('should return false for non-auth status codes', () => {
      expect(isAuthError({ status: 500 })).toBe(false);
      expect(isAuthError({ status: 404 })).toBe(false);
    });

    it('should return false for errors without a status', () => {
      expect(isAuthError({ code: 'ECONNRESET' })).toBe(false);
    });
  });

  describe('isRateLimitError', () => {
    it.each([408, 429, 502, 503, 504])('should return true for status %d', status => {
      expect(isRateLimitError({ status })).toBe(true);
    });

    it('should return false for non-rate-limit status codes', () => {
      expect(isRateLimitError({ status: 401 })).toBe(false);
      expect(isRateLimitError({ status: 500 })).toBe(false);
    });
  });

  describe('isCustomerSideError', () => {
    it('should return true for network errors', () => {
      expect(isCustomerSideError({ code: 'ECONNRESET' })).toBe(true);
    });

    it('should return true for SSL errors', () => {
      expect(isCustomerSideError({ code: 'CERT_HAS_EXPIRED' })).toBe(true);
    });

    it('should return true for auth errors', () => {
      expect(isCustomerSideError({ status: 401 })).toBe(true);
    });

    it('should return false for rate limit errors (not customer-side)', () => {
      expect(isCustomerSideError({ status: 429 })).toBe(false);
    });

    it('should return false for internal server errors', () => {
      expect(isCustomerSideError({ status: 500 })).toBe(false);
    });

    it('should return false for errors with no classifiable info', () => {
      expect(isCustomerSideError({ message: 'unknown' })).toBe(false);
    });

    it('should return false for null/undefined', () => {
      expect(isCustomerSideError(null)).toBe(false);
      expect(isCustomerSideError(undefined)).toBe(false);
    });
  });

  describe('isRetryableError', () => {
    it('should return true for network errors', () => {
      expect(isRetryableError({ code: 'ECONNRESET' })).toBe(true);
    });

    it('should return true for rate limit errors', () => {
      expect(isRetryableError({ status: 429 })).toBe(true);
    });

    it('should return true for 502 Bad Gateway', () => {
      expect(isRetryableError({ status: 502 })).toBe(true);
    });

    it('should return false for auth errors (not retryable)', () => {
      expect(isRetryableError({ status: 401 })).toBe(false);
    });

    it('should return false for internal server errors', () => {
      expect(isRetryableError({ status: 500 })).toBe(false);
    });

    it('should return false for errors with no classifiable info', () => {
      expect(isRetryableError({ message: 'unknown' })).toBe(false);
    });
  });
});
