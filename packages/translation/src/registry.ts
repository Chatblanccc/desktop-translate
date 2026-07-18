import type { TranslationProvider } from "./provider.js";

function assertProviderId(id: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(id)) {
    throw new TypeError("Translation provider id must be a lowercase slug");
  }
}

/** Main-process registry with deterministic ordering and duplicate protection. */
export class TranslationProviderRegistry {
  readonly #providers = new Map<string, TranslationProvider>();

  constructor(providers: readonly TranslationProvider[] = []) {
    for (const provider of providers) this.register(provider);
  }

  register(provider: TranslationProvider): void {
    assertProviderId(provider.id);
    if (this.#providers.has(provider.id)) {
      throw new Error(`Translation provider is already registered: ${provider.id}`);
    }
    this.#providers.set(provider.id, provider);
  }

  get(id: string): TranslationProvider | undefined {
    assertProviderId(id);
    return this.#providers.get(id);
  }

  require(id: string): TranslationProvider {
    const provider = this.get(id);
    if (provider === undefined) throw new Error(`Translation provider is not registered: ${id}`);
    return provider;
  }

  list(): readonly TranslationProvider[] {
    return [...this.#providers.values()];
  }
}
