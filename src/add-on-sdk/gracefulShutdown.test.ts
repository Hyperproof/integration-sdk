import { gracefulShutdown } from './gracefulShutdown';

import express from 'express';
import http from 'http';
import { AddressInfo } from 'net';

/**
 * Behavioral tests for the graceful-drain logic that lets a connector pod
 * finish an in-flight Hypersync /invoke on SIGTERM instead of aborting it.
 * Exercised against a real http.Server with controllable
 * slow/hanging routes, with `exit` and `log` injected so the test process is
 * never terminated.
 */
describe('gracefulShutdown', () => {
  let server: http.Server;
  let port: number;
  let baseUrl: string;
  // Resolves once a request has actually entered a route handler, so shutdown
  // is triggered while the request is genuinely in-flight (no timing guess).
  let requestEntered: Promise<void>;

  const buildServer = (configure: (app: express.Express) => void): Promise<void> => {
    const app = express();
    configure(app);
    server = http.createServer(app);
    return new Promise(resolve => {
      server.listen(0, '127.0.0.1', () => {
        port = (server.address() as AddressInfo).port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  };

  /** Plain GET that resolves with status + body, or rejects on connection error. */
  const get = (path: string, agent?: http.Agent): Promise<{ status: number; body: string }> =>
    new Promise((resolve, reject) => {
      const req = http.get(`${baseUrl}${path}`, { agent }, res => {
        let body = '';
        res.on('data', chunk => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on('error', reject);
    });

  const waitFor = async (predicate: () => boolean, timeoutMs = 2000): Promise<void> => {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) {
        throw new Error('waitFor timed out');
      }
      await new Promise(r => setTimeout(r, 5));
    }
  };

  afterEach(async () => {
    if (server && server.listening) {
      await new Promise<void>(resolve => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    }
    // Close any client-side keep-alive sockets so Jest sees no open handles.
    http.globalAgent.destroy();
  });

  it('lets an in-flight request finish before exiting 0', async () => {
    let entered!: () => void;
    requestEntered = new Promise<void>(resolve => (entered = resolve));
    await buildServer(app =>
      app.get('/slow', (_req, res) => {
        entered();
        setTimeout(() => res.status(200).send('slow-done'), 100);
      })
    );

    const exit = jest.fn();
    const inFlight = get('/slow');
    await requestEntered; // request is now executing in the handler

    gracefulShutdown(server, { exit, timeoutMs: 5000 });

    // The in-flight request must still complete successfully...
    const res = await inFlight;
    expect(res.status).toBe(200);
    expect(res.body).toBe('slow-done');

    // ...and exit(0) must fire only after the drain completes.
    await waitFor(() => exit.mock.calls.length > 0);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('keeps a request blocked awaiting a slow dependency alive across multiple idle sweeps', async () => {
    // Mirrors the real concern: an /invoke handler that has received the request
    // but is blocked awaiting an outbound vendor API response for longer than the
    // 250ms idle-sweep interval. The inbound connection is "active" (request in,
    // response not yet sent), so neither closeIdleConnections() nor server.close()
    // may drop it -- Node's "idle" means between-requests, not event-loop idle.
    let entered!: () => void;
    requestEntered = new Promise<void>(resolve => (entered = resolve));
    await buildServer(app =>
      app.get('/slow', (_req, res) => {
        entered();
        // ~3 idle-sweep ticks of "waiting on an outbound call" before responding.
        setTimeout(() => res.status(200).send('slow-done'), 800);
      })
    );

    const exit = jest.fn();
    const inFlight = get('/slow');
    await requestEntered;

    gracefulShutdown(server, { exit, timeoutMs: 5000 });

    // While the handler is still awaiting, several idle sweeps fire — none may
    // exit the process, because the request is in-flight.
    await new Promise(r => setTimeout(r, 500));
    expect(exit).not.toHaveBeenCalled();

    const res = await inFlight;
    expect(res.status).toBe(200);
    expect(res.body).toBe('slow-done');

    await waitFor(() => exit.mock.calls.length > 0);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('stops accepting new connections once shutdown begins', async () => {
    let entered!: () => void;
    requestEntered = new Promise<void>(resolve => (entered = resolve));
    await buildServer(app =>
      app.get('/slow', (_req, res) => {
        entered();
        setTimeout(() => res.status(200).send('slow-done'), 100);
      })
    );

    const exit = jest.fn();
    const inFlight = get('/slow');
    await requestEntered;

    gracefulShutdown(server, { exit, timeoutMs: 5000 });
    await inFlight;
    await waitFor(() => exit.mock.calls.length > 0);
    await waitFor(() => !server.listening);

    // Server has drained and closed; a fresh connection no longer succeeds.
    // (Errno varies by timing -- ECONNREFUSED once closed, ECONNRESET mid-close
    // -- so assert only that the connection fails.)
    await expect(get('/slow')).rejects.toThrow();
  });

  it('does not let idle keep-alive sockets hold the drain open', async () => {
    await buildServer(app => app.get('/fast', (_req, res) => res.status(200).send('ok')));

    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const first = await get('/fast', agent);
    expect(first.status).toBe(200);
    // The socket is now idle but kept alive on the server. Without
    // closeIdleConnections(), server.close() would block on it for ~5s.

    const exit = jest.fn();
    const startedAt = Date.now();
    gracefulShutdown(server, { exit, timeoutMs: 5000 });

    await waitFor(() => exit.mock.calls.length > 0);
    expect(exit).toHaveBeenCalledWith(0);
    expect(Date.now() - startedAt).toBeLessThan(1000);
    agent.destroy();
  });

  it('exits 0 promptly when there are no in-flight requests', async () => {
    await buildServer(app => app.get('/fast', (_req, res) => res.status(200).send('ok')));

    const exit = jest.fn();
    gracefulShutdown(server, { exit, timeoutMs: 5000 });

    await waitFor(() => exit.mock.calls.length > 0);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('force-closes and exits 1 when a request exceeds the hard-stop deadline', async () => {
    let entered!: () => void;
    requestEntered = new Promise<void>(resolve => (entered = resolve));
    await buildServer(app =>
      app.get('/hang', () => {
        entered();
        // never responds
      })
    );

    const exit = jest.fn();
    const hung = get('/hang').catch(() => undefined); // will be force-closed
    await requestEntered;

    gracefulShutdown(server, { exit, timeoutMs: 50 });

    await waitFor(() => exit.mock.calls.length > 0);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    await hung;
  });
});
