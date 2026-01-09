/* eslint-disable max-lines-per-function */
import * as express from 'express';
import { debug, IntegrationContext } from './add-on-sdk';
import { createFetchOptions } from './agent';
import { asyncLocalStorage, IAsyncStore } from './asyncStore';
import {
  getHyperproofAccessToken,
  getHyperproofAuthConfig,
  HYPERPROOF_USER_STORAGE_ID,
  HyperproofApiClient,
  Logger,
  LoggerContext,
  LoggerContextKey,
  setHyperproofClientSecret
} from './hyperproof-api';
import {
  AuthorizationType,
  CustomAuthCredentials,
  HealthStatus,
  HttpHeader,
  IAuthorizationConfigBase,
  ICheckConnectionHealthInvocationPayload,
  IConnectionHealth,
  ITestExternalPermissionsBody,
  ITestExternalPermissionsResponse,
  IValidateCredentialsResponse,
  LogContextKey,
  MimeType
} from './models';
import {
  OAuthConnector,
  OAuthTokenResponse,
  UserContext
} from './oauth-connector';
import { formatUserKey, getHpUserFromUserKey } from './util';

import fs from 'fs';
import createHttpError, { HttpError } from 'http-errors';
import { StatusCodes } from 'http-status-codes';
import path from 'path';
import { ParsedQs } from 'qs';
import queryString from 'query-string';

/**
 * Representation of a user's connection to an external service.
 */
export interface IUserConnection {
  vendorUserId: string;
  type: string;
  name: string;
  account: string;
  enabled: boolean;
  createdBy: string;
  createdOn: string;

  // Jira-specific values.
  hostUrl?: string;
}

/**
 * Model for the patch object used to update a stored user connection.
 */
export interface IUserConnectionPatch {
  name?: string;
}

/**
 * Model for user data stored in Fusebit by Hyperproof integrations.  We extend
 * Fusebit's built-in user context object with some additional properties.
 */
export interface IHyperproofUserContext<TUserProfile = object>
  extends UserContext<TUserProfile> {
  // Object which tracks the Hyperproof users which are associated with the
  // vendor user.  The user key is generally of the form '/orgs/orgid/users/userid'
  // although variants do exist for certain integrations like Jira.
  //
  // This is necessary for two reasons:
  //   a) A given user may use the same credentials to connect to a service in two
  //      different Hyperproof organizations.
  //   b) Two users may use the same crednetials to connect to a service in the same
  //      Hyperproof organization.
  //
  // In these scenarios when the user chooses to delete their connection, we don't
  // want to delete the persisted user context until the last Hyperproof identity
  // has been removed.
  hyperproofIdentities: {
    [userKey: string]: { userId: string; connectorBaseUrl: string };
  };

  // For non-Oauth connectors, an object that stores the credentials for the user.
  keys?: CustomAuthCredentials;

  // Jira-specific value.
  hostUrl?: string;
}

/**
 * Respond to a request with an error message with a formatted error message
 * Contains the error message and the stack trace.
 *
 * This should be the last middleware in the error handling chain.
 *
 * All 4 parameters are needed so that express knows this is an error handling middleware
 */
export const errorHandler = async (
  err: HttpError | Error,
  req: express.Request,
  res: express.Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  next: express.NextFunction
) => {
  if (err) {
    const status =
      (err as HttpError).status ??
      (err as HttpError).statusCode ??
      StatusCodes.INTERNAL_SERVER_ERROR;
    res.status(status).json({
      message: err.message,
      extendedError: {
        ...err,
        [LogContextKey.StackTrace]: err.stack
      }
    });
  } else {
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      message: 'Unknown error occurred. Please try again later.'
    });
  }
};

