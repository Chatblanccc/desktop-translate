import { BrowserWindow, app, session } from 'electron';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { arch, platform, release } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  ELECTRON_POC_SCHEMA_VERSION,
  assertElectronPocPrivacy,
  buildElectronRendererConfiguration,
  buildElectronStaticResources,
  classifyElectronPocError,
  closeLoopbackStaticServer,
  createElectronPocBlockedReport,
  isAllowedElectronRequestUrl,
  startLoopbackStaticServer,
  validateElectronRendererResult
} from './bergamot-electron-poc-lib.mjs';
import {
  buildBergamotGenerationArtifacts,
  loadBergamotGenerationDataset
} from './bergamot-generation-lib.mjs';
import {
  PocError,
  loadJson,
  resolveArtifactOutput,
  writeJsonArtifact
} from './lib.mjs';

const SCRIPT_ROOT = fileURLToPath(new URL('.', import.meta.url));
const RENDERER_PATH = resolve(SCRIPT_ROOT, 'bergamot-electron-poc-renderer.mjs');
const DEFAULT_TIMEOUT_MS = 360_000;
const HELP = `Phase 7 BrowserMT Electron/Chromium research POC

Runs the unmodified official BrowserMT worker/WASM in a hidden sandboxed
BrowserWindow and serves only verified local artifacts from 127.0.0.1:

  pnpm exec electron tooling/phase7-offline-poc/bergamot-electron-poc.mjs \\
    --poc-authorization artifacts/phase7/offline-poc/authorizations/bergamot.json \\
    --direction en-zh \\
    --output artifacts/phase7/offline-poc/measurements/bergamot-electron-poc.json

Generate one private, direction-bound Gate A candidate artifact:

  pnpm exec electron tooling/phase7-offline-poc/bergamot-electron-poc.mjs \\
    --poc-authorization artifacts/phase7/offline-poc/authorizations/bergamot.json \\
    --direction en-zh \\
    --generation-input artifacts/phase7/offline-poc/gate-a/source-en-zh.json \\
    --generation-run-id bergamot-en-zh-001 \\
    --candidate-output artifacts/phase7/offline-poc/gate-a/private/bergamot-en-zh-001.json \\
    --generation-evidence artifacts/phase7/offline-poc/gate-a/generation-en-zh.json

Omit --direction only for the bidirectional compatibility run. A direction
run loads exactly one route and is intended for an external fresh-process
QueryWorkingSet runner.

The JSON result contains only status, lengths, SHA-256 values, timings, and
cleanup/network-policy counters. It never emits source or translated text.
`;

app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-client-side-phishing-detection');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-default-apps');
app.commandLine.appendSwitch('disable-domain-reliability');
app.commandLine.appendSwitch('disable-features', 'MediaRouter,OptimizationHints');
app.commandLine.appendSwitch(
  'host-resolver-rules',
  'MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'
);
app.commandLine.appendSwitch('no-pings');
app.on('window-all-closed', () => {});

let browserWindow = null;
let loopback = null;
let pocSession = null;

const options = parseArguments(process.argv.slice(2));
if (options.help) {
  process.stdout.write(HELP);
  app.exit(0);
} else {
  app.whenReady().then(() => {
    diagnosticStatus('POC_PHASE_ELECTRON_READY');
    return runMain();
  }).catch((error) => {
    const report = createElectronPocBlockedReport(classifyElectronPocError(error));
    writeStdout(report).finally(() => app.exit(1));
  });
}

