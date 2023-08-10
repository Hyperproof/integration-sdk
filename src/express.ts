/* eslint-disable @typescript-eslint/no-namespace */
import { FusebitContext } from './add-on-sdk';
import { UserContext } from './oauth-connector';

export {};

declare global {
  export namespace Express {
    interface Request {
      fusebit: FusebitContext;
      userContext?: UserContext;
    }

    type ParsedQs = {
      [key: string]: undefined | string | string[] | ParsedQs | ParsedQs[];
    };
  }
}
