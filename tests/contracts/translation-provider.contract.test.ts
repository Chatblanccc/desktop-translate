import assert from "node:assert/strict";
import test from "node:test";

import type { TranslationProvider } from "../../packages/translation/src/provider.js";
import { isProviderCompatible } from "../../packages/translation/src/provider.ts";

const provider: TranslationProvider = {
  id: "fixture",
  displayName: "Fixture",
  capabilities: {
    translation: true,
    languageDetection: true,
    dictionary: true,
    pronunciation: false,
    examples: false,
    supportedSourceLanguages: ["en", "zh"],
    supportedTargetLanguages: ["zh-CN"],
    maxTextLength: 1_000,
  },
  async translate(request, context) {
    if (context.signal.aborted) throw new Error("cancelled");
    return {
      requestId: request.requestId,
      selectionId: request.selectionId,
      originalText: request.text,
      translatedText: "架构",
      targetLanguage: request.targetLanguage,
      attribution: { providerId: this.id, providerDisplayName: this.displayName },
      receivedAt: context.now().toISOString(),
      fromCache: false,
    };
  },
};

test("provider selection honors language and text-size capabilities", () => {
  const base = {
    requestId: "translate:1",
    selectionId: "11111111-1111-4111-8111-111111111111",
    text: "architecture",
    sourceLanguage: "en",
    targetLanguage: "zh-CN",
  };
  assert.equal(isProviderCompatible(provider, base), true);
  assert.equal(isProviderCompatible(provider, { ...base, targetLanguage: "ja" }), false);
  assert.equal(isProviderCompatible(provider, { ...base, sourceLanguage: "fr" }), false);
  assert.equal(isProviderCompatible(provider, { ...base, text: "x".repeat(1_001) }), false);
});
