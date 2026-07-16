import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  const supervisor = new NativeHostSupervisor({ executablePath, maxRestarts: 0 });
  try {
    const client = await supervisor.start();
    const health = await client.request('health', {});
    console.info(JSON.stringify({ ok: true, health: health.payload }, null, 2));
  } finally {
    await supervisor.stop();
  }
}