async function runMain() {
  let report;
  let generationArtifacts = null;
  let finalExitCode = 1;
  try {
    const result = await runElectronPoc(options);
    report = result.report;
    generationArtifacts = result.generationArtifacts;
    if (options.completionMarkerPath) {
      const marker = createWarmCompletionMarker(report);
      report.completionMarker = {
        status: 'BOUND_CREATE_NEW_ARTIFACT',
        bindingSha256: marker.bindingSha256
      };
      await writeJsonArtifact(
        resolveArtifactOutput(options.completionMarkerPath),
        marker
      );
    } else {
      report.completionMarker = {
        status: 'NOT_REQUESTED',
        bindingSha256: null
      };
    }
  } catch (error) {
    report = createElectronPocBlockedReport(classifyElectronPocError(error));
  } finally {
    const cleanup = await cleanupHarness();
    if (report) {
      report.cleanup = cleanup;
      if (cleanupHasFailure(cleanup)
          || (isSuccessfulPartialStatus(report.status)
            && !isCleanupComplete(cleanup))) {
        report.status = 'BLOCKED';
        report.blockerCode = 'BERGAMOT_ELECTRON_HARNESS_CLEANUP_FAILED';
      }
    }
  }

  try {
    assertElectronPocPrivacy(report);
    if (generationArtifacts) {
      const candidateOutputPath = resolveArtifactOutput(
        options.candidateOutputPath
      );
      await writeJsonArtifact(
        candidateOutputPath,
        generationArtifacts.candidateOutput
      );
      const candidateOutputRaw = await readFile(candidateOutputPath);
      if (createHash('sha256').update(candidateOutputRaw).digest('hex')
          !== generationArtifacts.evidence.candidateOutput.artifactSha256) {
        throw new PocError(
          'BERGAMOT_GENERATION_CANDIDATE_OUTPUT_WRITE_IDENTITY_MISMATCH'
        );
      }
      await writeJsonArtifact(
        resolveArtifactOutput(options.generationEvidencePath),
        generationArtifacts.evidence
      );
      report.candidateGeneration.artifactWriteStatus = 'COMPLETE';
    }
    if (options.outputPath) {
      await writeJsonArtifact(resolveArtifactOutput(options.outputPath), report);
    }
    await writeStdout(report);
    finalExitCode = isSuccessfulPartialStatus(report?.status) ? 0 : 1;
  } catch (error) {
    const fallback = createElectronPocBlockedReport(classifyElectronPocError(error));
    fallback.cleanup = report?.cleanup ?? fallback.cleanup;
    try {
      await writeStdout(fallback);
    } catch {
      // A failed stdout write must remain a nonzero process result.
    }
    finalExitCode = 1;
  } finally {
    app.exit(finalExitCode);
  }
}

