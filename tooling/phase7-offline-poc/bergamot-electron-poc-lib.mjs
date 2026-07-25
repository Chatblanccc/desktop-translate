import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, resolve } from 'node:path';

import {
  PocError,
  canonicalJson,
  sha256Text
} from './lib.mjs';

export const ELECTRON_POC_SCHEMA_VERSION = 'phase7-bergamot-electron-poc-v2';
export const ELECTRON_POC_RENDERER_SCHEMA_VERSION =
  'phase7-bergamot-electron-renderer-result-v2';

const CONTENT_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.wasm', 'application/wasm']
]);
const ROUTE_BY_DIRECTION = new Map([
  ['en-zh', { source: 'en', target: 'zh' }],
  ['zh-en', { source: 'zh', target: 'en' }]
]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_PATH_PATTERN = /^\/[A-Za-z0-9._/-]+$/u;
const STATUS_CODE_PATTERN = /^[A-Z0-9_]+$/u;

export function buildElectronRendererConfiguration(
  manifest,
  candidates,
  origin,
  pathToken
) {
  const originUrl = new URL(origin);
  if (originUrl.protocol !== 'http:'
      || originUrl.hostname !== '127.0.0.1'
      || originUrl.username
      || originUrl.password
      || originUrl.pathname !== '/'
      || originUrl.search
      || originUrl.hash) {
    throw new PocError('BERGAMOT_ELECTRON_LOOPBACK_ORIGIN_INVALID');
  }
  const rootPath = tokenRootPath(pathToken);
  if (!Array.isArray(candidates)
      || ![1, 2].includes(candidates.length)) {
    throw new PocError('BERGAMOT_ELECTRON_DIRECTION_CANDIDATES_INVALID');
  }
  const routes = candidates.map((candidate) => {
    const direction = `${candidate.route.source}-${candidate.route.target}`;
    const expected = ROUTE_BY_DIRECTION.get(direction);
    if (!expected
        || candidate.route.source !== expected.source
        || candidate.route.target !== expected.target) {
      throw new PocError('BERGAMOT_ELECTRON_ROUTE_INVALID');
    }
    return {
      direction,
      source: candidate.route.source,
      target: candidate.route.target,
      files: candidate.sourceFiles
        .filter((file) => file.runtimePart !== 'metadata')
        .map((file) => ({
          compression: file.compression,
          runtimePart: file.runtimePart,
          size: file.size,
          sha256: file.sha256,
          urlPath: modelUrlPath(pathToken, candidate.id, file.localPath)
        }))
        .sort((left, right) => left.runtimePart.localeCompare(right.runtimePart))
    };
  }).sort((left, right) => left.direction.localeCompare(right.direction));

  return {
    schemaVersion: 'phase7-bergamot-electron-renderer-config-v2',
    runMode: routes.length === 1
      ? 'DIRECTION_COLD_TRIAL'
      : 'BIDIRECTIONAL_COMPATIBILITY',
    origin: originUrl.origin,
    runtimeModulePath: `${rootPath}runtime/translator.js`,
    routes,
    options: {
      cacheSize: 0,
      downloadTimeout: 0,
      pivotLanguage: null,
      useNativeIntGemm: false,
      warmIterations: manifest.policy.benchmarkWarmIterations
    }
  };
}

export async function buildElectronStaticResources({
  candidates,
  packageRoot,
  rendererPath,
  supplyRoot,
  pathToken
}) {
  const rootPath = tokenRootPath(pathToken);
  const resources = new Map();
  resources.set(rootPath, {
    kind: 'buffer',
    bytes: Buffer.from(
      '<!doctype html><html><head><meta charset="utf-8">'
      + '<meta name="referrer" content="no-referrer">'
      + '<title>Phase 7 offline POC</title></head><body>'
      + `<script type="module" src="${rootPath}poc-renderer.mjs"></script>`
      + '</body></html>',
      'utf8'
    ),
    contentType: CONTENT_TYPES.get('.html')
  });
  resources.set(`${rootPath}poc-renderer.mjs`, {
    kind: 'buffer',
    bytes: await readVerifiedRegularFile(rendererPath),
    contentType: CONTENT_TYPES.get('.mjs')
  });

  const runtimeFiles = [
    ['translator.js', `${rootPath}runtime/translator.js`],
    [
      'worker/translator-worker.js',
      `${rootPath}runtime/worker/translator-worker.js`
    ],
    [
      'worker/bergamot-translator-worker.js',
      `${rootPath}runtime/worker/bergamot-translator-worker.js`
    ],
    [
      'worker/bergamot-translator-worker.wasm',
      `${rootPath}runtime/worker/bergamot-translator-worker.wasm`
    ]
  ];
  const runtimeIdentities = [];
  for (const [relativePath, urlPath] of runtimeFiles) {
    const absolutePath = resolve(packageRoot, ...relativePath.split('/'));
    const bytes = await readVerifiedRegularFile(absolutePath);
    resources.set(urlPath, {
      kind: 'buffer',
      bytes,
      contentType: contentTypeForPath(relativePath)
    });
    runtimeIdentities.push({
      path: relativePath,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex')
    });
  }

  for (const candidate of candidates) {
    for (const file of candidate.sourceFiles) {
      if (file.runtimePart === 'metadata') {
        continue;
      }
      const absolutePath = resolve(supplyRoot, ...file.localPath.split('/'));
      const stat = await lstat(absolutePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.size) {
        throw new PocError('BERGAMOT_ELECTRON_MODEL_RESOURCE_INVALID');
      }
      resources.set(modelUrlPath(pathToken, candidate.id, file.localPath), {
        kind: 'file',
        absolutePath,
        size: file.size,
        contentType: 'application/octet-stream'
      });
    }
  }
  return {
    resources,
    entryPath: rootPath,
    servedRuntimeTreeSha256: sha256Text(canonicalJson(
      runtimeIdentities.sort((left, right) => left.path.localeCompare(right.path))
    ))
  };
}

export async function startLoopbackStaticServer(resources) {
  validateStaticResources(resources);
  let origin = null;
  const metrics = {
    allowedRequests: 0,
    deniedRequests: 0
  };
  const server = createServer((request, response) => {
    handleStaticRequest(request, response, resources, origin, metrics);
  });
  server.maxHeadersCount = 32;
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 2_000;
  await new Promise((resolveListen, rejectListen) => {
    const onError = (error) => {
      server.off('listening', onListening);
      rejectListen(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolveListen();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({
      host: '127.0.0.1',
      port: 0,
      exclusive: true
    });
  });
  const address = server.address();
  if (!address
      || typeof address === 'string'
      || address.address !== '127.0.0.1'
      || address.family !== 'IPv4') {
    await closeLoopbackStaticServer(server);
    throw new PocError('BERGAMOT_ELECTRON_SERVER_NOT_IPV4_LOOPBACK');
  }
  origin = `http://127.0.0.1:${address.port}`;
  return {
    server,
    origin,
    metrics,
    allowedPaths: new Set(resources.keys())
  };
}

export async function closeLoopbackStaticServer(server) {
  if (!server || !server.listening) {
    return;
  }
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  await new Promise((resolveClose) => {
    server.close(() => resolveClose());
  });
}

export function isAllowedElectronRequestUrl(rawUrl, origin, allowedPaths) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  return url.origin === origin
    && url.protocol === 'http:'
    && url.hostname === '127.0.0.1'
    && !url.username
    && !url.password
    && !url.search
    && !url.hash
    && allowedPaths.has(url.pathname);
}

export function validateElectronRendererResult(
  value,
  { expectedDirections = ['en-zh', 'zh-en'] } = {}
) {
  const normalizedExpectedDirections = [...expectedDirections].sort();
  const expectedStatus = normalizedExpectedDirections.length === 1
    ? 'DIRECTION_FIRST_TRANSLATION_SINGLE_RUN_COMPLETE'
    : 'BIDIRECTIONAL_COMPATIBILITY_SINGLE_RUN_COMPLETE';
  if (![1, 2].includes(normalizedExpectedDirections.length)
      || new Set(normalizedExpectedDirections).size
        !== normalizedExpectedDirections.length
      || normalizedExpectedDirections.some(
        (direction) => !ROUTE_BY_DIRECTION.has(direction)
      )) {
    throw new PocError('BERGAMOT_ELECTRON_EXPECTED_DIRECTIONS_INVALID');
  }
  if (!isRecord(value)
      || value.schemaVersion !== ELECTRON_POC_RENDERER_SCHEMA_VERSION
      || value.status !== expectedStatus
      || !Number.isFinite(value.totalMs)
      || value.totalMs < 0
      || !SHA256_PATTERN.test(value.workloadConfigSha256 ?? '')
      || !Array.isArray(value.routes)
      || value.routes.length !== normalizedExpectedDirections.length) {
    throw new PocError('BERGAMOT_ELECTRON_RENDERER_RESULT_INVALID');
  }
  const directions = new Set();
  for (const route of value.routes) {
    if (!isRecord(route)
        || !ROUTE_BY_DIRECTION.has(route.direction)
        || directions.has(route.direction)
        || route.status !== 'FIRST_TRANSLATION_COMPLETE'
        || !Number.isSafeInteger(route.sourceChars)
        || route.sourceChars < 1
        || !Number.isSafeInteger(route.targetChars)
        || route.targetChars < 1
        || !SHA256_PATTERN.test(route.sourceSha256 ?? '')
        || !SHA256_PATTERN.test(route.sampleIdentitySha256 ?? '')
        || !SHA256_PATTERN.test(route.targetSha256 ?? '')
        || route.sourceSha256 === route.targetSha256
        || !Number.isFinite(route.wasmReadyMs)
        || route.wasmReadyMs < 0
        || !Number.isFinite(route.firstTranslationMs)
        || route.firstTranslationMs < 0
        || !Number.isFinite(route.coldRouteTotalMs)
        || route.coldRouteTotalMs < route.firstTranslationMs
        || !Number.isFinite(route.totalMs)
        || route.totalMs < route.coldRouteTotalMs
        || !isRecord(route.warm)
        || !Number.isSafeInteger(route.warm.iterationsRequested)
        || route.warm.iterationsRequested < 1
        || !Number.isSafeInteger(route.warm.failures)
        || route.warm.failures < 0
        || route.warm.failures > route.warm.iterationsRequested
        || !Array.isArray(route.warm.observations)
        || route.warm.observations.length
          !== route.warm.iterationsRequested - route.warm.failures
        || route.warm.observations.some((observation) => (
          !isRecord(observation)
          || !Number.isFinite(observation.translationOnlyMs)
          || observation.translationOnlyMs < 0
          || !Number.isSafeInteger(observation.targetChars)
          || observation.targetChars < 1
          || !SHA256_PATTERN.test(observation.targetSha256 ?? '')
        ))
        || route.translatorCleanupStatus !== 'DELETE_PROMISE_RESOLVED') {
      throw new PocError('BERGAMOT_ELECTRON_RENDERER_ROUTE_INVALID');
    }
    directions.add(route.direction);
  }
  if (!normalizedExpectedDirections.every((direction) => directions.has(direction))) {
    throw new PocError('BERGAMOT_ELECTRON_RENDERER_DIRECTIONS_INCOMPLETE');
  }
  return {
    schemaVersion: value.schemaVersion,
    status: value.status,
    totalMs: roundMs(value.totalMs),
    workloadConfigSha256: value.workloadConfigSha256,
    routes: value.routes
      .map((route) => ({
        direction: route.direction,
        status: route.status,
        sourceChars: route.sourceChars,
        sourceSha256: route.sourceSha256,
        sampleIdentitySha256: route.sampleIdentitySha256,
        targetChars: route.targetChars,
        targetSha256: route.targetSha256,
        wasmReadyMs: roundMs(route.wasmReadyMs),
        firstTranslationMs: roundMs(route.firstTranslationMs),
        coldRouteTotalMs: roundMs(route.coldRouteTotalMs),
        totalMs: roundMs(route.totalMs),
        warm: {
          iterationsRequested: route.warm.iterationsRequested,
          failures: route.warm.failures,
          observations: route.warm.observations.map((observation) => ({
            translationOnlyMs: roundMs(observation.translationOnlyMs),
            targetChars: observation.targetChars,
            targetSha256: observation.targetSha256
          }))
        },
        translatorCleanupStatus: route.translatorCleanupStatus
      }))
      .sort((left, right) => left.direction.localeCompare(right.direction))
  };
}

export function assertElectronPocPrivacy(report) {
  const serialized = JSON.stringify(report);
  const forbiddenKeys = [
    '"source"',
    '"target"',
    '"sourceText"',
    '"targetText"',
    '"translatedText"',
    '"translation"',
    '"reference"',
    '"absolutePath"',
    '"packageRoot"',
    '"supplyRoot"',
    '"authorizationRecordId"',
    '"stderr"',
    '"stack"',
    '"message"'
  ];
  if (forbiddenKeys.some((key) => serialized.includes(key))) {
    throw new PocError('BERGAMOT_ELECTRON_POC_PRIVACY_VIOLATION');
  }
  const homeName = basename(process.env.USERPROFILE ?? '');
  if (homeName && serialized.toLowerCase().includes(homeName.toLowerCase())) {
    throw new PocError('BERGAMOT_ELECTRON_POC_LOCAL_IDENTITY_LEAKED');
  }
}

export function classifyElectronPocError(error) {
  if (error instanceof PocError && STATUS_CODE_PATTERN.test(error.code ?? '')) {
    return error.code;
  }
  const value = [
    error?.code,
    error?.message,
    error?.stack
  ].filter(Boolean).join(' ');
  const explicitCode = value.match(
    /\b(?:BERGAMOT_ELECTRON|LOCAL_VERIFIED_MODEL)_[A-Z0-9_]+\b/u
  )?.[0];
  if (explicitCode && STATUS_CODE_PATTERN.test(explicitCode)) {
    return explicitCode;
  }
  if (/__phase7RunBergamotElectronPoc.*not a function/iu.test(value)) {
    return 'BERGAMOT_ELECTRON_RENDERER_ENTRY_UNAVAILABLE';
  }
  if (/Content Security Policy|Refused to (?:load|execute|connect)/iu.test(value)) {
    return 'BERGAMOT_ELECTRON_CONTENT_SECURITY_POLICY_BLOCKED';
  }
  if (/Failed to fetch|ERR_FAILED/iu.test(value)) {
    return 'BERGAMOT_ELECTRON_LOCAL_FETCH_FAILED';
  }
  if (/timeout/iu.test(value)) {
    return 'BERGAMOT_ELECTRON_POC_TIMEOUT';
  }
  if (/ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET/iu.test(value)) {
    return 'BERGAMOT_ELECTRON_LOOPBACK_SERVER_FAILURE';
  }
  if (/render process gone|crashed|oom/iu.test(value)) {
    return 'BERGAMOT_ELECTRON_RENDERER_GONE';
  }
  return 'BERGAMOT_ELECTRON_POC_UNEXPECTED_FAILURE';
}

export function createElectronPocBlockedReport(errorCode) {
  const blockerCode = STATUS_CODE_PATTERN.test(errorCode ?? '')
    ? errorCode
    : 'BERGAMOT_ELECTRON_POC_UNEXPECTED_FAILURE';
  return {
    schemaVersion: ELECTRON_POC_SCHEMA_VERSION,
    status: 'BLOCKED',
    blockerCode,
    rawTextEmitted: false,
    rawPathsEmitted: false,
    cleanup: {
      browserWindow: 'ATTEMPTED',
      staticServer: 'ATTEMPTED',
      electronAppExit: 'REQUESTED'
    }
  };
}

function handleStaticRequest(request, response, resources, origin, metrics) {
  response.on('error', () => {});
  const remoteAddress = request.socket.remoteAddress;
  const isLoopbackPeer = remoteAddress === '127.0.0.1'
    || remoteAddress === '::ffff:127.0.0.1';
  let url;
  try {
    url = new URL(request.url ?? '', origin);
  } catch {
    denyStaticRequest(response, metrics, 400);
    return;
  }
  const expectedHost = new URL(origin).host;
  const allowed = isLoopbackPeer
    && ['GET', 'HEAD'].includes(request.method ?? '')
    && request.headers.host === expectedHost
    && url.origin === origin
    && !url.username
    && !url.password
    && !url.search
    && !url.hash
    && !request.headers.range
    && resources.has(url.pathname);
  if (!allowed) {
    denyStaticRequest(response, metrics, 404);
    return;
  }
  const resource = resources.get(url.pathname);
  metrics.allowedRequests += 1;
  setStaticHeaders(response, resource.contentType);
  const size = resource.kind === 'buffer' ? resource.bytes.length : resource.size;
  response.statusCode = 200;
  response.setHeader('Content-Length', String(size));
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  if (resource.kind === 'buffer') {
    response.end(resource.bytes);
    return;
  }
  const stream = createReadStream(resource.absolutePath);
  stream.on('error', () => {
    if (!response.headersSent) {
      response.statusCode = 500;
    }
    response.destroy();
  });
  stream.pipe(response);
}

function setStaticHeaders(response, contentType) {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; "
    + "worker-src 'self'; connect-src 'self'; style-src 'none'; img-src 'none'; "
    + "object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
  );
  response.setHeader('Content-Type', contentType);
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
}

function denyStaticRequest(response, metrics, statusCode) {
  metrics.deniedRequests += 1;
  response.statusCode = statusCode;
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Length', '0');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.end();
}

function validateStaticResources(resources) {
  if (!(resources instanceof Map)
      || resources.size < 1
      || ![...resources.keys()].some((path) => /^\/[a-f0-9]{64}\/$/u.test(path))
      || [...resources.keys()].some((path) => (
        path !== '/' && (!SAFE_PATH_PATTERN.test(path) || path.includes('..'))
      ))) {
    throw new PocError('BERGAMOT_ELECTRON_STATIC_RESOURCES_INVALID');
  }
  for (const resource of resources.values()) {
    if (!isRecord(resource)
        || !['buffer', 'file'].includes(resource.kind)
        || typeof resource.contentType !== 'string'
        || (resource.kind === 'buffer' && !Buffer.isBuffer(resource.bytes))
        || (resource.kind === 'file' && (
          typeof resource.absolutePath !== 'string'
          || !Number.isSafeInteger(resource.size)
          || resource.size < 1
        ))) {
      throw new PocError('BERGAMOT_ELECTRON_STATIC_RESOURCE_INVALID');
    }
  }
}

function modelUrlPath(pathToken, candidateId, localPath) {
  const filename = localPath.split('/').at(-1);
  const path = `${tokenRootPath(pathToken)}models/${candidateId}/${filename}`;
  if (!SAFE_PATH_PATTERN.test(path)
      || path.includes('..')
      || encodeURI(path) !== path) {
    throw new PocError('BERGAMOT_ELECTRON_MODEL_URL_PATH_INVALID');
  }
  return path;
}

function tokenRootPath(pathToken) {
  if (typeof pathToken !== 'string' || !/^[a-f0-9]{64}$/u.test(pathToken)) {
    throw new PocError('BERGAMOT_ELECTRON_PATH_TOKEN_INVALID');
  }
  return `/${pathToken}/`;
}

async function readVerifiedRegularFile(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new PocError('BERGAMOT_ELECTRON_STATIC_FILE_INVALID');
  }
  return readFile(path);
}

function contentTypeForPath(path) {
  const extension = [...CONTENT_TYPES.keys()].find((candidate) => path.endsWith(candidate));
  return CONTENT_TYPES.get(extension) ?? 'application/octet-stream';
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function roundMs(value) {
  return Math.round(value * 1000) / 1000;
}
