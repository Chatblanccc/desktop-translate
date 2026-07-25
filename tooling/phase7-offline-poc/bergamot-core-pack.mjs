import { createHash } from 'node:crypto';
import { lstat, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  DEFAULT_BERGAMOT_MANIFEST_PATH,
  DEFAULT_BERGAMOT_SUPPLY_ROOT,
  loadBergamotManifest,
  selectBergamotCandidates,
  verifyBergamotAuthorization,
  verifyBergamotSupply
} from './bergamot-lib.mjs';
import {
  createBergamotCorePackPlan,
  createCorePackSizingPreparation,
  loadCandidateGenerationSet,
  verifyBaseInstallerPackage,
  writeDeterministicTarGzip
} from './bergamot-core-pack-lib.mjs';
import {
  PocError,
  assertNoReparsePointsWithinArtifactRoot,
  resolveArtifactOutput,
  writeJsonArtifact
} from './lib.mjs';

const USAGE = `Usage:
  node bergamot-core-pack.mjs \\
    --authorization <phase7-authorization.json> \\
    --generation-en-zh <generation-en-zh.json> \\
    --generation-zh-en <generation-zh-en.json> \\
    --base-installer <setup.exe> \\
    --base-unpacked <win-unpacked> \\
    --base-evidence-root <phase5-evidence-root> \\
    --pack-output <core-pack.tar.gz> \\
    --receipt-output <sizing-preparation.json>

Optional:
    --manifest <bergamot-candidates.json>
    --supply-root <verified-bergamot-supply-root>

This command creates research-only, non-authorizing M4 sizing preparation.
It does not create final Gate A package-sizing evidence and does not authorize
M5 integration or distribution.
`;

export async function buildBergamotCorePack(options) {
  const manifest = await loadBergamotManifest(
    options.manifestPath ?? DEFAULT_BERGAMOT_MANIFEST_PATH
  );
  const candidates = selectBergamotCandidates(manifest);
  const authorizationArtifact = await readAuthorization(
    options.authorizationPath
  );
  verifyBergamotAuthorization(
    authorizationArtifact.document,
    manifest,
    candidates.map((candidate) => candidate.id)
  );
  const supplyRoot = resolve(
    options.supplyRoot ?? DEFAULT_BERGAMOT_SUPPLY_ROOT
  );
  const modelTreeByCandidate = new Map();
  for (const candidate of candidates) {
    const supply = await verifyBergamotSupply(manifest, [candidate], {
      includeModels: true,
      supplyRoot
    });
    modelTreeByCandidate.set(candidate.id, supply.treeSha256);
  }
  const generationSet = await loadCandidateGenerationSet({
    paths: [
      options.generationEnZhPath,
      options.generationZhEnPath
    ],
    manifest,
    candidates,
    authorizationRaw: authorizationArtifact.raw,
    authorizationRecordId:
      authorizationArtifact.document.authorizationRecordId,
    modelTreeByCandidate
  });
  const plan = await createBergamotCorePackPlan({
    manifest,
    candidates,
    generationSet,
    supplyRoot
  });
  const baseInstaller = await verifyBaseInstallerPackage({
    installerPath: options.baseInstallerPath,
    unpackedPath: options.baseUnpackedPath,
    evidenceRoot: options.baseEvidenceRoot,
    modelPins: candidates.flatMap(
      (candidate) => candidate.sourceFiles
    )
  });
  const packOutput = resolveArtifactOutput(options.packOutputPath);
  const receiptOutput = resolveArtifactOutput(options.receiptOutputPath);
  await assertCreateNewOutput(packOutput);
  await assertCreateNewOutput(receiptOutput);
  let archive;
  try {
    archive = await writeDeterministicTarGzip({
      entries: plan.entries,
      outputPath: packOutput
    });
    const receipt = createCorePackSizingPreparation({
      baseInstaller,
      archive,
      plan,
      generationSet,
      measuredAt: new Date().toISOString()
    });
    await writeJsonArtifact(receiptOutput, receipt);
    return {
      receipt,
      summary: {
        schemaVersion: receipt.schemaVersion,
        status: receipt.status,
        candidateGenerationBindingSetSha256:
          receipt.candidateGenerationBindingSetSha256,
        baseInstallerSha256: receipt.baseInstaller.sha256,
        baseInstallerBytes: receipt.baseInstaller.sizeBytes,
        coreModelPackSha256: receipt.coreModelPack.sha256,
        coreModelPackArchiveBytes:
          receipt.coreModelPack.archiveSizeBytes,
        coreModelPackInstalledBytes:
          receipt.coreModelPack.installedSizeBytes,
        corePackTargetPass:
          receipt.coreModelPack.archiveSizeBytes
            <= receipt.limits.corePackTargetBytes,
        corePackHardLimitPass:
          receipt.coreModelPack.archiveSizeBytes
            <= receipt.limits.corePackHardMaximumBytes,
        containsExecutableCode: false,
        finalGateAPackageSizingStatus:
          receipt.finalization.finalGateAPackageSizingStatus,
        integrationOrDistributionAuthorized: false
      }
    };
  } catch (error) {
    if (archive) {
      await rm(packOutput, { force: true });
    }
    throw error;
  }
}

