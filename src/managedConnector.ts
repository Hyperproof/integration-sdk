import { IntegrationContext } from './add-on-sdk';
import {
  addVendorUserIdToHyperproofUser,
  deleteHyperproofUser,
  getVendorUserIdsFromHyperproofUser,
  HYPERPROOF_USER_STORAGE_ID,
  Logger,
  removeVendorUserIdFromHyperproofUser
} from './hyperproof-api';
import { FOREIGN_VENDOR_USER, HYPERPROOF_VENDOR_KEY } from './models';
import { OAuthConnector } from './oauth-connector';
import {
  createConnector,
  IHyperproofUserContext,
  IUserConnection
} from './sharedConnector';
import {
  formatUserKey,
  getHpUserFromUserKey,
  listAllStorageKeys,
  parseStorageKeyFromStorageId
} from './util';

import express from 'express';
import createHttpError from 'http-errors';
import { StatusCodes } from 'http-status-codes';

/**
 * Extends the createConnector function to inject additional functionality to the superclass for
 * managing user connections in connector storage. Originally, every connector used this logic, but
 * were later moved their connections management to the backend.
 *
 * The extensions provided here handle the creation and deletion of users that can have multiple
 * hypeproof identities associated with the same vendor identity. This logic enables us to track all
 * hyperproof identities associated with a user, rather than erasing the context of the previous ones
 * on every subsequent save. We do this by adding a hyperproofIdentities key to the user object and
 * only delete the user if there are no more hyperproof identities referring to this user
 */
