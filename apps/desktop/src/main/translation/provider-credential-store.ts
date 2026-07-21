import type { SecretsRepository } from '@desktop-translate/storage';
import type { BaiduCredentialSummary } from '@desktop-translate/contracts/ui-shell';

export type ProviderCredentialStatus = 'missing' | 'configured' | 'unavailable';

export interface BaiduProviderCredentials {
  readonly appId: string;
  readonly secretKey: string;
}

export interface AsyncSafeStoragePort {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(value: string): Promise<Buffer>;
  decryptStringAsync(value: Buffer): Promise<{
    readonly result: string;
    readonly shouldReEncrypt: boolean;
  }>;
}

export class ProviderCredentialStoreError extends Error {
  public readonly code:
    | 'encryption-unavailable'
    | 'credentials-corrupted'
    | 'operation-superseded';

  public constructor(code: ProviderCredentialStoreError['code']) {
    super(code === 'encryption-unavailable'
      ? 'Secure credential storage is unavailable'
      : code === 'credentials-corrupted'
        ? 'Stored provider credentials are invalid'
        : 'Credential operation was superseded');
    this.name = 'ProviderCredentialStoreError';
    this.code = code;
  }
}

const BAIDU_CREDENTIAL_KEY = 'translation.provider.baidu.credentials';
const CREDENTIAL_VERSION = 1;
const MAX_APP_ID_LENGTH = 128;
const MAX_SECRET_KEY_LENGTH = 512;
const CREDENTIAL_STATUS_TIMEOUT_MS = 8_000;

function hasValidUtf16AndNoNul(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit === 0) return false;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function isCredentialField(value: unknown, maximumLength: number): value is string {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= maximumLength
    && value.trim() === value
    && hasValidUtf16AndNoNul(value);
}

export function isBaiduProviderCredentials(value: unknown): value is BaiduProviderCredentials {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 2
    && isCredentialField(record.appId, MAX_APP_ID_LENGTH)
    && isCredentialField(record.secretKey, MAX_SECRET_KEY_LENGTH);
}

interface StoredCredentialEnvelope {
  readonly version: typeof CREDENTIAL_VERSION;
  readonly appId: string;
  readonly secretKey: string;
}

function parseStoredCredentials(serialized: string): BaiduProviderCredentials {
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    throw new ProviderCredentialStoreError('credentials-corrupted');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProviderCredentialStoreError('credentials-corrupted');
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 3
    || record.version !== CREDENTIAL_VERSION
    || !isCredentialField(record.appId, MAX_APP_ID_LENGTH)
    || !isCredentialField(record.secretKey, MAX_SECRET_KEY_LENGTH)
  ) {
    throw new ProviderCredentialStoreError('credentials-corrupted');
  }
  return { appId: record.appId, secretKey: record.secretKey };
}

export class ProviderCredentialStore {
  private mutationGeneration = 0;
  private readonly pendingMutationGenerations = new Set<number>();
  private writeTail: Promise<void> = Promise.resolve();

