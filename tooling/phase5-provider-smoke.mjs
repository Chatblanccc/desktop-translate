import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { cpus, release, totalmem } from 'node:os'
import { dirname, relative, resolve, sep } from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'

import {
  BAIDU_DEFAULT_MAX_RESPONSE_BYTES,
  BaiduTranslationProvider,
  BaiduTransportError
} from '../packages/translation/src/baidu.ts'
import { TranslationProviderError } from '../packages/translation/src/provider.ts'
import { nearestRank } from '../apps/desktop/src/main/metrics/metrics-summary.ts'

export const PROVIDER_SMOKE_SCHEMA_VERSION = 'phase5-provider-smoke-v2'
export const PROVIDER_SMOKE_METADATA_SCHEMA_VERSION = 'phase5-provider-smoke-run-metadata-v1'
export const PROVIDER_SMOKE_SOURCE_TEXT_ID = 'PERF08_PUBLIC_ZH_SHORT_V1'
export const PROVIDER_SMOKE_TARGET_LANGUAGES = Object.freeze(['en', 'ja', 'ko'])
export const PROVIDER_SMOKE_SAMPLES_PER_TARGET = 10
export const PROVIDER_SMOKE_SUCCESS_BUDGET_MS = 8_000
export const PROVIDER_SMOKE_P95_INTERPRETATION = 'N10_NEAREST_RANK_P95_EQUALS_MAX'
export const PROVIDER_SMOKE_FORMAL_FAULT_BLOCKED_CODE = 'formal-fault-controller-not-implemented'
export const PROVIDER_SMOKE_FAULT_SCENARIOS = Object.freeze([
  'timeout',
  'network-unavailable',
  'malformed-response',
  'recovery'
])

const PROVIDER_SMOKE_SOURCE_TEXT = '你好，欢迎使用桌面翻译。'
const PROVIDER_TIMEOUT_MS = 7_900
const REQUEST_SPACING_MS = 1_100
const GIT_SHA_PATTERN = /^[a-f0-9]{40}$/u
const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const SAFE_METADATA_TEXT = /^[\p{L}\p{N} ._:@/+()[\]-]+$/u
const PLACEHOLDER_PATTERN = /(?:replace|placeholder|unknown|unregistered|todo|tbd)/iu
const ALLOWED_STABLE_CODES = new Set([
  'success',
  'duration-budget-exceeded',
  'credentials-missing',
  'authentication-failed',
  'quota-exceeded',
  'rate-limited',
  'network-unavailable',
  'provider-unavailable',
  'unsupported-language',
  'malformed-response',
  'invalid-request',
  'cancelled',
  'unknown'
])
const INJECTABLE_PROVIDER_BOUNDARY = 'INJECTABLE_TEST_HARNESS'
const REAL_PROVIDER_BOUNDARY = 'REAL_BAIDU_PRODUCT_PROVIDER'
const REAL_PRODUCT_PROVIDERS = new WeakSet()

export class ProviderSmokeBlockedError extends Error {
  constructor(stableCode) {
    super('Phase 5 provider smoke is blocked')
    this.name = 'ProviderSmokeBlockedError'
    this.stableCode = stableCode
  }
}

export async function runProviderFaultSelfTests() {
  const request = createRequest('en', 'fault-selftest')
  const missingCredentials = new BaiduTranslationProvider({ timeoutMs: PROVIDER_TIMEOUT_MS })
  const networkFailure = new BaiduTranslationProvider({
    credentials: { appId: 'selftest-app-id', secretKey: 'selftest-secret-key' },
    timeoutMs: PROVIDER_TIMEOUT_MS,
    transport: {
      async send() {
        throw new BaiduTransportError(
          'network',
          'selftest raw transport detail must never enter provider smoke evidence'
        )
      }
    }
  })

  const checks = [
    await captureStableFailure(missingCredentials, request),
    await captureStableFailure(networkFailure, request)
  ]
  const expectedCodes = ['credentials-missing', 'network-unavailable']
  for (let index = 0; index < expectedCodes.length; index += 1) {
    if (checks[index] !== expectedCodes[index]) {
      throw new ProviderSmokeBlockedError('fault-selftest-failed')
    }
  }

  return Object.freeze(checks.map((stableCode) => Object.freeze({
    targetLanguage: 'en',
    sourceTextId: PROVIDER_SMOKE_SOURCE_TEXT_ID,
    attemptCount: 1,
    successCount: 0,
    failureCount: 1,
    stableCode
  })))
}

