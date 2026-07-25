import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { resolve } from 'node:path';
import tls from 'node:tls';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const options = parseArguments(process.argv.slice(2));
const network = installMainThreadNetworkGuard();
const originalConsole = {
  debug: console.debug,
  error: console.error,
  warn: console.warn
};
console.debug = () => {};
console.error = () => {};
console.warn = () => {};

let report;
try {
  report = await probeRuntime(options, network);
} catch (error) {
  report = blockedProbe(classifyError(error), 0, null, network.attemptedCalls);
}

console.debug = originalConsole.debug;
console.error = originalConsole.error;
console.warn = originalConsole.warn;
process.stdout.write(`${JSON.stringify(report)}\n`);
process.exit(0);

async function probeRuntime(config, guard) {
  const importStart = performance.now();
  let module;
  try {
    module = await import(pathToFileURL(resolve(config.packageRoot, 'translator.js')).href);
  } catch (error) {
    return blockedProbe(
      classifyError(error),
      performance.now() - importStart,
      null,
      guard.attemptedCalls
    );
  }
  const importMs = performance.now() - importStart;
  if (typeof module.TranslatorBacking !== 'function') {
    return blockedProbe('BERGAMOT_RUNTIME_EXPORT_MISSING', importMs, null, guard.attemptedCalls);
  }

  class OfflineProbeBacking extends module.TranslatorBacking {
    async loadModelRegistery() {
      return [];
    }
  }

  const backing = new OfflineProbeBacking({
    cacheSize: 0,
    downloadTimeout: 0,
    pivotLanguage: null,
    useNativeIntGemm: false
  });
  let resolveWorkerError;
  const workerError = new Promise((resolveError) => {
    resolveWorkerError = resolveError;
  });
  backing.onerror = (event) => {
    resolveWorkerError({
      status: 'BLOCKED',
      blockerCode: classifyError(event?.data ?? event)
    });
  };
  const initStart = performance.now();
  let timeoutId;
  const timeout = new Promise((resolveTimeout) => {
    timeoutId = setTimeout(() => resolveTimeout({
      status: 'BLOCKED',
      blockerCode: 'NODE_RUNTIME_PROBE_TIMEOUT'
    }), config.timeoutMs);
  });
  const initialization = backing.loadWorker()
    .then((worker) => ({ status: 'READY', worker }))
    .catch((error) => ({ status: 'BLOCKED', blockerCode: classifyError(error) }));
  const result = await Promise.race([initialization, workerError, timeout]);
  clearTimeout(timeoutId);
  const wasmInitMs = performance.now() - initStart;
  if (result.status !== 'READY') {
    return blockedProbe(
      result.blockerCode,
      importMs,
      wasmInitMs,
      guard.attemptedCalls
    );
  }
  result.worker.worker.terminate();
  return {
    status: 'READY',
    blockerCode: null,
    importMs: roundMs(importMs),
    wasmInitMs: roundMs(wasmInitMs),
    attemptedNetworkCalls: guard.attemptedCalls,
    rawErrorEmitted: false
  };
}

function blockedProbe(blockerCode, importMs, wasmInitMs, attemptedNetworkCalls) {
  return {
    status: 'BLOCKED',
    blockerCode,
    importMs: roundMs(importMs),
    wasmInitMs: wasmInitMs === null ? null : roundMs(wasmInitMs),
    attemptedNetworkCalls,
    rawErrorEmitted: false
  };
}

function classifyError(error) {
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
  if (/ERR_INPUT_TYPE_NOT_ALLOWED/iu.test(message)) {
    return 'NODE_PROBE_LAUNCH_FLAG_INVALID';
  }
  if (/DataCloneError/iu.test(message)) {
    return 'NODE_WORKER_OPTIONS_NOT_CLONEABLE';
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

function parseArguments(args) {
  let packageRoot = null;
  let timeoutMs = 5_000;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--package-root') {
      packageRoot = requireValue(args, ++index, argument);
    } else if (argument === '--timeout-ms') {
      timeoutMs = Number(requireValue(args, ++index, argument));
    } else {
      throw new Error('UNKNOWN_RUNTIME_WORKER_ARGUMENT');
    }
  }
  if (!packageRoot || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new Error('INVALID_RUNTIME_WORKER_ARGUMENTS');
  }
  return { packageRoot, timeoutMs };
}

function requireValue(args, index, option) {
  const value = args[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`MISSING_${option}`);
  }
  return value;
}

function roundMs(value) {
  return Math.round(value * 1000) / 1000;
}
