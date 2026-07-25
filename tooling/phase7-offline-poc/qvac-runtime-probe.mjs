import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  assertQvacRuntimeExecutionTreeBound,
  loadQvacRuntimeCandidate,
  qvacRuntimeCandidateSha256,
  verifyQvacAuthorization,
  verifyQvacProbeArtifacts
} from './qvac-runtime-audit.mjs';
import {
  PocError,
  loadJson,
  resolveArtifactOutput,
  writeJsonArtifact
} from './lib.mjs';

const execFileAsync = promisify(execFile);
const PROBE_SCOPE = 'POC_RESEARCH_ONLY_NO_INTEGRATION_OR_DISTRIBUTION';
const MAX_BUFFER = 1024 * 1024;
const PROBE_TIMEOUT_MS = 30_000;

const nodeProbeSource = String.raw`
const start = Date.now()
try {
  require('@qvac/translation-nmtcpp')
  console.log(JSON.stringify({
    status: 'UNEXPECTED_NODE_IMPORT_PASS',
    importMs: Date.now() - start,
    rawErrorEmitted: false
  }))
} catch (error) {
  const expected = error
    && error.name === 'ReferenceError'
    && error.message === 'Bare is not defined'
  console.log(JSON.stringify({
    status: expected ? 'BLOCKED_AS_EXPECTED' : 'BLOCKED_UNCLASSIFIED',
    blockerCode: expected ? 'BARE_GLOBAL_NOT_DEFINED' : 'UNCLASSIFIED_NODE_IMPORT_FAILURE',
    importMs: Date.now() - start,
    rawErrorEmitted: false
  }))
}
`;

const bareProbeSource = String.raw`
const importStart = Date.now()
const TranslationNmtcpp = require('@qvac/translation-nmtcpp')
const importMs = Date.now() - importStart
const constructorStart = Date.now()
const model = new TranslationNmtcpp({
  files: {
    model: 'model.enzh.intgemm.alphas.bin',
    srcVocab: 'srcvocab.enzh.spm',
    dstVocab: 'trgvocab.enzh.spm'
  },
  params: { srcLang: 'en', dstLang: 'zh' },
  config: { modelType: TranslationNmtcpp.ModelTypes.Bergamot }
})
const expectedMethods = [
  'load',
  'run',
  'runBatch',
  'unload',
  'destroy',
  'getState',
  'getActiveBackendName',
  'getActiveBackendDescription'
]
console.log(JSON.stringify({
  status: 'IMPORT_AND_CONSTRUCTOR_PASS',
  importMs,
  constructorMs: Date.now() - constructorStart,
  modelTypes: TranslationNmtcpp.ModelTypes,
  state: model.getState(),
  backend: model.getActiveBackendName(),
  methodCount: expectedMethods.filter((name) => typeof model[name] === 'function').length,
  modelLoad: 'NOT_RUN',
  firstTranslation: 'NOT_RUN',
  rawErrorEmitted: false
}))
`;

export async function runQvacImportConstructorProbe({
  authorization,
  manifest,
  probeRoot
}) {
  const authorizationSummary = verifyQvacAuthorization(authorization, manifest);
  assertQvacRuntimeExecutionTreeBound(manifest);
  const artifactVerification = await verifyQvacProbeArtifacts(manifest, probeRoot);
  const runtimeRoot = resolve(probeRoot, 'runtime');
  const bareExecutable = resolve(
    runtimeRoot,
    'node_modules',
    'bare-runtime-win32-x64',
    'bin',
    'bare.exe'
  );
  const environment = {
    ...sanitizedChildEnvironment(),
    npm_config_offline: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false'
  };

  const nodeStarted = performance.now();
  const nodeResult = await execProbe(process.execPath, ['-e', nodeProbeSource], {
    cwd: runtimeRoot,
    env: environment
  });
  nodeResult.processLaunchAndProbeMs = roundMilliseconds(
    performance.now() - nodeStarted
  );
  if (nodeResult.status !== 'BLOCKED_AS_EXPECTED'
      || nodeResult.blockerCode !== 'BARE_GLOBAL_NOT_DEFINED'
      || nodeResult.rawErrorEmitted !== false) {
    throw new PocError('QVAC_NODE_IMPORT_BLOCKER_CHANGED');
  }

  const bareStarted = performance.now();
  const bareResult = await execProbe(bareExecutable, ['-e', bareProbeSource], {
    cwd: runtimeRoot,
    env: environment
  });
  bareResult.processLaunchAndProbeMs = roundMilliseconds(
    performance.now() - bareStarted
  );
  if (bareResult.status !== 'IMPORT_AND_CONSTRUCTOR_PASS'
      || bareResult.modelTypes?.Bergamot !== 'Bergamot'
      || bareResult.methodCount !== 8
      || bareResult.backend !== 'Unloaded'
      || bareResult.state?.configLoaded !== false
      || bareResult.state?.weightsLoaded !== false
      || bareResult.modelLoad !== 'NOT_RUN'
      || bareResult.firstTranslation !== 'NOT_RUN'
      || bareResult.rawErrorEmitted !== false) {
    throw new PocError('QVAC_BARE_IMPORT_CONSTRUCTOR_PROBE_FAILED');
  }

  return {
    schemaVersion: 'phase7-qvac-import-constructor-probe-v1',
    status: 'CONTROLLED_RUNTIME_PROBE_PASS_GATE_A_STILL_BLOCKED',
    scope: authorizationSummary.scope,
    pocAuthorizationRecordId: authorizationSummary.authorizationRecordId,
    candidate: `${manifest.runtime.packageName}@${manifest.runtime.version}`,
    manifestSha256: qvacRuntimeCandidateSha256(manifest),
    host: {
      platform: process.platform,
      architecture: process.arch,
      nodeVersion: process.versions.node,
      bareVersion: manifest.runtime.barePocRuntime.version
    },
    coldStartDefinition: 'PROCESS_LAUNCH_PLUS_IMPORT_AND_CONSTRUCTOR_ONLY',
    node: nodeResult,
    bare: bareResult,
    artifactVerification: {
      status: artifactVerification.status,
      fileCount: artifactVerification.fileCount,
      totalBytes: artifactVerification.totalBytes
    },
    isolation: {
      applicationModelFetcherInvoked: false,
      modelLoadInvoked: false,
      translationInvoked: false,
      sourceOrOutputTextRecorded: false,
      externalNetworkAccess: 'NOT_VERIFIED',
      osLevelPacketCapture: 'NOT_RUN'
    },
    gateA: {
      status: 'BLOCKED',
      productIntegrationAllowed: false,
      firstTranslationEvidence: 'NOT_AVAILABLE'
    }
  };
}