export const getIntegrationsSystemAccessToken = async () => {
  // get accessToken from Hyperproof Public API using Integrations System API
  const clientId = process.env.integrations_system_api_client_id;
  const clientSecret = process.env.integrations_system_api_client_secret;

  const url = process.env.hyperproof_oauth_token_url;

  const body = {
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret
  };

  if (!url) {
    throw new Error(
      `Unable to get access token: no hyperproof_oauth_token_url is set.`
    );
  }
  const response = await fetch(
    url,
    createFetchOptions(url, {
      method: 'POST',
      headers: {
        'Content-Type': `${MimeType.FORM_URL_ENCODED};charset=UTF-8`
      },
      body: queryString.stringify(body)
    })
  );
  if (!response.ok) {
    await Logger.error(
      `Failed to get access token from Hyperproof Public API: ${await response.text()}`
    );
    throw new Error(`Failed to get access token from Hyperproof Public API`);
  }
  const obj = await response.json();

  return obj.access_token;
};

/**
 * Dynamically creates a connector class that can be used as a base for a Hyperproof integration.
 *
 * @param {*} superclass class that extends OAuthConnector
 *
 * Hyperproof connectors derive from OAuthConnector, AtlassianConnector, AsanaConnector and FusebitBot.
 * These are all built on OAuthConnector, but they are otherwise black boxes--we aren't able to easily
 * extend them by introducing our own HyperproofConnector which derives from OAuthConnector.
 *
 * createConnector allows us to dynamically extend all of these classes in the same way without
 * duplicating code.
 */
