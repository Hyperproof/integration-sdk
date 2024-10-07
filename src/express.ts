/* eslint-disable @typescript-eslint/no-namespace */
import { IntegrationContext } from './add-on-sdk';
import { UserContext } from './oauth-connector';

export {};

declare global {
  export namespace Express {
    interface Request {
      fusebit: IntegrationContext;
      userContext?: UserContext;
    }
  }
}
