import express from 'express';
import createHttpError from 'http-errors';
import { StatusCodes } from 'http-status-codes';
import Superagent from 'superagent';

import { IntegrationContext } from '../add-on-sdk';
import { Logger } from '../hyperproof-api';
import { LogContextKey } from '../models';

/**
 * Response to a request for an access token.
 */
export interface OAuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

/**
 * Model for persisted user data.
 */
export interface UserContext<TVendorUserProfile = { [key: string]: any }> {
  status?: string;
  timestamp: number;
  vendorUserId: string;
  vendorUserProfile: TVendorUserProfile;
  vendorToken?: {
    scope: string;
    expires_at: number;
    expires_in: number;
    token_type: string;
    access_token: string;
    refresh_token: string;
    ext_expires_in: number;
  };
  foreignOAuthIdentities?: {
    [key: string]: {
      userId: string;
      connectorBaseUrl: string;
    };
  };
  lastRefreshStarted?: number;
  lastRefreshError?: any;
  refreshErrorCount?: number;
}

export class OAuthConnector {
  public accessTokenExpirationBuffer: number;
  public refreshErrorLimit: number;
  public refreshWaitCountLimit: number;
  public refreshInitialBackoff: number;
  public refreshBackoffIncrement: number;
  public concurrentRefreshLockTimeout: number;

  constructor() {
    /**
     * Access tokens returned from ensureAccessToken method will expire not earlier
     * than accessTokenExpirationBuffer milliseconds in the future.
     */
    this.accessTokenExpirationBuffer = 30000;

    /**
     * If refreshing an access token fails for refreshErrorLimit of consecutive times, the user is deleted.
     */
    this.refreshErrorLimit = 10;

    /**
     * Maximum number of times the user status will be queried before failing while waiting for the user's
     * access token to be refreshed.
     */
    this.refreshWaitCountLimit = 5;

    /**
     * Intial backoff in milliseconds before querying user status for completion of an access token refresh.
     */
    this.refreshInitialBackoff = 100;

    /**
     * Backoff increment for consecutive attempts to query user status for completion of an access token refresh.
     */
    this.refreshBackoffIncrement = 1.2;

    /**
     * Time in milliseconds from the start of a token refresh operation after which subsequent token refresh attempts
     * are not longer queued waiting for its completion but initiate another token refresh request instead.
     */
    this.concurrentRefreshLockTimeout = 10000;
  }

  /**
   * Called during connector initialization to allow the connector to register additional, application-specific
   * routes on the provided Express router.
   * @param {*} Express router
   */
  onCreate(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    app: express.IRouter
  ) {
    // Subclasses should override to add routes.
  }

  /**
   * Called when the entire connector is being deleted. Override the logic in this method to remove
   * any artifacts created during the lifetime of this connector (e.g. Fusebit functions, storage).
   * @param {IntegrationContext} integrationContext The integration context
   */
  async onDelete(integrationContext: IntegrationContext) {
    // Clean up storage and vendor artifacts
    await integrationContext.storage.delete(undefined, true);
  }

  /**
   * Creates Express middleware that authorizes the call using Fusebit security. For example, the following will only execute
   * the Express handler if the access token supplied by the caller has the function:execute permission on the function resource.
   *
   * app.get('/myendpoint',
   *   authorize({
   *     action: 'function:execute',
   *     resourceFactory: req => `/account/${req.fusebit.accountId}/subscription/${req.fusebit.subscriptionId}/boundary/${req.fusebit.boundaryId}/function/${req.fusebit.functionId}/myendpoint/`
   *   }),
   *   handler
   * );
   *
   * @param {object} param Object with action and resourceFactory properties
   */
  authorize({
    action,
    resourceFactory
  }: {
    action: string;
    resourceFactory: (req: express.Request) => string;
  }) {
    const actionTokens = action.split(':');
    return async (
      req: express.Request,
      res: express.Response,
      next: express.NextFunction
    ) => {
      const resource = resourceFactory(req);
      try {
        if (!req.fusebit.caller.permissions) {
          throw new Error('The caller was not authenticated.');
        }
        for (const permission of req.fusebit.caller.permissions.allow) {
          if (resource.indexOf(permission.resource) !== 0) {
            continue;
          }
          const actualActionTokens = permission.action.split(':');
          let match = true;
          for (let i = 0; i < actionTokens.length; i++) {
            if (actionTokens[i] !== actualActionTokens[i]) {
              match = actualActionTokens[i] === '*';
              break;
            }
          }
          if (match) {
            return next();
          }
        }
        throw new Error('Caller does not have sufficient permissions.');
      } catch (e: any) {
        await Logger.debug(
          `FAILED AUTHORIZATION CHECK, message: ${e.message}, 
          action: ${action}, resource: ${resource}, 
          permissions: ${req.fusebit.caller.permissions}`
        );
        res
          .status(403)
          .send({ status: 403, statusCode: 403, message: 'Unauthorized' });
        return;
      }
    };
  }

