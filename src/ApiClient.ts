import { createFetchOptions } from './agent';
import { getAsyncStore } from './asyncStore';
import { Logger } from './hyperproof-api';
import { extractHostname, httpActiveRequests, httpRequestDuration, httpRequestErrors } from './metrics';
import { safeMetric } from './util/safeMetric';
import { HttpMethod, LogContextKey } from './models';
import { IThrottleModel, ThrottleManager } from './util';

import AbortController from 'abort-controller';
import createHttpError, { HttpError } from 'http-errors';
import { StatusCodes } from 'http-status-codes';
import fetch, { HeadersInit, Response } from 'node-fetch';

/**
 * Type alias for the tuple of parameters taken by `ApiClient.sendRequest()`.
 *
 * @property url The target URL of the request.  Relative to the `baseUrl` if `baseUrl` is configured in the ApiClient.
 * @property method The HTTP method to use for the request.
 * @property body The request body.
 * @property additionalHeaders Additional headers to merge with the client's `commonHeaders` for the
 *           request.
 */
interface ApiClientRequestArgs {
  url: string;
  method: string;
  body?: object | string;
  additionalHeaders?: HeadersInit;
  abortController?: AbortController;
  isAbsoluteUrl?: boolean;
}

/**
 * Type alias for the set of response headers that are returned from a request.
 */
type ResponseHeaders = { [name: string]: string[] };

type ResponseWithApiUrl = { response: Response; apiUrl: string };

/**
 * Type alias for the return type of `ApiClient.sendRequest()`.
 */
export interface IApiClientResponse<T = any> {
  source: string;
  json: T;
  headers: ResponseHeaders;
  status: number;
}

export interface IErrorMessagePattern {
  name: string;
  messageMatch: RegExp;
  fromStatus?: string;
  toStatus: number;
}

/**
 * Generic client for sending requests to external APIs
 */
export class ApiClient {
  protected baseUrl?: string;
  protected headers: HeadersInit;
  private throttleManager: ThrottleManager<ApiClientRequestArgs, ResponseWithApiUrl>;

  /**
   * @param commonHeaders Headers to add to all API requests.
   * @param baseUrl The base URL off of which relative URLs provided to `sendRequest()` stem.
   * @param throttleManager If this is a retry of a previously-attempted sync, provide the result
   *        of a call to `ThrottleManager.toBare()` on the `ThrottleManager` used by the previous
   *        run here to track and limit the number of allowable retries. If this is the
   *        first attempt, it should be `undefined`. If too many retries have already been
   *        attempted, a descriptive error will be thrown. If this argument is omitted, management
   *        of the quantity of retries is left to the JobEngine and the suggested delay time
   *        after a retry will not necessarily grow exponentially.
   */
  constructor(commonHeaders: HeadersInit, baseUrl?: string, throttleModel?: IThrottleModel) {
    const store = getAsyncStore();
    if (store?.externalServiceHeaders) {
      this.headers = { ...commonHeaders, ...store.externalServiceHeaders };
    } else {
      this.headers = commonHeaders;
    }
    this.baseUrl = baseUrl;
    this.throttleManager = new ThrottleManager(params => this.buildApiUrlAndFetch({ ...params }), throttleModel);
  }

  public setRetryCount(retryCount: number) {
    this.throttleManager.setRetryCount(retryCount);
  }

