import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { BaiduTranslationProvider, BaiduTransportError } from '../packages/translation/src/baidu.ts'
import {
  PROVIDER_SMOKE_FAULT_SCENARIOS,
  PROVIDER_SMOKE_FORMAL_FAULT_BLOCKED_CODE,
  PROVIDER_SMOKE_METADATA_SCHEMA_VERSION,
  PROVIDER_SMOKE_P95_INTERPRETATION,
  PROVIDER_SMOKE_SOURCE_TEXT_ID,
  ProviderSmokeBlockedError,
  aggregateProviderSmokeEvidence,
  assertFormalProviderSmokePostconditions,
  assertProviderSmokeEvidence,
  runProviderFaultSelfTests,
  runProviderHealthSmoke,
  validateFormalProviderSmokePreconditions,
  writeProviderSmokeEvidence
} from './phase5-provider-smoke.mjs'

const ARTIFACT_SET_DIGEST = 'b'.repeat(64)
const RUN_METADATA_DIGEST = 'c'.repeat(64)

test('injectable health harness is always non-formal and cannot claim PERF-08 PASS', async () => {
  let requestCount = 0
  const evidence = await runProviderHealthSmoke({
    provider: healthyProductProvider(() => { requestCount += 1 }),
    monotonicNow: advancingClock(5),
    delay: async () => {}
  })

  assert.equal(requestCount, 30)
  assert.equal(evidence.formal, false)
  assert.equal(evidence.providerBoundary, 'INJECTABLE_TEST_HARNESS')
  assert.equal(evidence.identity, null)
  assert.equal(evidence.stableCode, 'HEALTH_PASS')
  assert.equal(evidence.perf08Status, 'BLOCKED_FORMAL_REAL_PROVIDER_AND_FAULT_RECOVERY_REQUIRED')
  assert.equal(evidence.acceptance, false)
  assert.equal(evidence.p95Interpretation, PROVIDER_SMOKE_P95_INTERPRETATION)
  assert.deepEqual(evidence.healthTargets.map(({ targetLanguage }) => targetLanguage), ['en', 'ja', 'ko'])
  for (const target of evidence.healthTargets) {
    assert.equal(target.attemptCount, 10)
    assert.equal(target.successCount, 10)
    assert.equal(target.failureCount, 0)
    assert.deepEqual(target.stableCodeCounts, { success: 10 })
    assert.equal(target.durationMs.samples.length, 10)
    assert.equal(target.durationMs.p95, target.durationMs.max)
  }
  assertProviderSmokeEvidence(evidence)

  assert.throws(
    () => assertProviderSmokeEvidence({
      ...evidence,
      formal: true,
      identity: formalIdentity('fake-formal-run'),
      perf08Status: 'BLOCKED_FAULT_RECOVERY_EVIDENCE_REQUIRED'
    }),
    (error) => error instanceof ProviderSmokeBlockedError && error.stableCode === 'formal-fake-provider-forbidden'
  )
})

test('development fault selftests stay redacted and are not embedded as formal recovery evidence', async () => {
  const checks = await runProviderFaultSelfTests()
  assert.deepEqual(checks.map(({ stableCode }) => stableCode), [
    'credentials-missing',
    'network-unavailable'
  ])
  const serialized = JSON.stringify(checks)
  assert.doesNotMatch(serialized, /selftest-app-id/u)
  assert.doesNotMatch(serialized, /selftest-secret-key/u)
  assert.doesNotMatch(serialized, /raw transport detail/u)
  assert.equal(checks.some((check) => Object.hasOwn(check, 'formal')), false)
})

test('health evidence retains no source text, credentials, translations, body, or raw failure details', async () => {
  const appId = 'provider-smoke-test-app-id'
  const secretKey = 'provider-smoke-test-secret-key'
  const translatedSentinel = 'translated-body-sentinel'
  const provider = healthyProductProvider(undefined, { appId, secretKey, translatedSentinel })
  const evidence = await runProviderHealthSmoke({
    provider,
    monotonicNow: advancingClock(2),
    delay: async () => {}
  })
  const serialized = JSON.stringify(evidence)
  for (const forbidden of [
    appId,
    secretKey,
    translatedSentinel,
    '你好，欢迎使用桌面翻译。',
    'appid=',
    'sign=',
    'salt=',
    'requestId',
    'selectionId',
    'body',
    'raw provider body secret'
  ]) {
    assert.equal(serialized.includes(forbidden), false, `evidence leaked ${forbidden}`)
  }
  assert.equal(serialized.includes(PROVIDER_SMOKE_SOURCE_TEXT_ID), true)
})