async function runElectronPoc(config) {
  const trialStartedAt = performance.now();
  diagnosticStatus('POC_PHASE_BEGIN');
  if (!config.pocAuthorizationPath) {
    throw new PocError('BERGAMOT_POC_AUTHORIZATION_REQUIRED_FOR_ELECTRON_POC');
  }
  const manifest = await loadBergamotManifest(config.manifestPath);
  diagnosticStatus('POC_PHASE_MANIFEST_VERIFIED');
  const authorizedCandidates = selectBergamotCandidates(manifest, {
    candidateSetId: 'firefox-bergamot-base-memory-en-zh-bidirectional'
  });
  const authorization = await loadJson(config.pocAuthorizationPath);
  verifyBergamotAuthorization(
    authorization,
    manifest,
    authorizedCandidates.map((candidate) => candidate.id)
  );
  const candidates = config.direction
    ? authorizedCandidates.filter(
      (candidate) => (
        `${candidate.route.source}-${candidate.route.target}` === config.direction
      )
    )
    : authorizedCandidates;
  if (candidates.length !== (config.direction ? 1 : 2)) {
    throw new PocError('BERGAMOT_ELECTRON_DIRECTION_CANDIDATE_MISSING');
  }
  diagnosticStatus('POC_PHASE_AUTHORIZATION_VERIFIED');
  const generationDataset = config.generationInputPath
    ? await loadBergamotGenerationDataset(
      config.generationInputPath,
      config.direction
    )
    : null;
  if (generationDataset) {
    diagnosticStatus('POC_PHASE_GENERATION_DATASET_VERIFIED');
  }
  const supply = await verifyBergamotSupply(manifest, candidates, {
    includeModels: true,
    supplyRoot: config.supplyRoot
  });
  diagnosticStatus('POC_PHASE_SUPPLY_VERIFIED');
  const materialized = await materializeBergamotRuntime(manifest, {
    supplyRoot: config.supplyRoot,
    runtimeRoot: config.runtimeRoot
  });
  diagnosticStatus('POC_PHASE_RUNTIME_MATERIALIZED');
  const staticResources = await buildElectronStaticResources({
    candidates,
    packageRoot: materialized.packageRoot,
    rendererPath: RENDERER_PATH,
    supplyRoot: resolve(config.supplyRoot),
    pathToken: randomBytes(32).toString('hex')
  });
  diagnosticStatus('POC_PHASE_STATIC_RESOURCES_READY');
  loopback = await startLoopbackStaticServer(staticResources.resources);
  diagnosticStatus('POC_PHASE_LOOPBACK_LISTENING');
  const rendererConfiguration = buildElectronRendererConfiguration(
    manifest,
    candidates,
    loopback.origin,
    staticResources.entryPath.split('/')[1],
    {
      generation: generationDataset
        ? {
          generationRunId: config.generationRunId,
          records: generationDataset.rendererRecords
        }
        : null
    }
  );

  pocSession = session.fromPartition(
    `phase7-bergamot-poc-${process.pid}-${Date.now()}`,
    { cache: false }
  );
  const networkMetrics = installSessionNetworkPolicy(
    pocSession,
    loopback.origin,
    loopback.allowedPaths
  );
  browserWindow = new BrowserWindow({
    show: false,
    width: 320,
    height: 240,
    webPreferences: {
      allowRunningInsecureContent: false,
      backgroundThrottling: false,
      contextIsolation: true,
      devTools: false,
      javascript: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      session: pocSession,
      spellcheck: false,
      experimentalFeatures: false,
      plugins: false,
      enableWebSQL: false,
      webSecurity: true,
      webviewTag: false
    }
  });
  diagnosticStatus('POC_PHASE_BROWSER_WINDOW_CREATED');
  const entryUrl = `${loopback.origin}${staticResources.entryPath}`;
  hardenBrowserWindow(browserWindow, entryUrl);
  await browserWindow.loadURL(entryUrl);
  diagnosticStatus('POC_PHASE_RENDERER_LOADED');
  diagnosticStatus(
    `POC_PHASE_STATIC_REQUEST_COUNT_${loopback.metrics.allowedRequests}`
  );
  if (!await waitForRendererReady(browserWindow, 30_000)) {
    throw new PocError('BERGAMOT_ELECTRON_RENDERER_ENTRY_UNAVAILABLE');
  }
  diagnosticStatus('POC_PHASE_RENDERER_READY_HANDSHAKE');
  const rendererResult = await withTimeout(
    browserWindow.webContents.executeJavaScript(
      `window.__phase7RunBergamotElectronPoc(${
        JSON.stringify(rendererConfiguration)
      })`,
      false
    ),
    config.timeoutMs,
    'BERGAMOT_ELECTRON_POC_TIMEOUT'
  );
  diagnosticStatus('POC_PHASE_TRANSLATION_RETURNED');
  if (rendererResult?.status === 'BLOCKED'
      && /^[A-Z0-9_]+$/u.test(rendererResult.blockerCode ?? '')) {
    throw new PocError(rendererResult.blockerCode);
  }
  const cleanupHandshake = await withTimeout(
    browserWindow.webContents.executeJavaScript(
      'window.__phase7BergamotCleanupHandshake()',
      false
    ),
    15_000,
    'BERGAMOT_ELECTRON_RENDERER_CLEANUP_TIMEOUT'
  );
  if (!cleanupHandshake
      || cleanupHandshake.status !== 'RENDERER_TRANSLATORS_CLEAN'
      || cleanupHandshake.activeTranslatorCount !== 0) {
    throw new PocError('BERGAMOT_ELECTRON_RENDERER_CLEANUP_HANDSHAKE_FAILED');
  }
  const expectedDirections = config.direction
    ? [config.direction]
    : ['en-zh', 'zh-en'];
  const verifiedRendererResult = validateElectronRendererResult(
    rendererResult,
    { expectedDirections }
  );
  const generationRun = Boolean(generationDataset);
  let generationArtifacts = null;
  if (generationRun) {
    const route = verifiedRendererResult.routes[0];
    const authorizationRaw = await readFile(resolve(config.pocAuthorizationPath));
    generationArtifacts = buildBergamotGenerationArtifacts({
      authorization,
      authorizationRaw,
      candidateId: candidates[0].id,
      direction: config.direction,
      generationRunId: config.generationRunId,
      manifestSha256: bergamotManifestSha256(manifest),
      materializedRuntimeTreeSha256: materialized.treeSha256,
      modelTreeSha256: supply.treeSha256,
      rendererGeneration: rendererResult.routes?.[0]?.generation,
      servedRuntimeTreeSha256: staticResources.servedRuntimeTreeSha256,
      sourceSet: generationDataset.sourceSet,
      workloadIdentity: {
        sourceChars: route.sourceChars,
        sourceSha256: route.sourceSha256,
        sampleIdentitySha256: route.sampleIdentitySha256,
        workloadConfigSha256: verifiedRendererResult.workloadConfigSha256
      }
    });
  }
  const electronMemoryDiagnostics = collectElectronMemoryDiagnostics();
  const electronExecutable = await identifyElectronExecutable();
  if (networkMetrics.allowedRequests !== loopback.metrics.allowedRequests
      || networkMetrics.blockedExternalRequests !== 0
      || networkMetrics.blockedUnknownLoopbackRequests !== 0
      || loopback.metrics.deniedRequests !== 0) {
    throw new PocError('BERGAMOT_ELECTRON_NETWORK_POLICY_VIOLATION');
  }
  const directionRun = Boolean(config.direction);
  const warmFailureCount = verifiedRendererResult.routes.reduce(
    (sum, route) => sum + route.warm.failures,
    0
  );
  const report = {
    schemaVersion: ELECTRON_POC_SCHEMA_VERSION,
    status: generationRun
      ? 'PARTIAL_M4_FORMAL_CANDIDATE_GENERATION'
      : directionRun
      ? 'PARTIAL_M4_DIRECTION_COLD_TRIAL'
      : 'PARTIAL_M4_COMPATIBILITY_SINGLE_RUN',
    blockerCode: null,
    runMode: generationRun
      ? 'FORMAL_BLIND_CANDIDATE_GENERATION'
      : directionRun
      ? 'DIRECTION_COLD_TRIAL'
      : 'BIDIRECTIONAL_COMPATIBILITY',
    requestedDirection: config.direction,
    manifestSha256: bergamotManifestSha256(manifest),
    supplyTreeSha256: supply.treeSha256,
    materializedRuntimeTreeSha256: materialized.treeSha256,
    servedRuntimeTreeSha256: staticResources.servedRuntimeTreeSha256,
    environmentStatus: {
      platform: platform(),
      releaseHash: sha256Text(release()),
      architecture: arch(),
      electronVersion: process.versions.electron,
      electronVersionHash: sha256Text(process.versions.electron ?? ''),
      chromiumVersion: process.versions.chrome,
      chromiumVersionHash: sha256Text(process.versions.chrome ?? ''),
      electronExecutable
    },
    electronMemoryDiagnostics,
    networkPolicy: {
      status: 'LOOPBACK_ONLY',
      bindAddress: '127.0.0.1',
      allowedRequestCount: networkMetrics.allowedRequests,
      servedRequestCount: loopback.metrics.allowedRequests,
      blockedExternalRequestCount: networkMetrics.blockedExternalRequests,
      blockedUnknownLoopbackRequestCount:
        networkMetrics.blockedUnknownLoopbackRequests,
      deniedStaticRequestCount: loopback.metrics.deniedRequests,
      osFirewallVerification: 'NOT_PERFORMED'
    },
    totalMs: verifiedRendererResult.totalMs,
    harnessStartToWarmSequenceCompleteMs: roundMs(
      performance.now() - trialStartedAt
    ),
    warmIterationsPerRoute: manifest.policy.benchmarkWarmIterations,
    warmFailureCount,
    workloadConfigSha256: verifiedRendererResult.workloadConfigSha256,
    compatibilityRunStatus: verifiedRendererResult.status,
    routes: verifiedRendererResult.routes,
    ...(generationArtifacts
      ? {
        candidateGeneration: {
          ...generationArtifacts.summary,
          artifactWriteStatus: 'PENDING'
        }
      }
      : {}),
    rawTextEmitted: false,
    rawPathsEmitted: false,
    packageMutated: materialized.packageMutated,
    integrationOrDistributionAuthorized: false,
    gateA: {
      status: 'INCOMPLETE',
      eligible: false,
      reasonCodes: [
        generationRun
          ? 'FORMAL_COLD_PWS_REQUIRES_SEPARATE_TWENTY_BY_TWO_RUN'
          : directionRun
          ? 'ONE_FRESH_PROCESS_DIRECTION_TRIAL_REQUIRES_AGGREGATION'
          : 'SINGLE_RUN_NOT_TWENTY_FRESH_PROCESS_COLD_TRIALS',
        generationRun
          ? 'CANDIDATE_OUTPUT_REQUIRES_HUMAN_BLIND_REVIEW'
          : directionRun
          ? 'PRIVATE_WORKING_SET_REQUIRES_EXTERNAL_QUERYWORKINGSET_RUNNER'
          : 'NOT_QUERY_WORKING_SET_PRIVATE_PAGES',
        'NO_HUMAN_BLIND_EVALUATION',
        'LEGAL_REVIEW_INCOMPLETE',
        ...(warmFailureCount > 0
          ? ['WARM_TRANSLATION_FAILURES_PRESENT']
          : [])
      ]
    },
    outputArtifactStatus: config.outputPath ? 'REQUESTED' : 'NOT_REQUESTED'
  };
  assertElectronPocPrivacy(report);
  return { report, generationArtifacts };
}