  /**
   * Creates the fully formed web authorization URL to start the authorization flow.
   * @param {IntegrationContext} integrationContext The integration context of the request
   * @param {string} state The value of the OAuth state parameter.
   * @param {string} redirectUri The callback URL to redirect to after the authorization flow.
   */
  async getAuthorizationUrl(
    integrationContext: IntegrationContext,
    state: string,
    redirectUri: string
  ) {
    return [
      integrationContext.configuration.oauth_authorization_url,
      `?response_type=code`,
      `&scope=${encodeURIComponent(
        integrationContext.configuration.oauth_scope
      )}`,
      `&state=${state}`,
      `&client_id=${integrationContext.configuration.oauth_client_id}`,
      `&redirect_uri=${encodeURIComponent(redirectUri)}`,
      integrationContext.configuration.oauth_audience
        ? `&audience=${encodeURIComponent(
            integrationContext.configuration.oauth_audience
          )}`
        : undefined,
      integrationContext.configuration.oauth_extra_params
        ? `&${integrationContext.configuration.oauth_extra_params}`
        : undefined
    ].join('');
  }

  /**
   * Exchanges the OAuth authorization code for the access and refresh tokens.
   * @param {IntegrationContext} integrationContext The integration context of the request
   * @param {string} authorizationCode The authorization_code supplied to the OAuth callback upon successful authorization flow.
   * @param {string} redirectUri The redirect_uri value Fusebit used to start the authorization flow.
   */
  async getAccessToken(
    integrationContext: IntegrationContext,
    authorizationCode: string,
    redirectUri: string
  ) {
    const response = await Superagent.post(
      integrationContext.configuration.oauth_token_url
    )
      .type('form')
      .send({
        grant_type: 'authorization_code',
        code: authorizationCode,
        client_id: integrationContext.configuration.oauth_client_id,
        client_secret: integrationContext.configuration.oauth_client_secret,
        redirect_uri: redirectUri
      });
    return response.body;
  }

  /**
   * Obtains a new access token using refresh token.
   * @param {IntegrationContext} integrationContext The integration context of the request
   * @param {*} tokenContext An object representing the result of the getAccessToken call. It contains refresh_token.
   * @param {string} redirectUri The redirect_uri value Fusebit used to start the authorization flow.
   */
  async refreshAccessToken(
    integrationContext: IntegrationContext,
    tokenContext: OAuthTokenResponse,
    redirectUri: string
  ) {
    const currentRefreshToken = tokenContext.refresh_token;
    const response = await Superagent.post(
      integrationContext.configuration.oauth_token_url
    )
      .type('form')
      .send({
        grant_type: 'refresh_token',
        refresh_token: tokenContext.refresh_token,
        client_id: integrationContext.configuration.oauth_client_id,
        client_secret: integrationContext.configuration.oauth_client_secret,
        redirect_uri: redirectUri || `${integrationContext.baseUrl}/callback`
      })
      .catch(err => {
        // superagent uses a generic error message for 4xx responses, so we need to pull out the actual error
        if (typeof err.response?.body?.error === 'string') {
          err.message = err.response.body.error;
        }
        throw err;
      });
    if (!response.body.refresh_token) {
      Logger.info('No refresh token in response, reusing the current one.');
      response.body.refresh_token = currentRefreshToken;
    }
    return response.body;
  }