async function execProbe(command, args, options) {
  try {
    const result = await execFileAsync(command, args, {
      ...options,
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: MAX_BUFFER
    });
    return parseLastJsonLine(result.stdout);
  } catch {
    throw new PocError('QVAC_RUNTIME_PROBE_PROCESS_FAILED');
  }
}

function parseLastJsonLine(output) {
  const lines = String(output)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    throw new PocError('QVAC_RUNTIME_PROBE_OUTPUT_MISSING');
  }
  try {
    return JSON.parse(lines.at(-1));
  } catch {
    throw new PocError('QVAC_RUNTIME_PROBE_OUTPUT_INVALID');
  }
}

function roundMilliseconds(value) {
  return Math.round(value * 1000) / 1000;
}

function sanitizedChildEnvironment() {
  const allowed = new Set([
    'COMSPEC',
    'NUMBER_OF_PROCESSORS',
    'PATH',
    'PATHEXT',
    'PROCESSOR_ARCHITECTURE',
    'SYSTEMDRIVE',
    'SYSTEMROOT',
    'TEMP',
    'TMP',
    'WINDIR'
  ]);
  return Object.fromEntries(
    Object.entries(process.env)
      .filter(([key]) => allowed.has(key.toUpperCase()))
  );
}

function parseArguments(args) {
  if (args.includes('--help')) {
    return { help: true };
  }
  const options = {
    help: false,
    outputPath: null,
    pocAuthorizationPath: null,
    probeRoot: null,
    scope: null
  };
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (typeof value !== 'string') {
      throw new PocError('QVAC_RUNTIME_PROBE_ARGUMENT_INVALID');
    }
    if (flag === '--probe-root' && options.probeRoot === null) {
      options.probeRoot = value;
    } else if (flag === '--poc-authorization'
        && options.pocAuthorizationPath === null) {
      options.pocAuthorizationPath = value;
    } else if (flag === '--acknowledge-poc-scope' && options.scope === null) {
      options.scope = value;
    } else if (flag === '--output' && options.outputPath === null) {
      options.outputPath = value;
    } else {
      throw new PocError('QVAC_RUNTIME_PROBE_ARGUMENT_INVALID');
    }
  }
  if (!options.probeRoot
      || !options.pocAuthorizationPath
      || options.scope !== PROBE_SCOPE) {
    throw new PocError('QVAC_RUNTIME_PROBE_BOUND_AUTHORIZATION_REQUIRED');
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      'Usage: node qvac-runtime-probe.mjs --probe-root <ignored-qvac-probe-root> '
      + '--poc-authorization <ignored-json> '
      + `--acknowledge-poc-scope ${PROBE_SCOPE} [--output <ignored-json>]\n`
    );
    return;
  }
  const manifest = await loadQvacRuntimeCandidate();
  const authorization = await loadJson(options.pocAuthorizationPath);
  const report = await runQvacImportConstructorProbe({
    authorization,
    manifest,
    probeRoot: options.probeRoot
  });
  if (options.outputPath) {
    await writeJsonArtifact(resolveArtifactOutput(options.outputPath), report);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      errorCode: error instanceof PocError
        ? error.code
        : 'QVAC_RUNTIME_PROBE_UNEXPECTED_FAILURE'
    })}\n`);
    process.exitCode = 1;
  });
}
