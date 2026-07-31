// Import node-fetch module to spy on it
import * as nodeFetch from 'node-fetch';
import { ApiClient } from './ApiClient';
import { HttpMethod } from './models';

/* eslint-disable max-lines-per-function */
import { StatusCodes } from 'http-status-codes';
// Import after mock
import { Response } from 'node-fetch';

jest.mock('./hyperproof-api/Logger');

// Mock only the default export (fetch function)
const mockFetch = jest.spyOn(nodeFetch, 'default') as jest.MockedFunction<typeof nodeFetch.default>;

class TestApiClient extends ApiClient {
  // Expose protected methods for testing
  public async testParseResponseBodyJson(response: Response, url: string) {
    return this.parseResponseBodyJson(response, url);
  }

  public async testGetStatusCodeFromErrorMessage(error?: any) {
    return this.getStatusCodeFromErrorMessage(error);
  }

  public async testHandleNetworkError(err: any) {
    return this.handleNetworkError(err);
  }

  public async testHandleFailedResponse(response: Response, apiUrl: string, method: string) {
    return this.handleFailedResponse(response, apiUrl, method);
  }

  public async testBuildApiUrlAndFetch(params: any) {
    return (this as any).buildApiUrlAndFetch(params);
  }
}

describe('ApiClient', () => {
  let client: TestApiClient;

  beforeEach(() => {
    client = new TestApiClient({});
  });

  describe('parseResponseBodyJson', () => {
    it('should return JSON when response has valid JSON content', async () => {
      const response = new Response(JSON.stringify({ key: 'value' }), {
        status: StatusCodes.OK
      });

      const result = await client.testParseResponseBodyJson(response, 'http://example.com');
      expect(result).toEqual({ key: 'value' });
    });

    it('should return undefined when response is NO_CONTENT', async () => {
      const response = new Response(undefined, {
        status: StatusCodes.NO_CONTENT
      });

      const result = await client.testParseResponseBodyJson(response, 'http://example.com');
      expect(result).toBeUndefined();
    });

    it('should return undefined when response body is empty', async () => {
      const response = new Response('', {
        status: StatusCodes.OK
      });

      const result = await client.testParseResponseBodyJson(response, 'http://example.com');
      expect(result).toBeUndefined();
    });

    it('should throw error when response content is not valid JSON', async () => {
      const response = new Response('Not JSON content', {
        status: StatusCodes.OK
      });

      await expect(client.testParseResponseBodyJson(response, 'http://example.com')).rejects.toMatchObject({
        status: StatusCodes.INTERNAL_SERVER_ERROR,
        message: 'Failed to convert response body to JSON'
      });
    });
  });

  describe('getStatusCodeFromErrorMessage', () => {
    it('should return INTERNAL_SERVER_ERROR when error is undefined', async () => {
      const result = await client.testGetStatusCodeFromErrorMessage(undefined);
      expect(result).toBe(StatusCodes.INTERNAL_SERVER_ERROR);
    });

    it('should return INTERNAL_SERVER_ERROR when error has no code or message', async () => {
      const result = await client.testGetStatusCodeFromErrorMessage({});
      expect(result).toBe(StatusCodes.INTERNAL_SERVER_ERROR);
    });

    it('should map ENOTFOUND error to BAD_GATEWAY', async () => {
      const error = {
        code: 'ENOTFOUND',
        message: 'request to https://example.com failed, getaddrinfo ENOTFOUND'
      };

      const result = await client.testGetStatusCodeFromErrorMessage(error);
      expect(result).toBe(StatusCodes.BAD_GATEWAY);
    });

    it('should return INTERNAL_SERVER_ERROR when no pattern matches', async () => {
      const error = {
        code: 'UNKNOWN_ERROR',
        message: 'Some unknown error occurred'
      };

      const result = await client.testGetStatusCodeFromErrorMessage(error);
      expect(result).toBe(StatusCodes.INTERNAL_SERVER_ERROR);
    });
  });

  describe('handleNetworkError', () => {
    it('should preserve status code when error has valid status', async () => {
      const error = {
        status: StatusCodes.SERVICE_UNAVAILABLE,
        message: 'Service unavailable'
      };

      const result = await client.testHandleNetworkError(error);
      expect(result.status).toBe(StatusCodes.SERVICE_UNAVAILABLE);
      expect(result.message).toBe('Service unavailable');
    });

    it('should map ENOTFOUND to BAD_GATEWAY', async () => {
      const error = {
        code: 'ENOTFOUND',
        message: 'request to https://api.example.com failed, getaddrinfo ENOTFOUND'
      };

      const result = await client.testHandleNetworkError(error);
      expect(result.status).toBe(StatusCodes.BAD_GATEWAY);
    });
  });

  describe('handleFailedResponse', () => {
    it('should throw HttpError with response details', async () => {
      const response = new Response('Bad request error', {
        status: StatusCodes.BAD_REQUEST
      });

      await expect(client.testHandleFailedResponse(response, 'http://example.com/api', 'GET')).rejects.toMatchObject({
        status: StatusCodes.BAD_REQUEST
      });
    });
  });

  describe('setBaseUrl', () => {
    it('should update base URL', () => {
      client.setBaseUrl('https://api.newdomain.com');
      // No error should be thrown
      expect(client).toBeDefined();
    });
  });

  describe('buildApiUrlAndFetch', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should call handleNetworkError when fetch throws an error', async () => {
      const networkError = new Error('Network failure');
      mockFetch.mockRejectedValue(networkError);

      const handleNetworkErrorSpy = jest.spyOn(client as any, 'handleNetworkError');

      await expect(
        client.testBuildApiUrlAndFetch({
          url: 'https://example.com/api',
          method: HttpMethod.GET
        })
      ).rejects.toMatchObject({
        status: StatusCodes.INTERNAL_SERVER_ERROR
      });

      expect(handleNetworkErrorSpy).toHaveBeenCalledWith(networkError);
    });

    it('should call handleFailedResponse when response is not ok', async () => {
      const failedResponse = new Response('Bad request', {
        status: StatusCodes.BAD_REQUEST
      });
      mockFetch.mockResolvedValue(failedResponse);

      const handleFailedResponseSpy = jest.spyOn(client as any, 'handleFailedResponse');

      await expect(
        client.testBuildApiUrlAndFetch({
          url: 'https://example.com/api',
          method: HttpMethod.GET
        })
      ).rejects.toMatchObject({
        status: StatusCodes.BAD_REQUEST
      });

      expect(handleFailedResponseSpy).toHaveBeenCalledWith(failedResponse, 'https://example.com/api', 'GET');
    });
  });
});
