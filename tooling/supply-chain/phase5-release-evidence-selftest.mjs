import assert from 'node:assert/strict';
import {
  assertExactArtifactSet,
  assertExactAttestationBundle,
  expectedArtifactRoles,
  expectedSignedRoles
} from './phase5-release-evidence-lib.mjs';
import { assertNoProductionTestMarkers } from '../packaging/phase5-package-policy.mjs';
import { assertElectronBuilderSigningPolicy } from '../packaging/phase5-electron-builder-policy.mjs';

const records = [
  record('application', 'package/desktop-translate.exe', 'desktop-translate.exe', 'a'),
  record('nativeHost', 'package/resources/selection-host/selection-host.exe', 'selection-host.exe', 'b'),
  record('asar', 'package/resources/app.asar', 'app.asar', 'c'),
  record('installer', 'installer/Desktop-Translate-0.5.0-phase5-x64-setup.exe', 'Desktop-Translate-0.5.0-phase5-x64-setup.exe', 'd')
];

assert.doesNotThrow(() => assertExactArtifactSet(records, records, 'selftest', expectedArtifactRoles(true)));
assert.deepEqual(expectedSignedRoles(true), ['application', 'installer', 'nativeHost']);
assert.throws(
  () => assertExactArtifactSet(records.filter((item) => item.role !== 'installer'), records, 'missing installer', expectedArtifactRoles(true)),
  /roles must be exactly/u
);

assert.doesNotThrow(() => assertNoProductionTestMarkers([{
  path: '.vite/build/metrics-schema.js',
  content: 'const allowed = ["fake-native", "fake-provider"];'
}]));
for (const marker of [
  'DESKTOP_TRANSLATE_E2E',
  '__desktopTranslateTestApi',
  'e2e-baidu-transport',
  '--fake-mode',
  'DESKTOP_TRANSLATE_E2E_NATIVE_FIXTURE'
]) {
  assert.throws(
    () => assertNoProductionTestMarkers([{ path: '.vite/build/main.js', content: `unsafe:${marker}` }]),
    /forbidden test injection marker/u
  );
}

const attestation = bundleFor(records.map((item) => item.sha256));
assert.doesNotThrow(() => assertExactAttestationBundle(attestation, records.map((item) => item.sha256)));
assert.throws(
  () => assertExactAttestationBundle(bundleFor(records.slice(0, 3).map((item) => item.sha256)), records.map((item) => item.sha256)),
  /subject set is not exact/u
);

const signingConfig = `win:\n  executableName: desktop-translate\n  signExts:\n    - selection-host.exe\n  target:\n    - nsis\n  artifactName: Desktop-Translate-0.5.0-phase5-x64-setup.exe\npublish: null\n`;
assert.doesNotThrow(() => assertElectronBuilderSigningPolicy(signingConfig));
assert.throws(
  () => assertElectronBuilderSigningPolicy(signingConfig.replace('  signExts:\n    - selection-host.exe\n', '')),
  /signExts is required/u
);
assert.throws(
  () => assertElectronBuilderSigningPolicy(signingConfig.replace('    - selection-host.exe', '    - .exe')),
  /must contain exactly selection-host.exe/u
);
assert.throws(
  () => assertElectronBuilderSigningPolicy(`${signingConfig}${signingConfig}`),
  /exactly one top-level win block/u
);
assert.throws(
  () => assertElectronBuilderSigningPolicy(signingConfig.replace('  target:', '  signExts:\n    - selection-host.exe\n  target:')),
  /exactly one signExts key/u
);
assert.throws(
  () => assertElectronBuilderSigningPolicy(signingConfig.replace('Desktop-Translate-0.5.0-phase5-x64-setup.exe', 'Desktop-Translate-${version}-${arch}-setup.${ext}')),
  /artifactName must be exactly/u
);
assert.throws(
  () => assertElectronBuilderSigningPolicy(signingConfig.replace('publish: null', 'publish: always')),
  /publish policy must be exactly/u
);
assert.throws(
  () => assertExactAttestationBundle(bundleFor([...records, records[0]].map((item) => item.sha256)), records.map((item) => item.sha256)),
  /duplicate subjects/u
);
assert.throws(
  () => assertExactArtifactSet([...records, record('extra', 'extra.exe', 'extra.exe', 'e')], records, 'extra artifact', expectedArtifactRoles(true)),
  /roles must be exactly/u
);
assert.throws(
  () => assertExactArtifactSet(records.map((item) => item.role === 'application' ? { ...item, sha256: 'f'.repeat(64) } : item), records, 'stale hash'),
  /does not match the current file/u
);
assert.throws(
  () => assertExactArtifactSet([...records, records[0]], records, 'duplicate role'),
  /duplicate artifact roles/u
);

console.log('[phase5:release-evidence:selftest] exact-set and stale-hash negative cases PASS.');

function record(role, path, name, seed) {
  return { role, path, name, size: 100, sha256: seed.repeat(64) };
}

function bundleFor(digests) {
  const statement = {
    _type: 'https://in-toto.io/Statement/v1',
    predicateType: 'https://slsa.dev/provenance/v1',
    subject: digests.map((sha256, index) => ({ name: `artifact-${index}`, digest: { sha256 } }))
  };
  return { dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString('base64') } };
}
