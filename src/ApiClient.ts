import { getAsyncStore } from './asyncStore';
import { Logger } from './hyperproof-api';
import { HttpMethod, LogContextKey } from './models';
import { IThrottleModel, ThrottleManager } from './util';

import AbortController from 'abort-controller';
import createHttpError from 'http-errors';
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
type ApiClientRequestArgs = [
  url: string,
  method: string,
  body?: object | string,
  additionalHeaders?: HeadersInit,
  abortController?: AbortController
];

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

/**
 * Generic client for sending requests to external APIs
 */
export class ApiClient {
  protected baseUrl?: string;
  protected headers: HeadersInit;
  private throttleManager: ThrottleManager<
    ApiClientRequestArgs,
    ResponseWithApiUrl
  >;

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
  constructor(
    commonHeaders: HeadersInit,
    baseUrl?: string,
    throttleModel?: IThrottleModel
  ) {
    const store = getAsyncStore();
    if (store?.externalServiceHeaders) {
      this.headers = { ...commonHeaders, ...store.externalServiceHeaders };
    } else {
      this.headers = commonHeaders;
    }
    this.baseUrl = baseUrl;
    this.throttleManager = new ThrottleManager(
      params => this.buildApiUrlAndFetch(...params),
      throttleModel
    );
  }

  public setRetryCount(retryCount: number) {
    this.throttleManager.setRetryCount(retryCount);
  }

  public async getNonProcessedResponse(
    url: string,
    additionalHeaders?: HeadersInit,
    abortController?: AbortController
  ): Promise<Response> {
    const { response } = await this.throttleManager.retrieve([
      url,
      HttpMethod.GET,
      undefined,
      { ...this.headers, ...additionalHeaders },
      abortController
    ]);

    return response;
  }

  public async getJson(
    url: string,
    headers?: { [key: string]: string },
    abortController?: AbortController
  ) {
    return this.doSendRequest(
      url,
      HttpMethod.GET,
      undefined,
      headers,
      abortController
    );
  }

  public async postJson(
    url: string,
    body?: object | string,
    headers?: { [key: string]: string },
    abortController?: AbortController
  ) {
    return this.doSendRequest(
      url,
      HttpMethod.POST,
      body,
      headers,
      abortController
    );
  }

  public async patchJson(
    url: string,
    body?: object | string,
    headers?: { [key: string]: string },
    abortController?: AbortController
  ) {
    return this.doSendRequest(
      url,
      HttpMethod.PATCH,
      body,
      headers,
      abortController
    );
  }

  protected async handleFailedResponse(response: Response, apiUrl: string) {
    const errMsg = await response.text();
    throw createHttpError(
      response.status,
      `Error retrieving JSON from ${apiUrl}: ${errMsg}`,
      {
        [LogContextKey.Headers]: response.headers.raw(),
        [LogContextKey.StatusCode]: response.status,
        [LogContextKey.ApiUrl]: apiUrl,
        [LogContextKey.ExtendedMessage]: errMsg
      }
    );
  }

  protected async parseResponseBodyJson(
    response: Response,
    url: string
  ): Promise<string | undefined> {
    let json: string | undefined;
    const text = await response.text();
    if (text.length === 0) {
      return;
    }
    try {
      json = JSON.parse(text);
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (e: any) {
      throw createHttpError(
        StatusCodes.INTERNAL_SERVER_ERROR,
        'Failed to convert response body to JSON',
        {
          [LogContextKey.Headers]: response.headers.raw(),
          [LogContextKey.StatusCode]: response.status,
          [LogContextKey.ApiUrl]: url,
          [LogContextKey.ExtendedMessage]: `Response Body: ${text}`
        }
      );
    }
    return json;
  }

  public sendRequest(...params: ApiClientRequestArgs) {
    return this.doSendRequest(...params);
  }

  private async doSendRequest(
    ...[
      url,
      method,
      body,
      additionalHeaders,
      abortController
    ]: ApiClientRequestArgs
  ): Promise<IApiClientResponse> {
    // By default, throttleManager calls buildApiUrlAndFetch() to make the request.
    const { response, apiUrl } = await this.throttleManager.retrieve([
      url,
      method,
      body,
      additionalHeaders,
      abortController
    ]);

    const json = await this.parseResponseBodyJson(response, url);

    return {
      source: apiUrl,
      json,
      headers: response.headers.raw(),
      status: response.status
    };
  }

  private async buildApiUrlAndFetch(
    ...[
      url,
      method,
      body,
      additionalHeaders,
      abortController
    ]: ApiClientRequestArgs
  ): Promise<ResponseWithApiUrl> {
    const apiUrl = this.buildUrl(url);
    const headers = { ...this.headers, ...additionalHeaders };
    const headerNames = Object.keys(headers);
    await Logger.info(
      `Making ${method} request to ${apiUrl}. Header names: ${headerNames}`
    );
    const response = await fetch(apiUrl, {
      method,
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
      signal: abortController?.signal as AbortSignal | undefined
    });
    if (!response.ok) {
      await this.handleFailedResponse(response, apiUrl);
    }

    await Logger.info(`${url} returned ${response.status}`);

    return { response, apiUrl };
  }

  private buildUrl(url: string): string {
    return this.baseUrl ? new URL(url, this.baseUrl).href : url;
  }
}