export async function runProviderHealthSmoke(options) {
  const provider = options.provider
  const monotonicNow = options.monotonicNow ?? (() => performance.now())
  const wallClockNow = options.wallClockNow ?? (() => new Date())
  const delay = options.delay ?? wait
  const samplesPerTarget = options.samplesPerTarget ?? PROVIDER_SMOKE_SAMPLES_PER_TARGET
  if (!Number.isSafeInteger(samplesPerTarget) || samplesPerTarget !== PROVIDER_SMOKE_SAMPLES_PER_TARGET) {
    throw new ProviderSmokeBlockedError('insufficient-sample-count')
  }

  const targets = []
  for (const targetLanguage of PROVIDER_SMOKE_TARGET_LANGUAGES) {
    const samples = []
    for (let index = 0; index < samplesPerTarget; index += 1) {
      const request = createRequest(targetLanguage, `health-${index + 1}`)
      const startedAt = monotonicNow()
      let stableCode = 'unknown'
      try {
        const result = await provider.translate(request, {
          signal: new AbortController().signal,
          now: wallClockNow
        })
        stableCode = isExpectedResult(result, targetLanguage)
          ? 'success'
          : 'malformed-response'
      } catch (error) {
        stableCode = stableCodeFromError(error)
      }
      const rawDurationMs = monotonicDuration(startedAt, monotonicNow())
      if (stableCode === 'success' && rawDurationMs > PROVIDER_SMOKE_SUCCESS_BUDGET_MS) {
        stableCode = 'duration-budget-exceeded'
      }
      const durationMs = roundDuration(rawDurationMs)
      samples.push(Object.freeze({
        targetLanguage,
        sourceTextId: PROVIDER_SMOKE_SOURCE_TEXT_ID,
        durationMs,
        stableCode
      }))
      if (
        REQUEST_SPACING_MS > 0
        && (index + 1 < samplesPerTarget || targetLanguage !== PROVIDER_SMOKE_TARGET_LANGUAGES.at(-1))
      ) {
        await delay(REQUEST_SPACING_MS)
      }
    }
    targets.push(summarizeTarget(targetLanguage, samples))
  }

  const passed = targets.every((target) => (
    target.attemptCount >= PROVIDER_SMOKE_SAMPLES_PER_TARGET
    && target.successCount === target.attemptCount
    && target.failureCount === 0
    && target.durationMs.max <= PROVIDER_SMOKE_SUCCESS_BUDGET_MS
    && target.durationMs.p95 === target.durationMs.max
  ))
  const evidence = Object.freeze({
    schemaVersion: PROVIDER_SMOKE_SCHEMA_VERSION,
    evidenceKind: 'health',
    formal: false,
    providerBoundary: INJECTABLE_PROVIDER_BOUNDARY,
    identity: null,
    acceptance: false,
    perf08Status: 'BLOCKED_FORMAL_REAL_PROVIDER_AND_FAULT_RECOVERY_REQUIRED',
    sourceTextId: PROVIDER_SMOKE_SOURCE_TEXT_ID,
    statisticsMethod: 'nearest-rank',
    p95Interpretation: PROVIDER_SMOKE_P95_INTERPRETATION,
    targetCount: PROVIDER_SMOKE_TARGET_LANGUAGES.length,
    samplesPerTarget,
    healthTargets: Object.freeze(targets),
    stableCode: passed ? 'HEALTH_PASS' : 'HEALTH_FAIL'
  })
  assertProviderSmokeEvidence(evidence)
  return evidence
}

export function validateFormalProviderSmokePreconditions({
  formal,
  networkAuthorized,
  networkRequired = true,
  workspace,
  metadata,
  artifactSetDigest,
  runMetadataSha256,
  runtime = describeRuntime()
}) {
  if (formal !== true) throw new ProviderSmokeBlockedError('formal-mode-required')
  if (networkRequired && networkAuthorized !== true) {
    throw new ProviderSmokeBlockedError('network-authorization-required')
  }
  if (!GIT_SHA_PATTERN.test(workspace?.gitSha ?? '') || workspace?.dirty !== false) {
    throw new ProviderSmokeBlockedError('clean-head-required')
  }
  if (!SHA256_PATTERN.test(artifactSetDigest ?? '')) {
    throw new ProviderSmokeBlockedError('artifact-set-digest-required')
  }
  if (!SHA256_PATTERN.test(runMetadataSha256 ?? '')) {
    throw new ProviderSmokeBlockedError('run-metadata-digest-required')
  }
  assertFormalMetadata(metadata)
  if (runtime.platform !== 'win32') {
    throw new ProviderSmokeBlockedError('windows-interactive-session-required')
  }
  if (runtime.osBuild !== metadata.environment.osBuild) {
    throw new ProviderSmokeBlockedError('device-metadata-mismatch')
  }
  if (runtime.osArchitecture !== metadata.environment.osArchitecture) {
    throw new ProviderSmokeBlockedError('device-metadata-mismatch')
  }
  if (runtime.logicalProcessorCount !== metadata.environment.logicalProcessorCount) {
    throw new ProviderSmokeBlockedError('device-metadata-mismatch')
  }
  if (runtime.nodeVersion !== metadata.environment.nodeVersion) {
    throw new ProviderSmokeBlockedError('device-metadata-mismatch')
  }
  const ramDifference = Math.abs(runtime.ramBytes - metadata.environment.ramBytes)
  const allowedRamDifference = Math.max(256 * 1024 * 1024, runtime.ramBytes * 0.02)
  if (ramDifference > allowedRamDifference) {
    throw new ProviderSmokeBlockedError('device-metadata-mismatch')
  }
  if (stableStringArray(runtime.cpuModels) !== stableStringArray(metadata.environment.cpuModels)) {
    throw new ProviderSmokeBlockedError('device-metadata-mismatch')
  }
  return Object.freeze({
    gitSha: workspace.gitSha,
    artifactSetDigest,
    runMetadataSha256,
    deviceRegistrationId: metadata.run.deviceRegistrationId,
    workflowName: metadata.run.workflowName,
    workflowRunId: metadata.run.workflowRunId,
    runId: metadata.run.runId
  })
}

