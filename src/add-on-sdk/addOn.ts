import {
  FunctionConfiguration,
  FunctionData,
  FunctionError,
  FunctionState,
  IntegrationContext,
  LifeCycleManagerOptions,
  ListStorageOptions
} from './addOnModels';

import bodyParser from 'body-parser';
import express from 'express';
import createHttpError from 'http-errors';
import { StatusCodes } from 'http-status-codes';
import Mock from 'mock-http';
import Superagent from 'superagent';
import Url from 'url';

import { LogContextKey } from '../models';

let logger: (message?: any, ...optionalParams: any[]) => void = console.log;

export function debug(...args: any[]) {
  if (process.env.debug === '1') {
    logger(args);
  }
}

function validateReturnTo(ctx: IntegrationContext) {
  if (ctx.query?.returnTo) {
    const validReturnTo = (
      ctx.configuration.fusebit_allowed_return_to || ''
    ).split(',');
    const match = validReturnTo.find(allowed => {
      if (allowed === ctx.query?.returnTo) {
        return true;
      }
      if (
        allowed[allowed.length - 1] === '*' &&
        ctx.query?.returnTo.indexOf(
          allowed.substring(0, allowed.length - 1)
        ) === 0
      ) {
        return true;
      }
      return false;
    });
    if (!match) {
      throw {
        status: 403,
        message: `The specified 'returnTo' URL '${ctx.query.returnTo}' does not match any of the allowed returnTo URLs of the '${ctx.boundaryId}/${ctx.functionId}' Fusebit Add-On component. If this is a valid request, add the specified 'returnTo' URL to the 'fusebit_allowed_return_to' configuration property of the '${ctx.boundaryId}/${ctx.functionId}' Fusebit Add-On component.`
      };
    }
  }
}

export const createSettingsManager = (
  configure: FunctionConfiguration,
  disableDebug?: boolean
) => {
  const { states, initialState } = configure;
  return async (ctx: IntegrationContext): Promise<FunctionState> => {
    if (!disableDebug) {
      debug(
        'DEBUGGING ENABLED. To disable debugging information, comment out the `debug` configuration setting.'
      );
      debug('NEW REQUEST', ctx.method, ctx.url, ctx.query, ctx.body);
    }
    try {
      // Configuration request
      validateReturnTo(ctx);
      const [state, data] = getInputs(ctx, initialState || 'none');
      debug('STATE', state);
      debug('DATA', data);
      if (ctx.query?.status === 'error') {
        // This is a callback from a subordinate service that resulted in an error; propagate
        throw {
          status: data.status || 500,
          message: data.message || 'Unspecified error',
          state
        };
      }
      const stateHandler = states[state.configurationState!];
      if (stateHandler) {
        return await stateHandler(ctx, state, data);
      } else {
        throw {
          status: 400,
          message: `Unsupported configuration state '${state.configurationState}'`,
          state
        };
      }
    } catch (e: any) {
      return completeWithError(ctx, e);
    }
  };
};

export const createLifecycleManager = (options: LifeCycleManagerOptions) => {
  const { configure, install, uninstall } = options;
  return async (ctx: IntegrationContext) => {
    debug(
      'DEBUGGING ENABLED. To disable debugging information, comment out the `debug` configuration setting.'
    );
    debug('NEW REQUEST', ctx.method, ctx.url, ctx.query, ctx.body);
    const pathSegments = Url.parse(ctx.url!).pathname!.split('/');
    let lastSegment;
    do {
      lastSegment = pathSegments.pop();
    } while (!lastSegment && pathSegments.length > 0);
    try {
      switch (lastSegment) {
        case 'configure': // configuration
          if (configure) {
            // There is a configuration stage, process the next step in the configuration
            validateReturnTo(ctx);
            const settingsManager = createSettingsManager(configure, true);
            return await settingsManager(ctx);
          } else {
            // There is no configuration stage, simply redirect back to the caller with success
            validateReturnTo(ctx);
            const [state, data] = getInputs(ctx, 'none');
            return completeWithSuccess(state, data);
          }
          break;
        case 'install': // installation
          if (!install) {
            throw { status: 404, message: 'Not found' };
          }
          return await install(ctx);
        case 'uninstall': // uninstallation
          if (!uninstall) {
            throw { status: 404, message: 'Not found' };
          }
          return await uninstall(ctx);
        default:
          throw { status: 404, message: 'Not found' };
      }
    } catch (e: any) {
      return completeWithError(ctx, e);
    }
  };
};

