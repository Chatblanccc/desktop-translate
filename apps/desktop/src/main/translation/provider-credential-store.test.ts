import { describe, expect, it, vi } from 'vitest';
import type { SecretsRepository } from '@desktop-translate/storage';
import {
  ProviderCredentialStore,
  ProviderCredentialStoreError,
  isBaiduProviderCredentials,
  type AsyncSafeStoragePort
} from './provider-credential-store.js';

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((reason: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: (value) => resolvePromise?.(value),
    reject: (reason) => rejectPromise?.(reason)
  };
}

function createHarness(options: { readonly available?: boolean; readonly encrypted?: Uint8Array } = {}) {
  let stored = options.encrypted;
  const repository: SecretsRepository = {
    getEncrypted: vi.fn(async () => stored),
    setEncrypted: vi.fn(async (_key, value) => { stored = Uint8Array.from(value); }),
    replaceEncryptedIfCurrent: vi.fn(async (_key, expectedValue, replacementValue) => {
      if (
        stored === undefined ||
        !Buffer.from(stored).equals(Buffer.from(expectedValue))
      ) {
        return false;
      }
      stored = Uint8Array.from(replacementValue);
      return true;
    }),
    delete: vi.fn(async () => {
      const existed = stored !== undefined;
      stored = undefined;
      return existed;
    })
  };
  const safeStorage: AsyncSafeStoragePort = {
    isAsyncEncryptionAvailable: vi.fn(async () => options.available ?? true),
    encryptStringAsync: vi.fn(async (value) => Buffer.from(`encrypted:${value}`, 'utf8')),
    decryptStringAsync: vi.fn(async (value) => {
      const serialized = value.toString('utf8');
      if (!serialized.startsWith('encrypted:')) throw new Error('bad ciphertext');
      return { result: serialized.slice('encrypted:'.length), shouldReEncrypt: false };
    })
  };
  return {
    repository,
    safeStorage,
    getStored: () => stored === undefined ? undefined : Uint8Array.from(stored),
    store: new ProviderCredentialStore(repository, safeStorage, () => '2026-07-16T12:00:00.000Z')
  };
}

