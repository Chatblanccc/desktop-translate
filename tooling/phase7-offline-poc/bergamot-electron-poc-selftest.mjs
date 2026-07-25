import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  ELECTRON_POC_RENDERER_SCHEMA_VERSION,
  ELECTRON_POC_SCHEMA_VERSION,
  assertElectronPocPrivacy,
  closeLoopbackStaticServer,
  createElectronPocBlockedReport,
  isAllowedElectronRequestUrl,
  startLoopbackStaticServer,
  validateElectronRendererResult
} from './bergamot-electron-poc-lib.mjs';

const pathToken = 'a'.repeat(64);
const rootPath = `/${pathToken}/`;
const resources = new Map([
  [rootPath, {
    kind: 'buffer',
    bytes: Buffer.from('ok'),
    contentType: 'text/plain; charset=utf-8'
  }],
  [`${rootPath}runtime/test.js`, {
    kind: 'buffer',
    bytes: Buffer.from('export default true;'),
    contentType: 'text/javascript; charset=utf-8'
  }]
]);
const loopback = await startLoopbackStaticServer(resources);
try {
  assert.match(loopback.origin, /^http:\/\/127\.0\.0\.1:\d+$/u);
  assert.equal(
    isAllowedElectronRequestUrl(
      `${loopback.origin}${rootPath}runtime/test.js`,
      loopback.origin,
      loopback.allowedPaths
    ),
    true
  );
  assert.equal(
    isAllowedElectronRequestUrl(
      `${loopback.origin}${rootPath}runtime/../secret`,
      loopback.origin,
      loopback.allowedPaths
    ),
    false
  );
  assert.equal(
    isAllowedElectronRequestUrl(
      'https://example.com/runtime/test.js',
      loopback.origin,
      loopback.allowedPaths
    ),
    false
  );
  const response = await fetch(`${loopback.origin}${rootPath}runtime/test.js`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'export default true;');
  const denied = await fetch(`${loopback.origin}${rootPath}not-allowed`);
  assert.equal(denied.status, 404);
  assert.equal(loopback.metrics.deniedRequests, 1);
} finally {
  await closeLoopbackStaticServer(loopback.server);
}
assert.equal(loopback.server.listening, false);

const rendererResult = {
  schemaVersion: ELECTRON_POC_RENDERER_SCHEMA_VERSION,
  status: 'BIDIRECTIONAL_COMPATIBILITY_SINGLE_RUN_COMPLETE',
  totalMs: 3,
  workloadConfigSha256: createHash('sha256')
    .update('fixed-workload')
    .digest('hex'),
  routes: ['en-zh', 'zh-en'].map((direction, index) => ({
    direction,
    status: 'FIRST_TRANSLATION_COMPLETE',
    sourceChars: 10,
    sourceSha256: createHash('sha256').update(`source-${index}`).digest('hex'),
    sampleIdentitySha256: createHash('sha256')
      .update(`sample-${index}`)
      .digest('hex'),
    targetChars: 8,
    targetSha256: createHash('sha256').update(`target-${index}`).digest('hex'),
    wasmReadyMs: 1,
    firstTranslationMs: 2,
    coldRouteTotalMs: 2.5,
    totalMs: 3,
    warm: {
      iterationsRequested: 5,
      failures: 0,
      observations: Array.from({ length: 5 }, (_, warmIndex) => ({
        translationOnlyMs: warmIndex + 0.5,
        targetChars: 8,
        targetSha256: createHash('sha256')
          .update(`warm-target-${index}-${warmIndex}`)
          .digest('hex')
      }))
    },
    translatorCleanupStatus: 'DELETE_PROMISE_RESOLVED'
  }))
};
assert.equal(
  validateElectronRendererResult(rendererResult).routes.length,
  2
);
assert.throws(
  () => validateElectronRendererResult({
    ...rendererResult,
    routes: [rendererResult.routes[0], rendererResult.routes[0]]
  }),
  /BERGAMOT_ELECTRON_RENDERER_ROUTE_INVALID/u
);
const directionResult = {
  ...rendererResult,
  status: 'DIRECTION_FIRST_TRANSLATION_SINGLE_RUN_COMPLETE',
  routes: [rendererResult.routes[0]]
};
assert.equal(
  validateElectronRendererResult(
    directionResult,
    { expectedDirections: ['en-zh'] }
  ).routes.length,
  1
);
assert.throws(
  () => validateElectronRendererResult(
    directionResult,
    { expectedDirections: ['zh-en'] }
  ),
  /BERGAMOT_ELECTRON_RENDERER_DIRECTIONS_INCOMPLETE/u
);
assert.throws(
  () => validateElectronRendererResult({
    ...rendererResult,
    routes: rendererResult.routes.map((route, index) => (
      index === 0
        ? {
          ...route,
          warm: {
            ...route.warm,
            failures: 1
          }
        }
        : route
    ))
  }),
  /BERGAMOT_ELECTRON_RENDERER_ROUTE_INVALID/u
);

