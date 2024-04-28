import { LoggerContext } from './hyperproof-api';

import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * We use AsyncLocalStorage to store logging and tracing information
 * for the requests that are processsed by a connector.
 */

export interface IAsyncStore {
  baggage?: string | undefined;
  traceParent?: string | undefined;
  loggerContext?: LoggerContext;
}

declare global {
  // eslint-disable-next-line no-var
  var _logger_context_async_local_storage:
    | AsyncLocalStorage<IAsyncStore>
    | undefined;
}

if (!global._logger_context_async_local_storage) {
  global._logger_context_async_local_storage =
    new AsyncLocalStorage<IAsyncStore>();
}

export const asyncLocalStorage = global._logger_context_async_local_storage;

export function getAsyncStore() {
  return asyncLocalStorage.getStore();
}