function diagnosticStatus(code) {
  if (process.env.PHASE7_BERGAMOT_POC_DIAGNOSTICS === '1') {
    process.stderr.write(`${code}\n`);
  }
}

function collectElectronMemoryDiagnostics() {
  if (platform() !== 'win32') {
    return {
      status: 'UNSUPPORTED_PLATFORM',
      gateAEligible: false,
      reason: 'NOT_QUERY_WORKING_SET_PRIVATE_PAGES',
      unit: 'KiB',
      processCount: 0,
      workingSetSizeSum: 0,
      privateBytesSum: 0
    };
  }
  const rows = app.getAppMetrics()
    .map((metric) => metric.memory)
    .filter((memory) => (
      memory
      && Number.isFinite(memory.workingSetSize)
      && Number.isFinite(memory.peakWorkingSetSize)
      && Number.isFinite(memory.privateBytes)
    ));
  if (rows.length < 1) {
    return {
      status: 'MEASUREMENT_UNAVAILABLE',
      gateAEligible: false,
      reason: 'NOT_QUERY_WORKING_SET_PRIVATE_PAGES',
      unit: 'KiB',
      processCount: 0,
      workingSetSizeSum: 0,
      privateBytesSum: 0
    };
  }
  return {
    status: 'ELECTRON_API_DIAGNOSTIC_ONLY',
    gateAEligible: false,
    reason: 'NOT_QUERY_WORKING_SET_PRIVATE_PAGES',
    unit: 'KiB',
    processCount: rows.length,
    workingSetSizeSum: sumMetric(rows, 'workingSetSize'),
    privateBytesSum: sumMetric(rows, 'privateBytes')
  };
}

