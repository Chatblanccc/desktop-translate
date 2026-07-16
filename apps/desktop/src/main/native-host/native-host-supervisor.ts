import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { NativeHostClient } from './native-host-client.js';

export interface NativeHostSupervisorOptions {
  executablePath: string;
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
  private restartTimer: NodeJS.Timeout | undefined;
  private healthTimer: NodeJS.Timeout | undefined;
  private stableRunTimer: NodeJS.Timeout | undefined;
  private active = false;
  private stopping = false;
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

  public async stop(): Promise<void> {
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
    this.child = undefined;
    if (child && child.exitCode === null) {
      this.expectedExits.add(child);
      const exited = new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => resolve(false), 1_000);
        child.once('exit', () => {
          clearTimeout(timeout);
          resolve(true);
        });
      });
      if (!(await exited) && child.exitCode === null) child.kill();
    }
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
        desktopVersion: '0.1.0-phase1',
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
      client.once('disconnect', (error: Error) => this.handleDisconnect(child, client, error));
      this.scheduleHealthCheck(child, client);
      this.stableRunTimer = setTimeout(() => {
        if (this.child === child && !this.stopping) this.restartCount = 0;
      }, this.options.stableRunMs ?? 30_000).unref();
      this.emit('ready', ready);
      return client;
    } catch (error) {
      this.expectedExits.add(child);
      if (this.client === client) this.client = undefined;
      if (this.child === child) this.child = undefined;
      await client.close();
      child.removeListener('error', onSpawnError);
      child.on('error', (spawnError) => this.emit('spawnError', spawnError));
      if (child.pid !== undefined && child.exitCode === null) child.kill();
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
    if (this.child === child) {
      this.clearLivenessTimers();
      this.child = undefined;
      this.client = undefined;
    }
    this.emit('exit', { code, signal });
    if (!this.active || this.stopping || this.expectedExits.has(child)) return;

    const maxRestarts = this.options.maxRestarts ?? 3;
    if (this.restartCount >= maxRestarts) {
      this.active = false;
      this.emit('fatal', new Error('Native host exceeded restart limit'));
      return;
    }

    const delay = 250 * 2 ** this.restartCount;
    this.restartCount += 1;
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
        .then(() => this.scheduleHealthCheck(child, client))
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