  /**
   * Obtains the user profile given a freshly completed authorization flow. User profile will be stored along the token
   * context.
   * @param {*} tokenContext An object representing the result of the getAccessToken call. It contains access_token.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async getUserProfile(tokenContext: OAuthTokenResponse) {
    return {};
  }

  /**
   * Returns a string uniquely identifying the user in vendor's system. Typically this is a property of
   * userContext.vendorUserProfile. Default implementation is opportunistically returning userContext.vendorUserProfile.id
   * if it exists.
   * @param {*} userContext The user context representing the vendor's user. Contains vendorToken and vendorUserProfile, representing responses
   * from getAccessToken and getUserProfile, respectively.
   */
  async getUserId(userContext: UserContext) {
    if (userContext.vendorUserProfile.id) {
      return userContext.vendorUserProfile.id;
    }
    throw new Error(
      'Please implement the getUserProfile and getUserId methods in the class deriving from OAuthConnector.'
    );
  }

  /**
   * Called after successful completion of the connector's configuration flow. The 'data' parameter contains
   * configuration properties generated by settings managers that ran prior to this connector, for example a user ID
   * of the user in another system, or a URL to obtain the access token to another system. You can use this extensibility
   * point to modify the 'userContext' with information about the identity of the user in another system, therefore
   * creating an association between the same user in two systems.
   * @param {IntegrationContext} integrationContext The integration context of the request
   * @param {*} userContext The user context representing the vendor's user. Contains vendorToken and vendorUserProfile, representing responses
   * from getAccessToken and getUserProfile, respectively.
   * @param {*} data A property bag containing properties generated by settings managers that have completed prior to the configuration flow of this connector.
   */
  async onConfigurationComplete(
    integrationContext: IntegrationContext,
    userContext: UserContext,
    data: { [key: string]: any }
  ) {
    if (data) {
      for (const p in data) {
        const match = p.match(/^(.+)_oauth_user_id$/);
        if (
          match &&
          match[1] !== integrationContext.configuration.vendor_prefix &&
          typeof data[`${match[1]}_oauth_connector_base_url`] === 'string'
        ) {
          userContext.foreignOAuthIdentities = {
            ...(userContext.foreignOAuthIdentities || {}),
            [match[1]]: {
              userId: data[p],
              connectorBaseUrl: data[`${match[1]}_oauth_connector_base_url`]
            }
          };
        }
      }
    }
  }

  /**
   * Called after a new user successfuly completed a configuration flow and was persisted in the system. This extensibility
   * point allows for creation of any artifacts required to serve this new user, for example creation of additional
   * Fusebit functions.
   * @param {IntegrationContext} integrationContext The integration context of the request
   * @param {*} userContext The user context representing the vendor's user. Contains vendorToken and vendorUserProfile, representing responses
   * from getAccessToken and getUserProfile, respectively.
   */
  async onNewUser(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    integrationContext: IntegrationContext,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    userContext: UserContext
  ) {
    // Subclasses may override.
  }

  /**
   * Returns the HTML of the web page that initiates the authorization flow to the authorizationUrl. Return
   * undefined if you don't want to present any HTML to the user but instead redirect the user directly to
   * the authorizationUrl.
   * @param {IntegrationContext} integrationContext The integration context of the request
   * @param {string} authorizationUrl The fully formed authorization url to redirect the user to
   */
  async getAuthorizationPageHtml(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    integrationContext: IntegrationContext,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    authorizationUrl: string
  ) {
    return undefined;
  }

