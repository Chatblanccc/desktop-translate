import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReadyResponse } from '@desktop-translate/contracts/native-ipc';
import { NativeHostSupervisor } from './native-host/native-host-supervisor.js';

const workspaceRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const executableCandidates = [
  resolve(workspaceRoot, 'native/out/build/windows-x64-msvc/selection-host/Release/selection-host.exe'),
  resolve(workspaceRoot, 'native/out/build/windows-x64-llvm-mingw/selection-host/selection-host.exe'),
  resolve(workspaceRoot, 'native/out/build/llvm-mingw-release/selection-host/selection-host.exe')
];
const executablePath =
  process.env.SELECTION_HOST_PATH ??
  executableCandidates.find((candidate) => existsSync(candidate)) ??
  executableCandidates[0]!;

if (!existsSync(executablePath)) {
  console.error(`Native host is not built: ${executablePath}`);
  process.exitCode = 2;
} else {
  const supervisor = new NativeHostSupervisor({
    executablePath,
    desktopVersion: '0.5.0-phase5',
    maxRestarts: 0,
    healthCheckIntervalMs: 60_000
  });
  let ready: ReadyResponse | undefined;
  supervisor.once('ready', (value: ReadyResponse) => { ready = value; });
  try {
    const client = await supervisor.start();
    const before = await client.request('health', {});
    if (before.payload.listening) throw new Error('Native Host listened before start');

    const started = await client.request('start', {
      enableUia: true,
      enableOcrFallback: true,
      ocrActivation: 'fallback',
      settleDelayMs: 80,
      minDragDistancePx: 4,
      uiaTimeoutMs: 350,
      ocrTimeoutMs: 2_500,
      excludedProcessNames: [basename(process.execPath)]
    }, 3_000);
    const listening = await client.request('health', {});
    if (!started.payload.listening || !listening.payload.listening) {
      throw new Error('Native Host did not report a live Hook/Pipeline after start');
    }

    const stopped = await client.request('stop', { reason: 'phase3-smoke' });
    const after = await client.request('health', {});
    if (stopped.payload.listening || after.payload.listening) {
      throw new Error('Native Host remained listening after stop');
    }
    if (ready === undefined) throw new Error('Native Host omitted the ready handshake');

    console.info(JSON.stringify({
      ok: true,
      hostVersion: ready.payload.hostVersion,
      capabilities: ready.payload.capabilities,
      before: before.payload,
      listening: listening.payload,
      after: after.payload
    }, null, 2));
  } finally {
    await supervisor.stop();
  }
}
