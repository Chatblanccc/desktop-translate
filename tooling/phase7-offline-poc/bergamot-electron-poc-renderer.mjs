const runtimeModuleUrl = new URL('runtime/translator.js', import.meta.url);
const {
  LatencyOptimisedTranslator,
  TranslatorBacking
} = await import(runtimeModuleUrl.href);

const CONFIG_SCHEMA_VERSION = 'phase7-bergamot-electron-renderer-config-v2';
const RESULT_SCHEMA_VERSION = 'phase7-bergamot-electron-renderer-result-v2';
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const URL_PATH_PATTERN =
  /^\/[a-f0-9]{64}\/models\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u;
const ROUTE_SAMPLES = Object.freeze({
  'en-zh': 'Offline translation should work without a cloud account.',
  'zh-en': '离线翻译应该无需注册云平台账号即可使用。'
});
let activeTranslators = 0;

window.__phase7RunBergamotElectronPoc = async (configuration) => {
  try {
    validateConfiguration(configuration);
    const startedAt = performance.now();
    const routes = [];
    for (const route of configuration.routes) {
      routes.push(await executeFirstTranslation(route, configuration.options));
    }
    const workloadConfigSha256 = await sha256(JSON.stringify({
      schemaVersion: 'phase7-bergamot-fixed-workload-v1',
      runMode: configuration.runMode,
      warmIterations: configuration.options.warmIterations,
      routes: routes.map((route) => ({
        direction: route.direction,
        sourceChars: route.sourceChars,
        sourceSha256: route.sourceSha256,
        sampleIdentitySha256: route.sampleIdentitySha256
      }))
    }));
    return {
      schemaVersion: RESULT_SCHEMA_VERSION,
      status: routes.length === 1
        ? 'DIRECTION_FIRST_TRANSLATION_SINGLE_RUN_COMPLETE'
        : 'BIDIRECTIONAL_COMPATIBILITY_SINGLE_RUN_COMPLETE',
      totalMs: performance.now() - startedAt,
      workloadConfigSha256,
      routes
    };
  } catch (error) {
    return {
      schemaVersion: RESULT_SCHEMA_VERSION,
      status: 'BLOCKED',
      blockerCode: classifyRendererError(error)
    };
  }
};

window.__phase7BergamotCleanupHandshake = async () => {
  await new Promise((resolveWait) => setTimeout(resolveWait, 0));
  await new Promise((resolveWait) => setTimeout(resolveWait, 0));
  return {
    status: activeTranslators === 0
      ? 'RENDERER_TRANSLATORS_CLEAN'
      : 'RENDERER_TRANSLATORS_ACTIVE',
    activeTranslatorCount: activeTranslators
  };
};

