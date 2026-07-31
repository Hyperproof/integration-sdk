import { ensureHyperproofAccessToken } from './hyperproofTokens';
import { Logger } from './Logger';

import FormData from 'form-data';
import createHttpError from 'http-errors';
import { StatusCodes } from 'http-status-codes';
import mime from 'mime';
import fetch, { RequestInit } from 'node-fetch';
import { Response } from 'node-fetch';
import path from 'path';
import queryString from 'query-string';

import { debug, IntegrationContext } from '../add-on-sdk';
// Trusted internal calls to the Hyperproof platform: use the UNGUARDED agent (the platform host is system-configured
// and resolves internally, so the tenant-SSRF guard must not be applied here).
import { createInternalFetchOptions } from '../agent';
import {
  HttpHeader,
  HttpMethod,
  IArchiveProofLinkPost,
  ICommentBody,
  IExternalConnectionFilterSystem,
  IExternalConnectionPostSystem,
  IExternalUserRef,
  IIntegration,
  IIntegrationPostSystem,
  IIntegrationSettingsBase,
  IProof,
  IProofPost,
  IProofPostBase,
  IProofVersionPost,
  ITask,
  ITaskPatch,
  ITaskStatus,
  MimeType,
  ObjectType
} from '../models';
import { TraceParent } from '../TraceParent';

const BYTES_IN_KILOBYTE = 1024;
const BYTES_IN_MEGABYTE = BYTES_IN_KILOBYTE * BYTES_IN_KILOBYTE;
const MAX_FILE_SIZE = 100 * BYTES_IN_MEGABYTE;
const TXT_EXTENSION = 'txt';
const LDIF_EXTENSION = 'ldif';

const alternateMessages: { [key: number]: string } = {
  [StatusCodes.UNAUTHORIZED]: 'Your connection may have expired. Please re-authenticate your connection.',
  [StatusCodes.FORBIDDEN]: 'You do not have permission to access this object.',
  [StatusCodes.NOT_FOUND]: 'Referenced object is missing.'
};

