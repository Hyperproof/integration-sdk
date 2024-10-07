import { ensureHyperproofAccessToken } from './hyperproofTokens';
import { Logger } from './Logger';

import FormData from 'form-data';
import createHttpError from 'http-errors';
import { StatusCodes } from 'http-status-codes';
import mime from 'mime';
import fetch, { RequestInit } from 'node-fetch';
import path from 'path';
import queryString from 'query-string';

import { debug, IntegrationContext } from '../add-on-sdk';
import {
  HttpHeader,
  HttpMethod,
  ICommentBody,
  IExternalUser,
  IIntegration,
  IIntegrationSettingsBase,
  ITask,
  ITaskPatch,
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
  [StatusCodes.UNAUTHORIZED]:
    'Your connection may have expired. Please re-authenticate your connection.',
  [StatusCodes.FORBIDDEN]: 'You do not have permission to access this object.',
  [StatusCodes.NOT_FOUND]: 'Referenced object is missing.'
};

const createAndLogErrorMessage = (
  status: number,
  method: string,
  url: string,
  message: string,
  objectType?: ObjectType
) => {
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
  const longMsg = `Received ${status} response from Hyperproof when attempting to ${method} ${displayUrl}${
    objectType ? ' ' + objectType : ''
  }: ${message}`;
  debug(longMsg);
  return alternateMessages[status]
    ? `${alternateMessages[status]} ${longMsg}`
    : longMsg;
};

/**
 * Client interface to the Hyperproof API.
 */