export function assertFormalProviderSmokePostconditions({
  initialWorkspace,
  finalWorkspace,
  initialRunMetadataSha256,
  finalRunMetadataSha256
}) {
  if (
    initialWorkspace?.dirty !== false
    || finalWorkspace?.dirty !== false
    || !GIT_SHA_PATTERN.test(initialWorkspace?.gitSha ?? '')
    || finalWorkspace?.gitSha !== initialWorkspace.gitSha
  ) {
    throw new ProviderSmokeBlockedError('source-identity-changed-during-run')
  }
  if (
    !SHA256_PATTERN.test(initialRunMetadataSha256 ?? '')
    || finalRunMetadataSha256 !== initialRunMetadataSha256
  ) {
    throw new ProviderSmokeBlockedError('run-metadata-changed-during-run')
  }
}

export function assertProviderSmokeEvidence(value) {
  if (!isRecord(value) || value.schemaVersion !== PROVIDER_SMOKE_SCHEMA_VERSION) {
    throw new ProviderSmokeBlockedError('invalid-evidence-shape')
  }
  if (value.evidenceKind === 'health') {
    assertHealthEvidence(value)
    return
  }
  if (value.evidenceKind === 'fault') {
    assertFaultEvidence(value)
    return
  }
  if (value.evidenceKind === 'aggregate') {
    assertAggregateEvidence(value)
    return
  }
  throw new ProviderSmokeBlockedError('invalid-evidence-kind')
}

function assertHealthEvidence(value) {
  assertExactKeys(value, [
    'schemaVersion',
    'evidenceKind',
    'formal',
    'providerBoundary',
    'identity',
    'acceptance',
    'perf08Status',
    'sourceTextId',
    'statisticsMethod',
    'p95Interpretation',
    'targetCount',
    'samplesPerTarget',
    'healthTargets',
    'stableCode'
  ], 'provider health evidence')
  if (
    value.schemaVersion !== PROVIDER_SMOKE_SCHEMA_VERSION
    || value.evidenceKind !== 'health'
    || value.sourceTextId !== PROVIDER_SMOKE_SOURCE_TEXT_ID
    || value.statisticsMethod !== 'nearest-rank'
    || value.p95Interpretation !== PROVIDER_SMOKE_P95_INTERPRETATION
    || value.targetCount !== PROVIDER_SMOKE_TARGET_LANGUAGES.length
    || !Number.isSafeInteger(value.samplesPerTarget)
    || value.samplesPerTarget !== PROVIDER_SMOKE_SAMPLES_PER_TARGET
    || !['HEALTH_PASS', 'HEALTH_FAIL'].includes(value.stableCode)
    || value.acceptance !== false
    || value.perf08Status !== (value.formal
      ? 'BLOCKED_FAULT_RECOVERY_EVIDENCE_REQUIRED'
      : 'BLOCKED_FORMAL_REAL_PROVIDER_AND_FAULT_RECOVERY_REQUIRED')
  ) {
    throw new ProviderSmokeBlockedError('invalid-evidence-shape')
  }
  if (value.formal === true) {
    if (value.providerBoundary !== REAL_PROVIDER_BOUNDARY) {
      throw new ProviderSmokeBlockedError('formal-fake-provider-forbidden')
    }
    assertFormalIdentity(value.identity)
  } else if (
    value.formal !== false
    || value.providerBoundary !== INJECTABLE_PROVIDER_BOUNDARY
    || value.identity !== null
  ) {
    throw new ProviderSmokeBlockedError('invalid-evidence-shape')
  }
  if (!Array.isArray(value.healthTargets) || value.healthTargets.length !== value.targetCount) {
    throw new ProviderSmokeBlockedError('invalid-evidence-shape')
  }
  for (const target of value.healthTargets) assertTargetEvidence(target, value.samplesPerTarget)
  const actualTargetLanguages = value.healthTargets
    .map(({ targetLanguage }) => targetLanguage)
    .sort()
  if (JSON.stringify(actualTargetLanguages) !== JSON.stringify([...PROVIDER_SMOKE_TARGET_LANGUAGES].sort())) {
    throw new ProviderSmokeBlockedError('invalid-evidence-shape')
  }
  const expectedStableCode = value.healthTargets.every((target) => (
    target.attemptCount === PROVIDER_SMOKE_SAMPLES_PER_TARGET
    && target.successCount === target.attemptCount
    && target.failureCount === 0
    && target.durationMs.max <= PROVIDER_SMOKE_SUCCESS_BUDGET_MS
    && target.durationMs.p95 === target.durationMs.max
  )) ? 'HEALTH_PASS' : 'HEALTH_FAIL'
  if (value.stableCode !== expectedStableCode) {
    throw new ProviderSmokeBlockedError('invalid-evidence-shape')
  }
}

