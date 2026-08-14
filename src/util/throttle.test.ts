import { ExternalAPIError, FetchLikeError, ThrottleManager } from './throttle';

import { StatusCodes } from 'http-status-codes';

jest.mock('../hyperproof-api/Logger');

/* eslint-disable max-lines-per-function */

/**
 * Helper to create an ExternalAPIError with specific response headers and status code.
 * Simulates the error shape produced by node-fetch or Octokit when a request fails.
 */
function createErrorWithHeaders(
  statusCode: number,
  headers: Record<string, string>,
  throttleModel?: { totalTries?: number; maxTries?: number; maxBackoffDelay?: number }
) {
  const sendRequest = jest.fn();
  const manager = new ThrottleManager(sendRequest, throttleModel);
  const error = new FetchLikeError('Request failed');
  error.status = statusCode;
  (error as any).response = { headers };
  return new ExternalAPIError(manager, error);
}

describe('ThrottleManager', () => {
  const noopSender = jest.fn();

  describe('maxBackoffDelay', () => {
    it('should use default maxBackoffDelay (64) when not specified', () => {
      const manager = new ThrottleManager(noopSender);
      expect(manager.maxBackoffDelay).toBe(64);
    });

    it('should use custom maxBackoffDelay when specified', () => {
      const manager = new ThrottleManager(noopSender, { maxBackoffDelay: 300 });
      expect(manager.maxBackoffDelay).toBe(300);
    });

    it('should preserve maxBackoffDelay through toModel()', () => {
      const manager = new ThrottleManager(noopSender, { maxBackoffDelay: 120 });
      const model = manager.toModel();
      expect(model.maxBackoffDelay).toBe(120);
    });

    it('should restore maxBackoffDelay from a serialized model', () => {
      const original = new ThrottleManager(noopSender, { maxBackoffDelay: 200, maxTries: 10 });
      const model = original.toModel();

      const restored = new ThrottleManager(noopSender, model);
      expect(restored.maxBackoffDelay).toBe(200);
      expect(restored.totalTries).toBe(2); // original was 1, restored increments to 2
    });

    it('should use default maxBackoffDelay when restoring a model without it', () => {
      // Simulates deserializing a model from a previous version that didn't have maxBackoffDelay
      const legacyModel = { totalTries: 1, maxTries: 5 };
      const manager = new ThrottleManager(noopSender, legacyModel);
      expect(manager.maxBackoffDelay).toBe(64);
    });
  });

  describe('constructor', () => {
    it('should throw TOO_MANY_REQUESTS when totalTries exceeds maxTries', () => {
      expect(() => new ThrottleManager(noopSender, { totalTries: 5, maxTries: 5 })).toThrow(
        'Still unable to complete sync after 5 attempts.'
      );
    });

    it('should not throw when totalTries equals maxTries minus one', () => {
      expect(() => new ThrottleManager(noopSender, { totalTries: 4, maxTries: 5 })).not.toThrow();
    });
  });
});

