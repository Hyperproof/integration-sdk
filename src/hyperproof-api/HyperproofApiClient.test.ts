import { HyperproofApiClient } from './HyperproofApiClient';

import { StatusCodes } from 'http-status-codes';
import fetch from 'node-fetch';

import { IntegrationContext } from '../add-on-sdk';

jest.mock('node-fetch');
jest.mock('./Logger');

const { Response } = jest.requireActual('node-fetch');
const delaySeconds = 0.1;

describe('HyperproofApiClient', () => {
  const mockFetch = fetch as jest.MockedFunction<typeof fetch>;

  beforeAll(() => {
    HyperproofApiClient.setSubscriptionKey('subscription-key');
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('fetchWithRetry', () => {
    it('should return response JSON on success', async () => {
      mockFetch.mockResolvedValue(createSuccessResponse());

      const client = await HyperproofApiClient.createInstance(
        integrationContext,
        'org-id-uuid',
        'user-id-uuid'
      );
      const result = await client.fetchWithRetry({
        url: 'https://api.test.com/data',
        delaySeconds
      });

      expect(result).toEqual({ data: 'test' });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should retry on failure and eventually succeed', async () => {
      mockFetch
        .mockResolvedValueOnce(
          createErrorResponse(StatusCodes.INTERNAL_SERVER_ERROR)
        )
        .mockResolvedValueOnce(
          createErrorResponse(StatusCodes.INTERNAL_SERVER_ERROR)
        )
        .mockResolvedValueOnce(createSuccessResponse());

      const client = await HyperproofApiClient.createInstance(
        integrationContext,
        'org-id-uuid',
        'user-id-uuid'
      );
      const result = await client.fetchWithRetry({
        url: 'https://api.test.com/data',
        delaySeconds: 0.1
      });

      expect(result).toEqual({ data: 'test' });
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('should throw an error after all attempts fail', async () => {
      mockFetch
        .mockResolvedValueOnce(
          createErrorResponse(StatusCodes.INTERNAL_SERVER_ERROR)
        )
        .mockResolvedValueOnce(
          createErrorResponse(StatusCodes.INTERNAL_SERVER_ERROR)
        );
      const numCalls = 2;

      const client = await HyperproofApiClient.createInstance(
        integrationContext,
        'org-id-uuid',
        'user-id-uuid'
      );
      await expect(
        client.fetchWithRetry({
          url: 'https://api.test.com/data',
          delaySeconds,
          totalAttempts: numCalls
        })
      ).rejects.toThrow(
        'Received 500 response from Hyperproof when attempting to GET /data: Error'
      );

      expect(mockFetch).toHaveBeenCalledTimes(numCalls);
    });

    it('should not throw an error if onErrorResponse returns shouldThrow false', async () => {
      mockFetch.mockResolvedValueOnce(
        createErrorResponse(StatusCodes.INTERNAL_SERVER_ERROR)
      );

      const client = await HyperproofApiClient.createInstance(
        integrationContext,
        'org-id-uuid',
        'user-id-uuid'
      );
      const result = await client.fetchWithRetry({
        url: 'https://api.test.com/data',
        delaySeconds,
        totalAttempts: 1,
        onErrorResponse: () => ({ shouldThrow: false })
      });

      expect(result).toBeUndefined();
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });
});

const hyperproofTokenEntry = {
  hyperproofToken: {
    access_token: 'access-token'
  }
};

const integrationContext: IntegrationContext = {
  storage: {
    get: jest.fn(async () => ({
      data: hyperproofTokenEntry,
      etag: 'etag',
      tags: [],
      expires: ''
    })),
    put: jest.fn(),
    delete: jest.fn(),
    list: jest.fn()
  },
  accountId: '',
  subscriptionId: '',
  boundaryId: '',
  functionId: '',
  configuration: {},
  method: 'GET',
  query: {},
  headers: {},
  fusebit: {
    endpoint: '',
    functionAccessToken: ''
  },
  caller: {
    permissions: {
      allow: []
    }
  }
};

const createSuccessResponse = () =>
  new Response(JSON.stringify({ data: 'test' }), { status: 200 });

const createErrorResponse = (status: number) =>
  new Response('Error', { status });