function assertFaultEvidence(value) {
  assertExactKeys(value, [
    'schemaVersion',
    'evidenceKind',
    'formal',
    'providerBoundary',
    'identity',
    'acceptance',
    'perf08Status',
    'sourceTextId',
    'scenario',
    'faultControlId',
    'recoveryOfControlIds',
    'attemptCount',
    'observedStableCode',
    'scenarioStatus',
    'stableCode'
  ], 'provider fault evidence')
  // A scenario label, an observed provider error, and a caller-supplied control ID
  // do not prove that a distinct fault was actually injected. Until a trusted
  // controller can produce independently verifiable control evidence, no formal
  // fault record is valid acceptance evidence.
  throw new ProviderSmokeBlockedError(PROVIDER_SMOKE_FORMAL_FAULT_BLOCKED_CODE)
}

function assertAggregateEvidence(value) {
  assertExactKeys(value, [
    'schemaVersion',
    'evidenceKind',
    'formal',
    'providerBoundary',
    'identity',
    'acceptance',
    'perf08Status',
    'sourceTextId',
    'healthEvidenceSha256',
    'faultEvidenceDigests',
    'stableCode'
  ], 'provider aggregate evidence')
  // Aggregation cannot upgrade self-reported scenario records into acceptance
  // evidence. It remains disabled until the trusted fault controller exists.
  throw new ProviderSmokeBlockedError(PROVIDER_SMOKE_FORMAL_FAULT_BLOCKED_CODE)
}

function assertFormalIdentity(identity) {
  assertExactKeys(identity, [
    'gitSha',
    'artifactSetDigest',
    'runMetadataSha256',
    'deviceRegistrationId',
    'workflowName',
    'workflowRunId',
    'runId'
  ], 'provider formal identity')
  if (
    !GIT_SHA_PATTERN.test(identity.gitSha ?? '')
    || !SHA256_PATTERN.test(identity.artifactSetDigest ?? '')
    || !SHA256_PATTERN.test(identity.runMetadataSha256 ?? '')
    || identity.workflowName !== 'phase5-provider-smoke'
  ) {
    throw new ProviderSmokeBlockedError('invalid-formal-identity')
  }
  for (const field of ['deviceRegistrationId', 'workflowRunId', 'runId']) {
    assertSafeMetadataText(identity[field], field)
  }
}

function createFormalHealthEvidence(provider, healthEvidence, identity) {
  if (!REAL_PRODUCT_PROVIDERS.has(provider)) {
    throw new ProviderSmokeBlockedError('formal-fake-provider-forbidden')
  }
  assertHealthEvidence(healthEvidence)
  if (healthEvidence.formal !== false || healthEvidence.providerBoundary !== INJECTABLE_PROVIDER_BOUNDARY) {
    throw new ProviderSmokeBlockedError('invalid-health-promotion-source')
  }
  const evidence = Object.freeze({
    ...healthEvidence,
    formal: true,
    providerBoundary: REAL_PROVIDER_BOUNDARY,
    identity,
    perf08Status: 'BLOCKED_FAULT_RECOVERY_EVIDENCE_REQUIRED'
  })
  assertProviderSmokeEvidence(evidence)
  return evidence
}

export function aggregateProviderSmokeEvidence({
  identity: _identity,
  health: _health,
  healthSha256: _healthSha256,
  faultRecords: _faultRecords
}) {
  throw new ProviderSmokeBlockedError(PROVIDER_SMOKE_FORMAL_FAULT_BLOCKED_CODE)
}

export async function writeProviderSmokeEvidence(outputPath, evidence) {
  assertProviderSmokeEvidence(evidence)
  const resolvedPath = resolve(outputPath)
  await mkdir(dirname(resolvedPath), { recursive: true })
  await writeFile(resolvedPath, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx'
  })
}

function summarizeTarget(targetLanguage, samples) {
  const successfulDurations = samples
    .filter(({ stableCode }) => stableCode === 'success')
    .map(({ durationMs }) => durationMs)
  const stableCodeCounts = Object.fromEntries([...new Set(samples.map(({ stableCode }) => stableCode))]
    .sort()
    .map((stableCode) => [
      stableCode,
      samples.filter((sample) => sample.stableCode === stableCode).length
    ]))
  const durationMs = successfulDurations.length === 0
    ? Object.freeze({ samples: Object.freeze([]), p50: null, p95: null, max: null })
    : Object.freeze({
        samples: Object.freeze([...successfulDurations]),
        p50: roundDuration(nearestRank(successfulDurations, 0.5)),
        p95: roundDuration(nearestRank(successfulDurations, 0.95)),
        max: roundDuration(Math.max(...successfulDurations))
      })
  return Object.freeze({
    targetLanguage,
    sourceTextId: PROVIDER_SMOKE_SOURCE_TEXT_ID,
    attemptCount: samples.length,
    successCount: successfulDurations.length,
    failureCount: samples.length - successfulDurations.length,
    stableCodeCounts: Object.freeze(stableCodeCounts),
    durationMs
  })
}

