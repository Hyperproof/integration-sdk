import { createApp } from './app';
import { OAuthConnector } from './OAuthConnector';

import { createFusebitFunctionFromExpress } from '../add-on-sdk';

export * from './OAuthConnector';
export { createApp } from './app';

export const createOAuthConnector = (vendorConnector: OAuthConnector) => {
  // Create Express app that exposes:
  // - endpoints to handle Vendor's OAuth authorization,
  // - endpoint to obtain an access token for a given user,
  // - optional, application-specific endpoints defined by vendorConnector
  const app = createApp(vendorConnector);

  //  Create Fusebit function from the Express app.
  return createFusebitFunctionFromExpress(app);
};
