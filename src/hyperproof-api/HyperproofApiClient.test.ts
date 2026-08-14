import { HyperproofApiClient } from './HyperproofApiClient';

import FormData from 'form-data';
import { StatusCodes } from 'http-status-codes';
import fetch from 'node-fetch';

import { IntegrationContext } from '../add-on-sdk';
import { ObjectType } from '../models';

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

      const client = await HyperproofApiClient.createInstance(integrationContext, 'org-id-uuid', 'user-id-uuid');
      const result = await client.fetchWithRetry({
        url: 'https://api.test.com/data',
        delaySeconds
      });

      expect(result).toEqual({ data: 'test' });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should retry on failure and eventually succeed', async () => {
      mockFetch
        .mockResolvedValueOnce(createErrorResponse(StatusCodes.INTERNAL_SERVER_ERROR))
        .mockResolvedValueOnce(createErrorResponse(StatusCodes.INTERNAL_SERVER_ERROR))
        .mockResolvedValueOnce(createSuccessResponse());

      const client = await HyperproofApiClient.createInstance(integrationContext, 'org-id-uuid', 'user-id-uuid');
      const result = await client.fetchWithRetry({
        url: 'https://api.test.com/data',
        delaySeconds: 0.1
      });

      expect(result).toEqual({ data: 'test' });
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('should throw an error after all attempts fail', async () => {
      mockFetch
        .mockResolvedValueOnce(createErrorResponse(StatusCodes.INTERNAL_SERVER_ERROR))
        .mockResolvedValueOnce(createErrorResponse(StatusCodes.INTERNAL_SERVER_ERROR));
      const numCalls = 2;

      const client = await HyperproofApiClient.createInstance(integrationContext, 'org-id-uuid', 'user-id-uuid');
      await expect(
        client.fetchWithRetry({
          url: 'https://api.test.com/data',
          delaySeconds,
          totalAttempts: numCalls
        })
      ).rejects.toThrow('Received 500 response from Hyperproof when attempting to GET /data: Error');

      expect(mockFetch).toHaveBeenCalledTimes(numCalls);
    });

    it('should not throw an error if onErrorResponse returns shouldThrow false', async () => {
      mockFetch.mockResolvedValueOnce(createErrorResponse(StatusCodes.INTERNAL_SERVER_ERROR));

      const client = await HyperproofApiClient.createInstance(integrationContext, 'org-id-uuid', 'user-id-uuid');
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

  describe('postProof filename/mimeType handling', () => {
    const originalApiUrl = process.env.hyperproof_api_url;
    beforeAll(() => {
      process.env.hyperproof_api_url = 'https://api.test.com';
    });
    afterAll(() => {
      process.env.hyperproof_api_url = originalApiUrl;
    });

    const postProofAndCapture = async (filename: string, mimeType: string) => {
      mockFetch.mockResolvedValue(new Response(JSON.stringify({ id: 'proof-1' }), { status: 200 }));
      const client = await HyperproofApiClient.createInstance(integrationContext, 'org-id-uuid', 'user-id-uuid');
      await client.postProof({
        file: Buffer.from('file-content'),
        filename,
        mimeType,
        sourceFileId: 'src-file-1',
        objectType: ObjectType.TASK,
        objectId: 'task-1'
      });
      const body = mockFetch.mock.calls[0][1]?.body as FormData;
      const multipart = body.getBuffer().toString();
      const match = multipart.match(
        /Content-Disposition: form-data; name="proof"; filename="([^"]+)"\r\nContent-Type: (\S+)/
      );
      if (!match) {
        throw new Error(`Could not parse multipart body:\n${multipart}`);
      }
      return { filename: match[1], contentType: match[2] };
    };

    // HYP-78345 regression cases: ServiceNow reports application/octet-stream for files whose
    // mime-package-registered type differs (or is unknown). Extension must survive the round-trip.
    it('preserves .ps1 extension when source reports application/octet-stream', async () => {
      const result = await postProofAndCapture('script.ps1', 'application/octet-stream');
      expect(result.filename).toBe('script.ps1');
      expect(result.contentType).toBe('application/octet-stream');
    });

    it('preserves .msg extension when source reports application/octet-stream', async () => {
      const result = await postProofAndCapture('email.msg', 'application/octet-stream');
      expect(result.filename).toBe('email.msg');
      expect(result.contentType).toBe('application/octet-stream');
    });

    it('preserves .md extension when source reports application/octet-stream', async () => {
      const result = await postProofAndCapture('notes.md', 'application/octet-stream');
      expect(result.filename).toBe('notes.md');
      expect(result.contentType).toBe('application/octet-stream');
    });

    // Baseline: existing special cases must continue to work. Jira-Cloud and Jira-Server rely on them.
    it('preserves .csv extension when source reports text/plain (HYP-17979)', async () => {
      const result = await postProofAndCapture('data.csv', 'text/plain');
      expect(result.filename).toBe('data.csv');
      expect(result.contentType).toBe('text/csv');
    });

    it('casts mimeType for .ldif when source reports application/octet-stream', async () => {
      const result = await postProofAndCapture('export.ldif', 'application/octet-stream');
      expect(result.filename).toBe('export.ldif');
      expect(result.contentType).toBe('binary/octet-stream');
    });

    // Baseline: ordinary matching MIME + extension passes through unchanged.
    it('passes through when MIME matches the extension', async () => {
      const result = await postProofAndCapture('photo.png', 'image/png');
      expect(result.filename).toBe('photo.png');
      expect(result.contentType).toBe('image/png');
    });

    // Task integrations deal with arbitrary customer files; we must trust the filename the
    // source system provides rather than rewriting the extension to match mime.getExtension().
    it('preserves filename when MIME disagrees with extension', async () => {
      const result = await postProofAndCapture('attachment.dat', 'image/png');
      expect(result.filename).toBe('attachment.dat');
      expect(result.contentType).toBe('image/png');
    });

    it('sanitizes slashes in filenames', async () => {
      const result = await postProofAndCapture('path/to/file.txt', 'text/plain');
      expect(result.filename).toBe('path to file.txt');
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

const createSuccessResponse = () => new Response(JSON.stringify({ data: 'test' }), { status: 200 });

const createErrorResponse = (status: number) => new Response('Error', { status });