function assertTargetEvidence(target, expectedSamples) {
  assertExactKeys(target, [
    'targetLanguage',
    'sourceTextId',
    'attemptCount',
    'successCount',
    'failureCount',
    'stableCodeCounts',
    'durationMs'
  ], 'provider target evidence')
  if (
    !PROVIDER_SMOKE_TARGET_LANGUAGES.includes(target.targetLanguage)
    || target.sourceTextId !== PROVIDER_SMOKE_SOURCE_TEXT_ID
    || target.attemptCount !== expectedSamples
    || !Number.isSafeInteger(target.successCount)
    || !Number.isSafeInteger(target.failureCount)
    || target.successCount + target.failureCount !== target.attemptCount
  ) {
    throw new ProviderSmokeBlockedError('invalid-evidence-shape')
  }
  if (!isRecord(target.stableCodeCounts)) {
    throw new ProviderSmokeBlockedError('invalid-evidence-shape')
  }
  let stableCodeTotal = 0
  for (const [stableCode, count] of Object.entries(target.stableCodeCounts)) {
    if (!ALLOWED_STABLE_CODES.has(stableCode) || !Number.isSafeInteger(count) || count < 1) {
      throw new ProviderSmokeBlockedError('invalid-evidence-shape')
    }
    stableCodeTotal += count
  }
  if (stableCodeTotal !== target.attemptCount) {
    throw new ProviderSmokeBlockedError('invalid-evidence-shape')
  }
  if (
    (target.stableCodeCounts.success ?? 0) !== target.successCount
    || stableCodeTotal - (target.stableCodeCounts.success ?? 0) !== target.failureCount
  ) {
    throw new ProviderSmokeBlockedError('invalid-evidence-shape')
  }
  assertExactKeys(target.durationMs, ['samples', 'p50', 'p95', 'max'], 'provider duration evidence')
  if (
    !Array.isArray(target.durationMs.samples)
    || target.durationMs.samples.length !== target.successCount
    || target.durationMs.samples.some((duration) => !isDuration(duration))
  ) {
    throw new ProviderSmokeBlockedError('invalid-evidence-shape')
  }
  if (target.successCount === 0) {
    if (target.durationMs.p50 !== null || target.durationMs.p95 !== null || target.durationMs.max !== null) {
      throw new ProviderSmokeBlockedError('invalid-evidence-shape')
    }
    return
  }
  if (![target.durationMs.p50, target.durationMs.p95, target.durationMs.max].every(isDuration)) {
    throw new ProviderSmokeBlockedError('invalid-evidence-shape')
  }
  if (
    target.durationMs.p50 !== roundDuration(nearestRank(target.durationMs.samples, 0.5))
    || target.durationMs.p95 !== roundDuration(nearestRank(target.durationMs.samples, 0.95))
    || target.durationMs.max !== roundDuration(Math.max(...target.durationMs.samples))
    || target.durationMs.samples.some((duration) => duration > PROVIDER_SMOKE_SUCCESS_BUDGET_MS)
  ) {
    throw new ProviderSmokeBlockedError('invalid-evidence-shape')
  }
}

function assertFormalMetadata(metadata) {
  assertExactKeys(metadata, ['schemaVersion', 'run', 'environment'], 'provider smoke metadata')
  if (metadata.schemaVersion !== PROVIDER_SMOKE_METADATA_SCHEMA_VERSION) {
    throw new ProviderSmokeBlockedError('invalid-run-metadata')
  }
  assertExactKeys(metadata.run, [
    'runId',
    'workflowName',
    'workflowRunId',
    'operatorRole',
    'deviceRegistrationId',
    'evidenceLevel',
    'dedicatedInteractiveSession',
    'foregroundInputExclusive',
    'debuggerClosed',
    'unrelatedForegroundTasksClosed'
  ], 'provider smoke run metadata')
  for (const field of [
    'runId',
    'workflowRunId',
    'operatorRole',
    'deviceRegistrationId'
  ]) {
    assertSafeMetadataText(metadata.run[field], field)
  }
  if (
    metadata.run.workflowName !== 'phase5-provider-smoke'
    || metadata.run.evidenceLevel !== 'provider-smoke'
    || metadata.run.dedicatedInteractiveSession !== true
    || metadata.run.foregroundInputExclusive !== true
    || metadata.run.debuggerClosed !== true
    || metadata.run.unrelatedForegroundTasksClosed !== true
  ) {
    throw new ProviderSmokeBlockedError('exclusive-session-metadata-required')
  }

  assertExactKeys(metadata.environment, [
    'osBuild',
    'osArchitecture',
    'cpuModels',
    'physicalCoreCount',
    'logicalProcessorCount',
    'ramBytes',
    'storageType',
    'gpuModels',
    'displays',
    'powerPlanGuid',
    'powerPlanLabel',
    'acPower',
    'nodeVersion',
    'antivirusScanActivityAbsent',
    'osUpdateActivityAbsent'
  ], 'provider smoke environment metadata')
  for (const field of ['osBuild', 'osArchitecture', 'storageType', 'powerPlanGuid', 'powerPlanLabel', 'nodeVersion']) {
    assertSafeMetadataText(metadata.environment[field], field)
  }
  assertNonEmptySafeStringArray(metadata.environment.cpuModels, 'cpuModels')
  assertNonEmptySafeStringArray(metadata.environment.gpuModels, 'gpuModels')
  if (
    !Number.isSafeInteger(metadata.environment.physicalCoreCount)
    || metadata.environment.physicalCoreCount < 1
    || !Number.isSafeInteger(metadata.environment.logicalProcessorCount)
    || metadata.environment.logicalProcessorCount < metadata.environment.physicalCoreCount
    || !Number.isSafeInteger(metadata.environment.ramBytes)
    || metadata.environment.ramBytes < 2 * 1024 * 1024 * 1024
    || metadata.environment.acPower !== true
    || metadata.environment.antivirusScanActivityAbsent !== true
    || metadata.environment.osUpdateActivityAbsent !== true
  ) {
    throw new ProviderSmokeBlockedError('invalid-device-metadata')
  }
  if (!Array.isArray(metadata.environment.displays) || metadata.environment.displays.length < 1) {
    throw new ProviderSmokeBlockedError('invalid-device-metadata')
  }
  for (const display of metadata.environment.displays) {
    assertExactKeys(display, [
      'widthPixels',
      'heightPixels',
      'dpiPercent',
      'primary',
      'physical',
      'orientation',
      'taskbarEdge'
    ], 'provider smoke display metadata')
    if (
      !Number.isSafeInteger(display.widthPixels)
      || display.widthPixels < 640
      || !Number.isSafeInteger(display.heightPixels)
      || display.heightPixels < 480
      || !Number.isFinite(display.dpiPercent)
      || display.dpiPercent < 50
      || display.dpiPercent > 500
      || typeof display.primary !== 'boolean'
      || display.physical !== true
      || !['landscape', 'portrait'].includes(display.orientation)
      || !['top', 'right', 'bottom', 'left', 'hidden'].includes(display.taskbarEdge)
    ) {
      throw new ProviderSmokeBlockedError('invalid-device-metadata')
    }
  }
}

