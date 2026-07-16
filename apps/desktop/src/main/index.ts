import { app } from 'electron';
import { NativeHostSupervisor } from './native-host/native-host-supervisor.js';

let nativeHost: NativeHostSupervisor | undefined;

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Phase 2 will focus or reveal the settings window here.
  });

  void app
    .whenReady()
    .then(async () => {
      const executablePath = process.env.SELECTION_HOST_PATH;
      if (!executablePath) {
        console.info('[phase1] Native host path is not configured; UI remains intentionally absent.');
        return;
      }

      nativeHost = new NativeHostSupervisor({ executablePath });
      nativeHost.on('fatal', () => console.error('[native-host:fatal] Host restart budget exhausted.'));
      nativeHost.on('stderr', () => console.error('[native-host] Host reported a diagnostic error.'));
      await nativeHost.start();
      console.info('[phase1] Native host handshake completed.');
    })
    .catch(() => {
      console.error('[phase1] Native host failed to start.');
      app.quit();
    });

  app.on('before-quit', (event) => {
    if (!nativeHost) return;
    event.preventDefault();
    const current = nativeHost;
    nativeHost = undefined;
    void current.stop().finally(() => app.exit(0));
  });
}