async function identifyElectronExecutable() {
  const stat = await lstat(process.execPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new PocError('BERGAMOT_ELECTRON_EXECUTABLE_IDENTITY_INVALID');
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(process.execPath)) {
    hash.update(chunk);
  }
  return {
    status: 'IDENTIFIED',
    sizeBytes: stat.size,
    sha256: hash.digest('hex'),
    // A cold-PWS direction run must not add a non-Electron child process to
    // the measured Job. Release Authenticode evidence is gathered outside
    // this measurement child.
    authenticodeStatus: 'NOT_VERIFIED'
  };
}

function sumMetric(rows, key) {
  return Math.round(rows.reduce((sum, row) => sum + row[key], 0));
}

function installSessionNetworkPolicy(targetSession, origin, allowedPaths) {
  const metrics = {
    allowedRequests: 0,
    blockedExternalRequests: 0,
    blockedUnknownLoopbackRequests: 0
  };
  targetSession.setPermissionCheckHandler(() => false);
  targetSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  targetSession.on('will-download', (_event, item) => {
    item.cancel();
  });
  targetSession.webRequest.onBeforeRequest(
    { urls: ['<all_urls>'] },
    (details, callback) => {
      if (isAllowedElectronRequestUrl(details.url, origin, allowedPaths)) {
        metrics.allowedRequests += 1;
        callback({ cancel: false });
        return;
      }
      if (safeUrlOrigin(details.url) === origin) {
        metrics.blockedUnknownLoopbackRequests += 1;
      } else {
        metrics.blockedExternalRequests += 1;
      }
      callback({ cancel: true });
    }
  );
  return metrics;
}

