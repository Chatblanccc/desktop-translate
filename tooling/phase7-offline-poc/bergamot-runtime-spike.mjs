import { execFile } from 'node:child_process';
import { arch, cpus, platform, release } from 'node:os';
import { basename, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  DEFAULT_BERGAMOT_MANIFEST_PATH,
  DEFAULT_BERGAMOT_RUNTIME_ROOT,
  DEFAULT_BERGAMOT_SUPPLY_ROOT,
  bergamotManifestSha256,
  loadBergamotManifest,
  materializeBergamotRuntime,
  selectBergamotCandidates,
  verifyBergamotAuthorization,
  verifyBergamotSupply
} from './bergamot-lib.mjs';
import {
  PocError,
  loadJson,
  resolveArtifactOutput,
  writeJsonArtifact
} from './lib.mjs';

const SCRIPT_ROOT = fileURLToPath(new URL('.', import.meta.url));
const RUNTIME_WORKER = resolve(SCRIPT_ROOT, 'bergamot-runtime-worker.mjs');
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

const HELP = `Phase 7 official Bergamot npm runtime compatibility spike

Runs locally and with zero network:
  node tooling/phase7-offline-poc/bergamot-runtime-spike.mjs \\
    --poc-authorization artifacts/phase7/offline-poc/authorizations/bergamot.json

Optional ignored JSON output:
  --output artifacts/phase7/offline-poc/measurements/bergamot-runtime-spike.json

The command verifies the pinned npm tarball and separate MPL evidence, extracts
the tarball without executing npm scripts, and probes the unmodified package in
a child process. It never patches or vendors the package. A Node compatibility
failure is recorded as a Gate A blocker with no raw stack, path, or source text.
`;

export async function runBergamotRuntimeSpike(options) {
  const manifest = await loadBergamotManifest(options.manifestPath);
  const candidates = selectBergamotCandidates(manifest, options);
  if (!options.pocAuthorizationPath) {
    throw new PocError('BERGAMOT_POC_AUTHORIZATION_REQUIRED_FOR_RUNTIME_SPIKE');
  }
  const authorization = await loadJson(options.pocAuthorizationPath);
  verifyBergamotAuthorization(
    authorization,
    manifest,
    candidates.map((candidate) => candidate.id)
  );
  const supply = await verifyBergamotSupply(manifest, candidates, {
    includeModels: false,
    supplyRoot: options.supplyRoot
  });
  const materialized = await materializeBergamotRuntime(manifest, {
    supplyRoot: options.supplyRoot,
    runtimeRoot: options.runtimeRoot
  });
  const probe = await executeRuntimeProbe(
    materialized.packageRoot,
    options.probeTimeoutMs
  );
  const report = buildRuntimeSpikeReport({
    manifest,
    candidates,
    supply,
    materialized,
    probe,
    probeTimeoutMs: options.probeTimeoutMs
  });
  assertRuntimeSpikePrivacy(report);
  if (options.outputPath) {
    await writeJsonArtifact(resolveArtifactOutput(options.outputPath), report);
  }
  return report;
}

