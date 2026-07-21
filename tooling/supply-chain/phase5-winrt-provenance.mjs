import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  readJson,
  sha256File,
  sha256Tree,
  walkFiles
} from './phase5-supply-chain-lib.mjs';

export async function loadWinRtPins(workspaceRoot) {
  const pins = await readJson(join(workspaceRoot, 'tooling', 'supply-chain', 'winrt-provenance-pins.json'));
  validatePins(pins);
  return pins;
}

export async function collectWinRtProvenance(workspaceRoot, pins) {
  validatePins(pins);
  const pinManifestPath = join(workspaceRoot, 'tooling', 'supply-chain', 'winrt-provenance-pins.json');
  const prepareScriptPath = join(workspaceRoot, 'tooling', 'prepare-winrt.ps1');
  const prepareScript = await readFile(prepareScriptPath, 'utf8');
  assertPrepareScriptPins(prepareScript, pins);

  const packages = [];
  for (const pin of pins.packages) {
    const packagePath = resolveLogicalPath(workspaceRoot, pin.packagePath);
    const actualSha256 = await sha256File(packagePath);
    if (actualSha256 !== pin.sha256) {
      throw new Error(`${pin.id} ${pin.version} package SHA-256 does not match the reviewed pin`);
    }
    packages.push({
      id: pin.id,
      version: pin.version,
      purl: pin.purl,
      role: pin.role,
      packagePath: pin.packagePath,
      source: pin.source,
      sha256: actualSha256,
      license: pin.license
    });
  }

  const executablePath = resolveLogicalPath(workspaceRoot, pins.generator.executablePath);
  const executableSha256 = await sha256File(executablePath);
  if (executableSha256 !== pins.generator.executableSha256) {
    throw new Error('cppwinrt.exe SHA-256 does not match the reviewed pin');
  }

  const projectionPath = resolveLogicalPath(workspaceRoot, pins.projection.path);
  const projectionFiles = await walkFiles(projectionPath);
  const requiredHeaderPath = join(projectionPath, ...pins.projection.requiredHeader.split('/'));
  const requiredHeaderSha256 = await sha256File(requiredHeaderPath);
  const projectionSha256 = await sha256Tree(projectionPath);

  return {
    pinManifest: {
      path: 'tooling/supply-chain/winrt-provenance-pins.json',
      sha256: await sha256File(pinManifestPath)
    },
    prepareScript: {
      path: 'tooling/prepare-winrt.ps1',
      sha256: await sha256File(prepareScriptPath)
    },
    packages,
    generator: {
      packageId: pins.generator.packageId,
      executablePath: pins.generator.executablePath,
      executableSha256
    },
    projection: {
      path: pins.projection.path,
      classification: 'build-only',
      treeHashAlgorithm: pins.projection.treeHashAlgorithm,
      treeHashDefinition: pins.projection.treeHashDefinition,
      sha256: projectionSha256,
      fileCount: projectionFiles.length,
      requiredHeader: pins.projection.requiredHeader,
      requiredHeaderSha256,
      inputPackages: packages.map((item) => `${item.id}@${item.version}`)
    }
  };
}

export function assertPrepareScriptPins(prepareScript, pins) {
  for (const pin of pins.packages) {
    assertPowerShellAssignment(prepareScript, pin.prepareScript.versionVariable, pin.version);
    assertPowerShellAssignment(prepareScript, pin.prepareScript.hashVariable, pin.sha256.toUpperCase());
  }
  if (!prepareScript.includes('https://api.nuget.org/v3-flatcontainer/')) {
    throw new Error('prepare-winrt.ps1 must download reviewed inputs from the official NuGet flat-container endpoint');
  }
}

function assertPowerShellAssignment(script, variable, expected) {
  const escapedValue = expected.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const pattern = new RegExp(`\\$${variable}\\s*=\\s*'${escapedValue}'`, 'u');
  if (!pattern.test(script)) {
    throw new Error(`prepare-winrt.ps1 does not pin $${variable} to '${expected}'`);
  }
}

function resolveLogicalPath(workspaceRoot, logicalPath) {
  if (typeof logicalPath !== 'string' || logicalPath.length === 0 || logicalPath.includes('\\') || logicalPath.split('/').includes('..')) {
    throw new Error(`Invalid WinRT provenance path: ${JSON.stringify(logicalPath)}`);
  }
  return join(workspaceRoot, ...logicalPath.split('/'));
}

function validatePins(pins) {
  if (pins?.schemaVersion !== 1 || pins.officialNugetBaseUrl !== 'https://api.nuget.org/v3-flatcontainer') {
    throw new Error('WinRT provenance pin manifest is invalid');
  }
  if (!Array.isArray(pins.packages) || pins.packages.length !== 2) {
    throw new Error('WinRT provenance must contain exactly the reviewed CppWinRT and Windows SDK Contracts packages');
  }
  const expectedIds = new Set(['Microsoft.Windows.CppWinRT', 'Microsoft.Windows.SDK.Contracts']);
  for (const pin of pins.packages) {
    if (!expectedIds.delete(pin.id)) throw new Error(`Unexpected WinRT provenance package: ${pin.id}`);
    if (!/^[a-f0-9]{64}$/u.test(pin.sha256) || !pin.source.startsWith(`${pins.officialNugetBaseUrl}/`)) {
      throw new Error(`Invalid source or SHA-256 pin for ${pin.id}`);
    }
    if (pin.purl !== `pkg:nuget/${pin.id}@${pin.version}`) throw new Error(`Invalid purl for ${pin.id}`);
    if (!pin.license || typeof pin.license.requiresAcceptance !== 'boolean') throw new Error(`Invalid license record for ${pin.id}`);
  }
  if (expectedIds.size !== 0 || !/^[a-f0-9]{64}$/u.test(pins.generator?.executableSha256 ?? '')) {
    throw new Error('WinRT provenance generator pin is invalid');
  }
  if (
    pins.projection?.treeHashAlgorithm !== 'sha256-tree-v1' ||
    typeof pins.projection.treeHashDefinition !== 'string' ||
    pins.projection.treeHashDefinition.length === 0 ||
    pins.projection.requiredHeader !== 'winrt/Windows.Media.Ocr.h'
  ) {
    throw new Error('WinRT projection provenance policy is invalid');
  }
}
