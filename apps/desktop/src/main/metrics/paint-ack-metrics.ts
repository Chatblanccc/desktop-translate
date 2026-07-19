import type { Phase5CharacterCountBucket } from './phase5-metrics.js';
import type { Phase5RuntimeMetricsPort } from './runtime-metrics.js';
import {
  isPhase5PaintTokenPayload,
  PHASE5_METRICS_CHANNELS,
  type Phase5PaintTokenPayload
} from '../../shared/phase5-metrics-channels.js';
import type { InvokeEventLike, WindowRole } from '../ui-shell/ui-shell-ipc.js';

interface PaintProbeTarget {
  readonly id: number;
  isDestroyed(): boolean;
  send(channel: string, payload: Phase5PaintTokenPayload): void;
}

interface PendingPaintProbe {
  readonly senderId: number;
  readonly startedAt: number;
  readonly characterCountBucket: Phase5CharacterCountBucket;
  readonly timeout: NodeJS.Timeout;
}

export interface Phase5PaintMetricsControllerOptions {
  readonly metrics: Phase5RuntimeMetricsPort;
  readonly timeoutMs?: number;
}

export class Phase5PaintMetricsController {
  readonly #metrics: Phase5RuntimeMetricsPort;
  readonly #timeoutMs: number;
  readonly #pending = new Map<number, PendingPaintProbe>();
  #nextToken = 1;
  #disposed = false;

  public constructor(options: Phase5PaintMetricsControllerOptions) {
    this.#metrics = options.metrics;
    this.#timeoutMs = options.timeoutMs ?? 2_000;
  }

  public begin(
    target: PaintProbeTarget,
    characterCountBucket: Phase5CharacterCountBucket
  ): (() => void) | undefined {
    if (this.#disposed || !this.#metrics.enabled || target.isDestroyed()) return undefined;
    const token = this.#nextToken;
    this.#nextToken = token === 2_147_483_647 ? 1 : token + 1;
    if (this.#pending.has(token)) return undefined;
    const startedAt = this.#metrics.beginDuration();
    const timeout = setTimeout(() => {
      const pending = this.#pending.get(token);
      if (pending === undefined) return;
      this.#pending.delete(token);
      this.#metrics.recordDuration({
        metricId: 'PERF-06',
        role: 'main',
        scenario: 'renderer-paint-ack',
        source: 'renderer',
        startedAt: pending.startedAt,
        status: 'failure',
        errorCode: 'PAINT_ACK_TIMEOUT',
        characterCountBucket: pending.characterCountBucket
      });
    }, this.#timeoutMs);
    timeout.unref();
    this.#pending.set(token, {
      senderId: target.id,
      startedAt,
      characterCountBucket,
      timeout
    });
    return () => {
      if (this.#disposed || target.isDestroyed() || !this.#pending.has(token)) return;
      target.send(PHASE5_METRICS_CHANNELS.cardPaintProbe, { token });
    };
  }

  public acknowledge(senderId: number, payload: unknown): boolean {
    if (this.#disposed || !isPhase5PaintTokenPayload(payload)) return false;
    const pending = this.#pending.get(payload.token);
    if (pending === undefined || pending.senderId !== senderId) return false;
    clearTimeout(pending.timeout);
    this.#pending.delete(payload.token);
    this.#metrics.recordDuration({
      metricId: 'PERF-06',
      role: 'main',
      scenario: 'renderer-paint-ack',
      source: 'renderer',
      startedAt: pending.startedAt,
      status: 'success',
      characterCountBucket: pending.characterCountBucket
    });
    return true;
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const pending of this.#pending.values()) clearTimeout(pending.timeout);
    this.#pending.clear();
  }
}

export interface PaintAckIpcMainPort {
  on(
    channel: string,
    listener: (event: InvokeEventLike, ...args: readonly unknown[]) => void
  ): void;
  removeListener(
    channel: string,
    listener: (event: InvokeEventLike, ...args: readonly unknown[]) => void
  ): void;
}

export interface Phase5PaintAckIpcOptions {
  readonly ipcMain: PaintAckIpcMainPort;
  readonly resolveRole: (event: InvokeEventLike) => WindowRole | undefined;
  readonly acknowledge: (senderId: number, payload: unknown) => boolean;
}

export function registerPhase5PaintAckIpc(options: Phase5PaintAckIpcOptions): () => void {
  const listener = (event: InvokeEventLike, ...args: readonly unknown[]): void => {
    if (
      event.senderFrame === null
      || event.senderFrame !== event.sender.mainFrame
      || options.resolveRole(event) !== 'card'
      || args.length !== 1
      || !isPhase5PaintTokenPayload(args[0])
    ) return;
    options.acknowledge(event.sender.id, args[0]);
  };
  options.ipcMain.on(PHASE5_METRICS_CHANNELS.cardPaintAck, listener);
  return () => options.ipcMain.removeListener(PHASE5_METRICS_CHANNELS.cardPaintAck, listener);
}
