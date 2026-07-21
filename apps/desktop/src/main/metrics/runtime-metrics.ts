import { performance } from 'node:perf_hooks';
import type { MetricsSink, MetricsSinkState } from './metrics-sink.js';
import {
  createPhase5MetricSample,
  type Phase5BuildMode,
  type Phase5CharacterCountBucket,
  type Phase5MeasurementMode,
  type Phase5MetricErrorCode,
  type Phase5MetricId,
  type Phase5MetricRole,
  type Phase5MetricScenario,
  type Phase5MetricSource
} from './phase5-metrics.js';

export interface Phase5RuntimeMetricsContext {
  readonly gitSha: string;
  readonly binarySha256?: string;
  readonly buildMode: Phase5BuildMode;
  readonly measurementMode: Phase5MeasurementMode;
}

export interface Phase5RuntimeDurationRecord {
  readonly metricId: Phase5MetricId;
  readonly role: Phase5MetricRole;
  readonly scenario: Phase5MetricScenario;
  readonly source: Phase5MetricSource;
  readonly startedAt: number;
  readonly status: 'success' | 'failure';
  readonly characterCountBucket: Phase5CharacterCountBucket;
  readonly errorCode?: Phase5MetricErrorCode;
}

export interface Phase5RuntimeMetricsPort {
  readonly enabled: boolean;
  readonly measurementMode: Phase5MeasurementMode;
  beginDuration(): number;
  recordDuration(record: Phase5RuntimeDurationRecord): void;
  close(): Promise<void>;
}

export interface Phase5RuntimeMetricsOptions {
  readonly sink: MetricsSink;
  readonly context: Phase5RuntimeMetricsContext;
  readonly now?: () => number;
}

/**
 * Main-process-only recorder. It accepts only derived timing metadata and
 * deliberately has no API that can receive source text, credentials or paths.
 */
export class Phase5RuntimeMetrics implements Phase5RuntimeMetricsPort {
  readonly #sink: MetricsSink;
  readonly #context: Phase5RuntimeMetricsContext;
  readonly #now: () => number;
  readonly #pending = new Set<Promise<void>>();
  #closed = false;
  #closePromise: Promise<void> | undefined;

  public constructor(options: Phase5RuntimeMetricsOptions) {
    this.#sink = options.sink;
    this.#context = Object.freeze({ ...options.context });
    this.#now = options.now ?? (() => performance.now());
  }

  public get enabled(): boolean {
    return !this.#closed && this.#sink.getState().status === 'enabled';
  }

  public get measurementMode(): Phase5MeasurementMode {
    return this.#context.measurementMode;
  }

  public beginDuration(): number {
    return this.#now();
  }

  public recordDuration(record: Phase5RuntimeDurationRecord): void {
    if (!this.enabled) return;
    const endedAt = this.#now();
    if (
      !Number.isFinite(record.startedAt)
      || !Number.isFinite(endedAt)
      || endedAt < record.startedAt
    ) return;
    let sample;
    try {
      sample = createPhase5MetricSample({
        metricId: record.metricId,
        measurementMode: this.#context.measurementMode,
        buildMode: this.#context.buildMode,
        role: record.role,
        scenario: record.scenario,
        source: record.source,
        measurement: 'durationMs',
        unit: 'milliseconds',
        status: record.status,
        value: endedAt - record.startedAt,
        characterCountBucket: record.characterCountBucket,
        gitSha: this.#context.gitSha,
        ...(this.#context.binarySha256 === undefined
          ? {}
          : { binarySha256: this.#context.binarySha256 }),
        ...(record.errorCode === undefined ? {} : { errorCode: record.errorCode })
      });
    } catch {
      return;
    }
    const write = this.#sink.record(sample).catch(() => undefined);
    this.#pending.add(write);
    void write.finally(() => this.#pending.delete(write));
  }

  public async close(): Promise<void> {
    this.#closePromise ??= this.#performClose();
    await this.#closePromise;
  }

  async #performClose(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled(this.#pending);
    await this.#sink.close();
  }

  public getSinkState(): MetricsSinkState {
    return this.#sink.getState();
  }
}
