import http from 'http';

import { Logger } from '../hyperproof-api';

/**
 * Hard-stop deadline (ms) for the graceful drain, sized to the connector
 * request timeout -- the longest a caller (jobengine-hypersyncs /
 * integrationapi) waits for an /invoke sync before giving up. The drain never
 * holds a terminating pod longer than a request could legitimately run, and
 * completes before Kubernetes' SIGKILL at the end of terminationGracePeriodSeconds.
 *
 * NOTE: this is the caller-side request timeout, NOT Node's
 * `server.requestTimeout` -- that bounds how long the client takes to *send* a
 * request, not how long the handler runs, so it would not bound a long sync.
 */
export const DRAIN_TIMEOUT_MS = 300_000;

export interface GracefulShutdownOptions {
  /** Called to terminate the process. Overridable so tests don't exit. */
  exit?: (code: number) => void;
  /** Hard-stop deadline (ms) after which connections are force-closed. */
  timeoutMs?: number;
}

/**
 * Drains an HTTP server: stops accepting new connections, closes idle
 * keep-alive sockets so the drain isn't held open by them, lets in-flight
 * requests finish, then exits 0. If draining exceeds `timeoutMs`, remaining
 * connections are force-closed and the process exits 1.
 *
 * This is the piece that lets a connector pod finish an in-flight Hypersync
 * `/invoke` on SIGTERM instead of aborting it.
 */
export function gracefulShutdown(server: http.Server, options: GracefulShutdownOptions = {}): void {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const timeoutMs = options.timeoutMs ?? DRAIN_TIMEOUT_MS;

  // Exit exactly once. The force-close path destroys remaining sockets, which
  // also fires server.close()'s callback -- guard so we don't exit twice.
  let finished = false;
  const finish = (code: number) => {
    if (finished) {
      return;
    }
    finished = true;
    clearTimeout(forceExit);
    clearInterval(idleSweep);
    exit(code);
  };

  const forceExit = setTimeout(() => {
    Logger.error(`Graceful shutdown timed out after ${timeoutMs}ms; force-closing connections`);
    server.closeAllConnections();
    finish(1);
  }, timeoutMs);
  // The hard-stop timer must not itself keep the event loop (and process) alive.
  forceExit.unref();

  server.close(() => {
    Logger.info('Drain complete; exiting');
    finish(0);
  });

  // closeIdleConnections() is a one-shot: it only closes sockets idle at call
  // time. Keep-alive sockets that go idle *during* the drain (once their
  // in-flight request finishes) would otherwise hold server.close() open until
  // keepAliveTimeout. Sweep repeatedly so the process exits as soon as the last
  // in-flight request completes rather than lingering on idle sockets.
  server.closeIdleConnections();
  const idleSweep = setInterval(() => server.closeIdleConnections(), 250);
  idleSweep.unref();
}