test('health smoke fails closed for duration budget and raw network failures', async () => {
  const slowEvidence = await runProviderHealthSmoke({
    provider: healthyProductProvider(),
    monotonicNow: advancingClock(8_001),
    delay: async () => {}
  })
  assert.equal(slowEvidence.stableCode, 'HEALTH_FAIL')
  for (const target of slowEvidence.healthTargets) {
    assert.deepEqual(target.stableCodeCounts, { 'duration-budget-exceeded': 10 })
    assert.equal(target.successCount, 0)
  }

  const failingProvider = new BaiduTranslationProvider({
    credentials: { appId: 'app-id', secretKey: 'secret-key' },
    transport: {
      async send() {
        throw new BaiduTransportError('network', 'raw provider body secret')
      }
    }
  })
  const networkEvidence = await runProviderHealthSmoke({
    provider: failingProvider,
    monotonicNow: advancingClock(1),
    delay: async () => {}
  })
  assert.equal(networkEvidence.stableCode, 'HEALTH_FAIL')
  assert.equal(JSON.stringify(networkEvidence).includes('raw provider body secret'), false)
  for (const target of networkEvidence.healthTargets) {
    assert.deepEqual(target.stableCodeCounts, { 'network-unavailable': 10 })
  }
})

test('formal preconditions persist source, artifact, metadata, device, workflow, and run identity', () => {
  const metadata = validMetadata()
  const workspace = { gitSha: 'a'.repeat(40), dirty: false }
  const runtime = validRuntime()
  assert.deepEqual(
    validateFormalProviderSmokePreconditions({
      formal: true,
      networkAuthorized: true,
      workspace,
      metadata,
      artifactSetDigest: ARTIFACT_SET_DIGEST,
      runMetadataSha256: RUN_METADATA_DIGEST,
      runtime
    }),
    {
      gitSha: 'a'.repeat(40),
      artifactSetDigest: ARTIFACT_SET_DIGEST,
      runMetadataSha256: RUN_METADATA_DIGEST,
      deviceRegistrationId: 'device-lab-b-01',
      workflowName: 'phase5-provider-smoke',
      workflowRunId: 'provider-smoke-workflow-1',
      runId: 'provider-smoke-run-1'
    }
  )

  const base = {
    formal: true,
    networkAuthorized: true,
    workspace,
    metadata,
    artifactSetDigest: ARTIFACT_SET_DIGEST,
    runMetadataSha256: RUN_METADATA_DIGEST,
    runtime
  }
  const invalidCases = [
    { ...base, formal: false },
    { ...base, networkAuthorized: false },
    { ...base, artifactSetDigest: undefined },
    { ...base, runMetadataSha256: 'd'.repeat(63) },
    { ...base, workspace: { ...workspace, dirty: true } },
    { ...base, metadata: { ...metadata, run: { ...metadata.run, dedicatedInteractiveSession: false } } },
    { ...base, metadata: { ...metadata, unexpected: true } },
    { ...base, runtime: { ...runtime, logicalProcessorCount: 4 } }
  ]
  for (const configuration of invalidCases) {
    assert.throws(
      () => validateFormalProviderSmokePreconditions(configuration),
      ProviderSmokeBlockedError
    )
  }
})

test('formal postconditions reject dirty/source changes and run metadata mutation', () => {
  const clean = { gitSha: 'a'.repeat(40), dirty: false }
  assert.doesNotThrow(() => assertFormalProviderSmokePostconditions({
    initialWorkspace: clean,
    finalWorkspace: clean,
    initialRunMetadataSha256: RUN_METADATA_DIGEST,
    finalRunMetadataSha256: RUN_METADATA_DIGEST
  }))
  const invalidCases = [
    { finalWorkspace: { ...clean, dirty: true }, finalRunMetadataSha256: RUN_METADATA_DIGEST },
    { finalWorkspace: { gitSha: 'e'.repeat(40), dirty: false }, finalRunMetadataSha256: RUN_METADATA_DIGEST },
    { finalWorkspace: clean, finalRunMetadataSha256: 'f'.repeat(64) }
  ]
  for (const invalid of invalidCases) {
    assert.throws(() => assertFormalProviderSmokePostconditions({
      initialWorkspace: clean,
      initialRunMetadataSha256: RUN_METADATA_DIGEST,
      ...invalid
    }), ProviderSmokeBlockedError)
  }
})

