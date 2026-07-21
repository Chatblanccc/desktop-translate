import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import net, { type Socket } from 'node:net';
import {
  NATIVE_IPC_VERSION,
  isNativeMessage,
  type NativeEvent,
  type NativeRequest,
  type NativeResponse
} from '@desktop-translate/contracts/native-ipc';
import { FrameDecoder, encodeFrame } from './frame-codec.js';

type NativeRequestMethod = NativeRequest['method'];
type RequestPayload<TMethod extends NativeRequestMethod> = Extract<
  NativeRequest,
  { method: TMethod }
>['payload'];
type ResponseFor<TMethod extends NativeRequestMethod> = TMethod extends 'hello'
  ? Extract<NativeResponse, { method: 'ready' }>
  : Extract<NativeResponse, { method: TMethod }>;

interface PendingRequest {
  expectedMethod: NativeResponse['method'];
  resolve: (message: NativeResponse) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export interface NativeHostClientOptions {
  pipeName: string;
  requestTimeoutMs?: number;
}

export class NativeHostRequestError extends Error {
  public constructor(
    public readonly code: string,
    public readonly scope: string,
    public readonly recoverable: boolean
  ) {
    super(`Native host request failed (${code})`);
    this.name = 'NativeHostRequestError';
  }
}

export class NativeHostClient extends EventEmitter {
  private socket: Socket | undefined;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly requestTimeoutMs: number;
  private lastEventSeq = -1;
  private pointerDownEventsRequested = false;
  private pointerDownEventsNegotiated = false;

  public constructor(private readonly options: NativeHostClientOptions) {
    super();
    this.requestTimeoutMs = options.requestTimeoutMs ?? 2_000;
  }

  public async connect(timeoutMs = 5_000): Promise<void> {
    if (this.socket) throw new Error('Native host client is already connected');

    this.lastEventSeq = -1;
    this.pointerDownEventsRequested = false;
    this.pointerDownEventsNegotiated = false;

    const socket = net.createConnection(this.options.pipeName);
    this.socket = socket;
    const decoder = new FrameDecoder();
    socket.pipe(decoder);

    decoder.on('data', (value: unknown) => this.handleMessage(value));
    decoder.on('error', () =>
      this.closeWithError(new Error('Native host sent a malformed IPC frame'))
    );
    socket.on('error', (error) => this.closeWithError(sanitizeSocketError(error)));
    socket.on('close', () => this.closeWithError(new Error('Native host pipe closed')));

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error('Timed out connecting to native host pipe'));
      }, timeoutMs);
      socket.once('connect', () => {
        clearTimeout(timeout);
        resolve();
      });
      socket.once('error', (error) => {
        clearTimeout(timeout);
        reject(sanitizeSocketError(error));
      });
    });
  }

  public async request<TMethod extends NativeRequestMethod>(
    method: TMethod,
    payload: RequestPayload<TMethod>,
    timeoutMs = this.requestTimeoutMs
  ): Promise<ResponseFor<TMethod>> {
    if (!this.socket || this.socket.destroyed) {
      throw new Error('Native host is not connected');
    }

    const id = randomUUID();
    const message = {
      v: NATIVE_IPC_VERSION,
      kind: 'request',
      id,
      method,
      timestamp: new Date().toISOString(),
      payload
    } as NativeRequest;
    if (!isNativeMessage(message)) {
      throw new TypeError(`Outgoing Native IPC request violates v1 contract: ${method}`);
    }
    if (message.method === 'hello') {
      this.pointerDownEventsRequested =
        message.payload.requestedCapabilities?.includes('pointer-down-events') ?? false;
    }

    const response = new Promise<NativeResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Native host request timed out: ${method}`));
      }, timeoutMs);
      const expectedMethod: NativeResponse['method'] = method === 'hello' ? 'ready' : method;
      this.pending.set(id, { expectedMethod, resolve, reject, timeout });
    });

    this.socket.write(encodeFrame(message));
    return response as Promise<ResponseFor<TMethod>>;
  }

  public async close(): Promise<void> {
    const socket = this.socket;
    this.socket = undefined;
    this.rejectPending(new Error('Native host client closed'));
    if (!socket || socket.destroyed) return;

    await new Promise<void>((resolve) => {
      socket.end(resolve);
      setTimeout(() => {
        socket.destroy();
        resolve();
      }, 250).unref();
    });
  }

  private handleMessage(value: unknown): void {
    if (!isNativeMessage(value)) {
      this.failProtocol('Received an invalid Native IPC v1 message');
      return;
    }

    if (value.kind === 'response') {
      const pending = this.pending.get(value.id);
      if (!pending) {
        this.failProtocol('Received an unsolicited Native IPC response');
        return;
      }
      if (value.method !== pending.expectedMethod) {
        this.failProtocol(
          `Native IPC response method mismatch: expected ${pending.expectedMethod}, received ${value.method}`
        );
        return;
      }
      clearTimeout(pending.timeout);
      this.pending.delete(value.id);
      if (value.method === 'ready') {
        this.pointerDownEventsNegotiated =
          this.pointerDownEventsRequested &&
          value.payload.capabilities.includes('pointer-down-events');
      }
      pending.resolve(value);
      return;
    }

    if (value.kind === 'event') {
      if (value.method === 'input/pointer-down' && !this.pointerDownEventsNegotiated) {
        this.failProtocol('Native IPC pointer-down event was not negotiated');
        return;
      }
      if (value.seq <= this.lastEventSeq) {
        this.failProtocol('Native IPC event sequence did not increase');
        return;
      }
      this.lastEventSeq = value.seq;
      const event: NativeEvent = value;
      if (event.method === 'host/error' && event.payload.relatedRequestId) {
        const pending = this.pending.get(event.payload.relatedRequestId);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pending.delete(event.payload.relatedRequestId);
          pending.reject(
            new NativeHostRequestError(
              event.payload.code,
              event.payload.scope,
              event.payload.recoverable
            )
          );
        }
      }
      this.emit('message', event);
      this.emit(event.method, event);
    }
  }

  private closeWithError(error: Error): void {
    if (!this.socket) return;
    this.socket.destroy();
    this.socket = undefined;
    this.rejectPending(error);
    this.emit('disconnect', error);
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private failProtocol(message: string): void {
    const error = new Error(message);
    this.emit('protocolError', error);
    this.closeWithError(error);
  }
}

function sanitizeSocketError(error: Error): Error {
  const code = (error as NodeJS.ErrnoException).code;
  return new Error(code ? `Native host pipe error (${code})` : 'Native host pipe error');
}
