import { createHttpServerApp } from './addOn';
import { DRAIN_TIMEOUT_MS, gracefulShutdown } from './gracefulShutdown';

import express from 'express';
import http from 'http';

import { Logger } from '../hyperproof-api';

export interface HttpServerOptions {
  /** Called to terminate the process on shutdown. Overridable for tests. */
  exit?: (code: number) => void;
  /** Hard-stop deadline (ms) for graceful shutdown. */
  shutdownTimeoutMs?: number;
}

export class HttpServer {
  private port?: string | number | false;
  private server?: http.Server;
  private isShuttingDown = false;
  private readonly exit: (code: number) => void;
  private readonly shutdownTimeoutMs: number;

  constructor(options: HttpServerOptions = {}) {
    this.exit = options.exit ?? ((code: number) => process.exit(code));
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? DRAIN_TIMEOUT_MS;
    this.onError = this.onError.bind(this);
    this.onListening = this.onListening.bind(this);
    this.onClose = this.onClose.bind(this);
    this.shutdown = this.shutdown.bind(this);
  }

  public startListening(integrationApp: express.Express) {
    // Get port from environment and store in Express.
    this.port = HttpServer.normalizePort(process.env.PORT || '7071');

    // Wrap the integration app with an app that handles /invoke.
    const app = createHttpServerApp(integrationApp);
    app.set('port', this.port);

    // Create the HTTP server.
    this.server = http.createServer(app);

    // Listen on provided port, on all network interfaces.
    this.server.listen(this.port);
    this.server.on('error', this.onError);
    this.server.on('listening', this.onListening);
    this.server.on('close', this.onClose);

    // On SIGTERM/SIGINT (deploy rollout, HPA scale-down), drain in-flight
    // /invoke syncs before exiting instead of letting Node's default behavior
    // abort them.
    process.on('SIGTERM', this.shutdown);
    process.on('SIGINT', this.shutdown);
  }

  /**
   * Stops accepting new connections and drains in-flight requests, then exits.
   * Idempotent: repeat signals during draining are ignored.
   */
  public shutdown(signal?: NodeJS.Signals) {
    if (this.isShuttingDown) {
      return;
    }
    this.isShuttingDown = true;
    Logger.info(`Received ${signal ?? 'shutdown'}; draining in-flight requests before exit`);

    if (!this.server) {
      this.exit(0);
      return;
    }

    gracefulShutdown(this.server, {
      exit: this.exit,
      timeoutMs: this.shutdownTimeoutMs
    });
  }

  /**
   * Normalize a port into a number, string, or false.
   */
  private static normalizePort(val: string) {
    const portNumber = parseInt(val, 10);

    if (isNaN(portNumber)) {
      // named pipe
      return val;
    }

    if (portNumber >= 0) {
      // port number
      return portNumber;
    }

    return false;
  }

  /**
   * Event listener for HTTP server "error" event.
   */
  private onError(error: any) {
    if (error.syscall !== 'listen') {
      throw error;
    }

    const bind = typeof this.port === 'string' ? 'Pipe ' + this.port : 'Port ' + this.port;

    // Handle specific listen errors with friendly messages
    switch (error.code) {
      case 'EACCES':
        Logger.error(bind + ' requires elevated privileges');
        this.exit(1);
        break;

      case 'EADDRINUSE':
        Logger.error(bind + ' is already in use');
        this.exit(1);
        break;

      default:
        throw error;
    }
  }

  /**
   * Event listener for HTTP server "listening" event.
   */
  private onListening() {
    const addr = this.server?.address();
    const bind = typeof addr === 'string' ? 'pipe ' + addr : 'port ' + addr!.port;
    Logger.info('Listening on ' + bind);
  }

  /**
   * Event listener for HTTP server "close" event.
   */
  private onClose() {
    Logger.info('HTTP server closed');
  }
}