  /**
   * Gets the user context representing the user with vendorUserId id. Returned object contains vendorToken and vendorUserProfile properties.
   * @param {IntegrationContext} integrationContext The integration context
   * @param {string} vendorUserId The vendor user id
   * @param {string} foreignVendorId If specified, vendorUserId represents the identity of the user in another system.
   * The foreignVendorId must correspond to an entry in userContext.foreignOAuthIdentities.
   */
  async getUser(
    integrationContext: IntegrationContext,
    vendorUserId: string,
    foreignVendorId?: string
  ): Promise<UserContext | undefined> {
    if (foreignVendorId) {
      const data = await integrationContext.storage.get(
        this.getStorageIdForVendorUser(vendorUserId, foreignVendorId)
      );
      vendorUserId = data && data.data && data.data.vendorUserId;
      if (!vendorUserId) {
        await Logger.info(
          `Could not find vendorUserId from storage for foreignVendorId: ${foreignVendorId}, vendorUserId: ${vendorUserId}`
        );
        return undefined;
      }
    }
    await Logger.info(`Getting user from storage: ${vendorUserId}`);
    const s = await integrationContext.storage.get(
      this.getStorageIdForVendorUser(vendorUserId)
    );
    return s ? s.data : undefined;
  }

  /**
   * Saves user context in storage for future use.
   * @param {IntegrationContext} integrationContext The integration context of the request
   * @param {*} userContext The user context representing the vendor's user. Contains vendorToken and vendorUserProfile, representing responses
   * from getAccessToken and getUserProfile, respectively.
   */
  async saveUser(
    integrationContext: IntegrationContext,
    userContext: UserContext
  ) {
    await Logger.info(
      `Saving user with status ${userContext.status} to storage.`
    );
    if (userContext.foreignOAuthIdentities) {
      for (const foreignVendorId in userContext.foreignOAuthIdentities) {
        await integrationContext.storage.put(
          { data: { vendorUserId: userContext.vendorUserId } },
          this.getStorageIdForVendorUser(
            userContext.foreignOAuthIdentities[foreignVendorId].userId,
            foreignVendorId
          )
        );
      }
    }
    return integrationContext.storage.put(
      { data: userContext },
      this.getStorageIdForVendorUser(userContext.vendorUserId)
    );
  }

  /**
   * Deletes user context from storage.
   * @param {IntegrationContext} integrationContext The integration context
   * @param {string} vendorUserId The vendor user id
   * @param {string} vendorId If specified, vendorUserId represents the identity of the user in another system.
   * The vendorId must correspond to an entry in userContext.foreignOAuthIdentities.
   */
  async deleteUser(
    integrationContext: IntegrationContext,
    vendorUserId: string,
    vendorId?: string
  ) {
    const userContext = await this.getUser(
      integrationContext,
      vendorUserId,
      vendorId
    );
    if (userContext && userContext.foreignOAuthIdentities) {
      for (const fvId in userContext.foreignOAuthIdentities) {
        await integrationContext.storage.delete(
          this.getStorageIdForVendorUser(
            userContext.foreignOAuthIdentities[fvId].userId,
            fvId
          )
        );
      }
    }
    return (
      userContext &&
      integrationContext.storage.delete(
        this.getStorageIdForVendorUser(userContext.vendorUserId)
      )
    );
  }

  /**
   * Gets the health status of the user
   * @param {IntegrationContext} integrationContext The integration context of the request
   * @param {*} userContext The user context representing the vendor's user. Contains vendorToken and vendorUserProfile, representing responses
   * from getAccessToken and getUserProfile, respectively.
   */
  async getHealth(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    integrationContext: IntegrationContext,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    userContext: UserContext
  ): Promise<{ status: number; body?: any }> {
    return { status: 200 };
  }