export const serializeState = (state: any): string =>
  Buffer.from(JSON.stringify(state)).toString('base64');

export const deserializeState = <TData>(state: string): TData =>
  JSON.parse(Buffer.from(state, 'base64').toString());

export const getInputs = (
  ctx: IntegrationContext,
  initialConfigurationState: string
): [FunctionState, FunctionData] => {
  let data: FunctionData;
  try {
    data = ctx.query?.data
      ? deserializeState<FunctionData>(ctx.query.data as string)
      : {};
  } catch (e) {
    throw { status: 400, message: `Malformed 'data' parameter` };
  }
  if (ctx.query?.returnTo) {
    // Initialization of the add-on component interaction
    if (!initialConfigurationState) {
      throw {
        status: 400,
        message: `State consistency error. Initial configuration state is not specified, and 'state' parameter is missing.`
      };
    }
    [
      'baseUrl',
      'accountId',
      'subscriptionId',
      'boundaryId',
      'functionId',
      'templateName'
    ].forEach(p => {
      if (!data[p]) {
        throw {
          status: 400,
          message: `Missing 'data.${p}' input parameter`,
          state: ctx.query?.state
        };
      }
    });
    return [
      {
        configurationState: initialConfigurationState,
        returnTo: ctx.query.returnTo as string,
        returnToState: ctx.query.state as string
      },
      data
    ];
  } else if (ctx.query?.state) {
    // Continuation of the add-on component interaction (e.g. form post from a settings manager)
    try {
      return [deserializeState(ctx.query.state as string), data];
    } catch (e) {
      throw { status: 400, message: `Malformed 'state' parameter` };
    }
  } else {
    throw {
      status: 400,
      message: `Either the 'returnTo' or 'state' parameter must be present.`
    };
  }
};

export const completeWithSuccess = (
  state: FunctionState,
  data: FunctionData
) => {
  const location =
    `${state.returnTo}?status=success&data=${encodeURIComponent(
      serializeState(data)
    )}` +
    (state.returnToState
      ? `&state=${encodeURIComponent(state.returnToState)}`
      : '');
  return { status: 302, headers: { location } };
};

export const completeWithError = (
  ctx: IntegrationContext,
  error: FunctionError
) => {
  debug('COMPLETE WITH ERROR', error);
  const returnTo = (error.state && error.state.returnTo) || ctx.query?.returnTo;
  const state =
    (error.state && error.state.returnToState) ||
    (ctx.query?.returnTo && ctx.query.state);
  const body = { status: error.status || 500, message: error.message };
  if (returnTo) {
    const location =
      `${returnTo}?status=error&data=${encodeURIComponent(
        serializeState(body)
      )}` + (state ? `&state=${encodeURIComponent(state as string)}` : '');
    return { status: 302, headers: { location } };
  } else {
    return { status: body.status, body };
  }
};

export const getSelfUrl = (ctx: IntegrationContext) => {
  return ctx.baseUrl;
};

export const redirect = (
  ctx: IntegrationContext,
  state: FunctionState,
  data: FunctionData,
  redirectUrl: string,
  nextConfigurationState: string
) => {
  state.configurationState = nextConfigurationState;

  const location = `${redirectUrl}?returnTo=${`${getSelfUrl(
    ctx
  )}/configure`}&state=${encodeURIComponent(
    serializeState(state)
  )}&data=${encodeURIComponent(serializeState(data))}`;

  return { status: 302, headers: { location } };
};