function safeUrlOrigin(rawUrl) {
  try {
    return new URL(rawUrl).origin;
  } catch {
    return null;
  }
}

function hardenBrowserWindow(window, entryUrl) {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
  window.webContents.on('will-navigate', (event, navigationUrl) => {
    if (navigationUrl !== entryUrl) {
      event.preventDefault();
    }
  });
  window.webContents.on('will-redirect', (event) => {
    event.preventDefault();
  });
  window.webContents.on('console-message', (event) => {
    event.preventDefault?.();
  });
}

async function cleanupHarness() {
  let browserWindowStatus = 'NOT_CREATED';
  let staticServerStatus = 'NOT_STARTED';
  let sessionStorageStatus = 'NOT_CREATED';
  let sessionCacheStatus = 'NOT_CREATED';
  let sessionConnectionsStatus = 'NOT_CREATED';
  if (browserWindow) {
    try {
      browserWindow.destroy();
      browserWindowStatus = browserWindow.isDestroyed() ? 'DESTROYED' : 'FAILED';
    } catch {
      browserWindowStatus = 'FAILED';
    }
    browserWindow = null;
  }
  if (pocSession) {
    try {
      await withTimeout(
        pocSession.clearStorageData(),
        5_000,
        'BERGAMOT_ELECTRON_SESSION_STORAGE_CLEANUP_TIMEOUT'
      );
      sessionStorageStatus = 'CLEARED';
    } catch {
      sessionStorageStatus = 'FAILED';
    }
    try {
      await withTimeout(
        pocSession.clearCache(),
        5_000,
        'BERGAMOT_ELECTRON_SESSION_CACHE_CLEANUP_TIMEOUT'
      );
      sessionCacheStatus = 'CLEARED';
    } catch {
      sessionCacheStatus = 'FAILED';
    }
    try {
      await withTimeout(
        pocSession.closeAllConnections(),
        5_000,
        'BERGAMOT_ELECTRON_SESSION_CONNECTION_CLEANUP_TIMEOUT'
      );
      sessionConnectionsStatus = 'CLOSED';
    } catch {
      sessionConnectionsStatus = 'FAILED';
    }
    try {
      pocSession.webRequest.onBeforeRequest(null);
    } catch {
      sessionConnectionsStatus = 'FAILED';
    }
    pocSession = null;
  }
  if (loopback) {
    try {
      await withTimeout(
        closeLoopbackStaticServer(loopback.server),
        5_000,
        'BERGAMOT_ELECTRON_STATIC_SERVER_CLEANUP_TIMEOUT'
      );
      staticServerStatus = loopback.server.listening ? 'FAILED' : 'CLOSED';
    } catch {
      staticServerStatus = 'FAILED';
    }
    loopback = null;
  }
  return {
    browserWindow: browserWindowStatus,
    sessionStorage: sessionStorageStatus,
    sessionCache: sessionCacheStatus,
    sessionConnections: sessionConnectionsStatus,
    staticServer: staticServerStatus,
    electronAppExit: 'REQUESTED',
    residualProcessVerification: 'NOT_VERIFIED_IN_PROCESS'
  };
}

