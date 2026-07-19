import {
  PHASE5_BUILD_MODES
} from '../apps/desktop/src/main/metrics/phase5-metrics.ts';
import {
  runInstrumentationBaseline,
  summarizeFile
} from '../apps/desktop/src/main/metrics/phase5-perf-harness.ts';

async function main(arguments_) {
  const [command, ...argumentsAfterCommand] = arguments_;
  const options = parseArguments(argumentsAfterCommand);
  if (command === 'run-instrumentation') {
    const outputDirectory = requiredOption(options, 'output-dir');
    const gitSha = requiredOption(options, 'git-sha');
    const binarySha256 = options.get('binary-sha256');
    const buildMode = options.get('build-mode') ?? 'development';
    const sampleCount = Number(options.get('samples') ?? '30');
    if (!PHASE5_BUILD_MODES.includes(buildMode)) {
      throw new TypeError('Unsupported Phase 5 build mode');
    }
    await runInstrumentationBaseline({
      outputDirectory,
      gitSha,
      buildMode,
      sampleCount,
      ...(binarySha256 === undefined ? {} : { binarySha256 })
    });
    console.log(JSON.stringify({
      status: 'ok',
      evidenceScope: 'instrumentation-only',
      samples: sampleCount,
      files: ['raw.jsonl', 'summary.json']
    }));
    return;
  }
  if (command === 'summary') {
    await summarizeFile(
      requiredOption(options, 'input'),
      requiredOption(options, 'output')
    );
    console.log(JSON.stringify({ status: 'ok', statisticsMethod: 'nearest-rank' }));
    return;
  }
  throw new Error(
    'Usage: phase5-perf-harness <run-instrumentation|summary> --key value'
  );
}

function parseArguments(arguments_) {
  const options = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (key === undefined || value === undefined || !/^--[a-z0-9-]+$/u.test(key)) {
      throw new TypeError('Harness options must use --key value pairs');
    }
    const normalizedKey = key.slice(2);
    if (options.has(normalizedKey)) throw new TypeError('Harness option was provided more than once');
    options.set(normalizedKey, value);
  }
  return options;
}

function requiredOption(options, key) {
  const value = options.get(key);
  if (value === undefined || value.length === 0) throw new TypeError(`Missing --${key}`);
  return value;
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : 'Phase 5 perf harness failed');
  process.exitCode = 1;
});
