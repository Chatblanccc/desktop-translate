import { randomBytes } from 'node:crypto';
import {
  mkdir,
  readFile,
  writeFile
} from 'node:fs/promises';
import {
  basename,
  resolve
} from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  canonicalJson,
  sha256Text
} from './lib.mjs';
import {
  validateM4AiCompletion
} from './m4-ai-completion.mjs';

export const GATE_A_DECISION_SCHEMA_VERSION =
  'phase7-gate-a-decision-v1';

const scriptRoot = fileURLToPath(new URL('.', import.meta.url));
const repositoryRoot = resolve(scriptRoot, '..', '..');
const gateArtifactRoot = resolve(
  repositoryRoot,
  'artifacts',
  'phase7',
  'offline-poc',
  'gate-a'
);
const expectedCandidateIds = Object.freeze([
  'firefox-bergamot-base-memory-en-zh',
  'firefox-bergamot-base-memory-zh-en'
]);

function assert(condition, code) {
  if (!condition) {
    const error = new Error(code);
    error.code = code;
    throw error;
  }
}

export function buildGateADecision({
  m4Completion,
  m4CompletionSha256,
  decisionId,
  decidedAt
}) {
  validateM4AiCompletion(m4Completion);
  assert(
    /^gate-a-decision-[a-f0-9]{16}$/u.test(decisionId),
    'GATE_A_DECISION_ID_INVALID'
  );
  assert(
    !Number.isNaN(Date.parse(decidedAt)),
    'GATE_A_DECIDED_AT_INVALID'
  );
  const actualCandidateIds = m4Completion.candidateGenerationBindings
    .map((binding) => binding.candidateId)
    .sort();
  assert(
    JSON.stringify(actualCandidateIds)
      === JSON.stringify([...expectedCandidateIds].sort()),
    'GATE_A_SELECTED_CANDIDATE_SET_MISMATCH'
  );
  assert(
    m4Completion.packageSizingApproval.coreModelPack.archiveSizeBytes
      <= m4Completion.packageSizingApproval.limits.corePackTargetBytes,
    'GATE_A_DEFAULT_STORAGE_REQUIRES_CORE_PACK_WITHIN_TARGET'
  );
  const selection = {
    candidateSetId:
      'firefox-bergamot-base-memory-en-zh-bidirectional',
    candidateIds: [...expectedCandidateIds],
    runtimeId: 'browsermt-bergamot-translator-wasm',
    runtimeBoundary: 'DEDICATED_LOCAL_TRANSLATION_HOST',
    directions: ['en-zh', 'zh-en'],
    storageRoute: {
      type: 'CURRENT_USER_LOCALAPPDATA_DEFAULT',
      customModelPath: 'N/A_BY_USER_DECISION',
      customPathMigration: 'N/A_BY_USER_DECISION',
      removableByUser: true
    }
  };
  const selectionSha256 = sha256Text(canonicalJson(selection));
  const report = {
    schemaVersion: GATE_A_DECISION_SCHEMA_VERSION,
    status: 'GATE_A_CONFIRMED',
    decisionId,
    decidedAt,
    decisionAuthority: 'USER',
    decisionBasis: 'EXPLICIT_USER_CONFIRMATION_IN_CODEX',
    confirmationSummary:
      'Use the recommended bidirectional Firefox/Bergamot offline translation route, the default LocalAppData model directory, accept disclosed limitations, and enter M5.',
    m4Completion: {
      artifactSha256: m4CompletionSha256,
      primaryEvidenceSetSha256:
        m4Completion.primaryEvidenceSetSha256,
      candidateGenerationBindingSetSha256:
        m4Completion.primaryEvidence
          .candidateGenerationBindingSetSha256,
      status: m4Completion.status
    },
    selection,
    selectionSha256,
    acceptedLimitations: {
      aiQualityReview: true,
      aiM4RiskApprovalNotLegalAdvice: true,
      commercialRedistributionPermissionEstablished: false,
      osFirewallOrPacketCapturePerformed: false,
      zeroExternalTrafficClaimed: false,
      zhEnQualityLowerThanEnZh: true
    },
    authorization: {
      m5Authorized: true,
      authorizedScope:
        'M5_SELECTED_ROUTE_LOCAL_HOST_AND_MODEL_MANAGER_DEVELOPMENT',
      onlySelectedRouteAuthorized: true,
      gateBReached: false,
      signingOrProductionFeedAuthorized: false,
      packagingOrDistributionAuthorized: false,
      signedLimitedBetaAuthorized: false
    }
  };
  validateGateADecision(report, {
    m4Completion,
    m4CompletionSha256
  });
  return report;
}

