import { createApp } from './app';
import { OAuthConnector } from './OAuthConnector';

import { createFusebitFunctionFromExpress } from '../add-on-sdk';

export * from './OAuthConnector';

export const createOAuthConnector = (vendorConnector: OAuthConnector) => {
  // Create Express app that exposes:
  // - endpoints to handle Vendor's OAuth authorization,
  // - endpoint to obtain an access token for a given user,
  // - optional, application-specific endpoints defined by vendorConnector
  const app = createApp(vendorConnector);

  if (process.env.integration_platform === 'azure') {
    // If we are running on Azure (i.e. as a function app) we need to start
    // listening on the appropriate port.  An HttpTrigger on the function app
    // will forward incoming requests to this server.
    const port = process.env.FUNCTIONS_HTTPWORKER_PORT || 3005;
    app.listen(port, () => {
      console.log('Listening on port', port);
    });
    return app;
  }

  // Running in Fusebit.  Create Fusebit function from the Express app.
  return createFusebitFunctionFromExpress(app);
};