  public setBaseUrl(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  public getBaseUrl() {
    return this.baseUrl;
  }

  public async getUnprocessedResponse(
    url: string,
    additionalHeaders?: HeadersInit,
    isAbsoluteUrl = false,
    abortController?: AbortController
  ): Promise<Response> {
    const { response } = await this.buildApiUrlAndFetch({
      url,
      method: HttpMethod.GET,
      body: undefined,
      additionalHeaders,
      abortController,
      isAbsoluteUrl
    });
    return response;
  }

  public async getJson(url: string, headers?: { [key: string]: string }, abortController?: AbortController) {
    return this.doSendRequest({
      url,
      method: HttpMethod.GET,
      body: undefined,
      additionalHeaders: headers,
      abortController
    });
  }

  public async postJson(
    url: string,
    body?: object | string,
    headers?: { [key: string]: string },
    abortController?: AbortController
  ) {
    return this.doSendRequest({
      url,
      method: HttpMethod.POST,
      body,
      additionalHeaders: headers,
      abortController
    });
  }

  public async patchJson(
    url: string,
    body?: object | string,
    headers?: { [key: string]: string },
    abortController?: AbortController
  ) {
    return this.doSendRequest({
      url,
      method: HttpMethod.PATCH,
      body,
      additionalHeaders: headers,
      abortController
    });
  }

  public async putJson(
    url: string,
    body?: object | string,
    headers?: { [key: string]: string },
    abortController?: AbortController
  ) {
    return this.doSendRequest({
      url,
      method: HttpMethod.PUT,
      body,
      additionalHeaders: headers,
      abortController
    });
  }

  /**
   * Maps error message patterns to appropriate HTTP status codes.
   * Each pattern is a regex that will be tested against the error message.
   *
   * A connector can override this method to provide error message patterns
   * that map to specific HTTP status codes that are specific to the
   * handling of that connector and/or its target API.
   *
   * This will require the connector to implement its own ApiClient that
   * extends this base ApiClient class, and pass via the data source constructor
   * the custom ApiClient class to be used.
   */
  public getErrorMessageStatusPatterns(): IErrorMessagePattern[] {
    return [
      {
        name: 'DNS Resolution Failure',
        messageMatch: /request to.*getaddrinfo ENOTFOUND.*/i,
        fromStatus: 'ENOTFOUND',
        toStatus: StatusCodes.BAD_GATEWAY
      }
      // Add more global patterns here as needed
    ];
  }

  protected async getStatusCodeFromErrorMessage(error?: any): Promise<number> {
    const status: string = error?.code?.toString() || error?.statusCode?.toString() || error?.status?.toString() || '';
    const message: string = error?.message || '';

    if (!status && !message) {
      return StatusCodes.INTERNAL_SERVER_ERROR;
    }

    const patterns = this.getErrorMessageStatusPatterns();

    for (const errorPattern of patterns) {
      if ((!errorPattern.fromStatus || errorPattern.fromStatus === status) && errorPattern.messageMatch.test(message)) {
        Logger.info(
          `Mapped error status ${status} to status ${errorPattern.toStatus} using pattern ${errorPattern.name}`
        );
        return errorPattern.toStatus;
      }
    }

    Logger.warn(
      `No matching error pattern found for error status: ${status}, message: ${message}`,
      typeof error === 'object' ? JSON.stringify(error) : undefined
    );

    return StatusCodes.INTERNAL_SERVER_ERROR;
  }

  protected async handleNetworkError(err: any): Promise<HttpError> {
    const errorMessage = err.message || 'Network error occurred';
    // If the error contains a statusCode, use it
    if (Object.values(StatusCodes).includes(err.status)) {
      return createHttpError(err.status, errorMessage, {
        ...err
      });
    }

    // Map known codes to statusCodes
    const status = await this.getStatusCodeFromErrorMessage(err);

    return createHttpError(status, errorMessage, {
      ...err
    });
  }

  protected async handleFailedResponse(response: Response, apiUrl: string, method: string) {
    const errMsg = await response.text();
    Logger.warn(`Error retrieving JSON from ${method}: ${apiUrl}: ${errMsg}`);
    throw createHttpError(
      response.status ?? StatusCodes.INTERNAL_SERVER_ERROR,
      `Error retrieving JSON from ${method}: ${apiUrl}: ${errMsg}`,
      {
        [LogContextKey.Headers]: response.headers.raw(),
        [LogContextKey.StatusCode]: response.status,
        [LogContextKey.ApiUrl]: apiUrl,
        [LogContextKey.ExtendedMessage]: errMsg
      }
    );
  }

  /**
   * On a successful response, where response.ok is true, this method will be called
   * to parse the body into a JSON object. Returns undefined when the body is empty.
   */
  protected async parseResponseBodyJson(response: Response, url: string): Promise<any | undefined> {
    if (response.status === StatusCodes.NO_CONTENT) {
      return;
    }
    let json: any | undefined;
    const text = await response.text();
    if (text.length === 0) {
      return;
    }
    try {
      json = JSON.parse(text);
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (e: any) {
      throw createHttpError(StatusCodes.INTERNAL_SERVER_ERROR, 'Failed to convert response body to JSON', {
        [LogContextKey.Headers]: response.headers.raw(),
        [LogContextKey.StatusCode]: response.status,
        [LogContextKey.ApiUrl]: url,
        [LogContextKey.ExtendedMessage]: `Response Body: ${text}`
      });
    }
    return json;
  }

  public sendRequest(params: ApiClientRequestArgs) {
    return this.doSendRequest(params);
  }

  private async doSendRequest({
    url,
    method,
    body,
    additionalHeaders,
    abortController
  }: ApiClientRequestArgs): Promise<IApiClientResponse> {
    // By default, throttleManager calls buildApiUrlAndFetch() to make the request.
    const { response, apiUrl } = await this.throttleManager.retrieve({
      url,
      method,
      body,
      additionalHeaders,
      abortController
    });

    const json = await this.parseResponseBodyJson(response, url);

    return {
      source: apiUrl,
      json,
      headers: response.headers.raw(),
      status: response.status
    };
  }

  private async buildApiUrlAndFetch({
    url,
    method,
    body,
    additionalHeaders,
    abortController,
    isAbsoluteUrl
  }: ApiClientRequestArgs): Promise<ResponseWithApiUrl> {
    const apiUrl = isAbsoluteUrl ? url : this.buildUrl(url);
    const headers = { ...this.headers, ...additionalHeaders };
    const headerNames = Object.keys(headers);

    Logger.info(`Making ${method} request to ${apiUrl}. Header names: ${headerNames}`);

    const integrationType = process.env.integration_type ?? 'unknown';
    const targetHost = extractHostname(apiUrl);

    safeMetric(() => httpActiveRequests.inc({ integration_type: integrationType, target_host: targetHost }));
    const end = safeMetric(() =>
      httpRequestDuration.startTimer({
        integration_type: integrationType,
        method,
        target_host: targetHost
      })
    );

    let response: Response;
    try {
      response = await fetch(
        apiUrl,
        createFetchOptions(apiUrl, {
          method,
          headers,
          body: typeof body === 'string' ? body : JSON.stringify(body),
          signal: abortController?.signal as AbortSignal | undefined
        })
      );
    } catch (err) {
      // Record metrics for network errors
      safeMetric(() => {
        end?.({ status: 'error' });
        const errorCode = err instanceof Error ? err.name : 'unknown';
        httpRequestErrors.inc({
          integration_type: integrationType,
          error_code: errorCode,
          target_host: targetHost
        });
      });
      // Complete failure to make the request
      throw await this.handleNetworkError(err);
    } finally {
      safeMetric(() => httpActiveRequests.dec({ integration_type: integrationType, target_host: targetHost }));
    }

    // Record successful response duration
    safeMetric(() => end?.({ status: String(response.status) }));

    if (!response.ok) {
      // Received a response with non-2xx statusCode
      await this.handleFailedResponse(response, apiUrl, method);
    }

    // Successful response
    Logger.info(`Response from ${method} ${apiUrl}: ${response.status}`);
    return { response, apiUrl };
  }

  private buildUrl(url: string): string {
    return this.baseUrl ? new URL(url, this.baseUrl).href : url;
  }
}