export function buildRuntimeSpikeReport({
  manifest,
  candidates,
  supply,
  materialized,
  probe,
  probeTimeoutMs
}) {
  return {
    schemaVersion: 'phase7-bergamot-poc-runtime-spike-v1',
    status: probe.status === 'READY'
      ? 'RUNTIME_READY_FOR_MODEL_BENCHMARK'
      : 'BLOCKED_RUNTIME_COMPATIBILITY',
    measuredAt: new Date().toISOString(),
    scope: manifest.policy.pocAuthorizationScope,
    manifest: {
      schemaVersion: manifest.schemaVersion,
      sha256: bergamotManifestSha256(manifest),
      candidateIds: candidates.map((candidate) => candidate.id).sort()
    },
    runtime: {
      packageName: manifest.runtime.packageName,
      version: manifest.runtime.version,
      sourceCommit: manifest.runtime.sourceCommit,
      tarballSha256: manifest.runtime.tarball.sha256,
      tarballIntegrity: manifest.runtime.tarball.integrity,
      packageFileCount: materialized.fileCount,
      packageBytes: materialized.unpackedBytes,
      packageTreeSha256: materialized.treeSha256,
      packageContainsLicenseFile: manifest.runtime.packageContainsLicenseFile,
      installScriptsExecuted: materialized.installScriptsExecuted,
      packageMutated: materialized.packageMutated
    },
    environment: {
      os: `${platform()} ${release()}`,
      architecture: arch(),
      node: process.version,
      logicalCpuCount: cpus().length
    },
    networkIsolation: {
      mode: 'PROCESS_LEVEL_OFFLINE_GUARD',
      offlineEnvironment: true,
      mainThreadSocketGuard: true,
      attemptedCalls: probe.attemptedNetworkCalls,
      externalNetworkAccess: 'NOT_VERIFIED',
      osFirewallVerified: false
    },
    supply: {
      verifiedFileCount: supply.fileCount,
      verifiedBytes: supply.totalBytes,
      supplyTreeSha256: supply.treeSha256
    },
    probe: {
      status: probe.status,
      blockerCode: probe.blockerCode,
      importMs: probe.importMs,
      wasmInitMs: probe.wasmInitMs,
      timeoutBudgetMs: probeTimeoutMs,
      rawErrorEmitted: false
    },
    gateA: {
      status: 'BLOCKED',
      integrationOrDistributionAuthorized: false
    },
    limitations: [
      'This spike executes only the unmodified official npm runtime; it does not patch omitted package files or Windows file-URL handling.',
      'Process-level guards are not equivalent to an independently verified OS firewall or packet capture.',
      'A runtime-ready result would permit only the already-authorized POC benchmark, not product integration or distribution.'
    ]
  };
}

async function executeRuntimeProbe(packageRoot, probeTimeoutMs) {
  const childTimeoutMs = probeTimeoutMs + 2_000;
  const environment = {
    ...process.env,
    HF_HUB_OFFLINE: '1',
    TRANSFORMERS_OFFLINE: '1',
    NO_PROXY: '',
    HTTP_PROXY: 'http://127.0.0.1:9',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    npm_config_audit: 'false',
    npm_config_offline: 'true'
  };
  return new Promise((resolveProbe) => {
    execFile(
      process.execPath,
      [
        RUNTIME_WORKER,
        '--package-root',
        packageRoot,
        '--timeout-ms',
        String(probeTimeoutMs)
      ],
      {
        encoding: 'utf8',
        env: environment,
        maxBuffer: 1024 * 1024,
        timeout: childTimeoutMs,
        windowsHide: true
      },
      (error, stdout) => {
        if (error?.killed) {
          resolveProbe({
            status: 'BLOCKED',
            blockerCode: 'NODE_RUNTIME_PROBE_HARD_TIMEOUT',
            importMs: 0,
            wasmInitMs: null,
            attemptedNetworkCalls: 0,
            rawErrorEmitted: false
          });
          return;
        }
        try {
          const value = JSON.parse(stdout);
          if (!validProbe(value)) {
            throw new Error('INVALID_PROBE');
          }
          resolveProbe(value);
        } catch {
          resolveProbe({
            status: 'BLOCKED',
            blockerCode: 'NODE_RUNTIME_PROBE_INVALID_RESULT',
            importMs: 0,
            wasmInitMs: null,
            attemptedNetworkCalls: 0,
            rawErrorEmitted: false
          });
        }
      }
    );
  });
}

