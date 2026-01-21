import * as uuid from 'uuid';
import { OAuthConnector, UserContext } from './OAuthConnector';

import { StatusCodes } from 'http-status-codes';

import {
  completeWithSuccess,
  debug,
  FunctionData,
  FunctionState,
  IntegrationContext,
  redirect,
  serializeState
} from '../add-on-sdk';

const SAVED_STATE_COOKIE = 'savedstate';

const createHttpException = (
  status: StatusCodes,
  message: string,
  state: any
) => ({
  status,
  message,
  state
});

const configure = (connector: OAuthConnector) => {
  const settingsManagers = async (
    ctx: IntegrationContext,
    state: FunctionState,
    data: FunctionData
  ) => {
    // Run through optional additional settings managers

    debug('SETTINGS MANAGERS', state, data);

    if (!data.fusebit_skip_settings_managers) {
      const settingsManagers: string[] = [];
      (ctx.configuration.fusebit_settings_managers || '')
        .split(',')
        .forEach(s => {
          if (s.trim()) {
            settingsManagers.push(s);
          }
        });
      const stage = state.settingsManagersStage || 0;
      if (settingsManagers.length > stage) {
        // Invoke subsequent settings manager
        state.settingsManagersStage = stage + 1;
        return redirect(
          ctx,
          state,
          data,
          settingsManagers[stage],
          'settingsManagers'
        );
      }
    }

    // All settings managers processed (or nonde defined), or skipped, post-process user context
    // to populate foreign identities
    const vendorUserId =
      data[`${ctx.configuration.vendor_prefix}_oauth_user_id`];
    try {
      const userContext = await connector.getUser(ctx, vendorUserId);
      if (!userContext) {
        throw new Error(`Unable to load user ${vendorUserId}`);
      }
      await connector.onConfigurationComplete(ctx, userContext, data);
      await connector.onNewUser(ctx, userContext);
      await connector.saveUser(ctx, userContext);
    } catch (e: any) {
      debug('ERROR POST-PROCESSING USER CONTEXT', e);
      await connector.deleteUser(ctx, vendorUserId);
      throw createHttpException(
        StatusCodes.INTERNAL_SERVER_ERROR,
        `Error initializing new user: ${e.message}`,
        state
      );
    }

    // Complete the configuration flow
    delete data.fusebit_skip_settings_managers;
    return completeWithSuccess(state, data);
  };

  const authInit = async (
    ctx: IntegrationContext,
    state: FunctionState,
    data: FunctionData
  ) => {
    // Initiate authentication

    debug('AUTH INIT', state, data);

    state.configurationState = 'authCallback';
    data.stateParam = uuid.v4().replace(/-/g, '');
    state.data = data;
    const serializedState = serializeState(state);

    const authorizationUrl = await connector.getAuthorizationUrl(
      ctx,
      serializedState,
      `${ctx.baseUrl}/callback`
    );

    const view = await connector.getAuthorizationPageHtml(
      ctx,
      authorizationUrl
    );

    return view
      ? {
          status: 200,
          body: view,
          bodyEncoding: 'utf8',
          headers: { 'content-type': 'text/html' }
        }
      : {
          status: 302,
          headers: {
            location: authorizationUrl,
            ['set-cookie']: `${SAVED_STATE_COOKIE}=${serializedState}; Secure; HttpOnly`
          }
        };
  };

  const authCallback = async (
    ctx: IntegrationContext,
    state: FunctionState
  ) => {
    // Process OAuth callback

    let savedState;
    const cookieHeader = ctx.headers?.cookie;
    if (cookieHeader) {
      cookieHeader.split(';').forEach(cookie => {
        // Can't use split--value may have = chars.
        const index = cookie.indexOf('=');
        if (index > 0) {
          if (
            cookie.substring(0, index).trim().toLowerCase() ===
            SAVED_STATE_COOKIE
          ) {
            savedState = cookie.substring(index + 1).trim();
          }
        }
      });
    }

    if (serializeState(state) !== savedState) {
      debug('CALLBACK STATE DOES NOT MATCH SAVED STATE');
      throw createHttpException(
        StatusCodes.UNAUTHORIZED,
        'Error processing authorization code response.',
        state
      );
    }

    let vendorUserId = '';
    let userPersisted = false;
    let userContext: UserContext;
    if (ctx.query?.code) {
      try {
        const vendorToken = await connector.getAccessToken(
          ctx,
          ctx.query.code as string,
          `${ctx.baseUrl}/callback`
        );
        if (!isNaN(vendorToken.expires_in)) {
          vendorToken.expires_at = Date.now() + +vendorToken.expires_in * 1000;
        }
        userContext = {
          status: 'authenticated',
          vendorToken,
          vendorUserProfile: await connector.getUserProfile(vendorToken),
          timestamp: Date.now(),
          vendorUserId
        };
        userContext.vendorUserId = vendorUserId = await connector.getUserId(
          userContext
        );
        await connector.onConfigurationComplete(ctx, userContext, state.data);
        await connector.saveUser(ctx, userContext);
        userPersisted = true;
      } catch (e: any) {
        debug('AUTHORIZATION CODE EXCHANGE ERROR', e);
        if (userPersisted) {
          await connector.deleteUser(ctx, vendorUserId);
        }
        throw createHttpException(
          StatusCodes.INTERNAL_SERVER_ERROR,
          `Error exchanging the authorization code for an access token: ${e.message}`,
          state
        );
      }
      const data = { ...state.data };
      data[`${ctx.configuration.vendor_prefix}_oauth_user_id`] = vendorUserId;
      data[`${ctx.configuration.vendor_prefix}_oauth_connector_base_url`] =
        ctx.baseUrl;
      state.configurationState = 'settingsManagers';
      return settingsManagers(ctx, state, data);
    } else {
      throw createHttpException(
        StatusCodes.INTERNAL_SERVER_ERROR,
        `Authentication failed: ${
          ctx.query?.error_description || ctx.query?.error || 'Unknown error'
        }`,
        state
      );
    }
  };

  return {
    initialState: 'authInit',
    states: { settingsManagers, authInit, authCallback }
  };
};

export default configure;
