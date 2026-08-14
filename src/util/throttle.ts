import { getErrorCode, getHttpStatus, NETWORK_ERROR_CODES, RATE_LIMIT_STATUS_CODES } from './errorClassification';

import createHttpError from 'http-errors';
import { StatusCodes } from 'http-status-codes';

import { Logger } from '../hyperproof-api';

/**
 * Response provided to the JobEngine denoting that a retry is requested.
 */
export interface IRetryResponse {
  metadata: object;
  maxRetry: number;
  delay: number;
}

/**
 * An error similar to those raised by calls to fetch().
 */
export class FetchLikeError extends Error {
  code?: string;
  response?: string;
  responseCode?: string;
  status?: number;
  type?: string;
}

/**
 * Interface describing a function which performs a request to the remote API and returns its
 * response.
 */
interface IRequestSender<RequestType, ResponseType> {
  (request: RequestType): Promise<ResponseType>;
}

/**
 * Object which can be preserved between retries to track their quantity.
 * @property {number} totalTries The total number of times this `ThrottleManager` has been reused.
 * @property {number} maxTries The maximum number of tries this manager should execute before giving
 *           up. Note: this functionality is ultimately handled by the Job Engine.
 * @property {number} maxBackoffDelay The maximum delay in seconds for jittered exponential backoff
 *           when no server-suggested delay is available. Connectors with longer rate-limit windows
 *           (e.g. hourly resets) may want a higher value than the default.
 */
export interface IThrottleModel {
  totalTries?: number;
  maxTries?: number;
  maxBackoffDelay?: number;
}

/**
 * Implements a backoff-retry strategy for handling rate limits.
 *
 * @template RequestType An object containing everything needed to perform a request.
 * @template ResponseType The return type, if any, produced by a call to the `sendRequest` function
 *           provided to the `ThrottleManager` constructor.
 */
export class ThrottleManager<RequestType, ResponseType> {
  private _sendRequest: IRequestSender<RequestType, ResponseType>;
  private _maxTries: number;
  private _totalTries: number;
  private _maxBackoffDelay: number;

  /**
   * Construct a ThrottleManager, optionally continuing to track the number of re-instantiations this
   * manager has undergone using the bare representation of a previously-used ThrottleManager.
   *
   * @throws {HttpError} If the ThrottleManager has been re-instantiated too many times.
   */
  constructor(
    sendRequest: IRequestSender<RequestType, ResponseType>,
    {
      maxTries = COMMON_MAX_RETRIES,
      totalTries = 0,
      maxBackoffDelay = DEFAULT_MAX_BACKOFF_DELAY
    }: IThrottleModel | undefined = {}
  ) {
    this._sendRequest = sendRequest;
    this._maxTries = maxTries;
    this._maxBackoffDelay = maxBackoffDelay;
    this._totalTries = totalTries + 1;
    if (this._totalTries > this._maxTries)
      throw createHttpError(
        StatusCodes.TOO_MANY_REQUESTS,
        `Still unable to complete sync after ${this._maxTries} attempts. ` +
          'This is likely due to rate limiting by the vendor API. Please try again later.'
      );
  }

  get maxTries() {
    return this._maxTries;
  }

  get totalTries() {
    return this._totalTries;
  }

  get maxBackoffDelay() {
    return this._maxBackoffDelay;
  }

  /**
   * Explicitly overwrite the retry count in this ThrottleManager.
   *
   * This should be used only when a retry count persists outside of the context
   * of a single ThrottleManager, such as when JobEngine delegates retries through
   * multiple RestDataSources, which each contruct a new ThrottleManager
   * internally, yet need their retry counts to be coordinated
   */
  setRetryCount(retryCount: number) {
    this._totalTries = retryCount;
  }

  /**
   * @returns The data needed to re-initialize this ThrottleManager.
   */
  toModel(): IThrottleModel {
    return {
      totalTries: this._totalTries,
      maxTries: this._maxTries,
      maxBackoffDelay: this._maxBackoffDelay
    };
  }