test('formal fault labels cannot turn the same ordinary provider failure into acceptance evidence', () => {
  const sharedObservedFailure = 'network-unavailable'
  const timeout = untrustedFormalFaultEvidence(
    'timeout',
    formalIdentity('timeout-run', '2'),
    'caller-label-timeout',
    sharedObservedFailure
  )
  const network = untrustedFormalFaultEvidence(
    'network-unavailable',
    formalIdentity('network-run', '3'),
    'caller-label-network',
    sharedObservedFailure
  )
  const malformed = untrustedFormalFaultEvidence(
    'malformed-response',
    formalIdentity('malformed-run', '4'),
    'caller-label-malformed',
    sharedObservedFailure
  )

  for (const evidence of [timeout, network, malformed]) {
    assert.throws(
      () => assertProviderSmokeEvidence(evidence),
      (error) => (
        error instanceof ProviderSmokeBlockedError
        && error.stableCode === PROVIDER_SMOKE_FORMAL_FAULT_BLOCKED_CODE
      )
    )
  }
})

test('formal PERF-08 aggregate is fail-closed and cannot claim PASS without a trusted fault controller', async () => {
  const developmentHealth = await runProviderHealthSmoke({
    provider: healthyProductProvider(),
    monotonicNow: advancingClock(3),
    delay: async () => {}
  })
  const health = formalHealthEvidence(developmentHealth, formalIdentity('health-run', '1'))
  const aggregateIdentity = formalIdentity('aggregate-run', '6')
  assert.throws(
    () => aggregateProviderSmokeEvidence({
      identity: aggregateIdentity,
      health,
      healthSha256: '7'.repeat(64),
      faultRecords: []
    }),
    (error) => (
      error instanceof ProviderSmokeBlockedError
      && error.stableCode === PROVIDER_SMOKE_FORMAL_FAULT_BLOCKED_CODE
    )
  )

  const forgedAggregate = {
    schemaVersion: 'phase5-provider-smoke-v2',
    evidenceKind: 'aggregate',
    formal: true,
    providerBoundary: 'REAL_BAIDU_PRODUCT_PROVIDER',
    identity: aggregateIdentity,
    acceptance: false,
    perf08Status: 'PASS',
    sourceTextId: PROVIDER_SMOKE_SOURCE_TEXT_ID,
    healthEvidenceSha256: '7'.repeat(64),
    faultEvidenceDigests: PROVIDER_SMOKE_FAULT_SCENARIOS.map((scenario, index) => ({
      scenario,
      sha256: String(index + 1).repeat(64)
    })),
    stableCode: 'PASS'
  }
  assert.throws(
    () => assertProviderSmokeEvidence(forgedAggregate),
    (error) => (
      error instanceof ProviderSmokeBlockedError
      && error.stableCode === PROVIDER_SMOKE_FORMAL_FAULT_BLOCKED_CODE
    )
  )
})