const blocked = createElectronPocBlockedReport('BERGAMOT_ELECTRON_POC_TIMEOUT');
assert.equal(blocked.schemaVersion, ELECTRON_POC_SCHEMA_VERSION);
assert.doesNotThrow(() => assertElectronPocPrivacy(blocked));
assert.throws(
  () => assertElectronPocPrivacy({
    ...blocked,
    translation: 'forbidden'
  }),
  /BERGAMOT_ELECTRON_POC_PRIVACY_VIOLATION/u
);

const rendererSource = await (await import('node:fs/promises')).readFile(
  new URL('./bergamot-electron-poc-renderer.mjs', import.meta.url),
  'utf8'
);
assert.doesNotMatch(rendererSource, /console\.(?:log|debug|info|warn|error)/u);
assert.match(rendererSource, /await translatorToDelete\.delete\(\)/u);
assert.match(rendererSource, /options\.warmIterations/u);
assert.match(rendererSource, /translationOnlyMs/u);
assert.match(rendererSource, /response\.redirected/u);
assert.match(rendererSource, /crypto\.subtle\.digest/u);

const mainSource = await (await import('node:fs/promises')).readFile(
  new URL('./bergamot-electron-poc.mjs', import.meta.url),
  'utf8'
);
assert.match(mainSource, /let finalExitCode = 1/u);
assert.match(mainSource, /app\.exit\(finalExitCode\)/u);
assert.match(mainSource, /BERGAMOT_ELECTRON_HARNESS_CLEANUP_FAILED/u);
assert.match(mainSource, /BERGAMOT_ELECTRON_RENDERER_CLEANUP_TIMEOUT/u);
assert.match(mainSource, /BERGAMOT_ELECTRON_RENDERER_READY_PROBE_TIMEOUT/u);
assert.match(
  mainSource,
  /networkMetrics\.blockedExternalRequests !== 0/u
);
assert.match(
  mainSource,
  /networkMetrics\.blockedUnknownLoopbackRequests !== 0/u
);
assert.match(mainSource, /loopback\.metrics\.deniedRequests !== 0/u);
assert.doesNotMatch(mainSource, /node:child_process/u);
assert.doesNotMatch(mainSource, /execFile/u);
assert.doesNotMatch(mainSource, /powershell(?:\.exe)?/iu);
assert.match(mainSource, /authenticodeStatus: 'NOT_VERIFIED'/u);
assert.match(mainSource, /--completion-marker/u);
assert.match(mainSource, /createWarmCompletionMarker/u);
assert.match(mainSource, /BOUND_CREATE_NEW_ARTIFACT/u);

process.stdout.write(`${JSON.stringify({
  schemaVersion: 'phase7-bergamot-electron-poc-selftest-v1',
  status: 'SELF_TEST_PASS',
  externalNetworkVerification: 'NOT_VERIFIED',
  loopbackServerClosed: true,
  rawTextEmitted: false,
  rawPathsEmitted: false
}, null, 2)}\n`);