function withTimeout(
  promise,
  timeoutMs,
  blockerCode = 'BERGAMOT_ELECTRON_POC_TIMEOUT'
) {
  return new Promise((resolveValue, rejectValue) => {
    const timer = setTimeout(() => {
      rejectValue(new PocError(blockerCode));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolveValue(value);
      },
      (error) => {
        clearTimeout(timer);
        rejectValue(error);
      }
    );
  });
}

async function waitForRendererReady(window, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const ready = await withTimeout(
        window.webContents.executeJavaScript(
          'typeof window.__phase7RunBergamotElectronPoc === "function"'
          + ' && typeof window.__phase7BergamotCleanupHandshake === "function"',
          false
        ),
        Math.min(1_000, Math.max(100, deadline - Date.now())),
        'BERGAMOT_ELECTRON_RENDERER_READY_PROBE_TIMEOUT'
      );
      if (ready === true) {
        return true;
      }
    } catch {
      // Keep the bounded poll fail closed; no renderer error text is emitted.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  return false;
}

function parseArguments(args) {
  const parsed = {
    completionMarkerPath: null,
    help: false,
    manifestPath: DEFAULT_BERGAMOT_MANIFEST_PATH,
    outputPath: null,
    pocAuthorizationPath: null,
    runtimeRoot: DEFAULT_BERGAMOT_RUNTIME_ROOT,
    supplyRoot: DEFAULT_BERGAMOT_SUPPLY_ROOT,
    direction: null,
    generationInputPath: null,
    generationRunId: null,
    candidateOutputPath: null,
    generationEvidencePath: null,
    timeoutMs: DEFAULT_TIMEOUT_MS
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') {
      parsed.help = true;
    } else if (argument === '--completion-marker') {
      parsed.completionMarkerPath = requireValue(args, ++index, argument);
    } else if (argument === '--manifest') {
      parsed.manifestPath = requireValue(args, ++index, argument);
    } else if (argument === '--output') {
      parsed.outputPath = requireValue(args, ++index, argument);
    } else if (argument === '--poc-authorization') {
      parsed.pocAuthorizationPath = requireValue(args, ++index, argument);
    } else if (argument === '--direction') {
      parsed.direction = requireValue(args, ++index, argument);
    } else if (argument === '--generation-input') {
      parsed.generationInputPath = requireValue(args, ++index, argument);
    } else if (argument === '--generation-run-id') {
      parsed.generationRunId = requireValue(args, ++index, argument);
    } else if (argument === '--candidate-output') {
      parsed.candidateOutputPath = requireValue(args, ++index, argument);
    } else if (argument === '--generation-evidence') {
      parsed.generationEvidencePath = requireValue(args, ++index, argument);
    } else if (argument === '--runtime-root') {
      parsed.runtimeRoot = requireValue(args, ++index, argument);
    } else if (argument === '--supply-root') {
      parsed.supplyRoot = requireValue(args, ++index, argument);
    } else if (argument === '--timeout-ms') {
      parsed.timeoutMs = Number(requireValue(args, ++index, argument));
    } else if (argument.startsWith('--')) {
      throw new PocError('UNKNOWN_BERGAMOT_ELECTRON_POC_ARGUMENT');
    }
  }
  if (!Number.isSafeInteger(parsed.timeoutMs)
      || parsed.timeoutMs < 10_000
      || parsed.timeoutMs > 600_000) {
    throw new PocError('BERGAMOT_ELECTRON_POC_TIMEOUT_INVALID');
  }
  if (parsed.direction !== null
      && !['en-zh', 'zh-en'].includes(parsed.direction)) {
    throw new PocError('BERGAMOT_ELECTRON_POC_DIRECTION_INVALID');
  }
  const generationValues = [
    parsed.generationInputPath,
    parsed.generationRunId,
    parsed.candidateOutputPath,
    parsed.generationEvidencePath
  ];
  const generationRequested = generationValues.some((value) => value !== null);
  if (generationRequested
      && (generationValues.some((value) => value === null)
        || parsed.direction === null
        || parsed.completionMarkerPath !== null
        || !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(
          parsed.generationRunId ?? ''
        ))) {
    throw new PocError('BERGAMOT_ELECTRON_GENERATION_ARGUMENTS_INVALID');
  }
  return parsed;
}