function assertSafeMetadataText(value, label) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > 256
    || !SAFE_METADATA_TEXT.test(value)
    || PLACEHOLDER_PATTERN.test(value)
  ) {
    throw new ProviderSmokeBlockedError(`invalid-${label}`)
  }
}

function assertNonEmptySafeStringArray(value, label) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
    throw new ProviderSmokeBlockedError(`invalid-${label}`)
  }
  for (const entry of value) assertSafeMetadataText(entry, label)
}

function assertExactKeys(value, expected, label) {
  if (!isRecord(value)) throw new ProviderSmokeBlockedError('invalid-evidence-shape')
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new ProviderSmokeBlockedError(`unexpected-${label.replaceAll(' ', '-')}-field`)
  }
}

function describeWorkspace(workspaceRoot) {
  const gitSha = git(workspaceRoot, ['rev-parse', 'HEAD']).toLowerCase()
  const dirty = git(workspaceRoot, ['status', '--porcelain=v1', '--untracked-files=all']).length > 0
  return Object.freeze({ gitSha, dirty })
}

function describeRuntime() {
  const cpuModels = [...new Set(cpus().map(({ model }) => model.trim()).filter(Boolean))].sort()
  return Object.freeze({
    platform: process.platform,
    osBuild: release(),
    osArchitecture: process.arch,
    cpuModels: Object.freeze(cpuModels),
    logicalProcessorCount: cpus().length,
    ramBytes: totalmem(),
    nodeVersion: process.version
  })
}