async function main(argv) {
  const options = parseOptions(argv);
  const result = await buildBergamotCorePack(options);
  process.stdout.write(`${JSON.stringify(result.summary, null, 2)}\n`);
}

function parseOptions(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--help') {
      process.stdout.write(USAGE);
      process.exitCode = 0;
      return null;
    }
    if (!key.startsWith('--') || index + 1 >= argv.length) {
      throw new PocError('CORE_PACK_ARGUMENT_INVALID');
    }
    if (values.has(key)) {
      throw new PocError('CORE_PACK_ARGUMENT_DUPLICATE');
    }
    values.set(key, argv[index + 1]);
    index += 1;
  }
  if (values.has('--help')) {
    return null;
  }
  const required = [
    '--authorization',
    '--generation-en-zh',
    '--generation-zh-en',
    '--base-installer',
    '--base-unpacked',
    '--base-evidence-root',
    '--pack-output',
    '--receipt-output'
  ];
  if (required.some((key) => !values.has(key))
      || [...values.keys()].some((key) => ![
        ...required,
        '--manifest',
        '--supply-root'
      ].includes(key))) {
    throw new PocError('CORE_PACK_REQUIRED_ARGUMENT_MISSING_OR_UNKNOWN');
  }
  return {
    authorizationPath: values.get('--authorization'),
    generationEnZhPath: values.get('--generation-en-zh'),
    generationZhEnPath: values.get('--generation-zh-en'),
    baseInstallerPath: values.get('--base-installer'),
    baseUnpackedPath: values.get('--base-unpacked'),
    baseEvidenceRoot: values.get('--base-evidence-root'),
    packOutputPath: values.get('--pack-output'),
    receiptOutputPath: values.get('--receipt-output'),
    manifestPath: values.get('--manifest'),
    supplyRoot: values.get('--supply-root')
  };
}

async function readAuthorization(path) {
  const target = resolveArtifactOutput(path);
  await assertNoReparsePointsWithinArtifactRoot(target);
  const stat = await lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new PocError('CORE_PACK_AUTHORIZATION_FILE_INVALID');
  }
  const raw = await readFile(target);
  let document;
  try {
    document = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new PocError('CORE_PACK_AUTHORIZATION_JSON_INVALID');
  }
  return {
    raw,
    sha256: createHash('sha256').update(raw).digest('hex'),
    document
  };
}

async function assertCreateNewOutput(path) {
  await assertNoReparsePointsWithinArtifactRoot(path);
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return;
    }
    throw error;
  }
  throw new PocError('CORE_PACK_OUTPUT_ALREADY_EXISTS');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (process.argv.includes('--help')) {
    process.stdout.write(USAGE);
  } else {
    main(process.argv.slice(2)).catch((error) => {
      process.stderr.write(`${error.code ?? error.message}\n`);
      process.exitCode = 1;
    });
  }
}