function validProbe(value) {
  return value !== null
    && typeof value === 'object'
    && ['READY', 'BLOCKED'].includes(value.status)
    && (value.blockerCode === null || /^[A-Z0-9_]+$/u.test(value.blockerCode))
    && typeof value.importMs === 'number'
    && (value.wasmInitMs === null || typeof value.wasmInitMs === 'number')
    && Number.isSafeInteger(value.attemptedNetworkCalls)
    && value.attemptedNetworkCalls >= 0
    && value.rawErrorEmitted === false;
}

export function assertRuntimeSpikePrivacy(report) {
  const serialized = JSON.stringify(report);
  const forbiddenKeys = [
    '"sourceText"',
    '"targetText"',
    '"translation"',
    '"absolutePath"',
    '"stderr"',
    '"stack"'
  ];
  if (forbiddenKeys.some((key) => serialized.includes(key))) {
    throw new PocError('BERGAMOT_RUNTIME_SPIKE_PRIVACY_VIOLATION');
  }
  const homeName = basename(process.env.USERPROFILE ?? '');
  if (homeName && serialized.toLowerCase().includes(homeName.toLowerCase())) {
    throw new PocError('BERGAMOT_RUNTIME_SPIKE_LOCAL_IDENTITY_LEAKED');
  }
}

export function parseBergamotRuntimeSpikeArguments(args) {
  const options = {
    candidateId: null,
    candidateSetId: null,
    help: false,
    manifestPath: DEFAULT_BERGAMOT_MANIFEST_PATH,
    outputPath: null,
    pocAuthorizationPath: null,
    probeTimeoutMs: DEFAULT_PROBE_TIMEOUT_MS,
    runtimeRoot: DEFAULT_BERGAMOT_RUNTIME_ROOT,
    supplyRoot: DEFAULT_BERGAMOT_SUPPLY_ROOT
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--candidate') {
      options.candidateId = requireValue(args, ++index, argument);
    } else if (argument === '--candidate-set') {
      options.candidateSetId = requireValue(args, ++index, argument);
    } else if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else if (argument === '--manifest') {
      options.manifestPath = requireValue(args, ++index, argument);
    } else if (argument === '--output') {
      options.outputPath = requireValue(args, ++index, argument);
    } else if (argument === '--poc-authorization') {
      options.pocAuthorizationPath = requireValue(args, ++index, argument);
    } else if (argument === '--probe-timeout-ms') {
      options.probeTimeoutMs = parseTimeout(requireValue(args, ++index, argument));
    } else if (argument === '--runtime-root') {
      options.runtimeRoot = requireValue(args, ++index, argument);
    } else if (argument === '--supply-root') {
      options.supplyRoot = requireValue(args, ++index, argument);
    } else {
      throw new PocError('UNKNOWN_BERGAMOT_RUNTIME_SPIKE_ARGUMENT');
    }
  }
  if (options.candidateId && options.candidateSetId) {
    throw new PocError('BERGAMOT_CANDIDATE_AND_SET_MUTUALLY_EXCLUSIVE');
  }
  return options;
}

function parseTimeout(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 100 || parsed > 60_000) {
    throw new PocError('BERGAMOT_RUNTIME_PROBE_TIMEOUT_INVALID');
  }
  return parsed;
}

function requireValue(args, index, option) {
  const value = args[index];
  if (!value || value.startsWith('--')) {
    throw new PocError(`MISSING_VALUE_${option.slice(2).toUpperCase().replaceAll('-', '_')}`);
  }
  return value;
}

async function runCli() {
  const options = parseBergamotRuntimeSpikeArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  const report = await runBergamotRuntimeSpike(options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

function directInvocation() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (directInvocation()) {
  runCli().catch((error) => {
    const code = error instanceof PocError
      ? error.code
      : 'UNEXPECTED_BERGAMOT_RUNTIME_SPIKE_FAILURE';
    process.stderr.write(`${JSON.stringify({
      status: 'BLOCKED',
      errorCode: code,
      rawPathsEmitted: false,
      rawTextEmitted: false
    })}\n`);
    process.exitCode = 1;
  });
}