async function executeFirstTranslation(route, options) {
  const sourceText = ROUTE_SAMPLES[route.direction];
    const sourceSha256 = await sha256(sourceText);
    const sampleIdentitySha256 = await sha256(
      `${route.direction}\0${[...sourceText].length}\0${sourceSha256}`
    );
  const startedAt = performance.now();
  let translator = null;
  let completedResult = null;
  let cleanupStatus = 'NOT_STARTED';
  let operationError = null;
  try {
    class LocalVerifiedBacking extends TranslatorBacking {
      async loadModelRegistery() {
        return [{
          from: route.source,
          to: route.target
        }];
      }

      async loadTranslationModel({ from, to }) {
        if (from !== route.source || to !== route.target) {
          throw new Error('LOCAL_VERIFIED_MODEL_ROUTE_MISMATCH');
        }
        const parts = new Map();
        for (const file of route.files) {
          const compressed = await fetchVerifiedBytes(file);
          const bytes = file.compression === 'gzip'
            ? await gunzip(compressed)
            : compressed;
          parts.set(file.runtimePart, bytes);
        }
        const vocabularies = parts.has('shared-vocabulary')
          ? [parts.get('shared-vocabulary')]
          : [
            parts.get('source-vocabulary'),
            parts.get('target-vocabulary')
          ];
        if (!parts.get('model')
            || !parts.get('shortlist')
            || vocabularies.some((vocabulary) => !(vocabulary instanceof ArrayBuffer))) {
          throw new Error('LOCAL_VERIFIED_MODEL_PARTS_INCOMPLETE');
        }
        return {
          model: parts.get('model'),
          shortlist: parts.get('shortlist'),
          vocabs: vocabularies,
          qualityModel: null,
          config: {}
        };
      }
    }

    const backing = new LocalVerifiedBacking(options);
    translator = new LatencyOptimisedTranslator(options, backing);
    activeTranslators += 1;
    const wasmStartedAt = performance.now();
    try {
      await translator.worker;
    } catch {
      throw new Error('BERGAMOT_ELECTRON_WASM_WORKER_INITIALIZATION_FAILED');
    }
    const wasmReadyMs = performance.now() - wasmStartedAt;
    const translationStartedAt = performance.now();
    let response;
    try {
      response = await translator.translate({
        from: route.source,
        to: route.target,
        text: sourceText,
        html: false,
        qualityScores: false
      });
    } catch {
      throw new Error('BERGAMOT_ELECTRON_FIRST_TRANSLATION_CALL_FAILED');
    }
    const firstTranslationMs = performance.now() - translationStartedAt;
    const translatedText = response?.target?.text;
    if (typeof translatedText !== 'string' || translatedText.trim().length < 1) {
      throw new Error('BERGAMOT_ELECTRON_EMPTY_TRANSLATION');
    }
    const targetSha256 = await sha256(translatedText);
    if (targetSha256 === sourceSha256) {
      throw new Error('BERGAMOT_ELECTRON_UNCHANGED_TRANSLATION');
    }
    const coldRouteTotalMs = performance.now() - startedAt;
    const warm = {
      iterationsRequested: options.warmIterations,
      failures: 0,
      observations: []
    };
    for (let iteration = 0; iteration < options.warmIterations; iteration += 1) {
      const warmStartedAt = performance.now();
      try {
        const warmResponse = await translator.translate({
          from: route.source,
          to: route.target,
          text: sourceText,
          html: false,
          qualityScores: false
        });
        const warmTranslationOnlyMs = performance.now() - warmStartedAt;
        const warmText = warmResponse?.target?.text;
        if (typeof warmText !== 'string' || warmText.trim().length < 1) {
          throw new Error('BERGAMOT_ELECTRON_EMPTY_WARM_TRANSLATION');
        }
        const warmTargetSha256 = await sha256(warmText);
        if (warmTargetSha256 === sourceSha256) {
          throw new Error('BERGAMOT_ELECTRON_UNCHANGED_WARM_TRANSLATION');
        }
        warm.observations.push({
          translationOnlyMs: warmTranslationOnlyMs,
          targetChars: [...warmText].length,
          targetSha256: warmTargetSha256
        });
      } catch {
        warm.failures += 1;
      }
    }
    completedResult = {
      direction: route.direction,
      status: 'FIRST_TRANSLATION_COMPLETE',
      sourceChars: [...sourceText].length,
      sourceSha256,
      sampleIdentitySha256,
      targetChars: [...translatedText].length,
      targetSha256,
      wasmReadyMs,
      firstTranslationMs,
      coldRouteTotalMs,
      totalMs: performance.now() - startedAt,
      warm
    };
  } catch (error) {
    operationError = error;
  }
  if (translator) {
    const translatorToDelete = translator;
    translator = null;
    try {
      await translatorToDelete.delete();
      cleanupStatus = 'DELETE_PROMISE_RESOLVED';
    } catch {
      operationError ??= new Error('BERGAMOT_ELECTRON_TRANSLATOR_DELETE_FAILED');
    } finally {
      activeTranslators -= 1;
    }
  }
  if (operationError) {
    throw operationError;
  }
  if (!completedResult) {
    throw new Error('BERGAMOT_ELECTRON_RENDERER_RESULT_MISSING');
  }
  return {
    ...completedResult,
    translatorCleanupStatus: cleanupStatus
  };
}

