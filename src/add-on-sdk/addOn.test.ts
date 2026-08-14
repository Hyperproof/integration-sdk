import { createHttpServerApp } from './addOn';

import express from 'express';
import http from 'http';
import { AddressInfo } from 'net';

describe('createHttpServerApp', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(done => {
    const integrationApp = express();
    const app = createHttpServerApp(integrationApp);
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      baseUrl = `http://127.0.0.1:${port}`;
      done();
    });
  });

  afterAll(done => {
    server.close(() => done());
  });

  it('exposes /health/readiness on the outer Express app', async () => {
    const response = await fetch(`${baseUrl}/health/readiness`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('OK');
  });

  // The metrics endpoint must be reachable via plain HTTP (not via /invoke),
  // because Prometheus scrapes don't speak the Fusebit invocation envelope.
  it('exposes /metrics on the outer Express app for Prometheus scrapes', async () => {
    const response = await fetch(`${baseUrl}/metrics`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^text\/plain/);

    const body = await response.text();
    // initMetrics() registers default Node.js process metrics with the
    // integration_ prefix, so they should always be present.
    expect(body).toMatch(/^# HELP integration_process_/m);
    // The integration_up gauge is declared in metrics.ts at module load.
    expect(body).toContain('integration_up');
  });
});
