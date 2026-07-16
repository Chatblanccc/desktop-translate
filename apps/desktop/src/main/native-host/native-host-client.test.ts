import { randomUUID } from 'node:crypto';
import net, { type Server, type Socket } from 'node:net';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import type { NativeRequest } from '@desktop-translate/contracts/native-ipc';
import { FrameDecoder, encodeFrame } from './frame-codec.js';
import { NativeHostClient } from './native-host-client.js';

const openServers: Server[] = [];
const openClients: NativeHostClient[] = [];

async function listen(handler: (socket: Socket, request: NativeRequest) => void): Promise<string> {
  const pipeName = `\\\\.\\pipe\\desktop-translate.test.${process.pid}.${randomUUID()}`;
  const server = net.createServer((socket) => {
    const decoder = new FrameDecoder();
    socket.pipe(decoder);
    decoder.once('data', (request: NativeRequest) => handler(socket, request));
  });
  openServers.push(server);
  server.listen(pipeName);
  await once(server, 'listening');
  return pipeName;
}

afterEach(async () => {
  await Promise.all(openClients.splice(0).map((client) => client.close()));
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        )
    )
  );
});

describe('native host client protocol checks', () => {
  it('does not expose the private pipe name in connection errors', async () => {
    const pipeName = `\\\\.\\pipe\\desktop-translate.test.secret.${randomUUID()}`;
    const client = new NativeHostClient({ pipeName });
    openClients.push(client);
    client.on('disconnect', () => undefined);
    let error: Error | undefined;
    try {
      await client.connect(100);
    } catch (caught) {
      error = caught as Error;
    }
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).not.toContain(pipeName);
    expect(error?.message).not.toContain('secret');
  });

  it('matches a valid response to its request', async () => {
    const pipeName = await listen((socket, request) => {
      socket.write(
        encodeFrame({
          v: 1,
          kind: 'response',
          id: request.id,
          method: 'health',
          timestamp: new Date().toISOString(),
          payload: { status: 'ready', listening: false, uptimeMs: 10 }
        })
      );
    });
    const client = new NativeHostClient({ pipeName });
    openClients.push(client);
    await client.connect();
    await expect(client.request('health', {})).resolves.toMatchObject({ method: 'health' });
  });

  it('rejects a response with a mismatched method', async () => {
    const pipeName = await listen((socket, request) => {
      socket.write(
        encodeFrame({
          v: 1,
          kind: 'response',
          id: request.id,
          method: 'stop',
          timestamp: new Date().toISOString(),
          payload: { ok: true, listening: false }
        })
      );
    });
    const client = new NativeHostClient({ pipeName });
    openClients.push(client);
    client.on('disconnect', () => undefined);
    await client.connect();
    await expect(client.request('health', {})).rejects.toThrow('response method mismatch');
  });

  it('disconnects when event sequence numbers repeat', async () => {
    const pipeName = await listen((socket, request) => {
      socket.write(
        encodeFrame({
          v: 1,
          kind: 'response',
          id: request.id,
          method: 'health',
          timestamp: new Date().toISOString(),
          payload: { status: 'ready', listening: false, uptimeMs: 10 }
        })
      );
      const event = {
        v: 1,
        kind: 'event',
        seq: 1,
        method: 'host/error',
        timestamp: new Date().toISOString(),
        payload: {
          code: 'INTERNAL_ERROR',
          message: 'redacted diagnostic',
          scope: 'host',
          recoverable: true
        }
      };
      socket.write(Buffer.concat([encodeFrame(event), encodeFrame(event)]));
    });
    const client = new NativeHostClient({ pipeName });
    openClients.push(client);
    client.on('disconnect', () => undefined);
    const protocolError = once(client, 'protocolError');
    await client.connect();
    await client.request('health', {});
    const [error] = await protocolError;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('sequence did not increase');
  });

  it('rejects a related request immediately when the host emits an error', async () => {
    const pipeName = await listen((socket, request) => {
      socket.write(
        encodeFrame({
          v: 1,
          kind: 'event',
          seq: 1,
          method: 'host/error',
          timestamp: new Date().toISOString(),
          payload: {
            code: 'INVALID_STATE',
            message: 'request cannot run in the current state',
            scope: 'host',
            recoverable: true,
            relatedRequestId: request.id
          }
        })
      );
    });
    const client = new NativeHostClient({ pipeName, requestTimeoutMs: 5_000 });
    openClients.push(client);
    await client.connect();
    await expect(client.request('health', {})).rejects.toMatchObject({
      code: 'INVALID_STATE',
      scope: 'host',
      recoverable: true
    });
  });
});
