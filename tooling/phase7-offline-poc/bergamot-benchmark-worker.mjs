import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { readFile } from 'node:fs/promises';
import tls from 'node:tls';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';

const gunzipAsync = promisify(gunzip);
const DIGIT_PATTERN = /\d+(?:[./,:-]\d+)*/gu;
const URL_PATTERN = /https?:\/\/[^\s，。！？；]+/giu;
const PLACEHOLDER_PATTERN = /\{\{[^{}\s]+\}\}|\{[^{}\s]+\}|\$\{[^{}\s]+\}|%[A-Za-z0-9_]+%/gu;

export async function runBergamotBenchmarkWorker(config) {
  validateConfig(config);
  const network = installMainThreadNetworkGuard();
  const memoryBefore = process.memoryUsage().rss;
  let peakRss = memoryBefore;
  const start = performance.now();
  const importStart = performance.now();
  let runtime;
  try {
    runtime = await import(pathToFileURL(resolve(config.packageRoot, 'translator.js')).href);
  } catch (error) {
    return blockedRoute(config.direction, classifyRuntimeError(error), network.attemptedCalls);
  }
  const runtimeImportMs = performance.now() - importStart;
  let localModels = config.models;

  class LocalVerifiedBacking extends runtime.TranslatorBacking {
    async loadModelRegistery() {
      return localModels.map((model) => ({
        from: model.source,
        to: model.target
      }));
    }

    async loadTranslationModel({ from, to }) {
      const model = localModels.find((item) => item.source === from && item.target === to);
      if (!model) {
        throw new Error('LOCAL_VERIFIED_MODEL_NOT_FOUND');
      }
      const parts = new Map();
      for (const file of model.files) {
        if (file.runtimePart === 'metadata') {
          continue;
        }
        const compressed = await readFile(resolve(
          config.supplyRoot,
          ...file.localPath.split('/')
        ));
        const bytes = file.compression === 'gzip'
          ? await gunzipAsync(compressed)
          : compressed;
        parts.set(file.runtimePart, exactArrayBuffer(bytes));
      }
      const vocabularies = parts.has('shared-vocabulary')
        ? [parts.get('shared-vocabulary')]
        : [
          parts.get('source-vocabulary'),
          parts.get('target-vocabulary')
        ];
      if (!parts.get('model')
          || !parts.get('shortlist')
          || vocabularies.some((vocabulary) => !vocabulary)) {
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

  const backing = new LocalVerifiedBacking({
    cacheSize: 0,
    downloadTimeout: 0,
    pivotLanguage: null,
    useNativeIntGemm: false
  });
  let resolveWorkerError;
  const workerError = new Promise((resolveError) => {
    resolveWorkerError = resolveError;
  });
  backing.onerror = (event) => resolveWorkerError({
    status: 'BLOCKED',
    blockerCode: classifyRuntimeError(event?.data ?? event)
  });
  const originalConsole = {
    debug: console.debug,
    error: console.error,
    warn: console.warn
  };
  console.debug = () => {};
  console.error = () => {};
  console.warn = () => {};
  const translator = new runtime.LatencyOptimisedTranslator({
    cacheSize: 0,
    downloadTimeout: 0,
    pivotLanguage: null,
    useNativeIntGemm: false
  }, backing);
  const initialized = translator.worker
    .then(() => ({ status: 'READY' }))
    .catch((error) => ({
      status: 'BLOCKED',
      blockerCode: classifyRuntimeError(error)
    }));
  const initialization = await Promise.race([
    initialized,
    workerError,
    timeoutResult(config.runtimeProbeTimeoutMs, 'NODE_RUNTIME_PROBE_TIMEOUT')
  ]);
  const wasmInitMs = performance.now() - start - runtimeImportMs;
  if (initialization.status !== 'READY') {
    restoreConsole(originalConsole);
    return blockedRoute(
      config.direction,
      initialization.blockerCode,
      network.attemptedCalls,
      runtimeImportMs,
      wasmInitMs
    );
  }
  const coldStartMs = performance.now() - start;

  const requestBase = {
    from: config.source,
    to: config.target,
    html: false,
    qualityScores: false
  };
  const firstStart = performance.now();
  const firstResponse = await translator.translate({
    ...requestBase,
    text: config.samples[0].source
  });
  const firstTranslationMs = performance.now() - firstStart;
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
  const memoryAfterLoad = process.memoryUsage().rss;
  const outputs = new Map([[config.samples[0].id, firstResponse.target.text]]);
  for (const sample of config.samples.slice(1)) {
    const response = await translator.translate({ ...requestBase, text: sample.source });
    outputs.set(sample.id, response.target.text);
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }

  const warmLatencies = [];
  for (let iteration = 0; iteration < config.iterations; iteration += 1) {
    for (const sample of config.samples) {
      const warmStart = performance.now();
      await translator.translate({ ...requestBase, text: sample.source });
      warmLatencies.push(performance.now() - warmStart);
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }
  }
  await translator.delete();
  restoreConsole(originalConsole);
  const samples = config.samples.map((sample) => sampleSummary(
    sample,
    outputs.get(sample.id) ?? ''
  ));
  const report = {
    direction: config.direction,
    status: 'MEASURED',
    blockerCode: null,
    runtimeImportMs: roundMs(runtimeImportMs),
    wasmInitMs: roundMs(wasmInitMs),
    coldStartMs: roundMs(coldStartMs),
    firstTranslationMs: roundMs(firstTranslationMs),
    warmLatency: latencySummary(warmLatencies),
    memory: {
      rssBeforeBytes: memoryBefore,
      rssAfterLoadBytes: memoryAfterLoad,
      peakRssBytes: peakRss
    },
    quality: qualitySummary(config.samples, samples),
    samples,
    attemptedNetworkCalls: network.attemptedCalls,
    rawTextEmitted: false
  };
  assertWorkerReportPrivacy(report, config.samples);
  localModels = [];
  return report;
}

export function sampleSummary(sample, translated) {
  return {
    id: sample.id,
    sourceChars: [...sample.source].length,
    targetChars: [...translated].length,
    characterNgramF1: roundRate(characterNgramF1(translated, sample.reference)),
    digitsPreserved: exactMultisetPreserved(DIGIT_PATTERN, sample.source, translated),
    urlsPreserved: exactMultisetPreserved(URL_PATTERN, sample.source, translated),
    placeholdersPreserved: exactMultisetPreserved(
      PLACEHOLDER_PATTERN,
      sample.source,
      translated
    ),
    nonEmpty: translated.trim().length > 0
  };
}

export function characterNgramF1(hypothesis, reference) {
  const left = normalizeQualityText(hypothesis);
  const right = normalizeQualityText(reference);
  if (!left || !right) {
    return left === right ? 1 : 0;
  }
  const scores = [1, 2, 3].map((size) => ngramF1(left, right, size));
  return scores.reduce((sum, score) => sum + score, 0) / scores.length;
}

function ngramF1(left, right, size) {
  const leftGrams = ngramCounts(left, size);
  const rightGrams = ngramCounts(right, size);
  const leftCount = [...leftGrams.values()].reduce((sum, count) => sum + count, 0);
  const rightCount = [...rightGrams.values()].reduce((sum, count) => sum + count, 0);
  if (leftCount === 0 || rightCount === 0) {
    return left === right ? 1 : 0;
  }
  let overlap = 0;
  for (const [gram, count] of leftGrams) {
    overlap += Math.min(count, rightGrams.get(gram) ?? 0);
  }
  const precision = overlap / leftCount;
  const recall = overlap / rightCount;
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
}

function ngramCounts(value, size) {
  const characters = [...value];
  const counts = new Map();
  if (characters.length < size) {
    counts.set(value, 1);
    return counts;
  }
  for (let index = 0; index <= characters.length - size; index += 1) {
    const gram = characters.slice(index, index + size).join('');
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

function normalizeQualityText(value) {
  return value.normalize('NFKC').toLocaleLowerCase('und').replace(/\s+/gu, ' ').trim();
}

function qualitySummary(sourceSamples, summaries) {
  return {
    characterNgramF1: roundRate(
      summaries.reduce((sum, sample) => sum + sample.characterNgramF1, 0)
        / summaries.length
    ),
    digitsPreservedRate: relevantRate(
      sourceSamples,
      summaries,
      DIGIT_PATTERN,
      'digitsPreserved'
    ),
    urlsPreservedRate: relevantRate(
      sourceSamples,
      summaries,
      URL_PATTERN,
      'urlsPreserved'
    ),
    placeholdersPreservedRate: relevantRate(
      sourceSamples,
      summaries,
      PLACEHOLDER_PATTERN,
      'placeholdersPreserved'
    ),
    nonEmptyRate: roundRate(
      summaries.filter((sample) => sample.nonEmpty).length / summaries.length
    )
  };
}

function relevantRate(sourceSamples, summaries, pattern, field) {
  const relevantIds = new Set(
    sourceSamples
      .filter((sample) => matches(pattern, sample.source).length > 0)
      .map((sample) => sample.id)
  );
  if (relevantIds.size === 0) {
    return 1;
  }
  return roundRate(
    summaries.filter((summary) => relevantIds.has(summary.id) && summary[field]).length
      / relevantIds.size
  );
}

function exactMultisetPreserved(pattern, source, target) {
  const sourceValues = matches(pattern, source).sort();
  const targetValues = matches(pattern, target).sort();
  return sourceValues.length === targetValues.length
    && sourceValues.every((value, index) => value === targetValues[index]);
}

function matches(pattern, value) {
  return [...value.matchAll(new RegExp(pattern.source, pattern.flags))].map(
    (match) => match[0]
  );
}

export function latencySummary(values) {
  if (values.length === 0) {
    return {
      n: 0,
      minMs: null,
      p50Ms: null,
      p95Ms: null,
      maxMs: null,
      meanMs: null
    };
  }
  const sorted = [...values].sort((left, right) => left - right);
  return {
    n: sorted.length,
    minMs: roundMs(sorted[0]),
    p50Ms: roundMs(percentile(sorted, 0.5)),
    p95Ms: roundMs(percentile(sorted, 0.95)),
    maxMs: roundMs(sorted.at(-1)),
    meanMs: roundMs(sorted.reduce((sum, value) => sum + value, 0) / sorted.length)
  };
}

function percentile(sorted, quantile) {
  const position = (sorted.length - 1) * quantile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) {
    return sorted[lower];
  }
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function blockedRoute(
  direction,
  blockerCode,
  attemptedNetworkCalls,
  runtimeImportMs = 0,
  wasmInitMs = null
) {
  return {
    direction,
    status: 'BLOCKED_RUNTIME',
    blockerCode,
    runtimeImportMs: roundMs(runtimeImportMs),
    wasmInitMs: wasmInitMs === null ? null : roundMs(wasmInitMs),
    coldStartMs: null,
    firstTranslationMs: null,
    warmLatency: latencySummary([]),
    memory: {
      rssBeforeBytes: 0,
      rssAfterLoadBytes: 0,
      peakRssBytes: 0
    },
    quality: {
      characterNgramF1: null,
      digitsPreservedRate: 0,
      urlsPreservedRate: 0,
      placeholdersPreservedRate: 0,
      nonEmptyRate: 0
    },
    samples: [],
    attemptedNetworkCalls,
    rawTextEmitted: false
  };
}

function classifyRuntimeError(error) {
  const message = [
    error?.code,
    error?.message,
    error?.stack,
    error?.data?.code,
    error?.data?.message
  ].filter(Boolean).join(' ');
  if (/require is not defined in ES module scope/iu.test(message)) {
    return 'NODE_ESM_WORKER_REQUIRE_UNDEFINED';
  }
  if (/ENOENT/iu.test(message) && /(?:%20|[A-Za-z]:[\\/][A-Za-z]:)/u.test(message)) {
    return 'NODE_WINDOWS_FILE_URL_PATH_INVALID';
  }
  if (/NETWORK_DISABLED_FOR_BERGAMOT_POC/iu.test(message)) {
    return 'UNEXPECTED_NETWORK_ATTEMPT';
  }
  return 'BERGAMOT_RUNTIME_INITIALIZATION_FAILED';
}

function installMainThreadNetworkGuard() {
  const state = { attemptedCalls: 0 };
  const reject = () => {
    state.attemptedCalls += 1;
    throw new Error('NETWORK_DISABLED_FOR_BERGAMOT_POC');
  };
  globalThis.fetch = async () => {
    reject();
  };
  http.request = reject;
  http.get = reject;
  https.request = reject;
  https.get = reject;
  net.connect = reject;
  net.createConnection = reject;
  tls.connect = reject;
  return state;
}

function timeoutResult(milliseconds, blockerCode) {
  return new Promise((resolveTimeout) => {
    const timer = setTimeout(
      () => resolveTimeout({ status: 'BLOCKED', blockerCode }),
      milliseconds
    );
    timer.unref();
  });
}

function exactArrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function validateConfig(config) {
  if (!config
      || !['en-zh', 'zh-en'].includes(config.direction)
      || !['en', 'zh'].includes(config.source)
      || !['en', 'zh'].includes(config.target)
      || config.source === config.target
      || !Array.isArray(config.models)
      || config.models.length < 1
      || !Array.isArray(config.samples)
      || config.samples.length < 1
      || !Number.isSafeInteger(config.iterations)
      || config.iterations < 1
      || !Number.isSafeInteger(config.runtimeProbeTimeoutMs)
      || config.runtimeProbeTimeoutMs < 100) {
    throw new Error('INVALID_BERGAMOT_BENCHMARK_WORKER_CONFIG');
  }
}

function assertWorkerReportPrivacy(report, samples) {
  const serialized = JSON.stringify(report);
  for (const sample of samples) {
    for (const text of [sample.source, sample.reference]) {
      if (text.length >= 8 && serialized.includes(text)) {
        throw new Error('RAW_FIXTURE_TEXT_LEAKED');
      }
    }
  }
}

function restoreConsole(originalConsole) {
  console.debug = originalConsole.debug;
  console.error = originalConsole.error;
  console.warn = originalConsole.warn;
}

function roundMs(value) {
  return Math.round(value * 1000) / 1000;
}

function roundRate(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

async function workerMain() {
  try {
    const input = await readFile(0, 'utf8');
    const config = JSON.parse(input);
    const report = await runBergamotBenchmarkWorker(config);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exit(0);
  } catch (error) {
    process.stdout.write(`${JSON.stringify(blockedRoute(
      'en-zh',
      classifyRuntimeError(error),
      0
    ))}\n`);
    process.exit(0);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await workerMain();
}