export function createConnector(superclass: typeof OAuthConnector) {
  return class Connector extends superclass {
    public integrationType: string;
    public connectorName: string;
    public authorizationType: AuthorizationType;

    // TODO: Move types into @types/fusebit__oauth-connector (HYP-30165)
    /**
     * Maximum number of times the user status will be queried before failing while waiting for the user's
     * access token to be refreshed.
     */
    public refreshWaitCountLimit: number;
    /**
     * Intial backoff in milliseconds before querying user status for completion of an access token refresh.
     */
    public refreshInitialBackoff: number;
    /**
     * Backoff increment for consecutive attempts to query user status for completion of an access token refresh.
     */
    public refreshBackoffIncrement: number;
    /**
     * Time in milliseconds from the start of a token refresh operation after which subsequent token refresh attempts
     * are not longer queued waiting for its completion but initiate another token refresh request instead.
     */
    public concurrentRefreshLockTimeout: number;

    /**
     * Time in milliseconds to wait before trying to ensureAccessToken again with re-fetched user context.
     */
    public accessTokenRetryDelay: number;

    constructor(connectorName: string) {
      super();
      if (!process.env.integration_type) {
        throw new Error(
          'process.env.integration_type not set for this connector'
        );
      }
      this.integrationType = process.env.integration_type;
      this.connectorName = connectorName;
      this.authorizationType = process.env.oauth_client_id
        ? AuthorizationType.OAUTH
        : AuthorizationType.CUSTOM;
      this.checkAuthorized = this.checkAuthorized.bind(this);

      // this must be set in the constructor after super() and not as a default
      // value because the OAuthConnector constructor will set these
      //
      // refreshInitialBackoff * refreshBackoffIncrement ^ refreshWaitCountLimit = max refresh wait time in ms
      //
      // wait up to ~29s for other connector to finish refreshing token before
      // saying the other connector's refresh failed
      this.refreshWaitCountLimit = 10;
      this.refreshInitialBackoff = 1000;
      this.refreshBackoffIncrement = 1.4;
      // should wait 30s after a refresh lock is started before starting
      // another token refresh
      this.concurrentRefreshLockTimeout = 30000;

      this.accessTokenRetryDelay = 10000;
    }

    /**
     * Called during connector initialization to allow the connector to register additional, application-specific
     * routes on the provided Express router.
     * @param {*} app Express router
     */
    onCreate(app: express.Router) {
      super.onCreate(app);

      /**
       * Sets up the execution context and logs that a request was received.
       *
       * It would be nice to be able to add additional logging in the response's
       * finish event (i.e. use res.on('finish'...)) but our asynchronous logging
       * does not complete reliably in this case--the connection to Hyperproof is
       * often disconnected.
       */
      app.use(async (req, res, next) => {
        // When Hyperproof sends a request to an integration it includes the public API
        // subscription key and the Hyperproof OAuth client secret as headers.  If
        // these values are present in the request, stash them away for future use.
        const subscriptionKey = this.getHeader(req, HttpHeader.SubscriptionKey);
        if (subscriptionKey) {
          HyperproofApiClient.setSubscriptionKey(subscriptionKey);
        }
        Logger.init(
          subscriptionKey ?? process.env.hyperproof_api_subscription_key
        );

        this.setHyperproofClientSecret(req);

        const asyncLocalStore = await this.createAsyncLocalStorageContext(req);
        asyncLocalStorage.run(asyncLocalStore, async () => {
          await Logger.info(`${req.method} ${req.originalUrl}`);
          next();
        });
      });

      /**
       * Checks if the connector exists and is reachable
       */
      app.head('/', async (req: express.Request, res: express.Response) => {
        res.end();
      });

      /**
       * Returns authorization configuration information.
       */
      app.get(
        '/authorization/config',
        async (req: express.Request, res: express.Response) => {
          const integrationType =
            (req.query.integrationType as string | undefined) ??
            this.integrationType;
          const config = getHyperproofAuthConfig(
            req.fusebit,
            integrationType,
            this.authorizationType,
            this.outboundOnly(integrationType, req.query)
          );
          this.applyAdditionalAuthorizationConfig(config, req.query);
          res.json(config);
        }
      );

      /**
       * Sets a Hyperproof authorization code for a user.
       */
      app.put(
        [
          '/organizations/:orgId/users/:userId/authorization/code',
          '/organizations/:orgId/users/:userId/:type/authorization/code'
        ],
        this.checkAuthorized(),
        async (
          req: express.Request,
          res: express.Response,
          next: express.NextFunction
        ) => {
          const integrationContext = req.fusebit;

          // Some vendors use a purely numeric ID.  Make sure we treat
          // all vendor user IDs as strings.
          const vendorUserId = req.body.vendorUserId.toString();

          // For Slack the type route param is an integration type value.
          // For other connectors the type param is not specified.
          // TODO: HYP-23126: Figure out how to make this less confusing.

          try {
            // Exchange the authorization code for an access token. This will also
            // save the access token to Fusebit storage.
            await getHyperproofAccessToken(
              integrationContext,
              req.params.orgId,
              req.params.userId,
              vendorUserId,
              req.body.authorizationCode
            );

            res.send(
              await this.getUserConnection(
                integrationContext,
                req.params.orgId,
                req.params.userId,
                vendorUserId,
                req.params.type
              )
            );
          } catch (err: any) {
            next(err);
          }
        }
      );

      /**
       * Checks the health of connection for a given vendorUserId.
       * This called by Hyperproof to verify that the connection is still valid and
       * that the user can still access the service.  Returns an IConnectionHealth object
       * indicating the health status of a connection to include message, details,
       * and resulting external service HTTP status code.
       */
      app.put(
        [
          '/organizations/:orgId/users/:userId/connections/:vendorUserId/connectionhealth'
        ],
        this.checkAuthorized(),
        async (
          req: express.Request,
          res: express.Response,
          next: express.NextFunction
        ) => {
          try {
            const integrationContext = req.fusebit;
            const { orgId, userId, vendorUserId } = req.params;

            const result = await this.checkConnectionHealth(
              integrationContext,
              orgId,
              userId,
              vendorUserId,
              req.body
            );
            return res.json(result);
          } catch (err: any) {
            next(err);
          }
        }
      );

      /**
       * Retrieves a user connection by connection ID.
       */
      app.get(
        [
          '/organizations/:orgId/users/:userId/connections/:vendorUserId',
          '/organizations/:orgId/users/:userId/:type/connections/:vendorUserId'
        ],
        this.checkAuthorized(),
        async (
          req: express.Request,
          res: express.Response,
          next: express.NextFunction
        ) => {
          try {
            const integrationContext = req.fusebit;
            const { orgId, userId, vendorUserId, type } = req.params;

            const connection = await this.getUserConnection(
              integrationContext,
              orgId,
              userId,
              vendorUserId,
              type
            );
            if (connection) {
              res.json(connection);
            } else {
              res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
                message: `Connection with id ${vendorUserId} not found for user ${userId} in org ${orgId}.`
              });
            }
          } catch (err: any) {
            next(err);
          }
        }
      );

      /**
       * Delete a hyperproof-user entry directly by orgId and userId
       */
      app.delete(
        '/organizations/:orgId/users/:userId/oauthorizations',
        this.checkAuthorized(),
        async (
          req: express.Request,
          res: express.Response,
          next: express.NextFunction
        ) => {
          try {
            const integrationContext = req.fusebit;
            const { orgId, userId } = req.params;
            await this.deleteHyperproofUserOAuthorization(
              integrationContext,
              orgId,
              userId
            );
            res.status(StatusCodes.NO_CONTENT).end();
          } catch (err: any) {
            next(err);
          }
        }
      );

      /**
       * Delete a vendor-user entry directly by externalUserId/vendorUserId
       */
      app.delete(
        '/credentials/:externalUserId',
        this.checkAuthorized(),
        async (
          req: express.Request,
          res: express.Response,
          next: express.NextFunction
        ) => {
          try {
            const integrationContext = req.fusebit;
            const { externalUserId } = req.params;
            await this.deleteUser(integrationContext, externalUserId);
            res.status(StatusCodes.NO_CONTENT).end();
          } catch (err: any) {
            next(err);
          }
        }
      );

      app.post(
        '/organizations/:orgId/users/:userId/testpermissions',
        this.checkAuthorized(),
        async (req, res, next: express.NextFunction) => {
          try {
            const { orgId, userId } = req.params;
            const permissionsResponse = await this.testPermissions(
              req.fusebit,
              orgId,
              userId,
              req.body
            );
            res.json(permissionsResponse);
          } catch (err: any) {
            next(err);
          }
        }
      );

      /**
       * Retrieve this app's definition
       */
      app.get(
        '/files',
        this.checkAuthorized(),
        async (req, res, next: express.NextFunction) => {
          try {
            if (!req.query.fileName) {
              res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
                message: `Specify a fileName query parameter to retrieve`
              });
              return;
            }
            await this.serveStaticFile(req.query.fileName as string, res);
          } catch (err: any) {
            next(err);
          }
        }
      );

      // Register the error handler
      app.use(errorHandler);
    }

    /**
     * Whether this connector only communicates outbound from hyperproof. By default all connectors are 2 way
     */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    outboundOnly(integrationType: string, meta: ParsedQs) {
      return false;
    }

    /**
     * Shared express middleware that authorizes the requesting users permissions to access this connector function
     */
    checkAuthorized() {
      return this.authorize({
        action: 'function:execute',
        resourceFactory: req =>
          `/account/${req.fusebit.accountId}/subscription/${req.fusebit.subscriptionId}/boundary/${req.fusebit.boundaryId}/function/${req.fusebit.functionId}/`
      });
    }

    /**
     * Returns a string uniquely identifying the user in vendor's system. Typically this is a property of
     * userContext.vendorUserProfile. Default implementation is opportunistically returning userContext.vendorUserProfile.id
     * if it exists.
     * @param {*} userContext The user context representing the vendor's user. Contains vendorToken and vendorUserProfile, representing responses
     * from getAccessToken and getUserProfile, respectively.
     */
    getUserId(userContext: UserContext): Promise<string> {
      // Derived classes will generally override this method.
      return super.getUserId(userContext);
    }

    /**
     * Returns a human readable string which identifies the vendor user's account.
     * This string is displayed in Hypersync's Connected Accounts page to help the
     * user distinguish between multiple connections that use different accounts.
     *
     * @param {*} userContext The user context representing the vendor's user. Contains vendorToken and vendorUserProfile, representing responses
     * from getAccessToken and getUserProfile, respectively.
     */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    getUserAccount(userContext: UserContext): string {
      throw new Error('getUserAccount must be implemented by derived class');
    }

    /**
     * Formats the foreign-vendor-user/hyperproof storage key that points to the vendorUser token credentials. Overriden
     * by jira and slack as their keys are formatted slightly differently
     */
    getHyperproofUserStorageKey(
      orgId: string,
      userId: string,
      resource?: string,
      suffix?: string
    ) {
      return formatUserKey(orgId, userId, suffix);
    }

    /**
     * Can be overriden to add more parameters to the authorization config returned by the /config route as AWS does.
     */
    applyAdditionalAuthorizationConfig(
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      config: IAuthorizationConfigBase,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      meta: ParsedQs
    ): void {
      // custom auth apps can override this method to add fields to intake user credentials
    }

    /**
     * Can be overriden as a custom error handling callback on the call to delete users
     * swallow by default as failure to delete here should not impede the rest of the delete logic
     */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async deleteUserErrorCallback(err: any) {
      // override in derived class
    }

    /**
     * Gets the Hyperproof user context representing the user with vendorUserId id.
     * Returned object contains vendorToken and vendorUserProfile properties.
     *
     * @param {IntegrationContext} integrationContext The integration context
     * @param {string} vendorUserId The vendor user id
     * @param {string} vendorId If specified, vendorUserId represents the identity of the user in another system.
     */
    async getHyperproofUserContext<TUserProfile extends object = object>(
      integrationContext: IntegrationContext,
      vendorUserId: string,
      vendorId?: string
    ) {
      return (await this.getUser(
        integrationContext,
        vendorUserId,
        vendorId
      )) as IHyperproofUserContext<TUserProfile>;
    }

    /**
     * Extracts linked Hyperproof user information from a Fusebit userContext object.
     * @param {*} userContext The user context representing the vendor's user. Contains
     *  vendorToken and vendorUserProfile, representing responses from getAccessToken and
     *  getUserProfile, respectively.
     *
     * WARNING: This pulls data out of userContext.foreignOAuthIdentities.hyperproof which
     * is a singleton.  For multi-org scenarios, the value is correct upon adding a new
     * connection to an org, but as connections are deleted the org ID inside the user key
     * can be come stale.  See HYP-16177 for an example.
     */
    getHpUserFromUserContext(userContext: UserContext) {
      const userKey = userContext.foreignOAuthIdentities
        ? userContext.foreignOAuthIdentities.hyperproof.userId
        : undefined;
      if (!userKey) {
        return undefined;
      }
      return getHpUserFromUserKey(userKey);
    }

    /**
     * Task Apps do not store connections in storage, so we manufacture the connection information
     */
    async getUserConnection(
      integrationContext: IntegrationContext,
      orgId: string,
      userId: string,
      vendorUserId: string,
      // Used by Slack to differentiate between its two integrationTypes
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      integrationType?: string
    ): Promise<IUserConnection> {
      const userContext = await this.getHyperproofUserContext(
        integrationContext,
        vendorUserId
      );
      return this.getUserConnectionFromUserContext(userContext, userId);
    }

    /**
     * Builds a connection object from the data stored in user context.
     *
     * @param userContext User context from which to build the connection.
     * @param userId ID of the Hyperproof user that created the connection.
     */
    async getUserConnectionFromUserContext(
      userContext: UserContext,
      userId: string,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      userKey?: string
    ): Promise<IUserConnection> {
      // Some connectors have a numeric user ID (e.g. Jamf and Github) but we
      // always want to deal with them as strings, hence toString below.
      return {
        vendorUserId: userContext.vendorUserId.toString(),
        type: this.integrationType,
        name: this.connectorName,
        account: this.getUserAccount(userContext),
        enabled: true,
        createdBy: userId,
        createdOn: new Date(userContext.timestamp).toISOString()
      };
    }

    async deleteHyperproofUserOAuthorization(
      integrationContext: IntegrationContext,
      orgId: string,
      userId: string
    ) {
      const location = `${HYPERPROOF_USER_STORAGE_ID}/${formatUserKey(
        orgId,
        userId
      )}`;
      await Logger.info(
        `Deleting Hyperproof user oauthorization at ${location}`
      );
      await integrationContext.storage.delete(location);
    }

    /**
     * Validates custom auth credentials that are provided when creating a new
     * new user connection.  Designed to be overridden.
     *
     * @returns An object containing values to be persisted in UserContext.
     */
    async validateCredentials(
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      credentials: CustomAuthCredentials,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      integrationContext: IntegrationContext,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      hyperproofUserId: string,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      externalUserId: string
    ): Promise<IValidateCredentialsResponse> {
      throw createHttpError(StatusCodes.NOT_IMPLEMENTED, 'Not Implemented');
    }

    /**
     * Validate access token of the OAuth connector. This must be implemented by the connector.
     *
     * The connector's implementation should not handle any error so that it can be handled in checkConnectionHealth
     */
    async validateAccessToken(
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      integrationContext: IntegrationContext,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      userContext: UserContext,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      accessToken: string,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      body?: ICheckConnectionHealthInvocationPayload
    ): Promise<void> {
      throw createHttpError(StatusCodes.NOT_IMPLEMENTED, 'Not Implemented');
    }

    async checkConnectionHealth(
      integrationContext: IntegrationContext,
      orgId: string,
      userId: string,
      vendorUserId: string,
      body?: ICheckConnectionHealthInvocationPayload
    ): Promise<IConnectionHealth> {
      try {
        const userContext = await this.getHyperproofUserContext(
          integrationContext,
          vendorUserId
        );

        // we'll need to allow JiraHS to find its userContext using hostUrl
        if (!userContext) {
          throw createHttpError(
            StatusCodes.NOT_FOUND,
            this.getUserNotFoundMessage(vendorUserId)
          );
        }

        if (this.authorizationType === AuthorizationType.CUSTOM) {
          // NOTE: calling this will not save any token retrieved from the corresponding service to the vendor-user.
          // In the case of AWS, the temporary token for cross-account role auth is saved in vendor-user for each sync, but not saved by validateCredentials itself.
          // Since the token is temporary they will expire in an hour and way before AWS scheduled syncs are run and thus no reason to save it in this step.
          await this.validateCredentials(
            userContext.keys!,
            integrationContext,
            userId,
            vendorUserId
          );
        } else {
          const tokenResponse = await this.ensureAccessToken(
            integrationContext,
            userContext
          );

          await this.validateAccessToken(
            integrationContext,
            userContext,
            tokenResponse.access_token,
            body
          );
        }
      } catch (e: any) {
        // The connector can customize the health result status and message here.
        // However custom connectors' validateCredentials may have already handled the
        // error and threw a different error/status code.
        const healthResult = this.handleHealthError(e);

        if (healthResult.healthStatus === HealthStatus.NotImplemented) {
          await Logger.info(
            `Connection health check found the connector did not implement validate credentials function.`
          );
        } else if (healthResult.healthStatus === HealthStatus.Unhealthy) {
          if (healthResult.statusCode === StatusCodes.NOT_FOUND) {
            await Logger.info(
              `Connection health check returned an unhealthy response: ${this.getUserNotFoundMessage(
                vendorUserId
              )}`
            );
          } else {
            await Logger.info(
              `Connection health check returned an unhealthy response: ${healthResult.message}`
            );
          }
        } else if (healthResult.healthStatus === HealthStatus.Unknown) {
          await Logger.warn(
            `Connection health check returned an unknown error: ${healthResult.message}`
          );
        }

        return healthResult;
      }

      return {
        healthStatus: HealthStatus.Healthy,
        message: undefined,
        details: undefined,
        statusCode: StatusCodes.OK
      };
    }

    getUserNotFoundMessage(vendorUserId: string) {
      return `No ${this.connectorName} account found with id ${vendorUserId}. The connection may have been deleted.`;
    }

    handleHealthError(error: any): IConnectionHealth {
      const errorMessage = error.message;
      const extendedErrorMessage = error[LogContextKey.ExtendedMessage];
      const healthResult: Readonly<IConnectionHealth> = {
        healthStatus: HealthStatus.Unknown,
        message: `Error: ${
          extendedErrorMessage ? extendedErrorMessage : errorMessage
        }`,
        details: undefined,
        statusCode: error.statusCode || StatusCodes.INTERNAL_SERVER_ERROR
      };
      const statusCode = error.statusCode ?? error.status;
      switch (statusCode) {
        case StatusCodes.NOT_FOUND:
          return {
            ...healthResult,
            healthStatus: HealthStatus.Unhealthy,
            message: `Hyperproof cannot connect to ${this.connectorName}, your credentials may have expired. Try Update Credentials in Hyperproof and if that doesn't fix the connection, contact your system admin.`
          };
        case StatusCodes.UNAUTHORIZED:
        case StatusCodes.FORBIDDEN:
          return {
            ...healthResult,
            healthStatus: HealthStatus.Unhealthy,
            message: extendedErrorMessage ? extendedErrorMessage : errorMessage
          };
        case StatusCodes.NOT_IMPLEMENTED:
          return {
            ...healthResult,
            healthStatus: HealthStatus.NotImplemented,
            message: 'The function for validating token is not implemented.'
          };
        case StatusCodes.SERVICE_UNAVAILABLE:
          return {
            ...healthResult,
            healthStatus: HealthStatus.Unhealthy,
            message: extendedErrorMessage ? extendedErrorMessage : errorMessage
          };
      }

      return healthResult;
    }

    /**
     * Awaitable sleep function.
     *
     * @param {} ms Milliseconds to sleep.
     */
    sleep = (ms: number) => {
      return new Promise(resolve => setTimeout(resolve, ms));
    };

    /**
     * We wrap the original implementation of this function because it throws 500 errors on
     * refresh token issues, and we want to propagate those as 401 instead
     */
    override async ensureAccessToken(
      integrationContext: IntegrationContext,
      userContext: UserContext,
      foreignVendorId?: string
    ): Promise<OAuthTokenResponse> {
      return super
        .ensureAccessToken(integrationContext, userContext, foreignVendorId)
        .catch(async (err: any) => {
          // If two API requests refresh a token simultaneously, one of them may return a 409
          // We want to retry in that case, since there should be a fresh token available now
          // In the future, we may want to selectively catch only CONFLICT responses for retry
          await Logger.warn(
            `Encountered an error refreshing access token. Retrying...`,
            JSON.stringify({
              [LogContextKey.Message]: err.message,
              [LogContextKey.StatusCode]: err.statusCode,
              [LogContextKey.StackTrace]: err.stack
            })
          );
          // Wait 10 seconds to allow time to process any in progress token refreshes, as the token
          // refresh process can take some time.  Also, refetch the userContext as it can change during an async
          // refresh from another job
          return this.sleep(this.accessTokenRetryDelay).then(async () => {
            const refetchedUserContext = await this.getUser(
              integrationContext,
              userContext.vendorUserId
            );
            return super.ensureAccessToken(
              integrationContext,
              refetchedUserContext || userContext, // getUser can return undefined, so in that case just use the existing context
              foreignVendorId
            );
          });
        })
        .catch((err: any) => {
          throw createHttpError(StatusCodes.UNAUTHORIZED, err.message, {
            ...err,
            [LogContextKey.ApiUrl]:
              integrationContext?.configuration?.oauth_token_url
          });
        });
    }

    /**
     * Returns the HTML of the web page that initiates the authorization flow to the authorizationUrl. Return
     * undefined if you don't want to present any HTML to the user but instead redirect the user directly to
     * the authorizationUrl.
     * @param {IntegrationContext} integrationContext The integration context of the request
     * @param {string} authorizationUrl The fully formed authorization url to redirect the user to
     */
    override async getAuthorizationPageHtml(
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      integrationContext: IntegrationContext,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      authorizationUrl: string
    ) {
      return undefined;
    }

    decodeState(integrationContext: IntegrationContext) {
      if (integrationContext.query?.state)
        return JSON.parse(
          Buffer.from(
            integrationContext.query.state as string,
            'base64'
          ).toString()
        );
    }

    async testPermissions(
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      integrationContext: IntegrationContext,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      orgId: string,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      userId: string,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      body: ITestExternalPermissionsBody
    ): Promise<ITestExternalPermissionsResponse> {
      return { permissions: [] };
    }

    async serveStaticFile(fileName: string, res: express.Response) {
      try {
        const filePath = this.getAbsolutePath(fileName);
        const fileExtension = filePath.slice(filePath.lastIndexOf('.'));
        let rawData: string;
        debug(`Retrieving static file from ${filePath}`);
        switch (fileExtension) {
          case '.json': {
            rawData = fs.readFileSync(filePath, { encoding: 'utf8' });
            const jsonData = JSON.parse(rawData);
            res.json(jsonData);
            break;
          }
          case '.svg': {
            rawData = fs.readFileSync(filePath, { encoding: 'utf8' });
            res.set('Content-Type', 'image/svg+xml');
            res.end(rawData);
            break;
          }
          default: {
            res
              .status(StatusCodes.BAD_REQUEST)
              .json({ message: `File type ${fileExtension} is not supported` });
            break;
          }
        }
      } catch (err: any) {
        debug(`Caught error accessing local file: ${err.message}`);
        throw createHttpError(StatusCodes.INTERNAL_SERVER_ERROR);
      }
    }

    getAbsolutePath(fileName: string) {
      const relativePath =
        process.env.integration_platform === 'azure'
          ? `./static/${fileName}`
          : `./app/static/${fileName}`;
      const absolutePath = path.resolve(relativePath);
      return absolutePath;
    }

    setHyperproofClientSecret(req: express.Request) {
      const clientSecret = this.getHeader(
        req,
        HttpHeader.HyperproofClientSecret
      );
      if (clientSecret) {
        setHyperproofClientSecret(clientSecret);
      }
    }

    async createAsyncLocalStorageContext(
      req: express.Request
    ): Promise<IAsyncStore> {
      const baggage = this.getHeader(req, HttpHeader.Baggage);
      const traceParent = this.getHeader(req, HttpHeader.TraceParent);

      const { orgId, userId } = this.getIdsFromUrl(req.url);
      const loggerContext: LoggerContext = {
        [LoggerContextKey.IntegrationType]: this.integrationType,
        [LoggerContextKey.OrgId]: orgId,
        [LoggerContextKey.UserId]: userId
      };

      const externalServiceHeaders = await this.getExternalServiceHeaders(req);

      return { baggage, traceParent, loggerContext, externalServiceHeaders };
    }

    async getExternalServiceHeaders(
      req: express.Request
    ): Promise<{ [key: string]: string } | undefined> {
      const encodedExternalServiceHeaders = this.getHeader(
        req,
        HttpHeader.ExternalServiceHeaders
      );
      try {
        return encodedExternalServiceHeaders
          ? JSON.parse(decodeURIComponent(encodedExternalServiceHeaders))
          : undefined;
      } catch (e: any) {
        await Logger.error(`Failed to parse external service headers`, e);
      }
    }

    getHeader(req: express.Request, headerName: HttpHeader) {
      const header = req.headers[headerName];
      return Array.isArray(header) ? header[0] : header;
    }

    getIdsFromUrl(url: string) {
      let orgId: string | undefined;
      let userId: string | undefined;
      const parts = url.split('/');

      for (let i = 0; i < parts.length - 1; i++) {
        if (parts[i] === 'organizations') {
          orgId = parts[i + 1];
        } else if (parts[i] === 'users') {
          userId = parts[i + 1];
        }
      }

      return { orgId, userId };
    }
  };
}
