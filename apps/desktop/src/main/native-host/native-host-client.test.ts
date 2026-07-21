import { randomUUID } from 'node:crypto';
import net, { type Server, type Socket } from 'node:net';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import type { NativeRequest } from '@desktop-translate/contracts/native-ipc';
import { FrameDecoder, encodeFrame } from './frame-codec.js';
import { NativeHostClient } from './native-host-client.js';

const openServers: Server[] = [];
const openClients: NativeHostClient[] = [];

async function listenRaw(handler: (socket: Socket) => void): Promise<string> {
  const pipeName = `\\\\.\\pipe\\desktop-translate.test.${process.pid}.${randomUUID()}`;
  const server = net.createServer(handler);
  openServers.push(server);
  server.listen(pipeName);
  await once(server, 'listening');
  return pipeName;
}

async function listen(handler: (socket: Socket, request: NativeRequest) => void): Promise<string> {
  return listenRaw((socket) => {
    const decoder = new FrameDecoder();
    socket.pipe(decoder);
    decoder.once('data', (request: NativeRequest) => handler(socket, request));
  });
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
  it('fails closed before connection and allows repeated close calls', async () => {
    const client = new NativeHostClient({ pipeName: '\\\\.\\pipe\\unused' });
    openClients.push(client);
    await expect(client.request('health', {})).rejects.toThrow(/not connected/u);
    await expect(client.close()).resolves.toBeUndefined();
    await expect(client.close()).resolves.toBeUndefined();
  });

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

  it('rejects duplicate connections and invalid outgoing payloads', async () => {
    const pipeName = await listen(() => undefined);
    const client = new NativeHostClient({ pipeName });
    openClients.push(client);
    await client.connect();
    await expect(client.connect()).rejects.toThrow(/already connected/u);
    await expect(
      client.request('health', { unexpected: true } as never)
    ).rejects.toThrow(/violates v1 contract/u);
  });

  it('times out an unanswered request and removes it from pending state', async () => {
    const pipeName = await listen(() => undefined);
    const client = new NativeHostClient({ pipeName, requestTimeoutMs: 20 });
    openClients.push(client);
    await client.connect();
    await expect(client.request('health', {})).rejects.toThrow(/timed out/u);
    await expect(client.close()).resolves.toBeUndefined();
  });

  it('disconnects on an unsolicited response', async () => {
    const pipeName = await listen((socket) => {
      socket.write(encodeFrame({
        v: 1,
        kind: 'response',
        id: randomUUID(),
        method: 'health',
        timestamp: new Date().toISOString(),
        payload: { status: 'ready', listening: false, uptimeMs: 10 }
      }));
    });
    const client = new NativeHostClient({ pipeName });
    openClients.push(client);
    client.on('disconnect', () => undefined);
    const protocolError = once(client, 'protocolError');
    await client.connect();
    await expect(client.request('health', {})).rejects.toThrow(/unsolicited/u);
    await expect(protocolError).resolves.toBeDefined();
  });

  it('emits valid events and ignores unrelated host errors', async () => {
    const pipeName = await listen((socket, request) => {
      socket.write(encodeFrame({
        v: 1,
        kind: 'response',
        id: request.id,
        method: 'health',
        timestamp: new Date().toISOString(),
        payload: { status: 'ready', listening: false, uptimeMs: 10 }
      }));
      socket.write(encodeFrame({
        v: 1,
        kind: 'event',
        seq: 1,
        method: 'host/error',
        timestamp: new Date().toISOString(),
        payload: {
          code: 'INTERNAL_ERROR',
          message: 'redacted',
          scope: 'host',
          recoverable: true,
          relatedRequestId: randomUUID()
        }
      }));
    });
    const client = new NativeHostClient({ pipeName });
    openClients.push(client);
    const message = once(client, 'message');
    const hostError = once(client, 'host/error');
    await client.connect();
    await expect(client.request('health', {})).resolves.toMatchObject({ method: 'health' });
    await expect(message).resolves.toMatchObject([expect.objectContaining({ seq: 1 })]);
    await expect(hostError).resolves.toMatchObject([expect.objectContaining({ method: 'host/error' })]);
  });

  it('emits validated pointer-down activity from the Native Host', async () => {
    const pipeName = await listen((socket, request) => {
      socket.write(encodeFrame({
        v: 1,
        kind: 'response',
        id: request.id,
        method: 'ready',
        timestamp: new Date().toISOString(),
        payload: {
          selectedVersion: 1,
          hostVersion: 'test-host',
          hostPid: '4242',
          sessionNonce: '0123456789abcdef0123456789abcdef',
          capabilities: ['pointer-down-events']
        }
      }));
      socket.write(encodeFrame({
        v: 1,
        kind: 'event',
        seq: 1,
        method: 'input/pointer-down',
        timestamp: new Date().toISOString(),
        payload: {
          point: { x: -120, y: 480 },
          coordinateSpace: 'physical-px'
        }
      }));
    });
    const client = new NativeHostClient({ pipeName });
    openClients.push(client);
    const pointerDown = once(client, 'input/pointer-down');
    await client.connect();
    await expect(client.request('hello', {
      desktopVersion: '0.5.0-phase5',
      supportedVersions: [1],
      sessionNonce: '0123456789abcdef0123456789abcdef',
      requestedCapabilities: ['pointer-down-events']
    })).resolves.toMatchObject({ method: 'ready' });
    await expect(pointerDown).resolves.toMatchObject([
      expect.objectContaining({
        method: 'input/pointer-down',
        payload: { point: { x: -120, y: 480 }, coordinateSpace: 'physical-px' }
      })
    ]);
  });

  it('fails closed when a Host sends pointer activity without negotiating the capability', async () => {
    const sessionNonce = '0123456789abcdef0123456789abcdef';
    const pipeName = await listen((socket, request) => {
      socket.write(encodeFrame({
        v: 1,
        kind: 'response',
        id: request.id,
        method: 'ready',
        timestamp: new Date().toISOString(),
        payload: {
          selectedVersion: 1,
          hostVersion: 'legacy-test-host',
          hostPid: '4242',
          sessionNonce,
          capabilities: []
        }
      }));
      setImmediate(() => socket.write(encodeFrame({
        v: 1,
        kind: 'event',
        seq: 1,
        method: 'input/pointer-down',
        timestamp: new Date().toISOString(),
        payload: {
          point: { x: 120, y: 480 },
          coordinateSpace: 'physical-px'
        }
      })));
    });
    const client = new NativeHostClient({ pipeName });
    openClients.push(client);
    client.on('disconnect', () => undefined);
    const protocolError = once(client, 'protocolError');
    await client.connect();
    await expect(client.request('hello', {
      desktopVersion: '0.5.0-phase5',
      supportedVersions: [1],
      sessionNonce,
      requestedCapabilities: []
    })).resolves.toMatchObject({ method: 'ready' });
    await expect(protocolError).resolves.toMatchObject([
      expect.objectContaining({ message: expect.stringMatching(/not negotiated/u) })
    ]);
  });

  it('rejects pending work when explicitly closed', async () => {
    const pipeName = await listen(() => undefined);
    const client = new NativeHostClient({ pipeName, requestTimeoutMs: 5_000 });
    openClients.push(client);
    await client.connect();
    const pending = client.request('health', {}).then(
      () => undefined,
      (error: unknown) => error
    );
    await client.close();
    await expect(pending).resolves.toMatchObject({ message: expect.stringMatching(/client closed/u) });
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
