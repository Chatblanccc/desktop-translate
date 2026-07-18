import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { NativeHostClient } from './native-host-client.js';
import type { HostErrorEvent, SelectionResultEvent } from '@desktop-translate/contracts/native-ipc';

export interface NativeHostSupervisorOptions {
  executablePath: string;
  desktopVersion?: string;
  /** Prefix arguments are used by the executable test harness; production leaves this empty. */
  executableArguments?: readonly string[];
  maxRestarts?: number;
  healthCheckIntervalMs?: number;
  stableRunMs?: number;
}

export class NativeHostSupervisor extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | undefined;
  private client: NativeHostClient | undefined;
  private readonly expectedExits = new WeakSet<ChildProcessWithoutNullStreams>();
  private readonly readyChildren = new WeakSet<ChildProcessWithoutNullStreams>();
  private restartTimer: NodeJS.Timeout | undefined;
  private healthTimer: NodeJS.Timeout | undefined;
  private stableRunTimer: NodeJS.Timeout | undefined;
  private active = false;
  private stopping = false;
  private stopPromise: Promise<void> | undefined;
  private restartCount = 0;

  public constructor(private readonly options: NativeHostSupervisorOptions) {
    super();
  }

  public async start(): Promise<NativeHostClient> {
    if (process.platform !== 'win32') {
      throw new Error('selection-host is supported only on Windows');
    }
    if (this.active) throw new Error('Native host supervisor is already running');

    this.active = true;
    this.stopping = false;
    this.restartCount = 0;
    try {
      return await this.launch();
    } catch (error) {
      this.active = false;
      throw error;
    }
  }

  public stop(): Promise<void> {
    this.stopPromise ??= this.performStop();
    return this.stopPromise;
  }

  private async performStop(): Promise<void> {
    this.active = false;
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    this.clearLivenessTimers();
    const client = this.client;
    if (client) {
      try {
        await client.request('shutdown', {
          reason: 'electron-main-exit',
          gracePeriodMs: 250
        });
      } catch {
        // The process may have already stopped. Cleanup below is authoritative.
      }
      await client.close();
    }

    const child = this.child;
    this.client = undefined;
    if (child && child.exitCode === null) {
      this.expectedExits.add(child);
      if (!(await waitForChildExit(child, 1_000)) && child.exitCode === null) {
        child.kill();
        if (!(await waitForChildExit(child, 1_000)) && child.exitCode === null) {
          throw new Error('Native host did not exit after forced termination');
        }
      }
    }
    if (this.child === child) this.child = undefined;
  }

  private async launch(): Promise<NativeHostClient> {
    const nonce = randomBytes(16).toString('hex');
    const pipeName = buildNativePipeName(process.pid, nonce);
    const child = spawn(
      this.options.executablePath,
      [
        ...(this.options.executableArguments ?? []),
        '--pipe',
        pipeName,
        '--parent-pid',
        String(process.pid),
        '--nonce',
        nonce
      ],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    let rejectSpawn: ((error: Error) => void) | undefined;
    const spawnFailure = new Promise<never>((_resolve, reject) => {
      rejectSpawn = reject;
    });
    const onSpawnError = (error: Error): void => {
      this.emit('spawnError', error);
      rejectSpawn?.(error);
    };
    child.once('error', onSpawnError);
    this.child = child;
    child.stdout.on('data', (chunk: Buffer) => this.emit('stdout', chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => this.emit('stderr', chunk.toString('utf8')));
    child.once('exit', (code, signal) => this.handleExit(child, code, signal));

    const client = new NativeHostClient({ pipeName });
    this.client = client;
    try {
      await Promise.race([this.connectWithRetry(client), spawnFailure]);
      child.removeListener('error', onSpawnError);
      child.on('error', (error) => this.emit('spawnError', error));
      if (child.pid === undefined) {
        throw new Error('Native host was spawned without a process identifier');
      }
      const ready = await client.request('hello', {
        desktopVersion: this.options.desktopVersion ?? '0.3.0-phase3',
        supportedVersions: [1],
        sessionNonce: nonce,
        requestedCapabilities: [
          'mouse-hook',
          'uia-selection',
          'uia-point-approximation',
          'desktop-capture',
          'ocr'
        ]
      });
      validateReadyHandshake(ready.payload, nonce, child.pid);
      if (
        this.child !== child ||
        child.exitCode !== null ||
        child.signalCode !== null
      ) {
        throw new Error('Native host exited before its ready handshake completed');
      }
      this.readyChildren.add(child);
      client.on('selection/result', (event: SelectionResultEvent) => {
        if (
          this.active
          && !this.stopping
          && this.client === client
          && this.child === child
        ) {
          this.emit('selection', event.payload);
        }
      });
      client.on('host/error', (event: HostErrorEvent) => {
        if (this.client === client && this.child === child) this.emit('hostError', event.payload);
      });
      client.once('disconnect', (error: Error) => this.handleDisconnect(child, client, error));
      this.scheduleHealthCheck(child, client);
      this.stableRunTimer = setTimeout(() => {
        if (this.child === child && !this.stopping) this.restartCount = 0;
      }, this.options.stableRunMs ?? 30_000).unref();
      this.emit('ready', ready);
      this.emit('clientReady', client, ready);
      return client;
    } catch (error) {
      this.expectedExits.add(child);
      await client.close();
      child.removeListener('error', onSpawnError);
      child.on('error', (spawnError) => this.emit('spawnError', spawnError));
      if (
        child.pid !== undefined &&
        child.exitCode === null &&
        child.signalCode === null
      ) {
        child.kill();
        if (!(await waitForChildExit(child, 1_000))) {
          throw new AggregateError(
            [error],
            'Native host launch failed and the child did not exit after forced termination'
          );
        }
      }
      if (this.client === client) this.client = undefined;
      if (this.child === child) this.child = undefined;
      throw error;
    }
  }

  private async connectWithRetry(client: NativeHostClient): Promise<void> {
    const deadline = Date.now() + 5_000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        await client.connect(500);
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Native host did not open its pipe');
  }

  private handleExit(
    child: ChildProcessWithoutNullStreams,
    code: number | null,
    signal: NodeJS.Signals | null
  ): void {
    const wasReady = this.readyChildren.has(child);
    if (this.child === child) {
      this.clearLivenessTimers();
      this.child = undefined;
      this.client = undefined;
    }
    this.emit('exit', { code, signal });
    if (!wasReady || !this.active || this.stopping || this.expectedExits.has(child)) return;

    const maxRestarts = this.options.maxRestarts ?? 3;
    if (this.restartCount >= maxRestarts) {
      this.active = false;
      this.emit('fatal', new Error('Native host exceeded restart limit'));
      return;
    }

    const delay = 250 * 2 ** this.restartCount;
    this.restartCount += 1;
    this.emit('restarting', { delay, attempt: this.restartCount });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (!this.active || this.stopping) return;
      void this.launch().catch((error) => {
        this.active = false;
        this.emit('fatal', error);
      });
    }, delay).unref();
  }

  private handleDisconnect(
    child: ChildProcessWithoutNullStreams,
    client: NativeHostClient,
    error: Error
  ): void {
    if (this.stopping || this.child !== child || this.client !== client) return;
    this.emit('unhealthy', error);
    if (child.exitCode === null) child.kill();
  }

  private scheduleHealthCheck(
    child: ChildProcessWithoutNullStreams,
    client: NativeHostClient
  ): void {
    this.healthTimer = setTimeout(() => {
      this.healthTimer = undefined;
      if (this.stopping || this.child !== child || this.client !== client) return;
      void client
        .request('health', {})
        .then((health) => {
          this.emit('health', health);
          this.scheduleHealthCheck(child, client);
        })
        .catch((error: unknown) =>
          this.handleDisconnect(
            child,
            client,
            error instanceof Error ? error : new Error('Native host health check failed')
          )
        );
    }, this.options.healthCheckIntervalMs ?? 5_000).unref();
  }

  private clearLivenessTimers(): void {
    if (this.healthTimer) clearTimeout(this.healthTimer);
    if (this.stableRunTimer) clearTimeout(this.stableRunTimer);
    this.healthTimer = undefined;
    this.stableRunTimer = undefined;
  }
}

async function waitForChildExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise<boolean>((resolve) => {
    const onExit = (): void => {
      clearTimeout(timeout);
      resolve(true);
    };
    const timeout = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(child.exitCode !== null || child.signalCode !== null);
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

export function buildNativePipeName(mainPid: number, nonce: string): string {
  if (!Number.isSafeInteger(mainPid) || mainPid <= 0) throw new RangeError('Invalid main process ID');
  if (!/^[a-f0-9]{32}$/u.test(nonce)) throw new TypeError('Invalid native host session nonce');
  return `\\\\.\\pipe\\desktop-translate.selection-host.${mainPid}.${nonce}`;
}

export function validateReadyHandshake(
  payload: { selectedVersion: number; sessionNonce: string; hostPid: string },
  nonce: string,
  childPid: number
): void {
  if (
    payload.sessionNonce !== nonce ||
    payload.selectedVersion !== 1 ||
    payload.hostPid !== String(childPid)
  ) {
    throw new Error('Native host returned an invalid or stale ready handshake');
  }
}