const createErrorMessage = (status: number, method: string, url: string, message: string) => {
  const displayUrl = new URL(url).pathname;
  try {
    const json = JSON.parse(message);
    if (json.error) {
      message = json.error;
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
  } catch (ignore: any) {
    // just use the string if it's not valid json
  }
  const longMsg = `Received ${status} response from Hyperproof when attempting to ${method} ${displayUrl}: ${message}`;
  return alternateMessages[status] ? `${alternateMessages[status]} ${longMsg}` : longMsg;
};

interface IFetchWithRetryArgs {
  url: string;
  options?: RequestInit;
  totalAttempts?: number;
  delaySeconds?: number;
  onErrorResponse?: (response: Response, errorText: string) => { errorText?: string; shouldThrow?: boolean };
  onAnyFetchFailure?: (response: Response, errorText: string) => { errorText?: string; shouldBreak?: boolean };
}

/**
 * Client interface to the Hyperproof API.
 */
export class HyperproofApiClient {
  private static _subscriptionKey?: string = process.env.hyperproof_api_subscription_key;
  private accessToken: string;

  private constructor(accessToken: string) {
    this.accessToken = accessToken;
  }

  public static async sleep(seconds: number) {
    return new Promise(res => setTimeout(res, seconds * 1000));
  }

  /**
   * Fetch the given url with up to at most `totalAttempts` attempts in the case of failures
   * Return either the first successful response, or the last response if all responses fail
   */
  public async fetchWithRetry<T>({
    url,
    options = {},
    totalAttempts = 3,
    delaySeconds = 3,
    onErrorResponse,
    onAnyFetchFailure
  }: IFetchWithRetryArgs): Promise<T> {
    let attempt = 1;
    totalAttempts = Math.max(totalAttempts, 1);
    delaySeconds = Math.max(0, delaySeconds);

    const method = options?.method ?? HttpMethod.GET;
    let response: Response;
    let errorText: string = '';

    do {
      const attemptCounter = `Attempt ${attempt}/${totalAttempts}`;
      Logger.info(`HyperproofApiClient: Making ${method} request to ${url}. ${attemptCounter}`);
      response = await fetch(
        url,
        createInternalFetchOptions(url, {
          ...options,
          headers: {
            ...options?.headers,
            ...TraceParent.getHeaders(),
            [HttpHeader.Authorization]: `Bearer ${this.accessToken}`,
            [HttpHeader.SubscriptionKey]: HyperproofApiClient.subscriptionKey
          }
        } as any) // ignore typescript error caused by incompatible RequestInit type
      );
      if (response.ok) {
        break;
      }

      let shouldBreak = false;
      if (onAnyFetchFailure) {
        const { shouldBreak: newShouldBreak, errorText: newErrorText } = onAnyFetchFailure(response, errorText);
        shouldBreak = newShouldBreak ?? false;
        errorText = newErrorText ?? errorText;
      }
      if (shouldBreak) {
        break;
      }

      errorText = await response.text();
      Logger.warn(
        `HyperproofApiClient: Failed to make ${method} request to ${url}. Status code ${response.status}: ${errorText}. ${attemptCounter}`
      );
      await HyperproofApiClient.sleep(delaySeconds);
      attempt++;
    } while (attempt <= totalAttempts);

    Logger.info(`HyperproofApiClient: Received ${response.status} response from ${method} ${url}`);

    if (!response.ok) {
      const status = response.status ?? StatusCodes.INTERNAL_SERVER_ERROR;
      let shouldThrow = true;
      if (onErrorResponse) {
        const { shouldThrow: newShouldThrow, errorText: newErrorText } = onErrorResponse(response, errorText);
        shouldThrow = newShouldThrow ?? true;
        errorText = newErrorText ?? errorText;
      }
      if (shouldThrow) {
        throw createHttpError(status, createErrorMessage(status, method, url, errorText));
      } else {
        return undefined as T;
      }
    }

    return response.json();
  }

  public static setSubscriptionKey(subscriptionKey: string) {
    this._subscriptionKey = subscriptionKey;
  }

  private static get subscriptionKey(): string {
    if (!HyperproofApiClient._subscriptionKey) {
      throw new Error('Hyperproof API subscription key not set');
    }
    return HyperproofApiClient._subscriptionKey;
  }

  /**
   * Factory method that creates a new HyperproofApiClient instance.
   */

  public static async createInstance(integrationContext: IntegrationContext, orgId: string, userId: string) {
    // this is done to trigger the non null check in the getter method
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    HyperproofApiClient.subscriptionKey;

    Logger.debug(`Creating Hyperproof API client using URL ${process.env.hyperproof_api_url}`);

    const accessToken = await ensureHyperproofAccessToken(integrationContext, orgId, userId);

    return new HyperproofApiClient(accessToken);
  }

  public static async createInstanceByAccessToken(accessToken: string): Promise<HyperproofApiClient> {
    // this is done to trigger the non null check in the getter method
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    HyperproofApiClient.subscriptionKey;

    Logger.debug(`Creating Hyperproof API client using URL via accessToken ${process.env.hyperproof_api_url}`);

    return new HyperproofApiClient(accessToken);
  }

  /**
   * Retrieves an integration settings instance in Hyperproof.
   */
  public async getOrgIntegrationSettings(integrationId: string) {
    return this.getIntegrationSettings(integrationId);
  }

  public async getIntegrationSettings<TIntegration extends IIntegrationSettingsBase>(
    integrationId: string,
    objectType?: ObjectType,
    objectId?: string,
    forSynchronization?: boolean
  ): Promise<IIntegration<TIntegration>> {
    const query = queryString.stringify({ forSynchronization });
    let url = `${process.env.hyperproof_api_url}/beta`;
    if (objectType && objectId) {
      url += `/${objectType}s/${objectId}`;
    }
    url += `/integrations/${integrationId}?${query}`;

    return this.fetchWithRetry<IIntegration<TIntegration>>({
      url,
      onErrorResponse: (response, errorText) =>
        response.status === StatusCodes.CONFLICT ? { errorText: 'Operation is already in process' } : { errorText }
    });
  }

  /**
   * Updates an integration settings instance from Hyperproof.
   */
  public async updateIntegrationSettings<TIntegrationSettings extends IIntegrationSettingsBase>(
    objectType: ObjectType,
    objectId: string,
    integrationId: string,
    settings: TIntegrationSettings,
    suffix?: string
  ) {
    let url = `${process.env.hyperproof_api_url}/beta`;
    if (objectType && objectId) {
      url += `/${objectType}s/${objectId}`;
    }
    url += `/integrations/${integrationId}`;
    if (suffix) {
      url += `/${suffix}`;
    }
    return this.fetchWithRetry({
      url,
      options: {
        method: HttpMethod.PATCH,
        body: JSON.stringify(settings),
        headers: {
          [HttpHeader.ContentType]: MimeType.APPLICATION_JSON
        }
      }
    });
  }

  /**
   * Creates an integration settings instance from Hyperproof.
   */
  public async createIntegrationSettings(
    settings: IIntegrationSettingsBase,
    objectType?: ObjectType,
    objectId?: string
  ) {
    let url = `${process.env.hyperproof_api_url}/beta`;
    if (objectType && objectId) {
      url += `/${objectType}s/${objectId}`;
    }
    url += `/integrations`;
    return this.fetchWithRetry({
      url,
      options: {
        method: HttpMethod.POST,
        body: JSON.stringify(settings),
        headers: {
          [HttpHeader.ContentType]: MimeType.APPLICATION_JSON
        }
      }
    });
  }

  /**
   * Posts a proof file to a Hyperproof organization or object.
   */
  public async postProof(post: IProofPost) {
    const formData = this.buildProofFormData(post);
    return this.postNewProof(post.objectType, post.objectId, formData);
  }

  public async postProofVersion(post: IProofVersionPost) {
    const formData = this.buildProofFormData(post);
    const url = `${process.env.hyperproof_api_url}/beta/proof/${post.proofId}/versions`;
    return this.fetchWithRetry({
      url,
      options: {
        method: HttpMethod.POST,
        body: formData,
        headers: {}
      }
    });
  }

  /**
   * Retrieves the task statuses for Hyperproof org.
   */
  public async getTaskStatuses(): Promise<ITaskStatus[]> {
    const url = `${process.env.hyperproof_api_url}/v1/taskstatuses`;
    return this.fetchWithRetry({
      url,
      options: {
        method: HttpMethod.GET,
        headers: {
          [HttpHeader.ContentType]: MimeType.APPLICATION_JSON
        }
      }
    });
  }

  /**
   * Updates a hyperproof task
   *
   * @param objectId Unique ID of the task.
   * @param patch Updates to patch task with
   */
  public async patchTask(objectId: string, patch: ITaskPatch) {
    const url = `${process.env.hyperproof_api_url}/v1/tasks/${objectId}`;
    if (patch.externalUser && !patch.externalUser.id) {
      delete patch.externalUser;
    }
    return this.fetchWithRetry({
      url,
      options: {
        method: HttpMethod.PATCH,
        body: JSON.stringify(patch),
        headers: {
          [HttpHeader.ContentType]: MimeType.APPLICATION_JSON
        }
      }
    });
  }

  /**
   * Retrieves a hyperproof task
   *
   * @param objectId Unique ID of the task.
   */
  public async getTask(objectId: string): Promise<ITask> {
    const url = `${process.env.hyperproof_api_url}/v1/tasks/${objectId}`;
    return this.fetchWithRetry<ITask>({
      url,
      options: {
        method: HttpMethod.GET,
        headers: {
          [HttpHeader.ContentType]: MimeType.APPLICATION_JSON
        }
      }
    });
  }

  /**
   * Gets metadata of task proof
   *
   * @param objectId Unique ID of the task this proof is associated with.
   * @param sourceFileId Unique ID of the proof in the external system.  Optional.
   */
  public async getTaskProofMeta(objectId: string, sourceFileId?: string) {
    const query = queryString.stringify({ sourceFileId });
    const url = `${process.env.hyperproof_api_url}/v1/tasks/${objectId}/proof?${query}`;
    return this.fetchWithRetry({
      url,
      options: {
        method: HttpMethod.GET,
        headers: {
          [HttpHeader.ContentType]: MimeType.APPLICATION_JSON
        }
      }
    });
  }

  /**
   * Unlinks proof linked to a task based on a sourceFileId
   *
   * @param objectId Unique ID of the task this proof is associated with.
   * @param sourceFileId Unique ID of the proof in the external system
   * @param user External user who performed the unlink.
   */
  public async archiveTaskProofLink(objectId: string, sourceFileId: string, user: IExternalUserRef) {
    const proofMeta = await this.getTaskProofMeta(objectId, sourceFileId);
    const results = [];
    for (const proof of proofMeta as any) {
      const url = `${process.env.hyperproof_api_url}/beta/proof/${proof.id}/links/${objectId}/archive?objectType=task`;
      const json = await this.fetchWithRetry<object | undefined>({
        url,
        options: {
          method: HttpMethod.POST,
          body: JSON.stringify(user),
          headers: {
            [HttpHeader.ContentType]: MimeType.APPLICATION_JSON
          }
        },
        onErrorResponse: response => (response.status === StatusCodes.NOT_FOUND ? { shouldThrow: false } : {})
      });

      results.push(json);
    }
    return results;
  }

  public async archiveProofLink({ proofId, objectId, objectType, externalUser }: IArchiveProofLinkPost) {
    const url = `${process.env.hyperproof_api_url}/beta/proof/${proofId}/links/${objectId}/archive?objectType=${objectType}`;
    await this.fetchWithRetry({
      url,
      options: {
        method: HttpMethod.POST,
        body: JSON.stringify(externalUser),
        headers: {
          [HttpHeader.ContentType]: MimeType.APPLICATION_JSON
        }
      }
    });
  }

  /**
   * Gets the comments in an object's activity feed
   *
   * @param objectType Type of the object
   * @param objectId Unique ID of the object
   */
  public async getComments(objectType: ObjectType, objectId: string) {
    const versionPath = objectType === ObjectType.TASK ? 'v1' : 'beta';
    const url = `${process.env.hyperproof_api_url}/${versionPath}/${objectType}s/${objectId}/comments`;
    return this.fetchWithRetry({
      url
    });
  }

  /**
   * Posts a comment to the target object's activity feed
   *
   * @param commentBody - Contains information about the comment to be posted.
   * @param objectType Type of the object
   * @param objectId Unique ID of the object
   * @param parentObjectType Optional - Type of the parent object
   * @param parentObjectId Optional - Unique ID of the parent object
   */
  public async postComment(
    commentBody: ICommentBody,
    objectType: ObjectType,
    objectId: string,
    parentObjectType?: ObjectType,
    parentObjectId?: string
  ) {
    return this.sendCommentRequest(
      commentBody,
      HttpMethod.POST,
      objectType,
      objectId,
      parentObjectType,
      parentObjectId
    );
  }

  /**
   * Patches a comment to the target object's activity feed based on id of activity in hyperproof or sourceCommentId from external source
   *
   * @param commentBody - contains appId, commentTextFormatted, externalUser (author), mentionedExternalUsers, sourceCommentId, sourceUpdatedOn
   * @param objectType Type of the object
   * @param objectId Unique ID of the object
   * @param commentId - If patch is of a specific comment (to add a sourceId after syncing)
   */
  public async patchComment(commentBody: ICommentBody, objectType: ObjectType, objectId: string, commentId?: string) {
    return this.sendCommentRequest(
      commentBody,
      HttpMethod.PATCH,
      objectType,
      objectId,
      undefined, // parentObjectType not used
      undefined, // parentObjectId not used
      commentId
    );
  }

  /**
   * Gets user object for current user
   *
   */
  public async getMe() {
    const url = `${process.env.hyperproof_api_url}/v1/users/me`;
    return this.fetchWithRetry({
      url,
      options: {
        method: HttpMethod.GET,
        headers: {
          [HttpHeader.ContentType]: MimeType.APPLICATION_JSON
        }
      }
    });
  }

  private async postNewProof(objectType: ObjectType, objectId: string, formData: FormData): Promise<IProof> {
    let url = `${process.env.hyperproof_api_url}/v1`;
    if (objectType !== ObjectType.ORGANIZATION) {
      url += `/${objectType}s/${objectId}/proof`;
    } else {
      url += `/proof`;
    }
    return this.fetchWithRetry<IProof>({
      url,
      options: {
        method: HttpMethod.POST,
        body: formData,
        headers: {}
      }
    });
  }

  /**
   * Updates or creates a comment in the target object's activity feed
   *
   * @param commentBody - contains appId, commentTextFormatted, externalUser (author), mentionedExternalUsers, sourceCommentId, sourceUpdatedOn
   * @param method - POST or PATCH
   * @param objectType Type of the object
   * @param objectId Unique ID of the object
   * @param parentObjectType Optional - Type of the parent object
   * @param parentObjectId Optional - Unique ID of the parent object
   * @param commentId Optional - Unique id of comment in source system (i.e. in hyperproof or in jira)
   */
  public async sendCommentRequest(
    commentBody: ICommentBody,
    method: HttpMethod,
    objectType: ObjectType,
    objectId: string,
    parentObjectType?: ObjectType,
    parentObjectId?: string,
    commentId?: string,
    sourceCommentId?: string
  ) {
    const parentPrefix = parentObjectType && parentObjectId ? `${parentObjectType}s/${parentObjectId}/` : '';
    const versionPath = objectType === ObjectType.TASK ? 'v1' : 'beta';
    let url = `${process.env.hyperproof_api_url}/${versionPath}/${parentPrefix}${objectType}s/${objectId}/comments`;
    if (commentId) {
      url += `/${commentId}`;
    }
    const query = queryString.stringify({ sourceCommentId });
    url += `?${query}`;
    return this.fetchWithRetry({
      url,
      options: {
        method,
        body: JSON.stringify({
          ...commentBody,
          objectType,
          objectId
        }),
        headers: {
          [HttpHeader.ContentType]: MimeType.APPLICATION_JSON
        }
      }
    });
  }

  public async getNotificationIntegrationTokenLocation(orgId: string, objectType: ObjectType, objectId: string) {
    const url = `${process.env.hyperproof_api_url}/beta/integrations/tokenlocation`;
    const requestBody = {
      orgId: orgId,
      objectTypePlural: `${objectType}s`,
      objectId: objectId
    };
    return this.fetchWithRetry({
      url,
      options: {
        method: HttpMethod.POST,
        body: JSON.stringify(requestBody),
        headers: {
          [HttpHeader.ContentType]: MimeType.APPLICATION_JSON
        }
      },
      onErrorResponse: response => (response.status === StatusCodes.NOT_FOUND ? { shouldThrow: false } : {}),
      onAnyFetchFailure: response => (response.status === StatusCodes.NOT_FOUND ? { shouldBreak: true } : {})
    });
  }

  public async putIntegrationUpsert(integrationPost: IIntegrationPostSystem) {
    const url = `${process.env.hyperproof_api_url}/beta/integrations/notifications/system`;
    return this.fetchWithRetry({
      url,
      options: {
        method: HttpMethod.PUT,
        body: JSON.stringify(integrationPost),
        headers: {
          [HttpHeader.ContentType]: MimeType.APPLICATION_JSON
        }
      }
    });
  }

  public async createExternalConnection(externalConnectionPost: IExternalConnectionPostSystem) {
    const url = `${process.env.hyperproof_api_url}/beta/externalconnections/system`;
    return this.fetchWithRetry({
      url,
      options: {
        method: HttpMethod.POST,
        body: JSON.stringify(externalConnectionPost),
        headers: {
          [HttpHeader.ContentType]: MimeType.APPLICATION_JSON
        }
      }
    });
  }

  public async deleteExternalConnection(externalConnectionFilter: IExternalConnectionFilterSystem) {
    const url = `${process.env.hyperproof_api_url}/beta/externalconnections/system`;
    return this.fetchWithRetry({
      url,
      options: {
        method: HttpMethod.DELETE,
        body: JSON.stringify(externalConnectionFilter),
        headers: {
          [HttpHeader.ContentType]: MimeType.APPLICATION_JSON
        }
      }
    });
  }

  private formatFilename(filename: string, mimeType: string) {
    const { ext: existingExtension } = path.parse(filename);
    const mimeForExistingExtension = existingExtension && mime.getType(existingExtension);

    if (mimeForExistingExtension !== mimeType) {
      if (mimeForExistingExtension === MimeType.CSV_MIME && mime.getExtension(mimeType) === TXT_EXTENSION) {
        // we special case csv, jira sometimes gives us the wrong mime type (text/plain)
        // even though the extension is csv. If the file extension is csv it's okay to ignore
        // this check and just process as a csv. See: HYP-17979 for more context
        mimeType = mimeForExistingExtension;
      } else if (
        mimeType === MimeType.OCTET_MIME_APP &&
        existingExtension === `.${LDIF_EXTENSION}` // append the . before the extension based on how it is split
      ) {
        // Another special case from Jira Server.  We get back a (application/octet-stream) mime type
        // back when requesting a ldif file. In the case of jira cloud, we get (binary/octet-stream)
        // so we will cast to match Jira Cloud
        mimeType = MimeType.OCTET_MIME_BINARY;
      }
    }

    // Escaping other special characters is not necessary since the export will sanitize
    // the filename
    return { filename: filename.replace(/\//g, ' '), mimeType };
  }

  private buildProofFormData(post: IProofPostBase) {
    if (post.size && Number(post.size) >= MAX_FILE_SIZE) {
      const err = new Error(`Proof from source ${post.sourceId} is larger than max file size.`);
      debug(err.message);
      throw err;
    }

    // Reformat the filename and mimeType if necessary
    const { filename, mimeType } = this.formatFilename(post.filename, post.mimeType);

    const formData = new FormData();
    formData.append('proof', post.file, { filename, contentType: mimeType });
    if (post.sourceId) {
      formData.append('hp-proof-source-id', post.sourceId);
    }
    if (post.sourceFileId) {
      formData.append('hp-proof-source-file-id', post.sourceFileId);
    }
    if (post.sourceModifiedOn) {
      formData.append('hp-proof-source-modified-on', post.sourceModifiedOn);
    }
    if (post.sourceIntegrationId) {
      formData.append('hp-proof-integration-id', post.sourceIntegrationId);
    }
    if (post.user) {
      const user = post.user;
      if (user.id) {
        formData.append('hp-proof-ext-user-id', user.id);
      }
      if (user.givenName) {
        formData.append('hp-proof-ext-user-given-name', user.givenName);
      }
      if (user.surname) {
        formData.append('hp-proof-ext-user-surname', user.surname);
      }
      if (user.email) {
        formData.append('hp-proof-ext-user-email', user.email);
      }
      if (user.resource) {
        formData.append('hp-proof-ext-user-resource', user.resource);
      }
    }

    return formData;
  }
}

export const createHyperproofApiClient = async (
  integrationContext: IntegrationContext,
  orgId: string,
  userId: string
) => {
  return HyperproofApiClient.createInstance(integrationContext, orgId, userId);
};

export const createHyperproofApiClientByAccessToken = async (accessToken: string): Promise<HyperproofApiClient> => {
  return HyperproofApiClient.createInstanceByAccessToken(accessToken);
};