function createWarmCompletionMarker(report) {
  if (report?.status !== 'PARTIAL_M4_DIRECTION_COLD_TRIAL'
      || !['en-zh', 'zh-en'].includes(report.requestedDirection)
      || report.routes?.length !== 1
      || report.routes[0].direction !== report.requestedDirection) {
    throw new PocError('BERGAMOT_ELECTRON_COMPLETION_MARKER_INPUT_INVALID');
  }
  const route = report.routes[0];
  const binding = {
    direction: report.requestedDirection,
    manifestSha256: report.manifestSha256,
    supplyTreeSha256: report.supplyTreeSha256,
    materializedRuntimeTreeSha256: report.materializedRuntimeTreeSha256,
    servedRuntimeTreeSha256: report.servedRuntimeTreeSha256,
    workloadConfigSha256: report.workloadConfigSha256,
    sourceSha256: route.sourceSha256,
    sampleIdentitySha256: route.sampleIdentitySha256,
    targetSha256: route.targetSha256,
    warmTargetSha256: route.warm.observations.map(
      (observation) => observation.targetSha256
    ),
    harnessStartToWarmSequenceCompleteMs:
      report.harnessStartToWarmSequenceCompleteMs
  };
  return {
    schemaVersion: 'phase7-bergamot-warm-complete-v1',
    status: 'WARM_SEQUENCE_COMPLETE',
    direction: report.requestedDirection,
    bindingSha256: sha256Text(JSON.stringify(binding)),
    binding,
    rawTextEmitted: false,
    rawPathsEmitted: false
  };
}

function requireValue(args, index, option) {
  const value = args[index];
  if (!value || value.startsWith('--')) {
    throw new PocError(`MISSING_VALUE_${option.slice(2).toUpperCase().replaceAll('-', '_')}`);
  }
  return value;
}

function sha256Text(value) {
  return createHash('sha256').update(value).digest('hex');
}

function roundMs(value) {
  return Math.round(value * 1000) / 1000;
}

function isSuccessfulPartialStatus(status) {
  return [
    'PARTIAL_M4_COMPATIBILITY_SINGLE_RUN',
    'PARTIAL_M4_DIRECTION_COLD_TRIAL',
    'PARTIAL_M4_FORMAL_CANDIDATE_GENERATION'
  ].includes(status);
}

function isCleanupComplete(cleanup) {
  return cleanup?.browserWindow === 'DESTROYED'
    && cleanup?.sessionStorage === 'CLEARED'
    && cleanup?.sessionCache === 'CLEARED'
    && cleanup?.sessionConnections === 'CLOSED'
    && cleanup?.staticServer === 'CLOSED';
}

function cleanupHasFailure(cleanup) {
  return Object.values(cleanup ?? {}).includes('FAILED');
}

function writeStdout(value) {
  return new Promise((resolveWrite, rejectWrite) => {
    process.stdout.write(
      `${JSON.stringify(value, null, 2)}\n`,
      (error) => error ? rejectWrite(error) : resolveWrite()
    );
  });
}