export const createFunction = async (
  ctx: IntegrationContext,
  functionSpecification: object,
  accessToken: string
) => {
  let functionCreated = false;
  const accessTokenHeader = `Bearer ${accessToken}`;
  try {
    // Create the function
    const url = `${ctx.body.baseUrl}/v1/account/${ctx.body.accountId}/subscription/${ctx.body.subscriptionId}/boundary/${ctx.body.boundaryId}/function/${ctx.body.functionId}`;
    let response = await Superagent.put(url)
      .set('Authorization', accessTokenHeader)
      .send(functionSpecification);
    functionCreated = true;

    // Wait for the function to be built and ready
    let attempts = 15;
    while (response.status === 201 && attempts > 0) {
      response = await Superagent.get(
        `${ctx.body.baseUrl}/v1/account/${ctx.body.accountId}/subscription/${ctx.body.subscriptionId}/boundary/${ctx.body.boundaryId}/function/${ctx.body.functionId}/build/${response.body.buildId}`
      ).set('Authorization', accessTokenHeader);
      if (response.status === 200) {
        if (response.body.status === 'success') {
          break;
        } else {
          throw new Error(
            `Failure creating function: ${
              (response.body.error && response.body.error.message) ||
              'Unknown error'
            }`
          );
        }
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
      attempts--;
    }
    if (attempts === 0) {
      throw new Error(`Timeout creating function`);
    }

    if (
      response.status === 204 ||
      (response.body && response.body.status === 'success')
    ) {
      if (response.body && response.body.location) {
        return response.body.location;
      } else {
        response = await Superagent.get(
          `${ctx.body.baseUrl}/v1/account/${ctx.body.accountId}/subscription/${ctx.body.subscriptionId}/boundary/${ctx.body.boundaryId}/function/${ctx.body.functionId}/location`
        ).set('Authorization', accessTokenHeader);
        if (response.body && response.body.location) {
          return response.body.location;
        }
      }
    }
    throw response.body;
  } catch (e) {
    if (functionCreated) {
      try {
        await deleteFunction(ctx, accessToken);
      } catch (_) {
        /** Swallow the error */
      }
    }
    throw e;
  }
};

export const deleteFunction = async (
  ctx: IntegrationContext,
  accessToken: string,
  boundaryId?: string,
  functionId?: string
) => {
  await Superagent.delete(
    `${ctx.body.baseUrl}/v1/account/${ctx.body.accountId}/subscription/${
      ctx.body.subscriptionId
    }/boundary/${boundaryId || ctx.body.boundaryId}/function/${
      functionId || ctx.body.functionId
    }`
  )
    .set('Authorization', `Bearer ${accessToken}`)
    .ok(res => res.status === 204 || res.status === 404);
};

export const getFunctionDefinition = async (
  ctx: IntegrationContext,
  accessToken: string,
  boundaryId: string,
  functionId: string
) => {
  const response = await Superagent.get(
    `${ctx.body.baseUrl}/v1/account/${ctx.body.accountId}/subscription/${
      ctx.body.subscriptionId
    }/boundary/${boundaryId || ctx.body.boundaryId}/function/${
      functionId || ctx.body.functionId
    }`
  ).set('Authorization', `Bearer ${accessToken}`);

  return response.body;
};

const removeLeadingSlash = (s: string) => s.replace(/^\/(.+)$/, '$1');
const removeTrailingSlash = (s: string) => s.replace(/^(.+)\/$/, '$1');

export const createStorageClient = async (
  ctx: IntegrationContext,
  accessToken: string,
  storageIdPrefix: string
) => {
  storageIdPrefix = storageIdPrefix
    ? removeLeadingSlash(removeTrailingSlash(storageIdPrefix))
    : '';
  const functionUrl = Url.parse(ctx.baseUrl!);
  const storageBase =
    ctx?.fusebit?.storageServiceUrl ??
    `${functionUrl.protocol}//${functionUrl.host}/v1/account/${ctx.accountId}/subscription/${ctx.subscriptionId}`;
  const storageBaseUrl = `${storageBase}/storage${
    storageIdPrefix ? '/' + storageIdPrefix : ''
  }`;

  const getUrl = (storageSubId: string) => {
    storageSubId = storageSubId
      ? removeTrailingSlash(removeLeadingSlash(storageSubId))
      : '';
    return `${storageBaseUrl}${storageSubId ? '/' + storageSubId : ''}`;
  };

  const storageClient = {
    get: async function (storageSubId: string) {
      storageSubId = storageSubId
        ? removeTrailingSlash(removeLeadingSlash(storageSubId))
        : '';
      if (!storageSubId && !storageIdPrefix) {
        return undefined;
      }
      const response = await Superagent.get(getUrl(storageSubId))
        .set('Authorization', `Bearer ${accessToken}`)
        .ok(res => res.status < 300 || res.status === 404);
      return response.status === 404 ? undefined : response.body;
    },
    put: async function (data: any, storageSubId: string) {
      storageSubId = storageSubId
        ? removeTrailingSlash(removeLeadingSlash(storageSubId))
        : '';
      if (!storageSubId && !storageIdPrefix) {
        throw new Error(
          'Storage objects cannot be stored at the root of the hierarchy. Specify a storageSubId when calling the `put` method, or a storageIdPrefix when creating the storage client.'
        );
      }
      const response = await Superagent.put(getUrl(storageSubId))
        .set('Authorization', `Bearer ${accessToken}`)
        .send(data);
      return response.body;
    },
    delete: async function (
      storageSubId: string,
      recursive: boolean,
      forceRecursive: boolean
    ) {
      storageSubId = storageSubId
        ? removeLeadingSlash(removeTrailingSlash(storageSubId))
        : '';
      if (!storageSubId && !storageIdPrefix && recursive && !forceRecursive) {
        throw new Error(
          'You are attempting to recursively delete all storage objects in the Fusebit subscription. If this is your intent, please pass "true" as the third parameter in the call to delete(storageSubId, recursive, forceRecursive).'
        );
      }
      await Superagent.delete(`${getUrl(storageSubId)}${recursive ? '/*' : ''}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .ok(res => res.status === 404 || res.status === 204);
      return;
    },
    list: async function (
      storageSubId: string,
      { count, next } = {} as ListStorageOptions
    ) {
      const params = {
        count: count === undefined || isNaN(count) ? undefined : count,
        next: typeof next === 'string' ? next : undefined
      };
      const response = await Superagent.get(`${getUrl(storageSubId)}/*`)
        .query(params)
        .set('Authorization', `Bearer ${accessToken}`);
      return response.body;
    }
  };

  return storageClient;
};

export const createFusebitFunctionFromExpress = (
  app: express.Express,
  { disableStorageClient } = {} as { [key: string]: any }
) => {
  // See https://github.com/fusebit/samples/blob/master/express/index.js#L6
  Object.setPrototypeOf(
    Object.getPrototypeOf(Object.getPrototypeOf(app.response)),
    Mock.Response.prototype
  );
  Object.setPrototypeOf(
    Object.getPrototypeOf(Object.getPrototypeOf(app.request)),
    Mock.Request.prototype
  );

  return async (ctx: IntegrationContext) => {
    if (ctx.logger) {
      logger = ctx.logger;
    }

    debug('HTTP REQUEST', ctx.method, ctx.url, ctx.headers, ctx.body);

    if (!disableStorageClient) {
      ctx.storage = await createStorageClient(
        ctx,
        ctx.fusebit.functionAccessToken,
        `boundary/${ctx.boundaryId}/function/${
          process.env.storage_source ?? ctx.functionId
        }/root`
      );
    }

    // When running in Azure, we need to manually populate the config object.
    if (!ctx.configuration) {
      ctx.configuration = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined) {
          ctx.configuration[k] = v;
        }
      }
    }

    // Create the mock request object and then extend it with Express
    // and Fusebit data elements.
    const req: { [key: string]: any } = new Mock.Request({
      url: ctx.path,
      method: ctx.method,
      headers: ctx.headers
    });
    req.query = ctx.query;
    req.fusebit = ctx;
    if (ctx.body) {
      // Simulate the body had already been parsed
      req._body = true;
      req.body = ctx.body;
    }

    return new Promise((resolve, reject) => {
      try {
        let responseFinished = false;
        const res = new Mock.Response({
          onEnd: () => {
            if (responseFinished) {
              return;
            }
            responseFinished = true;
            const responseBody = (
              res._internal.buffer || Buffer.from('')
            ).toString('utf8');
            debug('HTTP RESPONSE', res.statusCode, responseBody);
            process.nextTick(() => {
              resolve({
                body: responseBody,
                bodyEncoding: 'utf8',
                headers: res._internal.headers,
                status: res.statusCode
              });
            });
          }
        });

        // Call internal Express method to handle the request.
        (app as any).handle(req, res);
      } catch (e) {
        reject(e);
      }
    });
  };
};

/**
 * Creates an Express app that that can be connected to an HTTP server
 * to handle incoming request to the /invoke endpoint.  Invoke requests are
 * forwarded to the Express app created and configured by the integration.
 */
export const createHttpServerApp = (integrationApp: express.Express) => {
  const app = express();
  app.use(bodyParser.json());

  // Main entry point to the integration.
  app.post('/invoke', async (req: express.Request, res: express.Response) => {
    return forwardIntegrationRequest(req, res, integrationApp);
  });

  // Catch 404 and forward to error handler
  app.use(
    (
      eq: express.Request,
      res: express.Response,
      next: express.NextFunction
    ) => {
      next(createHttpError(StatusCodes.NOT_FOUND));
    }
  );

  // error handler. 4th param required, see 'Error-handling middleware'
  // section: https://expressjs.com/en/guide/using-middleware.html
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: any, req: any, res: any, next: any) => {
    // set locals, only providing error in development
    res.locals.message = err.message;
    res.locals.error = req.app.get('env') === 'development' ? err : {};

    res
      .status(err.status || err.code || StatusCodes.INTERNAL_SERVER_ERROR)
      .json({
        error: err.message,
        extendedError: {
          ...err,
          [LogContextKey.StackTrace]: err.stack
        }
      });
  });

  return app;
};

/**
 * Forwards a request recieved via the /invoke endpoint to the express
 * app configured by an integration.
 */
const forwardIntegrationRequest = async (
  req: express.Request,
  res: express.Response,
  app: express.Express,
  { disableStorageClient } = {} as { [key: string]: any }
) => {
  const ctx: IntegrationContext = req.body;
  if (ctx.logger) {
    logger = ctx.logger;
  }

  debug('HTTP REQUEST', ctx.method, ctx.url, ctx.headers, ctx.body);

  if (!disableStorageClient) {
    ctx.storage = await createStorageClient(
      ctx,
      ctx.fusebit.functionAccessToken,
      `boundary/${ctx.boundaryId}/function/${
        process.env.storage_source ?? ctx.functionId
      }/root`
    );
  }

  // When running in Azure, we need to manually populate the config object.
  if (!ctx.configuration) {
    ctx.configuration = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) {
        ctx.configuration[k] = v;
      }
    }
  }

  // Modify the current request with information provided in the context object.
  req.url = ctx.path!;
  req.method = ctx.method;
  req.headers = ctx.headers;
  req.query = ctx.query;
  req.body = ctx.body;
  req.fusebit = ctx;

  // Pass the modified request and the response on to the integration's express app.
  return (app as any).handle(req, res);
};
