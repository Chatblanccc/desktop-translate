import {
  parseLocalDataResetHelperArguments,
  runLocalDataResetHelper
} from './local-data-reset.js';

async function main(): Promise<void> {
  const options = parseLocalDataResetHelperArguments(process.argv.slice(2));
  await runLocalDataResetHelper(options);
}

void main().then(
  () => { process.exitCode = 0; },
  () => {
    // Never print paths, marker contents, or filesystem diagnostics. A pending
    // marker is the only durable failure signal consumed by the next launch.
    process.exitCode = 1;
  }
);
