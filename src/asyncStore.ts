import { LoggerContext } from './hyperproof-api';

import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The AsyncLocalStorage contains globally-accessible information
 * that is specific to the current execution context/request
 */

export interface IAsyncStore {
  baggage?: string | undefined;
  traceParent?: string | undefined;
  loggerContext?: LoggerContext;
  externalServiceHeaders?: { [key: string]: string };
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