  /**
   * Returns a valid access token to the vendor's system representing the vendor's user described by the userContext,
   * or a valid access token to a foreign system if foreignVendorId is specified.
   * For the vendor's system, if the currently stored access token is expired or nearing expiry, and a refresh token is available, a new access
   * token is obtained, stored for future use, and returned. If a current access token cannot be returned, an exception is thrown.
   * @param {IntegrationContext} integrationContext The integration context of the request
   * @param {*} userContext The vendor user context
   * @param {string} foreignVendorId If specified, gets a valid access token for the OAuth connector identified by the
   * foreignVendorId entry in the userContext.foreignOAuthIdentities rather than a user of this connector.
   */
  async ensureAccessToken(
    integrationContext: IntegrationContext,
    userContext: UserContext,
    foreignVendorId?: string
  ) {
    const expiredRefreshTokenMessage =
      'Refresh token expired. Please reauthorize the connection.';
    const ensureForeignAccessToken = async () => {
      const oauthIdentity = (userContext.foreignOAuthIdentities || {})[
        foreignVendorId!
      ];
      await Logger.debug(
        `OBTAINING ACCESS TOKEN FOR FOREIGN USER,
        foreignVenderId: ${foreignVendorId},
        oauthIdentity: ${oauthIdentity}`
      );
      if (oauthIdentity) {
        try {
          const response = await Superagent.get(
            `${oauthIdentity.connectorBaseUrl}/user/${encodeURIComponent(
              oauthIdentity.userId
            )}/token`
          ).set(
            'Authorization',
            `Bearer ${integrationContext.fusebit.functionAccessToken}`
          );
          return response.body;
        } catch (e: any) {
          throw new Error(
            `Error obtaining current access token for user '${oauthIdentity.userId}' from the connector for vendor '${foreignVendorId}' at '${oauthIdentity.connectorBaseUrl}: ${e.message}'`
          );
        }
      } else {
        throw new Error(
          `The user ${userContext.vendorUserId} is not associated with an identity in the ${foreignVendorId} OAuth connector.`
        );
      }
    };

    const ensureLocalAccessToken = async () => {
      if (
        userContext.vendorToken?.access_token &&
        (userContext.vendorToken.expires_at === undefined ||
          userContext.vendorToken.expires_at >
            Date.now() + this.accessTokenExpirationBuffer)
      ) {
        await Logger.info(
          `RETURNING CURRENT ACCESS TOKEN FOR USER ${userContext.vendorUserId}`
        );
        return userContext.vendorToken;
      }
      if (userContext.status === 'refresh_failed') {
        await Logger.error(
          `EXPIRED ACCESS TOKEN FOR USER ${userContext.vendorUserId}, THROWING UNAUTHORIZED`
        );
        throw createHttpError(
          StatusCodes.UNAUTHORIZED,
          expiredRefreshTokenMessage
        );
      }

      if (userContext.vendorToken?.refresh_token) {
        await Logger.info(
          `REFRESHING ACCESS TOKEN FOR USER ${userContext.vendorUserId}`
        );
        userContext.status = 'refreshing';
        userContext.lastRefreshStarted = Date.now();
        try {
          await this.saveUser(integrationContext, userContext);
          userContext.vendorToken = await this.refreshAccessToken(
            integrationContext,
            userContext.vendorToken,
            `${integrationContext.baseUrl}/callback`
          );
          if (userContext.vendorToken) {
            if (!isNaN(userContext.vendorToken.expires_in)) {
              userContext.vendorToken.expires_at =
                Date.now() + +userContext.vendorToken.expires_in * 1000;
            }
            userContext.vendorUserProfile = await this.getUserProfile(
              userContext.vendorToken
            );
          }
          userContext.status = 'authenticated';
          userContext.refreshErrorCount = 0;
          delete userContext.lastRefreshError;
          await this.saveUser(integrationContext, userContext);
          return userContext.vendorToken;
        } catch (e: any) {
          const responseText = e.response?.text;
          if (
            userContext.refreshErrorCount &&
            userContext.refreshErrorCount > this.refreshErrorLimit
          ) {
            const msg = `Credential "${userContext.vendorUserId}" has expired. This may be resolved by reauthorizing the connection. Unable to refresh token after ${this.refreshErrorLimit} attempts: ${e.message}`;
            userContext.status = 'refresh_failed';
            userContext.lastRefreshError = msg;
            await this.saveUser(integrationContext, userContext);
            await Logger.error(msg, responseText);
            throw createHttpError(StatusCodes.UNAUTHORIZED, msg, {
              [LogContextKey.ExtendedMessage]: responseText,
              [LogContextKey.ApiUrl]:
                integrationContext.configuration?.oauth_token_url
            });
          } else {
            userContext.refreshErrorCount =
              (userContext.refreshErrorCount || 0) + 1;
            const msg = `Error refreshing access token, attempt ${userContext.refreshErrorCount} out of ${this.refreshErrorLimit}: ${e.message}`;
            userContext.status = 'refresh_error';
            userContext.lastRefreshError = msg;
            await this.saveUser(integrationContext, userContext);
            throw createHttpError(StatusCodes.UNAUTHORIZED, msg, {
              [LogContextKey.ExtendedMessage]: responseText,
              [LogContextKey.ApiUrl]:
                integrationContext.configuration?.oauth_token_url
            });
          }
        }
      }
      const msg = `Access token is expired and cannot be refreshed because the refresh token is not present. Credential: "${userContext.vendorUserId}"`;
      await Logger.error(msg);
      throw createHttpError(StatusCodes.UNAUTHORIZED, msg);
    };

    const waitForRefreshedAccessToken = async (
      count: number,
      backoff: number
    ) => {
      await Logger.info(
        `Waiting for access token to be refreshed for user: ${userContext.vendorUserId}, 
        ATTEMPTS LEFT: ${count}`
      );
      if (!(count > 0)) {
        userContext.status = 'refresh_error';
        await this.saveUser(integrationContext, userContext);
        throw new Error(
          `Error refreshing access token. Waiting for the access token to be refreshed exceeded the maximum time`
        );
      }
      return new Promise((resolve, reject) => {
        setTimeout(async () => {
          let newUserContext;
          try {
            newUserContext = await this.getUser(
              integrationContext,
              userContext.vendorUserId
            );
            if (!newUserContext || newUserContext.status === 'refresh_error') {
              throw new Error(
                `Concurrent access token refresh operation failed`
              );
            }

            if (newUserContext.status === 'refresh_failed') {
              throw createHttpError(
                StatusCodes.UNAUTHORIZED,
                expiredRefreshTokenMessage
              );
            }
          } catch (e: any) {
            return reject(
              new Error(`Error waiting for access token refresh: ${e.message}`)
            );
          }
          if (newUserContext.status === 'authenticated') {
            return resolve(newUserContext.vendorToken);
          } else {
            let result;
            try {
              result = await waitForRefreshedAccessToken(
                count - 1,
                Math.floor(backoff * this.refreshBackoffIncrement)
              );
            } catch (e) {
              return reject(e);
            }
            return resolve(result);
          }
        }, backoff);
      });
    };

    if (foreignVendorId) {
      // Get access token from foreign OAuth connector specified in userContext.foreignOAuthIdentities
      await Logger.info(`Ensuring Foreign Access Token.`);
      return ensureForeignAccessToken();
    } else {
      if (
        userContext.status === 'refreshing' &&
        userContext.lastRefreshStarted &&
        userContext.lastRefreshStarted + this.concurrentRefreshLockTimeout >
          Date.now()
      ) {
        // Wait for the currently ongoing refresh operation to finish
        await Logger.info(`Waiting for Refreshed Access Token.`);
        return waitForRefreshedAccessToken(
          this.refreshWaitCountLimit,
          this.refreshInitialBackoff
        );
      } else {
        // Get access token for "this" OAuth connector
        await Logger.info(`Ensuring Local Access Token.`);
        return ensureLocalAccessToken();
      }
    }
  }

  getStorageIdForVendorUser(id: string, foreignVendorId?: string) {
    return foreignVendorId
      ? `foreign-vendor-user/${encodeURIComponent(
          foreignVendorId
        )}/${encodeURIComponent(id)}`
      : `vendor-user/${encodeURIComponent(id)}`;
  }

  _getStorageIdForVendorUser(id: string, foreignVendorId?: string) {
    return this.getStorageIdForVendorUser(id, foreignVendorId);
  }
}
