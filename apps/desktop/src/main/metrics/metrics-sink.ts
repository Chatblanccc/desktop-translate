import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import {
  serializePhase5MetricSample,
  type Phase5MetricSample
} from './phase5-metrics.js';

export type MetricsSinkDisabledReason = 'not-enabled' | 'invalid-target' | 'write-failed';

export interface MetricsSinkState {
  readonly status: 'enabled' | 'disabled';
  readonly recordsWritten: number;
  readonly reason?: MetricsSinkDisabledReason;
}

export interface MetricsSink {
  getState(): MetricsSinkState;
  record(sample: Phase5MetricSample): Promise<void>;
  close(): Promise<void>;
}

export interface MetricsSinkOptions {
  readonly enabled?: boolean;
  readonly filePath?: string;
  /** Refuse to append to a file from an earlier benchmark run. */
  readonly exclusiveCreate?: boolean;
}

export function createMetricsSink(options: MetricsSinkOptions = {}): MetricsSink {
  if (options.enabled !== true) return new DisabledMetricsSink();
  if (options.filePath === undefined || !isSafeAbsoluteFilePath(options.filePath)) {
    return new DisabledMetricsSink('invalid-target');
  }
  return new JsonlMetricsSink(options.filePath, options.exclusiveCreate === true);
}

class DisabledMetricsSink implements MetricsSink {
  public constructor(
    private readonly reason: MetricsSinkDisabledReason = 'not-enabled'
  ) {}

  public getState(): MetricsSinkState {
    return Object.freeze({ status: 'disabled', recordsWritten: 0, reason: this.reason });
  }

  public async record(_sample: Phase5MetricSample): Promise<void> {}

  public async close(): Promise<void> {}
}

class JsonlMetricsSink implements MetricsSink {
  readonly #filePath: string;
  #handle: FileHandle | undefined;
  #writeQueue: Promise<void> = Promise.resolve();
  #recordsWritten = 0;
  #disabledReason: MetricsSinkDisabledReason | undefined;
  #needsSeparator = false;

  public constructor(filePath: string, private readonly exclusiveCreate: boolean) {
    this.#filePath = filePath;
  }

  public getState(): MetricsSinkState {
    if (this.#disabledReason !== undefined) {
      return Object.freeze({
        status: 'disabled',
        recordsWritten: this.#recordsWritten,
        reason: this.#disabledReason
      });
    }
    return Object.freeze({ status: 'enabled', recordsWritten: this.#recordsWritten });
  }

  public async record(sample: Phase5MetricSample): Promise<void> {
    const serialized = serializePhase5MetricSample(sample);
    this.#writeQueue = this.#writeQueue.then(async () => {
      if (this.#disabledReason !== undefined) {
        throw new Error('Phase 5 metrics sink is disabled');
      }
      try {
        const handle = await this.#getHandle();
        const prefix = this.#needsSeparator ? '\n' : '';
        this.#needsSeparator = false;
        await handle.appendFile(`${prefix}${serialized}\n`, 'utf8');
        await handle.datasync();
        this.#recordsWritten += 1;
      } catch {
        await this.#disable('write-failed');
        throw new Error('Phase 5 metrics sink write failed');
      }
    });
    await this.#writeQueue;
  }

  public async close(): Promise<void> {
    await this.#writeQueue.catch(() => undefined);
    const handle = this.#handle;
    this.#handle = undefined;
    await handle?.close().catch(() => undefined);
  }

  async #getHandle(): Promise<FileHandle> {
    if (this.#handle !== undefined) return this.#handle;
    const flags = constants.O_APPEND
      | constants.O_CREAT
      | constants.O_RDWR
      | constants.O_NOFOLLOW
      | (this.exclusiveCreate ? constants.O_EXCL : 0);
    const handle = await open(this.#filePath, flags, 0o600);
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) throw new TypeError('Metrics target must be a regular file');
      if (stats.size > 0) {
        const finalByte = Buffer.alloc(1);
        const result = await handle.read(finalByte, 0, 1, stats.size - 1);
        this.#needsSeparator = result.bytesRead === 1 && finalByte[0] !== 0x0a;
      }
      this.#handle = handle;
      return handle;
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  async #disable(reason: MetricsSinkDisabledReason): Promise<void> {
    this.#disabledReason ??= reason;
    const handle = this.#handle;
    this.#handle = undefined;
    await handle?.close().catch(() => undefined);
  }
}

function isSafeAbsoluteFilePath(filePath: string): boolean {
  if (!isAbsolute(filePath) || filePath.includes('\0')) return false;
  if (process.platform !== 'win32') return true;
  if (!/^[a-z]:[\\/]/iu.test(filePath)) return false;
  const normalized = filePath.replaceAll('/', '\\');
  return !normalized.slice(2).includes(':');
}
