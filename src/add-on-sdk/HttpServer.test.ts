import { HttpServer } from './HttpServer';

import express from 'express';
import http from 'http';

/**
 * Tests for the graceful-shutdown wiring: that startListening registers
 * SIGTERM/SIGINT drain handlers, and that shutdown() is idempotent and exits
 * cleanly. The drain mechanics themselves are covered in gracefulShutdown.test.ts.
 */
describe('HttpServer graceful shutdown', () => {
  const originalPort = process.env.PORT;
  const started: HttpServer[] = [];

  const startListening = async (exit: (code: number) => void = () => undefined): Promise<HttpServer> => {
    process.env.PORT = '0';
    const server = new HttpServer({ exit, shutdownTimeoutMs: 5000 });
    started.push(server);
    server.startListening(express());
    const httpServer = (server as any).server as http.Server;
    await new Promise<void>(resolve => httpServer.once('listening', () => resolve()));
    return server;
  };

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
    await Promise.all(
      started.splice(0).map(async server => {
        // Remove the process-level signal handlers this instance registered so
        // they don't leak across tests.
        process.removeListener('SIGTERM', (server as any).shutdown);
        process.removeListener('SIGINT', (server as any).shutdown);
        const httpServer = (server as any).server as http.Server | undefined;
        if (httpServer && httpServer.listening) {
          await new Promise<void>(resolve => {
            httpServer.closeAllConnections();
            httpServer.close(() => resolve());
          });
        }
      })
    );
    http.globalAgent.destroy();
  });

  afterAll(() => {
    process.env.PORT = originalPort;
  });

  it('registers SIGTERM and SIGINT handlers on startListening', async () => {
    const before = { term: process.listenerCount('SIGTERM'), int: process.listenerCount('SIGINT') };
    const server = await startListening();
    expect(process.listenerCount('SIGTERM')).toBe(before.term + 1);
    expect(process.listenerCount('SIGINT')).toBe(before.int + 1);
    expect(process.listeners('SIGTERM')).toContain((server as any).shutdown);
    expect(process.listeners('SIGINT')).toContain((server as any).shutdown);
  });

  it('drains and exits 0 on shutdown when idle', async () => {
    const exit = jest.fn();
    const server = await startListening(exit);
    server.shutdown('SIGTERM');
    await waitFor(() => exit.mock.calls.length > 0);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('is idempotent — a repeat signal during draining is ignored', async () => {
    const exit = jest.fn();
    const server = await startListening(exit);
    server.shutdown('SIGTERM');
    server.shutdown('SIGTERM'); // repeat while draining
    await waitFor(() => exit.mock.calls.length > 0);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('exits 0 immediately when shutdown is called before the server starts', () => {
    const exit = jest.fn();
    const server = new HttpServer({ exit });
    server.shutdown('SIGTERM');
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
