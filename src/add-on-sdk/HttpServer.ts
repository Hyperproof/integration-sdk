import { createHttpServerApp } from './addOn';

import express from 'express';
import http from 'http';

const log = console;

export class HttpServer {
  private port?: string | number | false;
  private server?: http.Server;

  constructor() {
    this.onError = this.onError.bind(this);
    this.onListening = this.onListening.bind(this);
    this.onClose = this.onClose.bind(this);
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

    const bind =
      typeof this.port === 'string' ? 'Pipe ' + this.port : 'Port ' + this.port;

    // Handle specific listen errors with friendly messages
    switch (error.code) {
      case 'EACCES':
        log.error(bind + ' requires elevated privileges');
        process.exit(1);
        break;

      case 'EADDRINUSE':
        log.error(bind + ' is already in use');
        process.exit(1);
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
    const bind =
      typeof addr === 'string' ? 'pipe ' + addr : 'port ' + addr!.port;
    log.info('Listening on ' + bind);
  }

  /**
   * Event listener for HTTP server "close" event.
   */
  private onClose() {
    log.info('HTTP server closed');
  }
}