  /**
   * Try to send the request using `_sendRequest()`.
   *
   * @throws {ExternalAPIError} Any exception thrown by `_sendRequest()` is wrapped with an
   *         `ExternalAPIError` instance and propagated.
   */
  async retrieve(request: RequestType, logger?: (response: any) => void): Promise<ResponseType> {
    try {
      const response = await this._sendRequest(request);
      if (logger) {
        logger(response);
      }
      return response;
    } catch (e: any) {
      throw this._makeError(e);
    }
  }

  _makeError<ErrorType extends FetchLikeError>(error: ErrorType): ExternalAPIError<ErrorType> {
    return new ExternalAPIError(this, error);
  }
}

/**
 * This is the type of error thrown if a request fails.
 *
 * It includes a reference to the underlying error and a reference to the `ThrottleManager`
 * which originally sent the request.
 */
export class ExternalAPIError<RequestError extends FetchLikeError> {
  throttleManager: ThrottleManager<any, any>;
  error: RequestError;

  constructor(throttleManager: ThrottleManager<any, any>, error: RequestError) {
    this.throttleManager = throttleManager;
    this.error = error;
  }

  /** @returns The response code extracted from the original error, or undefined if it couldn't be
   * found. */
  get responseCode(): number | undefined {
    return findAttr(['status', 'code', 'responseCode'], this.error, this.error.response);
  }

  /**
   * Alias for responseCode
   */
  get status() {
    return this.responseCode;
  }

  get statusCode() {
    return this.responseCode;
  }

  get message() {
    return this.error?.message || `Unknown ExternalAPIError: ${this.responseCode || 'unknown status code'}`;
  }

  // Determines whether the error is a candidate for automatic retry. Uses the
  // shared error classification constants from errorClassification.ts so that
  // the set of retryable error codes/statuses is maintained in one place.
  //
  // Previously this method had inline arrays with only 3 network error codes
  // (ECONNRESET, ECONNREFUSED, ETIMEDOUT) and 3 HTTP status codes (429, 503, 504).
  // Now it uses the full NETWORK_ERROR_CODES set (12 codes) and
  // RATE_LIMIT_STATUS_CODES set (408, 429, 502, 503, 504) for broader coverage.
  canRetry(): boolean {
    const legacyStatus =
      this.responseCode !== undefined && Number.isFinite(Number(this.responseCode))
        ? Number(this.responseCode)
        : undefined;
    const status = getHttpStatus(this.error) ?? legacyStatus;
    const code = getErrorCode(this.error);

    return (
      (status !== undefined && RATE_LIMIT_STATUS_CODES.has(status)) ||
      /rate limit/i.test(this.message) ||
      (code !== undefined && NETWORK_ERROR_CODES.has(code))
    );
  }

  /**
   * Generate a RetryResponse object to provide to the job engine.
   *
   * Determines a delay to request either by the suggestion from the API or according to an
   * exponential backoff strategy.
   *
   * @returns {IRetryResponse} Object to provide to the job engine in order to schedule a retry.
   * @throws {RequestError} If the error could not be determined to be due to throttling/rate
   *         limiting.
   */
  async computeRetry(): Promise<IRetryResponse> {
    let delay;
    const maxBackoff = this.throttleManager.maxBackoffDelay;
    const headers = this._findHeadersInError();
    if (headers) {
      const suggestedDelay = await extractDelayFromResponseHeaders(headers);
      if (suggestedDelay !== undefined) {
        delay = suggestedDelay + jitteredBackoff(1, undefined, maxBackoff);
      }
    }
    if (delay === undefined) {
      if (this.canRetry()) {
        delay = jitteredBackoff(this.throttleManager.totalTries, undefined, maxBackoff);
      } else {
        Logger.error(
          'ExternalAPIError does not appear to have been caused by a rate limit or intermittent error. Propagating the original error.',
          this.error
        );
        throw this.error;
      }
    }
    const retryInfo = {
      data: [],
      metadata: {
        throttleManager: this.throttleManager.toModel()
      },
      maxRetry: this.throttleManager.maxTries,
      delay
    };
    Logger.info(
      `There appears to be a failure due to a rate limit or intermittent error. Suggesting retry response: ${JSON.stringify(
        retryInfo
      )}`
    );
    return retryInfo;
  }

  /** Attempts to return the header object in an error similar to those raised by `fetch()`. */
  _findHeadersInError() {
    return findAttr(['headers'], this.error, this.error.response);
  }
}