export class HyperproofApiClient {
  private static _subscriptionKey?: string =
    process.env.hyperproof_api_subscription_key;
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
  public static async fetchWithRetry(
    url: string,
    options: RequestInit | undefined = undefined,
    totalAttempts = 3,
    delay = 3
  ) {
    totalAttempts = Math.max(totalAttempts, 1);
    delay = Math.max(0, delay);

    let response = await fetch(url, options);

    // retries
    for (let attempts = 1; attempts < totalAttempts; attempts++) {
      if (response.ok) {
        break;
      }

      await HyperproofApiClient.sleep(delay);
      Logger.warn(
        `Retrying fetch after failing ${attempts} time(s) with code ${
          response.status
        }: ${await response.text()}`
      );
      response = await fetch(url, options);
    }

    return response;
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
  public static async createInstance(
    integrationContext: IntegrationContext,
    orgId: string,
    userId: string
  ) {
    // this is done to trigger the non null check in the getter method
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    HyperproofApiClient.subscriptionKey;

    await Logger.debug(
      `Creating Hyperproof API client using URL ${process.env.hyperproof_api_url}`
    );

    const accessToken = await ensureHyperproofAccessToken(
      integrationContext,
      orgId,
      userId
    );

    return new HyperproofApiClient(accessToken);
  }

  /**
   * Retrieves an integration settings instance in Hyperproof.
   */
  public async getOrgIntegrationSettings(integrationId: string) {
    return this.getIntegrationSettings(integrationId);
  }

  public async getIntegrationSettings<
    TIntegration extends IIntegrationSettingsBase
  >(
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

    const response = await HyperproofApiClient.fetchWithRetry(url, {
      headers: {
        ...TraceParent.getHeaders(),
        [HttpHeader.Authorization]: `Bearer ${this.accessToken}`,
        [HttpHeader.SubscriptionKey]: HyperproofApiClient.subscriptionKey
      }
    });

    if (!response.ok) {
      const errorText =
        response.status === StatusCodes.CONFLICT
          ? 'Operation is already in process'
          : await response.text();
      throw createHttpError(
        response.status,
        createAndLogErrorMessage(
          response.status,
          HttpMethod.GET,
          url,
          errorText,
          objectType
        )
      );
    }

    return response.json() as Promise<IIntegration<TIntegration>>;
  }

  /**
   * Updates an integration settings instance from Hyperproof.
   */
  public async updateIntegrationSettings<
    TIntegrationSettings extends IIntegrationSettingsBase
  >(
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
    const response = await HyperproofApiClient.fetchWithRetry(url, {
      method: 'PATCH',
      body: JSON.stringify(settings),
      headers: {
        ...TraceParent.getHeaders(),
        [HttpHeader.Authorization]: `Bearer ${this.accessToken}`,
        [HttpHeader.SubscriptionKey]: HyperproofApiClient.subscriptionKey,
        [HttpHeader.ContentType]: MimeType.APPLICATION_JSON
      }
    });

    debug(`PATCH ${url} - ${response.status}`);

    if (!response.ok) {
      throw createHttpError(
        response.status,
        createAndLogErrorMessage(
          response.status,
          HttpMethod.PATCH,
          url,
          await response.text(),
          objectType
        )
      );
    }
    try {
      return await response.json();
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (err) {
      // swallow for 204;
    }
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
    const response = await HyperproofApiClient.fetchWithRetry(url, {
      method: 'POST',
      body: JSON.stringify(settings),
      headers: {
        ...TraceParent.getHeaders(),
        [HttpHeader.Authorization]: `Bearer ${this.accessToken}`,
        [HttpHeader.SubscriptionKey]: HyperproofApiClient.subscriptionKey,
        [HttpHeader.ContentType]: MimeType.APPLICATION_JSON
      }
    });

    debug(`POST ${url} - ${response.status}`);

    if (!response.ok) {
      throw createHttpError(
        response.status,
        createAndLogErrorMessage(
          response.status,
          HttpMethod.POST,
          url,
          await response.text(),
          objectType
        )
      );
    }

    return response.json();
  }

  /**
   * Posts a proof file to a Hyperproof organization or object.
   *
   * @param file File to upload.
   * @param filename Name of the file.
   * @param mimeType MIME type for the file.
   * @param objectType Type of object to which the file should be uploaded.
   * @param objectId Unique ID of the object.
   * @param sourceId (optional) id of the source of the proof
   * @param sourceFileId (optional) id of file in source
   * @param sourceModifiedOn (optional) ISO8601 date representing when this piece of proof was modified in the source
   * @param user (optional) External user that is uploading this proof
   * @param size (optional) Size of the file being uploaded.
   */
  public async postProof(
    file: Buffer,
    filename: string,
    mimeType: string,
    objectType: ObjectType,
    objectId: string,
    sourceId?: string,
    sourceFileId?: string,
    sourceModifiedOn?: string,
    user?: IExternalUser,
    size?: number
  ) {
    const formData = this.buildProofFormData(
      file,
      filename,
      mimeType,
      sourceId,
      sourceFileId,
      sourceModifiedOn,
      user,
      size
    );

    return this.postNewProof(objectType, objectId, formData);
  }

  public async postProofVersion(
    file: Buffer,
    filename: string,
    mimeType: string,
    proofId: string,
    sourceId: string,
    sourceFileId: string,
    sourceModifiedOn?: string,
    user?: IExternalUser,
    size?: number
  ) {
    const formData = this.buildProofFormData(
      file,
      filename,
      mimeType,
      sourceId,
      sourceFileId,
      sourceModifiedOn,
      user,
      size
    );

    const url = `${process.env.hyperproof_api_url}/beta/proof/${proofId}/versions`;
    const response = await HyperproofApiClient.fetchWithRetry(url, {
      method: 'POST',
      body: formData,
      headers: {
        ...TraceParent.getHeaders(),
        [HttpHeader.Authorization]: `Bearer ${this.accessToken}`,
        [HttpHeader.SubscriptionKey]: HyperproofApiClient.subscriptionKey
      }
    });
    debug(`POST ${url} - ${response.status}`);
    if (!response.ok) {
      throw createHttpError(
        response.status,
        createAndLogErrorMessage(
          response.status,
          HttpMethod.POST,
          url,
          await response.text()
        )
      );
    }
    return response.json();
  }

  /**
   * Retrieves the task statuses for Hyperproof org.
   */
  public async getTaskStatuses() {
    const url = `${process.env.hyperproof_api_url}/v1/taskstatuses`;

    const response = await HyperproofApiClient.fetchWithRetry(url, {
      method: 'GET',
      headers: {
        ...TraceParent.getHeaders(),
        [HttpHeader.Authorization]: `Bearer ${this.accessToken}`,
        [HttpHeader.SubscriptionKey]: HyperproofApiClient.subscriptionKey,
        [HttpHeader.ContentType]: MimeType.APPLICATION_JSON
      }
    });
    debug(`GET ${url} - ${response.status}`);
    if (!response.ok) {
      throw createHttpError(
        response.status,
        createAndLogErrorMessage(
          response.status,
          HttpMethod.GET,
          url,
          await response.text()
        )
      );
    }

    return response.json();
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
    const response = await HyperproofApiClient.fetchWithRetry(url, {
      method: 'PATCH',
      body: JSON.stringify(patch),
      headers: {
        ...TraceParent.getHeaders(),
        [HttpHeader.Authorization]: `Bearer ${this.accessToken}`,
        [HttpHeader.SubscriptionKey]: HyperproofApiClient.subscriptionKey,
        [HttpHeader.ContentType]: MimeType.APPLICATION_JSON
      }
    });
    debug(`PATCH ${url} - ${response.status}`);
    if (!response.ok) {
      throw createHttpError(
        response.status,
        createAndLogErrorMessage(
          response.status,
          HttpMethod.PATCH,
          url,
          await response.text()
        )
      );
    }

    return response.json();
  }

  /**
   * Retrieves a hyperproof task
   *
   * @param objectId Unique ID of the task.
   */
  public async getTask(objectId: string): Promise<ITask> {
    const url = `${process.env.hyperproof_api_url}/v1/tasks/${objectId}`;

    const response = await HyperproofApiClient.fetchWithRetry(url, {
      method: 'GET',
      headers: {
        ...TraceParent.getHeaders(),
        [HttpHeader.Authorization]: `Bearer ${this.accessToken}`,
        [HttpHeader.SubscriptionKey]: HyperproofApiClient.subscriptionKey,
        [HttpHeader.ContentType]: MimeType.APPLICATION_JSON
      }
    });
    debug(`GET ${url} - ${response.status}`);
    if (!response.ok) {
      throw createHttpError(
        response.status,
        createAndLogErrorMessage(
          response.status,
          HttpMethod.GET,
          url,
          await response.text()
        )
      );
    }

    return response.json() as Promise<ITask>;
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

    const response = await HyperproofApiClient.fetchWithRetry(url, {
      method: 'GET',
      headers: {
        ...TraceParent.getHeaders(),
        [HttpHeader.Authorization]: `Bearer ${this.accessToken}`,
        [HttpHeader.SubscriptionKey]: HyperproofApiClient.subscriptionKey,
        [HttpHeader.ContentType]: MimeType.APPLICATION_JSON
      }
    });
    debug(`POST ${url} - ${response.status}`);
    if (!response.ok) {
      throw createHttpError(
        response.status,
        createAndLogErrorMessage(
          response.status,
          HttpMethod.POST,
          url,
          await response.text()
        )
      );
    }

    return response.json();
  }

  /**
   * Unlinks proof linked to a task based on a sourceFileId
   *
   * @param objectId Unique ID of the task this proof is associated with.
   * @param sourceFileId Unique ID of the proof in the external system
   * @param user External user who performed the unlink.
   */
  public async archiveTaskProofLink(
    objectId: string,
    sourceFileId: string,
    user: IExternalUser
  ) {
    const proofMeta = await this.getTaskProofMeta(objectId, sourceFileId);
    const results = [];
    for (const proof of proofMeta as any) {
      const url = `${process.env.hyperproof_api_url}/beta/proof/${proof.id}/links/${objectId}/archive?objectType=task`;
      const response = await HyperproofApiClient.fetchWithRetry(url, {
        method: 'POST',
        body: JSON.stringify(user),
        headers: {
          ...TraceParent.getHeaders(),
          [HttpHeader.Authorization]: `Bearer ${this.accessToken}`,
          [HttpHeader.SubscriptionKey]: HyperproofApiClient.subscriptionKey,
          [HttpHeader.ContentType]: MimeType.APPLICATION_JSON
        }
      });

      if (!response.ok && response.status !== 404) {
        throw createHttpError(
          response.status,
          createAndLogErrorMessage(
            response.status,
            HttpMethod.POST,
            url,
            await response.text()
          )
        );
      }
      const proofArchive = await response.json();
      results.push(proofArchive);
    }
    return results;
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
    const response = await HyperproofApiClient.fetchWithRetry(url, {
      headers: {
        ...TraceParent.getHeaders(),
        [HttpHeader.Authorization]: `Bearer ${this.accessToken}`,
        [HttpHeader.SubscriptionKey]: HyperproofApiClient.subscriptionKey
      }
    });

    debug(`GET ${url} - ${response.status}`);
    if (!response.ok) {
      throw createHttpError(
        response.status,
        createAndLogErrorMessage(
          response.status,
          HttpMethod.GET,
          url,
          await response.text(),
          objectType
        )
      );
    }

    return response.json();
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
  public async patchComment(
    commentBody: ICommentBody,
    objectType: ObjectType,
    objectId: string,
    commentId?: string
  ) {
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

    const response = await HyperproofApiClient.fetchWithRetry(url, {
      method: 'GET',
      headers: {
        ...TraceParent.getHeaders(),
        [HttpHeader.Authorization]: `Bearer ${this.accessToken}`,
        [HttpHeader.SubscriptionKey]: HyperproofApiClient.subscriptionKey,
        [HttpHeader.ContentType]: MimeType.APPLICATION_JSON
      }
    });
    debug(`GET ${url} - ${response.status}`);
    if (!response.ok) {
      throw createHttpError(
        response.status,
        createAndLogErrorMessage(
          response.status,
          HttpMethod.GET,
          url,
          await response.text()
        )
      );
    }

    return response.json();
  }

  private async postNewProof(
    objectType: ObjectType,
    objectId: string,
    formData: FormData
  ) {
    let url = `${process.env.hyperproof_api_url}/v1`;
    if (objectType !== ObjectType.ORGANIZATION) {
      url += `/${objectType}s/${objectId}/proof`;
    } else {
      url += `/proof`;
    }

    const response = await HyperproofApiClient.fetchWithRetry(url, {
      method: 'POST',
      body: formData,
      headers: {
        ...TraceParent.getHeaders(),
        [HttpHeader.Authorization]: `Bearer ${this.accessToken}`,
        [HttpHeader.SubscriptionKey]: HyperproofApiClient.subscriptionKey
      }
    });
    debug(`POST ${url} - ${response.status}`);
    if (!response.ok) {
      throw createHttpError(
        response.status,
        createAndLogErrorMessage(
          response.status,
          HttpMethod.POST,
          url,
          await response.text(),
          objectType
        )
      );
    }

    return response.json();
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
  private async sendCommentRequest(
    commentBody: ICommentBody,
    method: HttpMethod,
    objectType: ObjectType,
    objectId: string,
    parentObjectType?: ObjectType,
    parentObjectId?: string,
    commentId?: string
  ) {
    const parentPrefix =
      parentObjectType && parentObjectId
        ? `${parentObjectType}s/${parentObjectId}/`
        : '';
    const versionPath = objectType === ObjectType.TASK ? 'v1' : 'beta';
    let url = `${process.env.hyperproof_api_url}/${versionPath}/${parentPrefix}${objectType}s/${objectId}/comments`;
    if (commentId) {
      url += `/${commentId}`;
    }
    const response = await HyperproofApiClient.fetchWithRetry(url, {
      method,
      body: JSON.stringify({
        ...commentBody,
        objectType,
        objectId
      }),
      headers: {
        ...TraceParent.getHeaders(),
        [HttpHeader.Authorization]: `Bearer ${this.accessToken}`,
        [HttpHeader.SubscriptionKey]: HyperproofApiClient.subscriptionKey,
        [HttpHeader.ContentType]: MimeType.APPLICATION_JSON
      }
    });
    debug(`${method} ${url} - ${response.status}`);
    if (!response.ok) {
      throw createHttpError(
        response.status,
        createAndLogErrorMessage(
          response.status,
          method,
          url,
          await response.text(),
          objectType
        )
      );
    }
    return response.json();
  }

  private formatFilename(filename: string, mimeType: string) {
    const { name: nameWithoutExtension, ext: existingExtension } =
      path.parse(filename);
    const mimeForExistingExtension =
      existingExtension && mime.getType(existingExtension);

    if (mimeForExistingExtension !== mimeType) {
      const fileExtension = mime.getExtension(mimeType);

      // NOTE:  If we need to add an additional case, we should probably convert to a
      //        switch statement here.

      // we special case csv, jira sometimes gives us the wrong mime type (text/plain)
      // even though the extension is csv. If the file extension is csv it's okay to ignore
      // this check and just process as a csv. See: HYP-17979 for more context
      if (
        mimeForExistingExtension === MimeType.CSV_MIME &&
        fileExtension === TXT_EXTENSION
      ) {
        mimeType = mimeForExistingExtension;
      }
      // Another special case from Jira Server.  We get back a (application/octet-stream) mime type
      // back when requesting a ldif file. In the case of jira cloud, we get (binary/octet-stream)
      // so we will cast to match Jira Cloud
      else if (
        mimeType === MimeType.OCTET_MIME_APP &&
        existingExtension === `.${LDIF_EXTENSION}` // append the . before the extension based on how it is split
      ) {
        mimeType = MimeType.OCTET_MIME_BINARY;
      } else {
        // otherwise we replace the extension with the extension that maps to its mime type
        if (fileExtension && !filename.endsWith(fileExtension)) {
          filename = `${nameWithoutExtension}.${fileExtension}`;
        }
      }
    }

    // Escaping other special characters is not necessary since the export will sanitize
    // the filename
    return { filename: filename.replace(/\//g, ' '), mimeType };
  }

  private buildProofFormData(
    file: Buffer,
    filename: string,
    mimeType: string,
    sourceId?: string,
    sourceFileId?: string,
    sourceModifiedOn?: string,
    user?: IExternalUser,
    size?: number
  ) {
    if (size && Number(size) >= MAX_FILE_SIZE) {
      const err = new Error(
        `Proof from source ${sourceId} is larger than max file size.`
      );
      debug(err.message);
      throw err;
    }

    const fileResults = this.formatFilename(filename, mimeType);
    filename = fileResults.filename;
    mimeType = fileResults.mimeType;

    const formData = new FormData();
    formData.append('proof', file, { filename, contentType: mimeType });
    if (sourceId) {
      formData.append('hp-proof-source-id', sourceId);
    }
    if (sourceFileId) {
      formData.append('hp-proof-source-file-id', sourceFileId);
    }
    if (sourceModifiedOn) {
      formData.append('hp-proof-source-modified-on', sourceModifiedOn);
    }
    if (user) {
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