describe('ProviderCredentialStore', () => {
  it('validates credential fields without accepting whitespace or unknown keys', () => {
    expect(isBaiduProviderCredentials({ appId: 'app', secretKey: 'secret' })).toBe(true);
    expect(isBaiduProviderCredentials(null)).toBe(false);
    expect(isBaiduProviderCredentials([])).toBe(false);
    expect(isBaiduProviderCredentials({ appId: ' app', secretKey: 'secret' })).toBe(false);
    expect(isBaiduProviderCredentials({ appId: 'app\0', secretKey: 'secret' })).toBe(false);
    expect(isBaiduProviderCredentials({ appId: 'app\uD800', secretKey: 'secret' })).toBe(false);
    expect(isBaiduProviderCredentials({ appId: 'app\uDC00', secretKey: 'secret' })).toBe(false);
    expect(isBaiduProviderCredentials({ appId: 'app😀', secretKey: 'secret' })).toBe(true);
    expect(isBaiduProviderCredentials({ appId: 'app', secretKey: 'secret', raw: true })).toBe(false);
  });

  it('rejects invalid saves and returns undefined when no credential exists', async () => {
    const harness = createHarness();
    await expect(harness.store.save({ appId: '', secretKey: 'secret' })).rejects.toThrow(
      /credentials are invalid/u
    );
    await expect(harness.store.load()).resolves.toBeUndefined();
    expect(harness.repository.setEncrypted).not.toHaveBeenCalled();
  });

  it('encrypts credentials before storage and never exposes them through status', async () => {
    const harness = createHarness();
    await harness.store.save({ appId: 'phase4-app', secretKey: 'phase4-secret-sentinel' });
    expect(harness.repository.setEncrypted).toHaveBeenCalledOnce();
    expect(await harness.store.getStatus()).toBe('configured');
    expect(await harness.store.load()).toEqual({
      appId: 'phase4-app',
      secretKey: 'phase4-secret-sentinel'
    });
  });

  it('projects only the App ID and configured state for renderer display', async () => {
    const harness = createHarness();
    await expect(harness.store.getSummary()).resolves.toEqual({
      appId: '',
      secretConfigured: false
    });

    const secret = 'phase4-summary-secret-sentinel';
    await harness.store.save({ appId: 'phase4-summary-app', secretKey: secret });
    const summary = await harness.store.getSummary();

    expect(summary).toEqual({ appId: 'phase4-summary-app', secretConfigured: true });
    expect(summary).not.toHaveProperty('secretKey');
    expect(JSON.stringify(summary)).not.toContain(secret);
  });

  it('fails closed instead of exposing old credentials while a replacement is pending', async () => {
    const oldSerialized = JSON.stringify({
      version: 1,
      appId: 'old-app',
      secretKey: 'old-secret'
    });
    const newSerialized = JSON.stringify({
      version: 1,
      appId: 'new-app',
      secretKey: 'new-secret'
    });
    const harness = createHarness({
      encrypted: Buffer.from(`encrypted:${oldSerialized}`, 'utf8')
    });
    const delayedEncryption = deferred<Buffer>();
    vi.mocked(harness.safeStorage.encryptStringAsync).mockReturnValueOnce(
      delayedEncryption.promise
    );

    const replacement = harness.store.save({ appId: 'new-app', secretKey: 'new-secret' });
    await vi.waitFor(() => expect(harness.safeStorage.encryptStringAsync).toHaveBeenCalledOnce());

    await expect(harness.store.load()).rejects.toEqual(
      expect.objectContaining<Partial<ProviderCredentialStoreError>>({
        code: 'operation-superseded'
      })
    );
    await expect(harness.store.getStatus()).resolves.toBe('unavailable');
    expect(harness.repository.getEncrypted).not.toHaveBeenCalled();

    delayedEncryption.resolve(Buffer.from(`encrypted:${newSerialized}`, 'utf8'));
    await replacement;
    await expect(harness.store.load()).resolves.toEqual({
      appId: 'new-app',
      secretKey: 'new-secret'
    });
  });

  it('lets deletion supersede a hung replacement before it reaches persistent storage', async () => {
    const oldSerialized = JSON.stringify({
      version: 1,
      appId: 'old-app',
      secretKey: 'old-secret'
    });
    const harness = createHarness({
      encrypted: Buffer.from(`encrypted:${oldSerialized}`, 'utf8')
    });
    const delayedEncryption = deferred<Buffer>();
    vi.mocked(harness.safeStorage.encryptStringAsync).mockReturnValueOnce(
      delayedEncryption.promise
    );

    const replacement = harness.store.save({ appId: 'new-app', secretKey: 'new-secret' });
    const replacementFailure = replacement.catch((error: unknown) => error);
    await vi.waitFor(() => expect(harness.safeStorage.encryptStringAsync).toHaveBeenCalledOnce());

    await expect(harness.store.delete()).resolves.toBe(true);
    await expect(harness.store.getStatus()).resolves.toBe('missing');
    expect(harness.getStored()).toBeUndefined();

    delayedEncryption.reject(new Error('late replacement failed'));
    await expect(replacementFailure).resolves.toEqual(
      expect.objectContaining<Partial<ProviderCredentialStoreError>>({
        code: 'operation-superseded'
      })
    );
    expect(harness.getStored()).toBeUndefined();
  });

  it('continues the serialized write queue after a repository write rejects', async () => {
    const harness = createHarness();
    vi.mocked(harness.repository.setEncrypted).mockRejectedValueOnce(
      new Error('database write failed')
    );

    await expect(harness.store.save({ appId: 'first-app', secretKey: 'first-secret' }))
      .rejects.toThrow(/database write failed/u);
    await expect(harness.store.save({ appId: 'second-app', secretKey: 'second-secret' }))
      .resolves.toBeUndefined();
    await expect(harness.store.load()).resolves.toEqual({
      appId: 'second-app',
      secretKey: 'second-secret'
    });
  });

  it('fails closed when asynchronous encryption is unavailable', async () => {
    const harness = createHarness({ available: false });
    await expect(harness.store.save({ appId: 'app', secretKey: 'secret' })).rejects.toEqual(
      expect.objectContaining<Partial<ProviderCredentialStoreError>>({ code: 'encryption-unavailable' })
    );
    expect(await harness.store.getStatus()).toBe('unavailable');
  });

  it('turns asynchronous backend initialization rejection into unavailable status', async () => {
    const harness = createHarness();
    vi.mocked(harness.safeStorage.isAsyncEncryptionAvailable).mockRejectedValue(
      new Error('backend initialization failed')
    );
    await expect(harness.store.getStatus()).resolves.toBe('unavailable');
    await expect(harness.store.load()).rejects.toEqual(
      expect.objectContaining<Partial<ProviderCredentialStoreError>>({
        code: 'encryption-unavailable'
      })
    );
  });

  it('bounds a hung secure-storage status probe and keeps startup fail-closed', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      vi.mocked(harness.safeStorage.isAsyncEncryptionAvailable).mockReturnValue(
        new Promise<boolean>(() => undefined)
      );
      const status = harness.store.getStatus();
      await vi.advanceTimersByTimeAsync(8_000);
      await expect(status).resolves.toBe('unavailable');
      expect(harness.repository.getEncrypted).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never persists plaintext when asynchronous encryption rejects', async () => {
    const harness = createHarness();
    vi.mocked(harness.safeStorage.encryptStringAsync).mockRejectedValue(
      new Error('encryption failed')
    );
    await expect(harness.store.save({ appId: 'app', secretKey: 'secret' })).rejects.toEqual(
      expect.objectContaining<Partial<ProviderCredentialStoreError>>({
        code: 'encryption-unavailable'
      })
    );
    expect(harness.repository.setEncrypted).not.toHaveBeenCalled();
  });

  it('reports corrupted ciphertext as unavailable and supports deletion', async () => {
    const harness = createHarness({ encrypted: Buffer.from('not-encrypted', 'utf8') });
    expect(await harness.store.getStatus()).toBe('unavailable');
    await expect(harness.store.load()).rejects.toEqual(
      expect.objectContaining<Partial<ProviderCredentialStoreError>>({ code: 'credentials-corrupted' })
    );
    expect(await harness.store.delete()).toBe(true);
    expect(await harness.store.getStatus()).toBe('missing');
  });

  it('does not resurrect deleted credentials when a timed-out key rotation finishes late', async () => {
    vi.useFakeTimers();
    try {
      const serialized = JSON.stringify({ version: 1, appId: 'old-app', secretKey: 'old-secret' });
      const harness = createHarness({ encrypted: Buffer.from(`encrypted:${serialized}`, 'utf8') });
      const delayedDecrypt = deferred<{ readonly result: string; readonly shouldReEncrypt: boolean }>();
      vi.mocked(harness.safeStorage.decryptStringAsync).mockImplementationOnce(
        () => delayedDecrypt.promise
      );

      const status = harness.store.getStatus();
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.safeStorage.decryptStringAsync).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(8_000);
      await expect(status).resolves.toBe('unavailable');
      await expect(harness.store.delete()).resolves.toBe(true);

      delayedDecrypt.resolve({ result: serialized, shouldReEncrypt: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.safeStorage.decryptStringAsync).toHaveBeenCalledOnce();
      expect(harness.safeStorage.encryptStringAsync).not.toHaveBeenCalled();
      expect(harness.repository.replaceEncryptedIfCurrent).not.toHaveBeenCalled();
      expect(harness.getStored()).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not overwrite newly saved credentials when an old key rotation finishes late', async () => {
    vi.useFakeTimers();
    try {
      const serialized = JSON.stringify({ version: 1, appId: 'old-app', secretKey: 'old-secret' });
      const harness = createHarness({ encrypted: Buffer.from(`encrypted:${serialized}`, 'utf8') });
      const delayedDecrypt = deferred<{ readonly result: string; readonly shouldReEncrypt: boolean }>();
      vi.mocked(harness.safeStorage.decryptStringAsync).mockImplementationOnce(
        () => delayedDecrypt.promise
      );

      const status = harness.store.getStatus();
      await vi.advanceTimersByTimeAsync(8_000);
      await expect(status).resolves.toBe('unavailable');
      await harness.store.save({ appId: 'new-app', secretKey: 'new-secret' });

      delayedDecrypt.resolve({ result: serialized, shouldReEncrypt: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.safeStorage.decryptStringAsync).toHaveBeenCalledOnce();
      expect(harness.repository.replaceEncryptedIfCurrent).not.toHaveBeenCalled();
      await expect(harness.store.load()).resolves.toEqual({
        appId: 'new-app',
        secretKey: 'new-secret'
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('classifies a stale decrypt rejection as superseded after a newer save', async () => {
    const oldSerialized = JSON.stringify({
      version: 1,
      appId: 'old-app',
      secretKey: 'old-secret'
    });
    const harness = createHarness({
      encrypted: Buffer.from(`encrypted:${oldSerialized}`, 'utf8')
    });
    const delayedDecrypt = deferred<{ readonly result: string; readonly shouldReEncrypt: boolean }>();
    vi.mocked(harness.safeStorage.decryptStringAsync).mockImplementationOnce(
      () => delayedDecrypt.promise
    );

    const oldLoad = harness.store.load();
    const oldFailure = oldLoad.catch((error: unknown) => error);
    await vi.waitFor(() => expect(harness.safeStorage.decryptStringAsync).toHaveBeenCalledOnce());
    await harness.store.save({ appId: 'new-app', secretKey: 'new-secret' });
    delayedDecrypt.reject(new Error('old key failed'));

    await expect(oldFailure).resolves.toEqual(
      expect.objectContaining<Partial<ProviderCredentialStoreError>>({
        code: 'operation-superseded'
      })
    );
    await expect(harness.store.load()).resolves.toEqual({
      appId: 'new-app',
      secretKey: 'new-secret'
    });
  });

  it('re-encrypts a credential when the platform requests key rotation', async () => {
    const serialized = JSON.stringify({ version: 1, appId: 'app', secretKey: 'secret' });
    const harness = createHarness({ encrypted: Buffer.from(`encrypted:${serialized}`, 'utf8') });
    vi.mocked(harness.safeStorage.decryptStringAsync).mockResolvedValue({
      result: serialized,
      shouldReEncrypt: true
    });
    await expect(harness.store.load()).resolves.toEqual({ appId: 'app', secretKey: 'secret' });
    expect(harness.safeStorage.decryptStringAsync).toHaveBeenCalledTimes(2);
    expect(harness.repository.replaceEncryptedIfCurrent).toHaveBeenCalledOnce();
  });
});
