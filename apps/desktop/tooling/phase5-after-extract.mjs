import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, unlink } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';

const expectedDefaultAppSha256 =
  '06d4a28be095a80eff94dbd18edcfac5b5805e1b5538e0fb7cee7c7ae81db76a';

function isWithin(parent, child) {
  const value = relative(parent, child);
  return value === '' || (!value.startsWith('..') && !resolve(value).startsWith('\\'));
}

export default async function removeOfflineElectronDefaultApp(context) {
  if (process.platform !== 'win32' || context?.electronPlatformName !== 'win32') {
    throw new Error('Phase 5 afterExtract only supports the audited Windows package lane.');
  }

  const appOutDir = await realpath(context.appOutDir);
  const resourcesDir = await realpath(resolve(appOutDir, 'resources'));
  if (!isWithin(appOutDir, resourcesDir)) {
    throw new Error('Electron resources directory escaped the unpacked application root.');
  }

  const defaultAppPath = resolve(resourcesDir, 'default_app.asar');
  const info = await lstat(defaultAppPath);
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0) {
    throw new Error('Electron default_app.asar must be a non-empty regular non-symlink file.');
  }
  if ((await realpath(dirname(defaultAppPath))) !== resourcesDir) {
    throw new Error('Electron default_app.asar parent identity changed during validation.');
  }

  const bytes = await readFile(defaultAppPath);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== expectedDefaultAppSha256) {
    throw new Error(
      `Electron default_app.asar does not match the audited Electron 43.1.1 payload: ${digest}`
    );
  }

  await unlink(defaultAppPath);
  try {
    await lstat(defaultAppPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  throw new Error('Electron default_app.asar remained after the audited afterExtract cleanup.');
}
