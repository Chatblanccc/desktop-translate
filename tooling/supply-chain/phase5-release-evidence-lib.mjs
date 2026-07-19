import { stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { sha256File } from './phase5-supply-chain-lib.mjs';

export const REQUIRED_PACKAGE_ROLES = Object.freeze(['application', 'asar', 'nativeHost']);
export const REQUIRED_SIGNED_ROLES = Object.freeze(['application', 'nativeHost']);

export async function collectReleaseArtifacts(packageDirectory, installerPath) {
  const definitions = [
    ['application', 'package/desktop-translate.exe', join(packageDirectory, 'desktop-translate.exe')],
    ['nativeHost', 'package/resources/selection-host/selection-host.exe', join(packageDirectory, 'resources', 'selection-host', 'selection-host.exe')],
    ['asar', 'package/resources/app.asar', join(packageDirectory, 'resources', 'app.asar')]
  ];
  if (installerPath) definitions.push(['installer', `installer/${basename(installerPath)}`, installerPath]);

  const records = [];
  for (const [role, logicalPath, absolutePath] of definitions) {
    const details = await stat(absolutePath).catch(() => undefined);
    assert(details?.isFile(), `Release artifact '${role}' is missing: ${absolutePath}`);
    records.push({
      role,
      path: logicalPath,
      name: basename(absolutePath),
      size: details.size,
      sha256: await sha256File(absolutePath),
      absolutePath
    });
  }
  return records;
}

export function expectedArtifactRoles(hasInstaller) {
  return [...REQUIRED_PACKAGE_ROLES, ...(hasInstaller ? ['installer'] : [])].sort();
}

export function expectedSignedRoles(hasInstaller) {
  return [...REQUIRED_SIGNED_ROLES, ...(hasInstaller ? ['installer'] : [])].sort();
}

export function assertExactArtifactSet(actualRecords, expectedRecords, label, roles = undefined) {
  assert(Array.isArray(actualRecords), `${label} must be an array`);
  assert(Array.isArray(expectedRecords), 'Expected artifact records must be an array');
  const expectedByRole = new Map(expectedRecords.map((record) => [record.role, record]));
  const requiredRoles = [...(roles ?? expectedByRole.keys())].sort();
  const actualRoles = actualRecords.map((record) => record?.role).sort();
  assert(new Set(actualRoles).size === actualRoles.length, `${label} contains duplicate artifact roles`);
  assert(JSON.stringify(actualRoles) === JSON.stringify(requiredRoles), `${label} roles must be exactly [${requiredRoles.join(', ')}], got [${actualRoles.join(', ')}]`);

  for (const actual of actualRecords) {
    const expected = expectedByRole.get(actual.role);
    assert(expected, `${label} contains unexpected role '${actual.role}'`);
    for (const field of ['path', 'name', 'size', 'sha256']) {
      assert(actual[field] === expected[field], `${label} ${actual.role}.${field} does not match the current file`);
    }
    assert(/^[a-f0-9]{64}$/u.test(actual.sha256), `${label} ${actual.role}.sha256 is invalid`);
  }
}

export function publicArtifactRecords(records) {
  return records.map(({ role, path, name, size, sha256 }) => ({ role, path, name, size, sha256 }));
}

export function assertExactAttestationBundle(bundle, expectedSha256, label = 'attestation bundle') {
  let statement;
  try {
    statement = JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, 'base64').toString('utf8'));
  } catch {
    throw new Error(`${label} DSSE statement is malformed`);
  }
  assert(statement._type === 'https://in-toto.io/Statement/v1', `${label} is not an in-toto v1 statement`);
  assert(statement.predicateType === 'https://slsa.dev/provenance/v1', `${label} predicate is not SLSA provenance v1`);
  const actualDigests = (statement.subject ?? []).map((subject) => subject?.digest?.sha256).sort();
  const expectedDigests = [...expectedSha256].sort();
  assert(new Set(actualDigests).size === actualDigests.length, `${label} contains duplicate subjects`);
  assert(JSON.stringify(actualDigests) === JSON.stringify(expectedDigests), `${label} subject set is not exact`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
