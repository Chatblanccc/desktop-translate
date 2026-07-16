export interface LifecycleShell {
  start(): Promise<void>;
  openSettings(): void;
  dispose(): Promise<void>;
}

export interface BeforeQuitEventLike {
  preventDefault(): void;
}

export interface ShellLifecycleOptions<TShell extends LifecycleShell> {
  readonly createShell: (requestQuit: () => void) => TShell;
  readonly onShellStarted: (shell: TShell) => void;
  readonly onInitializationFailure: () => void;
  readonly onCleanupFailure: () => void;
  readonly finishShutdown: () => void;
}

export class ShellLifecycle<TShell extends LifecycleShell> {
  private shell: TShell | undefined;
  private shutdownPromise: Promise<void> | undefined;
  private shutdownComplete = false;
  private pendingSecondInstance = false;
  private shellReady = false;

  public constructor(private readonly options: ShellLifecycleOptions<TShell>) {}

  public readonly requestShutdown = (): void => {
    if (this.shutdownComplete || this.shutdownPromise !== undefined) return;
    const current = this.shell;
    this.shell = undefined;
    this.shellReady = false;
    const finishShutdown = (): void => {
      this.shutdownComplete = true;
      this.options.finishShutdown();
    };
    if (current === undefined) {
      finishShutdown();
      return;
    }
    this.shutdownPromise = current.dispose().then(
      finishShutdown,
      () => {
        this.options.onCleanupFailure();
        finishShutdown();
      }
    );
  };

  public async startWhenReady(readiness: Promise<unknown>): Promise<void> {
    try {
      await readiness;
      if (this.shutdownComplete) return;
      const current = this.options.createShell(this.requestShutdown);
      this.shell = current;
      await current.start();
      if (this.shell !== current) return;
      this.shellReady = true;
      this.options.onShellStarted(current);
      if (this.pendingSecondInstance) {
        this.pendingSecondInstance = false;
        current.openSettings();
      }
    } catch {
      this.options.onInitializationFailure();
    }
  }

  public handleSecondInstance(): void {
    if (this.shutdownComplete || this.shutdownPromise !== undefined) return;
    if (this.shell === undefined || !this.shellReady) {
      this.pendingSecondInstance = true;
    } else {
      this.shell.openSettings();
    }
  }

  public handleBeforeQuit(event: BeforeQuitEventLike): void {
    if (this.shutdownComplete) return;
    event.preventDefault();
    this.requestShutdown();
  }
}
