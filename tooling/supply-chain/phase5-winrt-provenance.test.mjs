import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPrepareScriptPins } from './phase5-winrt-provenance.mjs';

const pins = {
  packages: [
    {
      id: 'Microsoft.Windows.CppWinRT',
      version: '3.0.260520.1',
      sha256: 'd22e2e26133d63217ae26e91b1685fb024b03a508a78af645f8347a3126c8435',
      prepareScript: {
        versionVariable: 'cppWinRtVersion',
        hashVariable: 'cppWinRtHash'
      }
    },
    {
      id: 'Microsoft.Windows.SDK.Contracts',
      version: '10.0.26100.8249',
      sha256: '0e1c25793ed1265d49ed5846f1f9dd5a5a32fd44d3e9c16e74b7fda018e5fbd8',
      prepareScript: {
        versionVariable: 'contractsVersion',
        hashVariable: 'contractsHash'
      }
    }
  ]
};

test('accepts the reviewed prepare-winrt version, hash, and official source pins', () => {
  assert.doesNotThrow(() => assertPrepareScriptPins(reviewedScript(), pins));
});

test('rejects a package hash drift before provenance can pass', () => {
  const drifted = reviewedScript().replace(
    'D22E2E26133D63217AE26E91B1685FB024B03A508A78AF645F8347A3126C8435',
    'A'.repeat(64)
  );
  assert.throws(
    () => assertPrepareScriptPins(drifted, pins),
    /does not pin \$cppWinRtHash/u
  );
});

test('rejects a non-official WinRT package source', () => {
  const drifted = reviewedScript().replace(
    'https://api.nuget.org/v3-flatcontainer/',
    'https://packages.example.invalid/'
  );
  assert.throws(
    () => assertPrepareScriptPins(drifted, pins),
    /official NuGet flat-container endpoint/u
  );
});

function reviewedScript() {
  return [
    "$cppWinRtVersion = '3.0.260520.1'",
    "$contractsVersion = '10.0.26100.8249'",
    "$cppWinRtHash = 'D22E2E26133D63217AE26E91B1685FB024B03A508A78AF645F8347A3126C8435'",
    "$contractsHash = '0E1C25793ED1265D49ED5846F1F9DD5A5A32FD44D3E9C16E74B7FDA018E5FBD8'",
    '$uri = "https://api.nuget.org/v3-flatcontainer/$lowerId/$Version/$lowerId.$Version.nupkg"'
  ].join('\n');
}
