import assert from "node:assert/strict";
import test from "node:test";

import {
  TranslationProviderRegistry,
  type TranslationProvider,
} from "../../packages/translation/src/index.ts";

const provider = {
  id: "fixture",
  displayName: "Fixture",
  capabilities: {
    translation: true,
    languageDetection: false,
    dictionary: false,
    pronunciation: false,
    examples: false,
    maxTextLength: 32,
  },
  translate: async () => {
    throw new Error("not used");
  },
} satisfies TranslationProvider;

test("registry preserves registration order and rejects duplicate or unsafe ids", () => {
  const registry = new TranslationProviderRegistry([provider]);
  assert.equal(registry.get("fixture"), provider);
  assert.equal(registry.require("fixture"), provider);
  assert.deepEqual(registry.list(), [provider]);
  assert.throws(() => registry.register(provider), /already registered/);
  assert.throws(() => registry.get("../fixture"), /lowercase slug/);
  assert.throws(() => registry.require("missing"), /not registered/);
});