async function fetchVerifiedBytes(file) {
  const url = new URL(file.urlPath, window.location.origin);
  if (url.origin !== window.location.origin
      || url.protocol !== 'http:'
      || url.hostname !== '127.0.0.1'
      || url.search
      || url.hash
      || !URL_PATH_PATTERN.test(url.pathname)) {
    throw new Error('BERGAMOT_ELECTRON_NON_LOOPBACK_MODEL_URL_REJECTED');
  }
  const response = await fetch(url, {
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
    referrerPolicy: 'no-referrer'
  });
  if (!response.ok || response.redirected || response.url !== url.href) {
    throw new Error('BERGAMOT_ELECTRON_LOCAL_MODEL_FETCH_FAILED');
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength !== file.size
      || await sha256(bytes) !== file.sha256) {
    throw new Error('BERGAMOT_ELECTRON_LOCAL_MODEL_IDENTITY_MISMATCH');
  }
  return bytes;
}

async function gunzip(bytes) {
  if (typeof DecompressionStream !== 'function') {
    throw new Error('BERGAMOT_ELECTRON_GZIP_UNAVAILABLE');
  }
  const decompressed = new Blob([bytes])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));
  return new Response(decompressed).arrayBuffer();
}

async function sha256(value) {
  const bytes = typeof value === 'string'
    ? new TextEncoder().encode(value)
    : value;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function validateConfiguration(configuration) {
  if (!configuration
      || configuration.schemaVersion !== CONFIG_SCHEMA_VERSION
      || configuration.origin !== window.location.origin
      || new URL(configuration.runtimeModulePath, window.location.origin).href
        !== runtimeModuleUrl.href
      || !Array.isArray(configuration.routes)
      || ![1, 2].includes(configuration.routes.length)
      || configuration.runMode !== (
        configuration.routes.length === 1
          ? 'DIRECTION_COLD_TRIAL'
          : 'BIDIRECTIONAL_COMPATIBILITY'
      )
      || !configuration.options
      || configuration.options.cacheSize !== 0
      || configuration.options.downloadTimeout !== 0
      || configuration.options.pivotLanguage !== null
      || configuration.options.useNativeIntGemm !== false
      || !Number.isSafeInteger(configuration.options.warmIterations)
      || configuration.options.warmIterations < 1
      || configuration.options.warmIterations > 100) {
    throw new Error('BERGAMOT_ELECTRON_RENDERER_CONFIG_INVALID');
  }
  const directions = new Set();
  for (const route of configuration.routes) {
    if (!route
        || !Object.hasOwn(ROUTE_SAMPLES, route.direction)
        || directions.has(route.direction)
        || `${route.source}-${route.target}` !== route.direction
        || !Array.isArray(route.files)
        || route.files.length < 3) {
      throw new Error('BERGAMOT_ELECTRON_RENDERER_ROUTE_CONFIG_INVALID');
    }
    directions.add(route.direction);
    for (const file of route.files) {
      if (!file
          || !['gzip', 'none'].includes(file.compression)
          || ![
            'model',
            'shared-vocabulary',
            'shortlist',
            'source-vocabulary',
            'target-vocabulary'
          ].includes(file.runtimePart)
          || !Number.isSafeInteger(file.size)
          || file.size < 1
          || !SHA256_PATTERN.test(file.sha256 ?? '')
          || !URL_PATH_PATTERN.test(file.urlPath ?? '')) {
        throw new Error('BERGAMOT_ELECTRON_RENDERER_MODEL_CONFIG_INVALID');
      }
    }
  }
  if (configuration.routes.length === 2
      && !Object.keys(ROUTE_SAMPLES).every(
        (direction) => directions.has(direction)
      )) {
    throw new Error('BERGAMOT_ELECTRON_RENDERER_DIRECTIONS_INCOMPLETE');
  }
}

function classifyRendererError(error) {
  const message = [
    error?.name,
    error?.message,
    error?.stack
  ].filter(Boolean).join(' ');
  const explicit = message.match(
    /\b(?:BERGAMOT_ELECTRON|LOCAL_VERIFIED_MODEL)_[A-Z0-9_]+\b/u
  )?.[0];
  return explicit ?? 'BERGAMOT_ELECTRON_RENDERER_RUNTIME_FAILED';
}
