import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { buildNativePipeName, validateReadyHandshake } from './native-host-supervisor.js';
import { NativeHostSupervisor } from './native-host-supervisor.js';

describe('native host supervisor security boundary', () => {
  const nonce = '0123456789abcdef0123456789abcdef';

  it('builds a private per-launch pipe name', () => {
    expect(buildNativePipeName(4242, nonce)).toBe(
      `\\\\.\\pipe\\desktop-translate.selection-host.4242.${nonce}`
    );
  });

  it('rejects malformed pipe-name inputs', () => {
    expect(() => buildNativePipeName(0, nonce)).toThrow(RangeError);
    expect(() => buildNativePipeName(4242, 'predictable')).toThrow(TypeError);
  });

  it('accepts only a ready response bound to the launch nonce and child PID', () => {
    const payload = {
      selectedVersion: 1,
      sessionNonce: nonce,
      hostPid: '9001',
      capabilities: ['pointer-down-events']
    };
    expect(() => validateReadyHandshake(payload, nonce, 9001)).not.toThrow();
    expect(() => validateReadyHandshake(payload, `${nonce}00`, 9001)).toThrow();
    expect(() => validateReadyHandshake(payload, nonce, 9002)).toThrow();
    expect(() =>
      validateReadyHandshake({ ...payload, selectedVersion: 2 }, nonce, 9001)
    ).toThrow();
    expect(() =>
      validateReadyHandshake({ ...payload, capabilities: [] }, nonce, 9001)
    ).toThrow(/required pointer-down events/u);
  });
});

