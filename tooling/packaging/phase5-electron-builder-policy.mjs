import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function assertElectronBuilderSigningPolicy(configuration) {
  const normalized = configuration.replaceAll('\r\n', '\n');
  const winHeaders = normalized.match(/^win:[ \t]*$/gmu) ?? [];
  if (winHeaders.length !== 1) throw new Error(`electron-builder config must contain exactly one top-level win block, got ${winHeaders.length}`);
  const winMatch = normalized.match(/^win:\n(?<body>(?:^[ \t].*(?:\n|$))*)/mu);
  if (!winMatch?.groups?.body) throw new Error('electron-builder config is missing the top-level win block');
  const signExtsHeaders = winMatch.groups.body.match(/^  signExts:[ \t]*$/gmu) ?? [];
  if (signExtsHeaders.length === 0) throw new Error('electron-builder win.signExts is required');
  if (signExtsHeaders.length !== 1) throw new Error(`electron-builder win block must contain exactly one signExts key, got ${signExtsHeaders.length}`);
  const signExtsMatch = winMatch.groups.body.match(/^  signExts:\n(?<items>(?:^    - .+(?:\n|$))*)/mu);
  if (!signExtsMatch?.groups?.items) throw new Error('electron-builder win.signExts is required');
  const items = signExtsMatch.groups.items
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice('    - '.length).trim());
  if (JSON.stringify(items) !== JSON.stringify(['selection-host.exe'])) {
    throw new Error(`electron-builder win.signExts must contain exactly selection-host.exe, got [${items.join(', ')}]`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const index = process.argv.indexOf('--config');
  if (index < 0 || !process.argv[index + 1] || process.argv.length !== 4) {
    throw new Error('Usage: node phase5-electron-builder-policy.mjs --config <electron-builder.yml>');
  }
  const path = resolve(process.argv[index + 1]);
  assertElectronBuilderSigningPolicy(await readFile(path, 'utf8'));
  console.log(`[phase5:package] electron-builder exact Host signExts policy PASS: ${path}`);
}