test('evidence is append-never, exact-shape, and privacy-safe', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phase5-provider-smoke-'))
  try {
    const evidence = await runProviderHealthSmoke({
      provider: healthyProductProvider(),
      monotonicNow: advancingClock(3),
      delay: async () => {}
    })
    const outputPath = join(directory, 'evidence.json')
    await writeProviderSmokeEvidence(outputPath, evidence)
    assert.deepEqual(JSON.parse(await readFile(outputPath, 'utf8')), evidence)
    await assert.rejects(writeProviderSmokeEvidence(outputPath, evidence), /EEXIST/u)
    assert.throws(
      () => assertProviderSmokeEvidence({ ...evidence, rawBody: 'forbidden' }),
      ProviderSmokeBlockedError
    )
    const serialized = JSON.stringify(evidence)
    assert.doesNotMatch(serialized, /provider-smoke-test-secret-key|translated-body-sentinel|\\|:\//u)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

function healthyProductProvider(onRequest, options = {}) {
  const appId = options.appId ?? 'app-id'
  const secretKey = options.secretKey ?? 'secret-key'
  const translatedSentinel = options.translatedSentinel ?? 'translated'
  return new BaiduTranslationProvider({
    credentials: { appId, secretKey },
    transport: {
      async send(request) {
        onRequest?.()
        const parameters = new URLSearchParams(request.body)
        return {
          status: 200,
          body: JSON.stringify({
            from: 'zh',
            to: parameters.get('to'),
            trans_result: [{
              src: parameters.get('q'),
              dst: translatedSentinel
            }]
          })
        }
      }
    }
  })
}

function formalHealthEvidence(developmentEvidence, identity) {
  const evidence = {
    ...developmentEvidence,
    formal: true,
    providerBoundary: 'REAL_BAIDU_PRODUCT_PROVIDER',
    identity,
    perf08Status: 'BLOCKED_FAULT_RECOVERY_EVIDENCE_REQUIRED'
  }
  assertProviderSmokeEvidence(evidence)
  return evidence
}

function untrustedFormalFaultEvidence(scenario, identity, faultControlId, observedStableCode) {
  return {
    schemaVersion: 'phase5-provider-smoke-v2',
    evidenceKind: 'fault',
    formal: true,
    providerBoundary: 'REAL_BAIDU_PRODUCT_PROVIDER',
    identity,
    acceptance: false,
    perf08Status: 'BLOCKED_AGGREGATION_REQUIRED',
    sourceTextId: PROVIDER_SMOKE_SOURCE_TEXT_ID,
    scenario,
    faultControlId,
    recoveryOfControlIds: [],
    attemptCount: 1,
    observedStableCode,
    scenarioStatus: 'PASS',
    stableCode: 'SCENARIO_PASS'
  }
}

function formalIdentity(runId, digestSeed = 'c') {
  return {
    gitSha: 'a'.repeat(40),
    artifactSetDigest: ARTIFACT_SET_DIGEST,
    runMetadataSha256: digestSeed.repeat(64),
    deviceRegistrationId: 'device-lab-b-01',
    workflowName: 'phase5-provider-smoke',
    workflowRunId: `workflow-${runId}`,
    runId
  }
}

function advancingClock(durationMs) {
  let current = -durationMs
  return () => {
    current += durationMs
    return current
  }
}

function validMetadata() {
  return {
    schemaVersion: PROVIDER_SMOKE_METADATA_SCHEMA_VERSION,
    run: {
      runId: 'provider-smoke-run-1',
      workflowName: 'phase5-provider-smoke',
      workflowRunId: 'provider-smoke-workflow-1',
      operatorRole: 'Quality',
      deviceRegistrationId: 'device-lab-b-01',
      evidenceLevel: 'provider-smoke',
      dedicatedInteractiveSession: true,
      foregroundInputExclusive: true,
      debuggerClosed: true,
      unrelatedForegroundTasksClosed: true
    },
    environment: {
      osBuild: '10.0.26200',
      osArchitecture: 'x64',
      cpuModels: ['Test CPU'],
      physicalCoreCount: 8,
      logicalProcessorCount: 16,
      ramBytes: 16 * 1024 * 1024 * 1024,
      storageType: 'SSD',
      gpuModels: ['Test GPU'],
      displays: [{
        widthPixels: 2160,
        heightPixels: 1440,
        dpiPercent: 150,
        primary: true,
        physical: true,
        orientation: 'landscape',
        taskbarEdge: 'bottom'
      }],
      powerPlanGuid: '381b4222-f694-41f0-9685-ff5bb260df2e',
      powerPlanLabel: 'Balanced',
      acPower: true,
      nodeVersion: 'v22.23.1',
      antivirusScanActivityAbsent: true,
      osUpdateActivityAbsent: true
    }
  }
}

function validRuntime() {
  return {
    platform: 'win32',
    osBuild: '10.0.26200',
    osArchitecture: 'x64',
    cpuModels: ['Test CPU'],
    logicalProcessorCount: 16,
    ramBytes: 16 * 1024 * 1024 * 1024,
    nodeVersion: 'v22.23.1'
  }
}
