import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ShellLifecycle,
  type LifecycleShell,
  type ShellLifecycleOptions
} from './shell-lifecycle.js';

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (reason?: unknown) => void;
}

interface TestShell extends LifecycleShell {
  readonly start: ReturnType<typeof vi.fn<() => Promise<void>>>;
  readonly openSettings: ReturnType<typeof vi.fn<() => void>>;
  readonly dispose: ReturnType<typeof vi.fn<() => Promise<void>>>;
}

function deferred(): Deferred {
  let resolvePromise: (() => void) | undefined;
  let rejectPromise: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: () => resolvePromise?.(),
    reject: (reason?: unknown) => rejectPromise?.(reason)
  };
}

function makeShell(start = Promise.resolve(), dispose = Promise.resolve()): TestShell {
  return {
    start: vi.fn(() => start),
    openSettings: vi.fn(),
    dispose: vi.fn(() => dispose)
  };
}

function makeHarness(shell: TestShell) {
  const options: ShellLifecycleOptions<TestShell> = {
    createShell: vi.fn(() => shell),
    onShellStarted: vi.fn(),
    onInitializationFailure: vi.fn(),
    onCleanupFailure: vi.fn(),
    finishShutdown: vi.fn()
  };
  return { lifecycle: new ShellLifecycle(options), options };
}

describe('ShellLifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('coalesces second-instance requests before and during start, then handles later requests immediately', async () => {
    const readiness = deferred();
    const starting = deferred();
    const shell = makeShell(starting.promise);
    const { lifecycle, options } = makeHarness(shell);

    const startup = lifecycle.startWhenReady(readiness.promise);
    lifecycle.handleSecondInstance();
    readiness.resolve();
    await vi.waitFor(() => expect(options.createShell).toHaveBeenCalledOnce());

    lifecycle.handleSecondInstance();
    lifecycle.handleSecondInstance();
    expect(shell.openSettings).not.toHaveBeenCalled();

    starting.resolve();
    await startup;
    expect(options.onShellStarted).toHaveBeenCalledOnce();
    expect(shell.openSettings).toHaveBeenCalledOnce();

    lifecycle.handleSecondInstance();
    expect(shell.openSettings).toHaveBeenCalledTimes(2);
  });

  it('reports readiness and shell startup failures without throwing', async () => {
    const readinessFailure = makeHarness(makeShell());
    await readinessFailure.lifecycle.startWhenReady(Promise.reject(new Error('not ready')));
    expect(readinessFailure.options.onInitializationFailure).toHaveBeenCalledOnce();
    expect(readinessFailure.options.createShell).not.toHaveBeenCalled();

    const startupFailure = makeHarness(makeShell(Promise.reject(new Error('start failed'))));
    await startupFailure.lifecycle.startWhenReady(Promise.resolve());
    expect(startupFailure.options.onInitializationFailure).toHaveBeenCalledOnce();
    expect(startupFailure.options.onShellStarted).not.toHaveBeenCalled();
  });

  it('finishes immediately without a shell and ignores later lifecycle events', async () => {
    const { lifecycle, options } = makeHarness(makeShell());
    const event = { preventDefault: vi.fn() };

    lifecycle.requestShutdown();
    lifecycle.requestShutdown();
    lifecycle.handleBeforeQuit(event);
    lifecycle.handleSecondInstance();
    await lifecycle.startWhenReady(Promise.resolve());

    expect(options.finishShutdown).toHaveBeenCalledOnce();
    expect(options.createShell).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('prevents repeated quit events while one successful cleanup is pending', async () => {
    const cleaning = deferred();
    const shell = makeShell(Promise.resolve(), cleaning.promise);
    const { lifecycle, options } = makeHarness(shell);
    await lifecycle.startWhenReady(Promise.resolve());
    const firstEvent = { preventDefault: vi.fn() };
    const repeatedEvent = { preventDefault: vi.fn() };

    lifecycle.handleBeforeQuit(firstEvent);
    lifecycle.handleBeforeQuit(repeatedEvent);
    lifecycle.requestShutdown();
    lifecycle.handleSecondInstance();
    expect(shell.dispose).toHaveBeenCalledOnce();
    expect(options.finishShutdown).not.toHaveBeenCalled();

    cleaning.resolve();
    await vi.waitFor(() => expect(options.finishShutdown).toHaveBeenCalledOnce());
    lifecycle.handleBeforeQuit({ preventDefault: vi.fn() });

    expect(firstEvent.preventDefault).toHaveBeenCalledOnce();
    expect(repeatedEvent.preventDefault).toHaveBeenCalledOnce();
    expect(options.onCleanupFailure).not.toHaveBeenCalled();
  });

  it('reports cleanup failure and still finishes shutdown', async () => {
    const shell = makeShell(Promise.resolve(), Promise.reject(new Error('cleanup failed')));
    const { lifecycle, options } = makeHarness(shell);
    await lifecycle.startWhenReady(Promise.resolve());

    lifecycle.requestShutdown();
    await vi.waitFor(() => expect(options.finishShutdown).toHaveBeenCalledOnce());

    expect(options.onCleanupFailure).toHaveBeenCalledOnce();
  });

  it('does not publish a shell that finishes starting after shutdown begins', async () => {
    const starting = deferred();
    const shell = makeShell(starting.promise);
    const { lifecycle, options } = makeHarness(shell);
    const startup = lifecycle.startWhenReady(Promise.resolve());
    await vi.waitFor(() => expect(shell.start).toHaveBeenCalledOnce());

    lifecycle.requestShutdown();
    await vi.waitFor(() => expect(options.finishShutdown).toHaveBeenCalledOnce());
    starting.resolve();
    await startup;

    expect(options.onShellStarted).not.toHaveBeenCalled();
    expect(shell.openSettings).not.toHaveBeenCalled();
  });
});