describe.skipIf(process.platform !== 'win32')('native host supervisor lifecycle', () => {
  const fakeHost = fileURLToPath(new URL('./test-fixtures/fake-native-host.mjs', import.meta.url));

  it('starts, handshakes, checks health, and stops a child process', async () => {
    const supervisor = new NativeHostSupervisor({
      executablePath: process.execPath,
      desktopVersion: '0.5.0-phase5',
      executableArguments: [fakeHost, '--fake-mode', 'stable'],
      healthCheckIntervalMs: 25,
      stableRunMs: 1_000
    });
    const client = await supervisor.start();
    await expect(supervisor.start()).rejects.toThrow(/already running/u);
    await expect(client.request('health', {})).resolves.toMatchObject({ method: 'health' });
    await new Promise((resolve) => setTimeout(resolve, 75));
    const firstStop = supervisor.stop();
    expect(supervisor.stop()).toBe(firstStop);
    await firstStop;
  });

  it('uses safe liveness defaults and force-terminates a Host that ignores shutdown', async () => {
    const supervisor = new NativeHostSupervisor({
      executablePath: process.execPath,
      desktopVersion: '0.5.0-phase5',
      executableArguments: [fakeHost, '--fake-mode', 'ignore-shutdown']
    });
    await supervisor.start();
    await expect(supervisor.stop()).resolves.toBeUndefined();
  }, 5_000);

  it('does not forward a queued selection after shutdown starts', async () => {
    const supervisor = new NativeHostSupervisor({
      executablePath: process.execPath,
      desktopVersion: '0.5.0-phase5',
      executableArguments: [fakeHost, '--fake-mode', 'selection-during-shutdown']
    });
    const selection = vi.fn();
    supervisor.on('selection', selection);

    await supervisor.start();
    await supervisor.stop();

    expect(selection).not.toHaveBeenCalled();
  }, 5_000);

  it('forwards pointer activity only from the active ready child', async () => {
    const supervisor = new NativeHostSupervisor({
      executablePath: process.execPath,
      desktopVersion: '0.5.0-phase5',
      executableArguments: [fakeHost, '--fake-mode', 'pointer-down']
    });
    const pointerDown = once(supervisor, 'pointerDown');

    await supervisor.start();

    await expect(pointerDown).resolves.toMatchObject([
      { point: { x: 120, y: 120 }, coordinateSpace: 'physical-px' }
    ]);
    await supervisor.stop();
  }, 5_000);

  it('retains a failed-handshake child until forced termination has completed', async () => {
    const supervisor = new NativeHostSupervisor({
      executablePath: process.execPath,
      desktopVersion: '0.5.0-phase5',
      executableArguments: [fakeHost, '--fake-mode', 'invalid-handshake']
    });
    const start = supervisor.start();
    const launchedChild = (
      supervisor as unknown as {
        readonly child?: { readonly exitCode: number | null; readonly signalCode: string | null };
      }
    ).child;

    if (launchedChild === undefined) throw new Error('Expected a launched child');
    await expect(start).rejects.toThrow(/invalid or stale ready handshake/u);
    expect(launchedChild.exitCode !== null || launchedChild.signalCode !== null).toBe(true);
    expect((supervisor as unknown as { readonly child?: unknown }).child).toBeUndefined();
    await expect(supervisor.stop()).resolves.toBeUndefined();
  }, 5_000);

  it('rejects a v1 Host that does not negotiate required pointer activity', async () => {
    const supervisor = new NativeHostSupervisor({
      executablePath: process.execPath,
      desktopVersion: '0.5.0-phase5',
      executableArguments: [fakeHost, '--fake-mode', 'missing-pointer-capability']
    });

    await expect(supervisor.start()).rejects.toThrow(/required pointer-down events/u);
    await expect(supervisor.stop()).resolves.toBeUndefined();
  }, 5_000);

  it('does not restart or retain a child that exits before completing its handshake', async () => {
    const supervisor = new NativeHostSupervisor({
      executablePath: process.execPath,
      desktopVersion: '0.5.0-phase5',
      executableArguments: [fakeHost, '--fake-mode', 'exit-before-ready'],
      maxRestarts: 3
    });
    const restarting = vi.fn();
    supervisor.on('restarting', restarting);

    await expect(supervisor.start()).rejects.toBeInstanceOf(Error);
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(restarting).not.toHaveBeenCalled();
    expect((supervisor as unknown as { readonly child?: unknown }).child).toBeUndefined();
    await expect(supervisor.stop()).resolves.toBeUndefined();
  }, 5_000);

  it('opens the restart circuit after repeated early crashes', async () => {
    const supervisor = new NativeHostSupervisor({
      executablePath: process.execPath,
      desktopVersion: '0.5.0-phase5',
      executableArguments: [fakeHost, '--fake-mode', 'crash'],
      maxRestarts: 1,
      healthCheckIntervalMs: 1_000,
      stableRunMs: 10_000
    });
    const fatal = once(supervisor, 'fatal');
    const restarting = once(supervisor, 'restarting');
    await supervisor.start();
    await expect(restarting).resolves.toMatchObject([
      expect.objectContaining({ delay: 250, attempt: 1 })
    ]);
    const [error] = await fatal;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('restart limit');
    await supervisor.stop();
  }, 5_000);

  it('cancels a pending restart when stopped', async () => {
    const supervisor = new NativeHostSupervisor({
      executablePath: process.execPath,
      desktopVersion: '0.5.0-phase5',
      executableArguments: [fakeHost, '--fake-mode', 'crash'],
      maxRestarts: 5,
      healthCheckIntervalMs: 1_000,
      stableRunMs: 10_000
    });
    const restarting = once(supervisor, 'restarting');
    await supervisor.start();
    await restarting;
    await expect(supervisor.stop()).resolves.toBeUndefined();
  }, 5_000);

  it('rejects a missing executable without an unhandled child error', async () => {
    const supervisor = new NativeHostSupervisor({
      executablePath: `Z:\\missing-${Date.now()}\\selection-host.exe`,
      desktopVersion: '0.5.0-phase5',
      maxRestarts: 0
    });
    supervisor.on('spawnError', () => undefined);
    await expect(supervisor.start()).rejects.toBeInstanceOf(Error);
  });
});