/**
 * Determine how long to wait until resending a request to avoid throttling.
 *
 * Returns exponentially longer amounts of time, on average, proportional to how many times
 * the request has been sent. A random jitter is applied to avoid stampedes. This
 * is implemented via a random multiplier on the entire exponential term to maximize
 * the effect of the entropy.
 *
 * @param triesSoFar How many times the request has been sent so far.
 * @param baseDelay The minimum value that can be returned.
 * @param maxValue The maximum value that can be returned.
 * @returns The minimum amount of time in seconds to wait before re-sending a request.
 */
const jitteredBackoff = (triesSoFar: number, baseDelay = 8, maxValue = 64): number =>
  Math.min(Math.ceil(baseDelay + Math.random() * (baseDelay * 2 ** triesSoFar - baseDelay)), maxValue);

/**
 * @param possibleNames The set of names, in order of precedence, under which the desired data
 *                      may be stored in the target objects. Implicitly case-insensitive.
 * @param targets The objects, in order of precedence, to search for an attribute with one of the
 *                possible names.
 * @returns The first non-undefined attribute with one of the possible names found in one
 *          of the targets, or `undefined` if no such attribute was found.
 */
export const findAttr = (possibleNames: (string | undefined)[], ...targets: any[]) => {
  const lowercaseNames = possibleNames.map(name => name?.toLowerCase());
  for (const target of targets) {
    if (target) {
      for (const possibleName of possibleNames) {
        // check for possibleNames as-is first to cover non-enumerable
        // properties
        if (possibleName && target[possibleName]) {
          return target[possibleName];
        }
      }
      for (const name of Object.keys(target)) {
        if (lowercaseNames.includes(name.toLowerCase()) && target[name]) {
          return target[name];
        }
      }
    }
  }
};

/**
 * Attempt to extract a server's suggested delay-time from an object containing a failed response's
 * headers on a best-effort basis.
 *
 * This generalized function is preferred over API-specific implementations because APIs are often
 * not actually consistent in their rate limit responses, despite what their documentation may claim
 * (often, APIs route your request through multiple services, some of which may not be correctly
 * configured to provide standardized responses).
 *
 * If this function doesn't work for a new API, you can simply modify it to account for the new
 * API's responses--take care not to affect the existing logic, though (place your new check toward
 * the end of the function so it is only executed after all of the existing checks fail).
 *
 * @param headers An object mapping the response's headers to their values. This may (or may not)
 *        include headers such as X-RateLimit-Remaining or Retry-After, which can be used to
 *        determine how long the next request should be delayed.
 * @returns The number of seconds the server suggests we wait before trying again, or `undefined` if
 *          a suggestion could not be determined from the headers.
 */
const extractDelayFromResponseHeaders = async (headers: object): Promise<number | undefined> => {
  try {
    const retryAfter = findAttr(['retry-after'], headers);
    if (retryAfter) {
      Logger.info(`Got value from Retry-After header. ${retryAfter}`);
      // Retry-After can be either seconds (numeric) or an HTTP-date (RFC 7231)
      const numericValue = Number(retryAfter);
      if (Number.isFinite(numericValue) && numericValue >= 0) {
        return numericValue;
      }
      const dateValue = Date.parse(retryAfter);
      if (!isNaN(dateValue)) {
        return Math.max(0, (dateValue - Date.now()) / 1000);
      }
    }
    const rateLimitRemaining = findAttr(['x-ratelimit-remaining', 'x-rate-limit-remaining'], headers);
    if (rateLimitRemaining !== '' && Number(rateLimitRemaining) <= 0) {
      const rateLimitReset = findAttr(['x-ratelimit-reset', 'x-rate-limit-reset', 'x-ratelimit-retryafter'], headers);
      if (rateLimitReset) {
        Logger.info(`Got value from X-RateLimit headers. ${rateLimitReset}`);
        return Math.max(0, (new Date(Number(rateLimitReset) * 1000).getTime() - Date.now()) / 1000);
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
  } catch (ignored) {
    return undefined;
  }
};

const COMMON_MAX_RETRIES = 5;
const DEFAULT_MAX_BACKOFF_DELAY = 64;