  public constructor(
    private readonly repository: SecretsRepository,
    private readonly safeStorage: AsyncSafeStoragePort,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  public async getStatus(): Promise<ProviderCredentialStatus> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const generation = this.mutationGeneration;
    try {
      return await Promise.race([
        this.readStatus(generation),
        new Promise<ProviderCredentialStatus>((resolve) => {
          timeout = setTimeout(() => resolve('unavailable'), CREDENTIAL_STATUS_TIMEOUT_MS);
        })
      ]);
    } catch {
      return 'unavailable';
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  private async readStatus(generation: number): Promise<ProviderCredentialStatus> {
    await this.requireEncryption();
    this.requireReadableGeneration(generation);
    const encrypted = await this.repository.getEncrypted(BAIDU_CREDENTIAL_KEY);
    this.requireReadableGeneration(generation);
    if (encrypted === undefined) return 'missing';
    await this.decrypt(encrypted, generation);
    return 'configured';
  }

  public async save(credentials: BaiduProviderCredentials): Promise<void> {
    if (!isBaiduProviderCredentials(credentials)) {
      throw new TypeError('Baidu provider credentials are invalid');
    }
    const generation = this.beginMutation();
    try {
      await this.requireEncryption();
      this.requireCurrentGeneration(generation);
      const envelope: StoredCredentialEnvelope = {
        version: CREDENTIAL_VERSION,
        appId: credentials.appId,
        secretKey: credentials.secretKey
      };
      const encrypted = await this.encrypt(JSON.stringify(envelope));
      this.requireCurrentGeneration(generation);
      await this.enqueueWrite(async () => {
        this.requireCurrentGeneration(generation);
        await this.repository.setEncrypted(BAIDU_CREDENTIAL_KEY, encrypted, this.now());
        this.requireCurrentGeneration(generation);
      });
    } catch (error) {
      // A newer save/delete owns the final state even if this older secure-
      // storage operation wakes up by rejecting instead of resolving.
      this.requireCurrentGeneration(generation);
      throw error;
    } finally {
      this.pendingMutationGenerations.delete(generation);
    }
  }

  public async load(): Promise<BaiduProviderCredentials | undefined> {
    const generation = this.mutationGeneration;
    try {
      await this.requireEncryption();
      this.requireReadableGeneration(generation);
      const encrypted = await this.repository.getEncrypted(BAIDU_CREDENTIAL_KEY);
      this.requireReadableGeneration(generation);
      if (encrypted === undefined) return undefined;
      return await this.decrypt(encrypted, generation);
    } catch (error) {
      // A late backend failure from an old read must not make the caller mark
      // credentials unavailable after a newer save or delete has won.
      this.requireReadableGeneration(generation);
      throw error;
    }
  }

  /**
   * Returns the only credential projection permitted to cross into the settings
   * renderer. The decrypted secret is consumed inside Main and never copied to
   * the returned object.
   */
  public async getSummary(): Promise<BaiduCredentialSummary> {
    const credentials = await this.load();
    if (credentials === undefined) return { appId: '', secretConfigured: false };
    return { appId: credentials.appId, secretConfigured: true };
  }

  public async delete(): Promise<boolean> {
    const generation = this.beginMutation();
    try {
      return await this.enqueueWrite(async () => {
        this.requireCurrentGeneration(generation);
        const deleted = await this.repository.delete(BAIDU_CREDENTIAL_KEY);
        this.requireCurrentGeneration(generation);
        return deleted;
      });
    } finally {
      this.pendingMutationGenerations.delete(generation);
    }
  }

  private async requireEncryption(): Promise<void> {
    try {
      if (await this.safeStorage.isAsyncEncryptionAvailable()) return;
    } catch {
      // The asynchronous backend can reject while it is being initialized. Treat
      // that exactly like an unavailable backend and never fall back to plaintext.
    }
    throw new ProviderCredentialStoreError('encryption-unavailable');
  }

  private async encrypt(serialized: string): Promise<Buffer> {
    try {
      return await this.safeStorage.encryptStringAsync(serialized);
    } catch {
      throw new ProviderCredentialStoreError('encryption-unavailable');
    }
  }

  private async decrypt(
    encrypted: Uint8Array,
    generation: number
  ): Promise<BaiduProviderCredentials> {
    let decrypted: { readonly result: string; readonly shouldReEncrypt: boolean };
    try {
      decrypted = await this.safeStorage.decryptStringAsync(Buffer.from(encrypted));
    } catch {
      throw new ProviderCredentialStoreError('credentials-corrupted');
    }
    this.requireReadableGeneration(generation);

    const shouldReEncrypt = decrypted.shouldReEncrypt;
    if (shouldReEncrypt) {
      // Electron 43 documents a second async decrypt after key rotation so the
      // caller receives plaintext from the newly selected backend/key.
      try {
        decrypted = await this.safeStorage.decryptStringAsync(Buffer.from(encrypted));
      } catch {
        throw new ProviderCredentialStoreError('credentials-corrupted');
      }
      this.requireReadableGeneration(generation);
    }
    const credentials = parseStoredCredentials(decrypted.result);
    if (shouldReEncrypt) {
      const replacement = await this.encrypt(decrypted.result);
      this.requireReadableGeneration(generation);
      await this.repository.replaceEncryptedIfCurrent(
        BAIDU_CREDENTIAL_KEY,
        encrypted,
        replacement,
        this.now()
      );
      this.requireReadableGeneration(generation);
    }
    this.requireReadableGeneration(generation);
    return credentials;
  }

  private beginMutation(): number {
    const generation = ++this.mutationGeneration;
    this.pendingMutationGenerations.add(generation);
    return generation;
  }

  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeTail.then(operation);
    this.writeTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private requireReadableGeneration(generation: number): void {
    this.requireCurrentGeneration(generation);
    if (this.pendingMutationGenerations.has(generation)) {
      throw new ProviderCredentialStoreError('operation-superseded');
    }
  }

  private requireCurrentGeneration(generation: number): void {
    if (generation !== this.mutationGeneration) {
      throw new ProviderCredentialStoreError('operation-superseded');
    }
  }
}