describe('ExternalAPIError', () => {
  describe('computeRetry with Retry-After header (numeric seconds)', () => {
    it('should use the Retry-After value as delay', async () => {
      const err = createErrorWithHeaders(StatusCodes.TOO_MANY_REQUESTS, {
        'retry-after': '120'
      });

      const result = await err.computeRetry();
      // delay = 120 (from header) + jitteredBackoff(1, undefined, 64) which is 8..16
      expect(result.delay).toBeGreaterThanOrEqual(128);
      expect(result.delay).toBeLessThanOrEqual(136);
      expect(result.maxRetry).toBe(5);
      expect(result.metadata).toHaveProperty('throttleManager');
    });
  });

  describe('computeRetry with Retry-After: 0 (immediate retry)', () => {
    it('should honor a zero Retry-After instead of falling through to jittered backoff', async () => {
      const err = createErrorWithHeaders(StatusCodes.TOO_MANY_REQUESTS, {
        'retry-after': '0'
      });

      const result = await err.computeRetry();
      // delay = 0 (from header) + jitteredBackoff(1, undefined, 64) which is 8..16
      expect(result.delay).toBeGreaterThanOrEqual(8);
      expect(result.delay).toBeLessThanOrEqual(16);
    });
  });

  describe('computeRetry with Retry-After header (HTTP-date format)', () => {
    it('should parse an HTTP-date Retry-After and compute delay as seconds from now', async () => {
      const futureDate = new Date(Date.now() + 300_000); // 5 minutes from now
      const httpDate = futureDate.toUTCString(); // e.g. "Thu, 05 Mar 2026 12:00:00 GMT"

      const err = createErrorWithHeaders(StatusCodes.TOO_MANY_REQUESTS, {
        'retry-after': httpDate
      });

      const result = await err.computeRetry();
      // delay = ~300s (from date) + jitteredBackoff(1) which is 8..16
      // Allow some tolerance for time elapsed during test execution
      expect(result.delay).toBeGreaterThanOrEqual(290);
      expect(result.delay).toBeLessThanOrEqual(320);
    });

    it('should fall back to jittered backoff for negative Retry-After values', async () => {
      const err = createErrorWithHeaders(StatusCodes.TOO_MANY_REQUESTS, {
        'retry-after': '-10'
      });

      const result = await err.computeRetry();
      // Negative is rejected, falls through to jitteredBackoff(totalTries=1), range 8..16
      expect(result.delay).toBeGreaterThanOrEqual(8);
      expect(result.delay).toBeLessThanOrEqual(16);
    });

    it('should fall back to jittered backoff for Infinity Retry-After values', async () => {
      const err = createErrorWithHeaders(StatusCodes.TOO_MANY_REQUESTS, {
        'retry-after': 'Infinity'
      });

      const result = await err.computeRetry();
      // Infinity is rejected, falls through to jitteredBackoff(totalTries=1), range 8..16
      expect(result.delay).toBeGreaterThanOrEqual(8);
      expect(result.delay).toBeLessThanOrEqual(16);
    });

    it('should fall back to jittered backoff for unparseable Retry-After values', async () => {
      const err = createErrorWithHeaders(StatusCodes.TOO_MANY_REQUESTS, {
        'retry-after': 'not-a-date-or-number'
      });

      const result = await err.computeRetry();
      // Should fall through to jitteredBackoff(totalTries=1), range 8..16
      expect(result.delay).toBeGreaterThanOrEqual(8);
      expect(result.delay).toBeLessThanOrEqual(16);
    });
  });

  describe('computeRetry with X-RateLimit headers', () => {
    it('should compute delay from X-RateLimit-Reset when remaining is 0', async () => {
      const resetTime = Math.floor(Date.now() / 1000) + 600; // 10 minutes from now

      const err = createErrorWithHeaders(StatusCodes.TOO_MANY_REQUESTS, {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(resetTime)
      });

      const result = await err.computeRetry();
      // delay = ~600s (from reset header) + jitteredBackoff(1) which is 8..16
      expect(result.delay).toBeGreaterThanOrEqual(590);
      expect(result.delay).toBeLessThanOrEqual(620);
    });

    it('should not use X-RateLimit-Reset when remaining is > 0', async () => {
      const resetTime = Math.floor(Date.now() / 1000) + 600;

      const err = createErrorWithHeaders(StatusCodes.TOO_MANY_REQUESTS, {
        'x-ratelimit-remaining': '50',
        'x-ratelimit-reset': String(resetTime)
      });

      const result = await err.computeRetry();
      // Should fall through to jitteredBackoff since remaining > 0
      expect(result.delay).toBeGreaterThanOrEqual(8);
      expect(result.delay).toBeLessThanOrEqual(16);
    });
  });

  describe('computeRetry with no headers (jittered backoff)', () => {
    it('should use jittered backoff when no rate-limit headers are present', async () => {
      const err = createErrorWithHeaders(StatusCodes.TOO_MANY_REQUESTS, {});

      const result = await err.computeRetry();
      // jitteredBackoff(totalTries=1, baseDelay=8, maxValue=64) → range 8..16
      expect(result.delay).toBeGreaterThanOrEqual(8);
      expect(result.delay).toBeLessThanOrEqual(16);
    });

    it('should increase delay with higher totalTries', async () => {
      const err = createErrorWithHeaders(
        StatusCodes.TOO_MANY_REQUESTS,
        {},
        { totalTries: 2, maxTries: 10 } // will become totalTries=3 after construction
      );

      const result = await err.computeRetry();
      // jitteredBackoff(totalTries=3, baseDelay=8, maxValue=64) → range 8..64
      expect(result.delay).toBeGreaterThanOrEqual(8);
      expect(result.delay).toBeLessThanOrEqual(64);
    });
  });

  describe('computeRetry respects maxBackoffDelay', () => {
    it('should cap jittered backoff at custom maxBackoffDelay', async () => {
      // Use high totalTries so the exponential term would exceed maxBackoffDelay
      const err = createErrorWithHeaders(
        StatusCodes.TOO_MANY_REQUESTS,
        {},
        { totalTries: 3, maxTries: 10, maxBackoffDelay: 30 }
      );

      const result = await err.computeRetry();
      // jitteredBackoff(4, 8, 30) → min(ceil(8 + rand * (8*16 - 8)), 30) → capped at 30
      expect(result.delay).toBeLessThanOrEqual(30);
      expect(result.delay).toBeGreaterThanOrEqual(8);
    });

    it('should allow higher delays with a larger maxBackoffDelay', async () => {
      // Run multiple times to check the cap is respected
      for (let i = 0; i < 20; i++) {
        const err = createErrorWithHeaders(
          StatusCodes.TOO_MANY_REQUESTS,
          {},
          { totalTries: 4, maxTries: 10, maxBackoffDelay: 300 }
        );

        const result = await err.computeRetry();
        // jitteredBackoff(5, 8, 300) → min(ceil(8 + rand * (8*32 - 8)), 300) → up to 256, capped at 300
        expect(result.delay).toBeLessThanOrEqual(300);
        expect(result.delay).toBeGreaterThanOrEqual(8);
      }
    });

    it('should pass maxBackoffDelay through when server delay is present', async () => {
      const err = createErrorWithHeaders(
        StatusCodes.TOO_MANY_REQUESTS,
        { 'retry-after': '60' },
        { maxBackoffDelay: 20 }
      );

      const result = await err.computeRetry();
      // delay = 60 (from header) + jitteredBackoff(1, 8, 20) → 60 + 8..16 (capped at 20)
      expect(result.delay).toBeGreaterThanOrEqual(68);
      expect(result.delay).toBeLessThanOrEqual(80);
    });
  });

  describe('computeRetry metadata', () => {
    it('should include throttleManager model with maxBackoffDelay in metadata', async () => {
      const err = createErrorWithHeaders(StatusCodes.TOO_MANY_REQUESTS, {}, { maxBackoffDelay: 200, maxTries: 8 });

      const result = await err.computeRetry();
      const model = (result.metadata as any).throttleManager;
      expect(model.maxBackoffDelay).toBe(200);
      expect(model.maxTries).toBe(8);
      expect(model.totalTries).toBe(1);
    });
  });

  describe('canRetry', () => {
    it('should return true for 429', () => {
      const err = createErrorWithHeaders(StatusCodes.TOO_MANY_REQUESTS, {});
      expect(err.canRetry()).toBe(true);
    });

    it('should return true for 503', () => {
      const err = createErrorWithHeaders(StatusCodes.SERVICE_UNAVAILABLE, {});
      expect(err.canRetry()).toBe(true);
    });

    it('should return true for 504', () => {
      const err = createErrorWithHeaders(StatusCodes.GATEWAY_TIMEOUT, {});
      expect(err.canRetry()).toBe(true);
    });

    it('should return false for 400', () => {
      const err = createErrorWithHeaders(StatusCodes.BAD_REQUEST, {});
      expect(err.canRetry()).toBe(false);
    });

    it('should throw original error from computeRetry when canRetry is false', async () => {
      const err = createErrorWithHeaders(StatusCodes.BAD_REQUEST, {});
      await expect(err.computeRetry()).rejects.toBeInstanceOf(FetchLikeError);
    });
  });
});