function git(workspaceRoot, arguments_) {
  try {
    return execFileSync('git', arguments_, {
      cwd: workspaceRoot,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
  } catch {
    throw new ProviderSmokeBlockedError('workspace-identity-unavailable')
  }
}

async function readRunMetadata(path) {
  try {
    const bytes = await readFile(resolve(path))
    return Object.freeze({
      metadata: JSON.parse(bytes.toString('utf8')),
      sha256: sha256(bytes)
    })
  } catch {
    throw new ProviderSmokeBlockedError('run-metadata-unavailable')
  }
}

async function readEvidence(path) {
  try {
    const bytes = await readFile(resolve(path))
    const evidence = JSON.parse(bytes.toString('utf8'))
    assertProviderSmokeEvidence(evidence)
    return Object.freeze({ evidence, sha256: sha256(bytes) })
  } catch (error) {
    if (error instanceof ProviderSmokeBlockedError) throw error
    throw new ProviderSmokeBlockedError('provider-evidence-unavailable')
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function createProviderFromEnvironment(environment) {
  const appId = environment.BAIDU_APP_ID
  const secretKey = environment.BAIDU_SECRET_KEY
  if (!isCredentialPart(appId) || !isCredentialPart(secretKey)) {
    throw new ProviderSmokeBlockedError('credentials-missing')
  }
  const provider = new BaiduTranslationProvider({
    credentials: { appId, secretKey },
    timeoutMs: PROVIDER_TIMEOUT_MS,
    maxResponseBytes: BAIDU_DEFAULT_MAX_RESPONSE_BYTES
  })
  REAL_PRODUCT_PROVIDERS.add(provider)
  return provider
}

async function assertFormalOutputPath(workspaceRoot, outputPath, gitSha) {
  const resolvedRoot = resolve(workspaceRoot)
  const requiredRoot = resolve(resolvedRoot, 'artifacts', 'phase5', gitSha)
  const resolvedOutput = resolve(outputPath)
  const outputRelative = relative(requiredRoot, resolvedOutput)
  if (
    outputRelative.length === 0
    || outputRelative === '..'
    || outputRelative.startsWith(`..${sep}`)
  ) {
    throw new ProviderSmokeBlockedError('formal-output-path-outside-identity-root')
  }
  try {
    await lstat(resolvedOutput)
    throw new ProviderSmokeBlockedError('formal-output-already-exists')
  } catch (error) {
    if (error instanceof ProviderSmokeBlockedError) throw error
    if (error?.code !== 'ENOENT') throw new ProviderSmokeBlockedError('formal-output-path-unavailable')
  }

  let cursor = dirname(resolvedOutput)
  const stop = resolvedRoot
  while (cursor !== stop) {
    try {
      const status = await lstat(cursor)
      if (status.isSymbolicLink() || !status.isDirectory()) {
        throw new ProviderSmokeBlockedError('formal-output-reparse-forbidden')
      }
    } catch (error) {
      if (error instanceof ProviderSmokeBlockedError) throw error
      if (error?.code !== 'ENOENT') throw new ProviderSmokeBlockedError('formal-output-path-unavailable')
    }
    const parent = dirname(cursor)
    if (parent === cursor) throw new ProviderSmokeBlockedError('formal-output-path-outside-identity-root')
    cursor = parent
  }

  try {
    execFileSync('git', ['check-ignore', '--quiet', '--', resolvedOutput], {
      cwd: resolvedRoot,
      windowsHide: true,
      stdio: 'ignore'
    })
  } catch {
    throw new ProviderSmokeBlockedError('formal-output-must-be-gitignored')
  }
}

function isCredentialPart(value) {
  return (
    typeof value === 'string'
    && value.trim().length > 0
    && value.length <= 512
    && !value.includes('\0')
  )
}

function createRequest(targetLanguage, suffix) {
  return Object.freeze({
    requestId: `perf08-request-${targetLanguage}-${suffix}`,
    selectionId: randomUUID(),
    text: PROVIDER_SMOKE_SOURCE_TEXT,
    sourceLanguage: 'zh-CN',
    targetLanguage
  })
}

async function captureStableFailure(provider, request) {
  try {
    await provider.translate(request, {
      signal: new AbortController().signal,
      now: () => new Date('2026-01-01T00:00:00.000Z')
    })
    return 'unexpected-success'
  } catch (error) {
    return stableCodeFromError(error)
  }
}

function stableCodeFromError(error) {
  if (error instanceof TranslationProviderError && ALLOWED_STABLE_CODES.has(error.failure.code)) {
    return error.failure.code
  }
  return 'unknown'
}

function isExpectedResult(result, targetLanguage) {
  return (
    result !== null
    && typeof result === 'object'
    && result.originalText === PROVIDER_SMOKE_SOURCE_TEXT
    && result.targetLanguage === targetLanguage
    && typeof result.translatedText === 'string'
    && result.translatedText.trim().length > 0
    && result.attribution?.providerId === 'baidu'
  )
}

function monotonicDuration(startedAt, finishedAt) {
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || finishedAt < startedAt) {
    throw new ProviderSmokeBlockedError('monotonic-clock-failure')
  }
  return finishedAt - startedAt
}

function roundDuration(value) {
  return Math.round(value * 1_000) / 1_000
}

function isDuration(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function stableStringArray(value) {
  return JSON.stringify([...value].map((entry) => entry.trim()).sort())
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function wait(durationMs) {
  return new Promise((resolveWait) => setTimeout(resolveWait, durationMs))
}

function parseArguments(arguments_) {
  const [command, ...optionArguments] = arguments_
  if (!['selftest', 'health', 'fault', 'aggregate'].includes(command)) {
    throw new ProviderSmokeBlockedError('invalid-command')
  }
  const options = new Map()
  for (let index = 0; index < optionArguments.length; index += 2) {
    const key = optionArguments[index]
    const value = optionArguments[index + 1]
    if (
      typeof key !== 'string'
      || typeof value !== 'string'
      || !/^--[a-z-]+$/u.test(key)
      || value.startsWith('--')
      || options.has(key)
    ) {
      throw new ProviderSmokeBlockedError('invalid-arguments')
    }
    options.set(key, value)
  }
  const commonAllowed = [
    '--formal',
    '--network-authorized',
    '--artifact-set-digest',
    '--run-metadata',
    '--output'
  ]
  const allowed = command === 'selftest'
    ? []
    : command === 'fault'
      ? [...commonAllowed, '--fault-scenario', '--fault-control-id', '--recovery-of-control-ids']
      : command === 'aggregate'
        ? [
            '--formal',
            '--artifact-set-digest',
            '--run-metadata',
            '--output',
            '--health-evidence',
            '--timeout-evidence',
            '--network-evidence',
            '--malformed-response-evidence',
            '--recovery-evidence'
          ]
        : commonAllowed
  if ([...options.keys()].some((key) => !allowed.includes(key))) {
    throw new ProviderSmokeBlockedError('invalid-arguments')
  }
  if (command === 'selftest' && options.size !== 0) {
    throw new ProviderSmokeBlockedError('invalid-arguments')
  }
  const required = command === 'selftest'
    ? []
    : command === 'fault'
      ? [
          '--formal',
          '--network-authorized',
          '--artifact-set-digest',
          '--run-metadata',
          '--output',
          '--fault-scenario',
          '--fault-control-id'
        ]
      : command === 'aggregate'
        ? allowed
        : commonAllowed
  if (required.some((key) => !options.has(key))) {
    throw new ProviderSmokeBlockedError('missing-required-arguments')
  }
  if (
    command === 'fault'
    && options.get('--fault-scenario') === 'recovery'
    && !options.has('--recovery-of-control-ids')
  ) {
    throw new ProviderSmokeBlockedError('recovery-binding-required')
  }
  if (
    command === 'fault'
    && options.get('--fault-scenario') !== 'recovery'
    && options.has('--recovery-of-control-ids')
  ) {
    throw new ProviderSmokeBlockedError('invalid-arguments')
  }
  return { command, options }
}

async function main() {
  if (!process.execArgv.some((argument) => argument.toLowerCase().includes('tsx'))) {
    throw new ProviderSmokeBlockedError('tsx-cli-required')
  }
  const { command, options } = parseArguments(process.argv.slice(2))
  if (command === 'selftest') {
    await runProviderFaultSelfTests()
    console.log('[phase5:provider-smoke] DEVELOPMENT SELFTEST PASS NOT ACCEPTANCE')
    return
  }
  if (command === 'fault' || command === 'aggregate') {
    throw new ProviderSmokeBlockedError(PROVIDER_SMOKE_FORMAL_FAULT_BLOCKED_CODE)
  }

  const workspaceRoot = resolve(import.meta.dirname, '..')
  const initialMetadataRecord = await readRunMetadata(options.get('--run-metadata'))
  const initialWorkspace = describeWorkspace(workspaceRoot)
  const identity = validateFormalProviderSmokePreconditions({
    formal: options.get('--formal') === 'true',
    networkAuthorized: options.get('--network-authorized') === 'true',
    networkRequired: command !== 'aggregate',
    workspace: initialWorkspace,
    metadata: initialMetadataRecord.metadata,
    artifactSetDigest: options.get('--artifact-set-digest'),
    runMetadataSha256: initialMetadataRecord.sha256
  })
  await assertFormalOutputPath(workspaceRoot, options.get('--output'), identity.gitSha)

  let evidence
  const aggregateInputs = []
  if (command === 'health') {
    const provider = createProviderFromEnvironment(process.env)
    const health = await runProviderHealthSmoke({ provider })
    evidence = createFormalHealthEvidence(provider, health, identity)
  } else {
    const inputSpecifications = [
      ['health', '--health-evidence'],
      ['timeout', '--timeout-evidence'],
      ['network-unavailable', '--network-evidence'],
      ['malformed-response', '--malformed-response-evidence'],
      ['recovery', '--recovery-evidence']
    ]
    for (const [label, option] of inputSpecifications) {
      const path = options.get(option)
      const record = await readEvidence(path)
      aggregateInputs.push({ label, path, ...record })
    }
    const healthRecord = aggregateInputs.find(({ label }) => label === 'health')
    evidence = aggregateProviderSmokeEvidence({
      identity,
      health: healthRecord.evidence,
      healthSha256: healthRecord.sha256,
      faultRecords: aggregateInputs
        .filter(({ label }) => label !== 'health')
        .map(({ evidence: faultEvidence, sha256: faultSha256 }) => ({
          evidence: faultEvidence,
          sha256: faultSha256
        }))
    })
  }

  const finalWorkspace = describeWorkspace(workspaceRoot)
  const finalMetadataRecord = await readRunMetadata(options.get('--run-metadata'))
  assertFormalProviderSmokePostconditions({
    initialWorkspace,
    finalWorkspace,
    initialRunMetadataSha256: initialMetadataRecord.sha256,
    finalRunMetadataSha256: finalMetadataRecord.sha256
  })
  for (const input of aggregateInputs) {
    const finalInput = await readEvidence(input.path)
    if (finalInput.sha256 !== input.sha256) {
      throw new ProviderSmokeBlockedError('aggregate-input-changed-during-run')
    }
  }
  await writeProviderSmokeEvidence(options.get('--output'), evidence)
  console.log(`[phase5:provider-smoke] ${evidence.stableCode} / PERF08 ${evidence.perf08Status}`)
  if (
    evidence.stableCode.endsWith('FAIL')
    || (evidence.evidenceKind === 'aggregate' && evidence.perf08Status !== 'PASS')
  ) {
    process.exitCode = 1
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    const stableCode = error instanceof ProviderSmokeBlockedError
      ? error.stableCode
      : 'unexpected-runner-failure'
    console.error(`[phase5:provider-smoke] BLOCKED ${stableCode}`)
    process.exitCode = 1
  })
}
