/**
 * Method of invocation for the call coming into Fusebit.
 */
export type Method = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'CRON';

/**
 * Identifying information for an item in Fusebit storage.
 */
export interface StorageItem {
  storageId: string;
  tags: object;
  etag: string;
  expires: string;
}

/**
 * Fusebit storage data object.
 */
export interface StorageDataObject {
  etag: string;
  tags: object;
  expires: string;
  data: any;
}

/**
 * Options which can be passed to Storage.list() to control the data
 * that is returned from the method.
 */
export interface ListStorageOptions {
  count?: number;
  next?: string;
}

export interface ListStorageResult {
  items: StorageItem[];
  next?: string;
}

export interface StorageClient {
  // https://fusebit.io/docs/reference/fusebit-http-api/#operation/getStorage
  get(storageSubId: string): Promise<StorageDataObject>;

  // https://fusebit.io/docs/reference/fusebit-http-api/#operation/putStorage
  put(data: any, storageSubId: string): Promise<StorageDataObject>;

  // https://fusebit.io/docs/reference/fusebit-http-api/#operation/deleteStorage
  delete(
    storageSubId?: string,
    recursive?: boolean,
    forceRecursive?: boolean
  ): Promise<void>;

  // https://fusebit.io/docs/reference/fusebit-http-api/#operation/getStorageList
  list(
    storageSubId: string,
    options?: ListStorageOptions
  ): Promise<ListStorageResult>;
}

export interface IResourceAction {
  resource: string;
  action: string;
}

export interface FusebitContext {
  accountId: string;
  subscriptionId: string;
  boundaryId: string;
  functionId: string;
  configuration: { [key: string]: string };
  method: Method;
  baseUrl?: string;
  url?: string;
  path?: string;
  query?: { [key: string]: string | string[] };
  headers?: { [key: string]: string };
  body?: any;
  fusebit: {
    endpoint: string;
    functionAccessToken: string;
  };
  caller: {
    permissions: {
      allow: IResourceAction[];
    };
  };
  storage: StorageClient;
}

export interface FunctionState {
  configurationState?: string;
  returnTo?: string;
  returnToState?: string;
  body?: any;
  bodyEncoding?: string;
  headers?: { [header: string]: string };
  status?: number;
  [key: string]: any;
}

export interface FunctionData {
  baseUrl?: string;
  accountId?: string;
  subscriptionId?: string;
  boundaryId?: string;
  functionId?: string;
  templateName?: string;
  [key: string]: any;
}

export interface FunctionError {
  status: number;
  message: string;
  state: FunctionState;
}

export interface FunctionConfiguration {
  initialState: string;
  states: {
    [state: string]: (
      ctx: FusebitContext,
      state: FunctionState,
      data: FunctionData
    ) => FunctionState;
  };
}

export interface LifeCycleResult {
  status: number;
  body: any;
}

export interface LifeCycleManagerOptions {
  configure: FunctionConfiguration;
  install: (ctx: FusebitContext) => LifeCycleResult;
  uninstall: (ctx: FusebitContext) => LifeCycleResult;
}