export function createManagedConnector(superclass: typeof OAuthConnector) {
  return class ManagedConnector extends createConnector(superclass) {
    onCreate(app: express.Router) {
      super.onCreate(app);

      /**
       * Retrieves a list of connections created by a user.
       */
      app.get(
        [
          '/organizations/:orgId/users/:userId/connections',
          '/organizations/:orgId/users/:userId/:type/connections'
        ],
        this.checkAuthorized(),
        async (
          req: express.Request,
          res: express.Response,
          next: express.NextFunction
        ) => {
          try {
            const integrationContext = req.fusebit;
            const { orgId, userId, type } = req.params;

            const connections = await this.getUserConnections(
              integrationContext,
              orgId,
              userId,
              type
            );
            if (connections.length > 0) {
              return res.json(connections);
            } else {
              return res
                .status(StatusCodes.NOT_FOUND)
                .json({ message: `no user with userId ${userId} found` });
            }
          } catch (err: any) {
            next(err);
          }
        }
      );

      /**
       * Deletes all connections for a given integration and Hyperproof user id.
       * This is invoked when a Hyperproof user is deactivated.
       */
      app.delete(
        [
          '/organizations/:orgId/users/:userId/connections',
          '/organizations/:orgId/users/:userId/:type/connections'
        ],
        this.checkAuthorized(),
        async (
          req: express.Request,
          res: express.Response,
          next: express.NextFunction
        ) => {
          try {
            const integrationContext = req.fusebit;
            const { orgId, userId, type } = req.params;

            // In the Slack connector the type passed in is an integration type value.
            // For all other connections the type route parameter is not used.
            // TODO: HYP-23126: Figure out how to make this less confusing.

            const connections = await this.getUserConnections(
              integrationContext,
              orgId,
              userId,
              type
            );

            const results: {
              [vendorUserId: string]: { success: boolean; err: any };
            } = {};

            for (const connection of connections) {
              let success = true;
              let err = undefined;
              try {
                await this.deleteUserConnection(
                  integrationContext,
                  orgId,
                  userId,
                  connection.vendorUserId,
                  connection.hostUrl
                );
              } catch (error: any) {
                success = false;
                err = error.message;
              }
              results[connection.vendorUserId] = {
                success,
                err
              };
            }

            res.json({
              message: `Attempted to delete connections for user ${userId} in organization ${orgId}`,
              results
            });
          } catch (err: any) {
            next(err);
          }
        }
      );

      /**
       * Deletes a user connection by connection ID.
       */
      app.delete(
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
            const { orgId, userId, vendorUserId } = req.params;
            const { resource } = req.query;

            // In the Slack case it is an integration type value.  So technically in the Slack
            // case the cast below is invalid.  But Slack overrides `deleteUserConnection` and
            // ignores the type parameter, so there is no issue.  Still, we should clean this up.

            await this.deleteUserConnection(
              integrationContext,
              orgId,
              userId,
              vendorUserId,
              resource as string
            );

            res.json({
              message: `Connection for user ${formatUserKey(
                orgId,
                userId
              )} successfully deleted`
            });
          } catch (err: any) {
            next(err);
          }
        }
      );
    }

    /**
     * Deletes all artifacts associated with a vendor user. This is an opportunity to remove any artifacts created in
     * onNewUser, for example integration functions.
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
      await Logger.info(`Deleting user ${vendorUserId} for vendor ${vendorId}`);
      const user = await this.getHyperproofUserContext(
        integrationContext,
        vendorUserId,
        vendorId
      );

      if (vendorId) {
        if (user) {
          await this.deleteUserIfLast(
            integrationContext,
            user,
            vendorUserId,
            vendorId
          );
        } else {
          throw createHttpError(
            StatusCodes.NOT_FOUND,
            `No user with id ${vendorUserId} vendor: ${vendorId}`
          );
        }
      } else {
        const state = this.decodeState(integrationContext);
        const hpUserId = state?.data?.hyperproof_oauth_user_id;
        // this delete came from authorizing
        if (user) {
          if (state && user.hyperproofIdentities) {
            await this.deleteUserIfLast(
              integrationContext,
              user,
              hpUserId,
              'hyperproof'
            );
          } else {
            await Logger.info(
              `no vendorId specified for user ${vendorUserId}, deleting user`
            );
            await super.deleteUser(integrationContext, vendorUserId, vendorId);
          }
        }
      }
    }

    async deleteUserIfLast(
      integrationContext: IntegrationContext,
      user: IHyperproofUserContext,
      vendorUserId: string,
      vendorId: string
    ) {
      const hyperproofIdentities = user.hyperproofIdentities || {};
      delete hyperproofIdentities[vendorUserId];
      const numIdentities = Object.keys(hyperproofIdentities);
      if (numIdentities.length > 0) {
        await Logger.info(
          `user ${vendorUserId} for vendor ${vendorId} has ${numIdentities.length} remaining hyperproof identities, not deleting user`
        );
        await super.saveUser(integrationContext, user);
        await integrationContext.storage.delete(
          `${FOREIGN_VENDOR_USER}/${vendorId}/${vendorUserId}`
        );
      } else {
        await Logger.info(
          `user ${vendorUserId} for vendor ${vendorId} has no remaining hyperproof identities, DELETING user`
        );
        await integrationContext.storage.delete(
          `${FOREIGN_VENDOR_USER}/${vendorId}/${vendorUserId}`
        );
        await super.deleteUser(integrationContext, user.vendorUserId);
      }
    }

    /**
     * Deletes the user's Hyperproof token unless there are other user connections
     * which are depending on that token.
     *
     * @param {IntegrationContext} integrationContext The integration context of the request
     * @param {*} orgId ID of the Hyperproof organization.
     * @param {*} userId ID of the Hyperproof user.
     */
    async deleteHyperproofUserIfUnused(
      integrationContext: IntegrationContext,
      orgId: string,
      userId: string,
      vendorUserId: string
    ) {
      const connections = await this.getUserConnections(
        integrationContext,
        orgId,
        userId
      );

      if (connections.length === 0) {
        await deleteHyperproofUser(integrationContext, orgId, userId).catch(
          this.deleteUserErrorCallback
        );
      } else {
        await Logger.info(
          `Not deleting Hyperproof user ${userId} because other connections exist for this user.`
        );
        await removeVendorUserIdFromHyperproofUser(
          integrationContext,
          orgId,
          userId,
          vendorUserId
        );
      }
    }

    /**
     * Saves user context in storage for future use.
     * @param {IntegrationContext} integrationContext The integration context of the request
     * @param {*} userContext The user context representing the vendor's user. Contains vendorToken and vendorUserProfile, representing responses
     * from getAccessToken and getUserProfile, respectively.
     */
    async saveUser(
      integrationContext: IntegrationContext,
      userContext: IHyperproofUserContext
    ) {
      const existingUser = await this.getHyperproofUserContext(
        integrationContext,
        userContext.vendorUserId
      );

      const hyperproofIdentities = existingUser?.hyperproofIdentities ?? {};

      if (userContext.foreignOAuthIdentities) {
        hyperproofIdentities[
          userContext.foreignOAuthIdentities.hyperproof.userId
        ] = userContext.foreignOAuthIdentities.hyperproof;
      }

      userContext.hyperproofIdentities = hyperproofIdentities;

      const hpUser = this.getHpUserFromUserContext(userContext);
      // Integrations that don't require an associated hyperproof user will not have
      // this. For example, the workspace vendor-user entry for Slack integrations
      if (hpUser) {
        await addVendorUserIdToHyperproofUser(
          integrationContext,
          hpUser.orgId,
          hpUser.id,
          userContext.vendorUserId
        );
      }

      return super.saveUser(integrationContext, userContext);
    }

    /**
     * Retrieves the list of connections to the service made by a given user
     * in a Hyperproof organization.
     *
     * @param integrationContext Integration context use.
     * @param orgId Unique ID of the Hyperproof organization.
     * @param userId Unique ID of the Hyperproof user.
     * @param type Type of integration (optional).  Used by connectors like Slack
     *             that implement multiple integrations in one connector.
     * @returns An array of connections.
     */
    async getUserConnections(
      integrationContext: IntegrationContext,
      orgId: string,
      userId: string,
      type?: string
    ) {
      const connections = [];
      try {
        const vendorUserIds = await getVendorUserIdsFromHyperproofUser(
          integrationContext,
          orgId,
          userId
        );
        const userKey = formatUserKey(orgId, userId, type);
        for (const vendorUserId of vendorUserIds) {
          const userContext = await this.getHyperproofUserContext(
            integrationContext,
            vendorUserId
          );
          if (userContext?.hyperproofIdentities[userKey]) {
            connections.push(
              await this.getUserConnectionFromUserContext(
                userContext,
                userId,
                userContext.hyperproofIdentities[userKey].userId
              )
            );
          }
        }
      } catch (err: any) {
        if (err.status === StatusCodes.UNAUTHORIZED) {
          // Hyperproof user does not exist.  Therefore there are no
          // corresponding vendorUserIds.
          return [];
        } else {
          throw err;
        }
      }
      return connections;
    }

    /**
     * Retreives a single connection for a Hyperproof user by vendorUserId.
     * override to handle the case where the user has multiple hyperproof identities
     *
     * @param integrationContext Integration context use.
     * @param orgId Unique ID of the Hyperproof organization.
     * @param userId Unique ID of the Hyperproof user.
     * @param vendorUserId ID of the vendor user which uniquely identifies the connection.
     * @param integrationType Type of integration (optional).
     */
    override async getUserConnection(
      integrationContext: IntegrationContext,
      orgId: string,
      userId: string,
      vendorUserId: string,
      integrationType?: string
    ): Promise<IUserConnection> {
      const userContext = await this.getHyperproofUserContext(
        integrationContext,
        vendorUserId
      );
      const userKey = formatUserKey(orgId, userId, integrationType);
      if (!userContext.hyperproofIdentities) {
        return this.getUserConnectionFromUserContext(userContext, userId);
      } else if (userContext.hyperproofIdentities[userKey]) {
        return this.getUserConnectionFromUserContext(
          userContext,
          userId,
          userContext.hyperproofIdentities[userKey].userId
        );
      }
      throw createHttpError(StatusCodes.UNAUTHORIZED, 'No connection');
    }

    /**
     * Deletes a collection of users in an organization.
     *
     * @param {*} integrationContext Integration context to use.
     * @param {*} userContexts Candidate set of vendor users to delete.
     * @param {*} orgId ID of the organization where users are being deleted.
     * @param {*} resource Optional resource to filter for.
     */
    async deleteUserConnections(
      integrationContext: IntegrationContext,
      userContexts: IHyperproofUserContext[],
      orgId: string,
      resource?: string
    ): Promise<void> {
      // Must be deleted sequentially since deleteUserIfLast removes one
      // identity and saves the storage entry. Concurrent writing to one place
      // causes a conflict error
      for (const userContext of userContexts) {
        if (!userContext) {
          return;
        }
        // The vendor user may be linked to a Hyperproof user in multiple
        // organizations.  We only want to delete the Hyperproof users in
        // the specified organization.
        const identityKeys = Object.keys(userContext.hyperproofIdentities);
        let identitiesToDelete = identityKeys.filter(key =>
          key.includes(orgId)
        );

        // If the optional resource was provided, use it to filter the identities.
        if (resource) {
          identitiesToDelete = identitiesToDelete.filter(key =>
            key.includes(resource)
          );
        }

        // Delete the matching identities.  Note that when we delete the last
        // identity on the vendor user, the vendor user will be deleted.
        await Logger.info(
          `On ${
            userContext.vendorUserId
          }, deleting identities: ${identitiesToDelete.toString()}`
        );
        for (const identity of identitiesToDelete) {
          await this.deleteUserIfLast(
            integrationContext,
            userContext,
            identity,
            HYPERPROOF_VENDOR_KEY
          );
        }

        // Delete the Hyperproof token if it is not being used by another connection.
        const hpUserId = this.getHpUserFromUserContext(userContext)!.id;
        await Logger.info(`Deleting hyperproof token for ${hpUserId}`);
        await this.deleteHyperproofUserIfUnused(
          integrationContext,
          orgId,
          hpUserId,
          userContext.vendorUserId
        );
        await Logger.info(
          `Deletion finished for user ${userContext.vendorUserId}`
        );
      }
    }

    /**
     * Deletes a user connection from storage.
     *
     * @param integrationContext Integration context to use.
     * @param orgId Unique ID of the Hyperproof organization.
     * @param userId Unique ID of the Hyperproof user.
     * @param vendorUserId ID of the vendor user which uniquely identifies the connection.
     * @param resource Resource to which the connection applies (optional)
     */
    async deleteUserConnection(
      integrationContext: IntegrationContext,
      orgId: string,
      userId: string,
      vendorUserId: string,
      resource?: string
    ) {
      const user = await this.getHyperproofUserContext(
        integrationContext,
        vendorUserId
      );

      if (!user) {
        throw createHttpError(
          StatusCodes.NOT_FOUND,
          `No connection found for user ${userId} in org ${orgId} with an ID of ${vendorUserId}`
        );
      }

      const userKey = this.getHyperproofUserStorageKey(orgId, userId, resource);

      await this.deleteUserIfLast(
        integrationContext,
        user,
        userKey,
        HYPERPROOF_VENDOR_KEY
      );

      await this.deleteHyperproofUserIfUnused(
        integrationContext,
        orgId,
        userId,
        vendorUserId
      );
    }

    async getAllOrgUsers(
      integrationContext: IntegrationContext,
      orgId: string
    ) {
      try {
        const location = `${HYPERPROOF_USER_STORAGE_ID}/organizations/${orgId}`;
        const items = await listAllStorageKeys(integrationContext, location);
        const users = [];
        const processedUsers = new Set();
        for (const item of items) {
          const hyperproofUserKey = parseStorageKeyFromStorageId(item);
          const userKey = hyperproofUserKey.split(
            `${HYPERPROOF_USER_STORAGE_ID}/`
          )[1];
          const hpUser = getHpUserFromUserKey(userKey);

          if (!processedUsers.has(hpUser.id)) {
            const storageEntry = await integrationContext.storage.get(
              hyperproofUserKey
            );
            const vendorUserIds = storageEntry.data.vendorUserIds || [
              storageEntry.data.vendorUserId
            ];
            for (const vendorUserId of vendorUserIds) {
              const userData = (await this.getUser(
                integrationContext,
                vendorUserId
              )) as IHyperproofUserContext;
              users.push(userData);
            }
            processedUsers.add(hpUser.id);
          }
        }
        await Logger.info(
          `Found ${users.length} vendor-users, connected to ${items.length} hyperproof-users`
        );
        return users;
      } catch (err) {
        await Logger.error(err);
        return [];
      }
    }
  };
}