export function validateGateADecision(report, expected = {}) {
  assert(
    report?.schemaVersion === GATE_A_DECISION_SCHEMA_VERSION
      && report?.status === 'GATE_A_CONFIRMED'
      && report?.decisionAuthority === 'USER'
      && report?.decisionBasis
        === 'EXPLICIT_USER_CONFIRMATION_IN_CODEX'
      && /^gate-a-decision-[a-f0-9]{16}$/u.test(
        report?.decisionId ?? ''
      )
      && !Number.isNaN(Date.parse(report?.decidedAt))
      && report?.selection?.candidateSetId
        === 'firefox-bergamot-base-memory-en-zh-bidirectional'
      && report?.selection?.runtimeId
        === 'browsermt-bergamot-translator-wasm'
      && report?.selection?.runtimeBoundary
        === 'DEDICATED_LOCAL_TRANSLATION_HOST'
      && JSON.stringify([...report.selection.candidateIds].sort())
        === JSON.stringify([...expectedCandidateIds].sort())
      && JSON.stringify([...report.selection.directions].sort())
        === JSON.stringify(['en-zh', 'zh-en'])
      && report?.selection?.storageRoute?.type
        === 'CURRENT_USER_LOCALAPPDATA_DEFAULT'
      && report?.selection?.storageRoute?.customModelPath
        === 'N/A_BY_USER_DECISION'
      && report?.selection?.storageRoute?.customPathMigration
        === 'N/A_BY_USER_DECISION'
      && report?.selection?.storageRoute?.removableByUser === true
      && report?.selectionSha256
        === sha256Text(canonicalJson(report.selection))
      && report?.acceptedLimitations?.aiQualityReview === true
      && report?.acceptedLimitations
        ?.aiM4RiskApprovalNotLegalAdvice === true
      && report?.acceptedLimitations
        ?.commercialRedistributionPermissionEstablished === false
      && report?.acceptedLimitations
        ?.osFirewallOrPacketCapturePerformed === false
      && report?.acceptedLimitations?.zeroExternalTrafficClaimed
        === false
      && report?.authorization?.m5Authorized === true
      && report?.authorization?.onlySelectedRouteAuthorized === true
      && report?.authorization?.gateBReached === false
      && report?.authorization?.signingOrProductionFeedAuthorized
        === false
      && report?.authorization?.packagingOrDistributionAuthorized
        === false
      && report?.authorization?.signedLimitedBetaAuthorized === false,
    'GATE_A_DECISION_INVALID'
  );
  if (expected.m4Completion) {
    assert(
      report.m4Completion.artifactSha256
        === expected.m4CompletionSha256
        && report.m4Completion.primaryEvidenceSetSha256
          === expected.m4Completion.primaryEvidenceSetSha256
        && report.m4Completion.candidateGenerationBindingSetSha256
          === expected.m4Completion.primaryEvidence
            .candidateGenerationBindingSetSha256,
      'GATE_A_DECISION_M4_BINDING_MISMATCH'
    );
  }
  return true;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  assert(
    options['confirmation-record']
      === 'USER_CONFIRMED_RECOMMENDED_ROUTE_IN_CODEX_2026_07_26',
    'GATE_A_EXPLICIT_CONFIRMATION_REQUIRED'
  );
  const m4Path = resolve(required(options, 'm4-completion'));
  const m4Content = await readFile(m4Path, 'utf8');
  const m4Completion = JSON.parse(m4Content);
  const m4CompletionSha256 = sha256Text(m4Content);
  const decisionId =
    `gate-a-decision-${randomBytes(8).toString('hex')}`;
  const report = buildGateADecision({
    m4Completion,
    m4CompletionSha256,
    decisionId,
    decidedAt: new Date().toISOString()
  });
  const reportContent = `${JSON.stringify(report, null, 2)}\n`;
  await mkdir(gateArtifactRoot, { recursive: true });
  const outputPath = resolve(gateArtifactRoot, `${decisionId}.json`);
  await writeFile(outputPath, reportContent, {
    encoding: 'utf8',
    flag: 'wx'
  });
  process.stdout.write(`${JSON.stringify({
    status: report.status,
    decisionAuthority: report.decisionAuthority,
    candidateSetId: report.selection.candidateSetId,
    runtimeId: report.selection.runtimeId,
    directions: report.selection.directions,
    storageRoute: report.selection.storageRoute.type,
    customModelPath:
      report.selection.storageRoute.customModelPath,
    m5Authorized: report.authorization.m5Authorized,
    packagingOrDistributionAuthorized:
      report.authorization.packagingOrDistributionAuthorized,
    selectionSha256: report.selectionSha256,
    reportSha256: sha256Text(reportContent),
    logicalName: basename(outputPath)
  }, null, 2)}\n`);
}

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    assert(args[index]?.startsWith('--'), 'GATE_A_CLI_OPTION_INVALID');
    options[args[index].slice(2)] = args[index + 1];
  }
  return options;
}

function required(options, key) {
  assert(
    typeof options[key] === 'string' && options[key].length > 0,
    `GATE_A_CLI_OPTION_REQUIRED:${key}`
  );
  return options[key];
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      status: 'FAILED',
      code: error?.code ?? error?.message ?? 'GATE_A_DECISION_FAILED'
    }, null, 2)}\n`);
    process.exitCode = 1;
  });
}
