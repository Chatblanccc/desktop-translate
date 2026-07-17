import assert from "node:assert/strict";
import test from "node:test";

import {
  BAIDU_DEFAULT_MAX_RESPONSE_BYTES,
  BAIDU_TRANSLATION_ENDPOINT,
  BaiduTranslationProvider,
  BaiduTransportError,
  FetchBaiduTransport,
  TranslationProviderError,
  createBaiduSignature,
  type BaiduTransport,
  type BaiduTransportRequest,
  type BaiduTransportResponse,
} from "../../packages/translation/src/index.ts";

const REQUEST = Object.freeze({
  requestId: "request-1",
  selectionId: "3f4d236a-9f12-4d3b-8a2b-45d3a61a7c90",
  text: "apple",
  sourceLanguage: "auto" as const,
  targetLanguage: "zh-CN",
});

class FakeTransport implements BaiduTransport {
  public request: BaiduTransportRequest | undefined;

  constructor(private readonly response: BaiduTransportResponse | Error) {}

  async send(request: BaiduTransportRequest): Promise<BaiduTransportResponse> {
    this.request = request;
    if (this.response instanceof Error) throw this.response;
    return this.response;
  }
}

function context(signal: AbortSignal = new AbortController().signal) {
  return {
    signal,
    now: () => new Date("2026-07-16T12:00:00.000Z"),
  };
}

function provider(
  response: BaiduTransportResponse | Error,
  options: { readonly maxResponseBytes?: number } = {},
) {
  const transport = new FakeTransport(response);
  return {
    transport,
    provider: new BaiduTranslationProvider({
      credentials: { appId: "2015063000000001", secretKey: "12345678" },
      transport,
      createSalt: () => "1435660288",
      ...options,
    }),
  };
}

async function expectFailure(
  promise: Promise<unknown>,
  code: TranslationProviderError["failure"]["code"],
  retryable: boolean,
): Promise<TranslationProviderError> {
  try {
    await promise;
    assert.fail("Expected translation to fail");
  } catch (error) {
    assert.ok(error instanceof TranslationProviderError);
    assert.equal(error.failure.code, code);
    assert.equal(error.failure.retryable, retryable);
    assert.equal(error.failure.providerId, "baidu");
    assert.equal("cause" in error.failure, false);
    return error;
  }
}

test("uses the documented unencoded q signing order", () => {
  assert.equal(
    createBaiduSignature(
      { appId: "2015063000000001", secretKey: "12345678" },
      "apple",
      "1435660288",
    ),
    "f89f9594663708c1605f3d736d01d2d4",
  );
});

test("posts only translation and authentication fields and normalizes a successful response", async () => {
  const { provider: adapter, transport } = provider({
    status: 200,
    body: JSON.stringify({
      from: "en",
      to: "zh",
      trans_result: [{ src: "apple", dst: "苹果" }],
    }),
  });

  const result = await adapter.translate(REQUEST, context());
  assert.deepEqual(result, {
    requestId: REQUEST.requestId,
    selectionId: REQUEST.selectionId,
    originalText: "apple",
    translatedText: "苹果",
    detectedSourceLanguage: "en",
    targetLanguage: "zh-CN",
    attribution: { providerId: "baidu", providerDisplayName: "百度翻译" },
    receivedAt: "2026-07-16T12:00:00.000Z",
    fromCache: false,
  });

  assert.equal(transport.request?.url, BAIDU_TRANSLATION_ENDPOINT);
  assert.equal(transport.request?.method, "POST");
  assert.equal(transport.request?.timeoutMs, 8_000);
  assert.equal(transport.request?.maxResponseBytes, 256 * 1024);
  const params = new URLSearchParams(transport.request?.body);
  assert.deepEqual([...params.keys()].sort(), ["appid", "from", "q", "salt", "sign", "to"]);
  assert.equal(params.get("q"), "apple");
  assert.equal(params.get("from"), "auto");
  assert.equal(params.get("to"), "zh");
  assert.equal(params.get("appid"), "2015063000000001");
  assert.equal(params.get("salt"), "1435660288");
  assert.equal(params.get("sign"), "f89f9594663708c1605f3d736d01d2d4");
  assert.equal(transport.request?.body.includes("12345678"), false);
});

test("maps missing credentials, unsupported languages, and UTF-8 byte overflow before transport", async () => {
  const transport = new FakeTransport({ status: 200, body: "{}" });
  const missing = new BaiduTranslationProvider({ transport });
  await expectFailure(missing.translate(REQUEST, context()), "credentials-missing", false);

  const configured = new BaiduTranslationProvider({
    credentials: { appId: "app", secretKey: "secret" },
    transport,
  });
  await expectFailure(
    configured.translate({ ...REQUEST, targetLanguage: "eo" }, context()),
    "unsupported-language",
    false,
  );
  await expectFailure(
    configured.translate({ ...REQUEST, text: "汉".repeat(2_001) }, context()),
    "invalid-request",
    false,
  );
  assert.equal(transport.request, undefined);
});

test("maps documented provider failures to stable sanitized failures", async () => {
  const cases = [
    ["52001", "provider-unavailable", true],
    ["52003", "authentication-failed", false],
    ["54000", "invalid-request", false],
    ["54001", "authentication-failed", false],
    ["54003", "rate-limited", true],
    ["54004", "quota-exceeded", false],
    ["58001", "unsupported-language", false],
    ["58002", "provider-unavailable", false],
    ["99999", "unknown", false],
  ] as const;

  for (const [providerCode, failureCode, retryable] of cases) {
    const { provider: adapter } = provider({
      status: 200,
      body: JSON.stringify({ error_code: providerCode, error_msg: "must-not-cross-boundary" }),
    });
    const error = await expectFailure(adapter.translate(REQUEST, context()), failureCode, retryable);
    assert.equal(error.failure.message.includes("must-not-cross-boundary"), false);
  }
});

test("rejects malformed, non-UTF-sized, and cancelled responses", async () => {
  const malformed = provider({ status: 200, body: "{not-json" }).provider;
  await expectFailure(malformed.translate(REQUEST, context()), "malformed-response", false);

  const oversized = provider(
    { status: 200, body: JSON.stringify({ from: "en", to: "zh", trans_result: [] }) },
    { maxResponseBytes: 16 },
  ).provider;
  await expectFailure(oversized.translate(REQUEST, context()), "malformed-response", false);

  const controller = new AbortController();
  controller.abort();
  const cancelled = provider({ status: 200, body: "{}" }).provider;
  await expectFailure(cancelled.translate(REQUEST, context(controller.signal)), "cancelled", false);
});

test("rejects successful HTTP responses that omit required translation fields", async () => {
  const malformedBodies = [
    {},
    { from: "en", to: "zh" },
    { from: "en", trans_result: [{ src: "apple", dst: "result" }] },
    { to: "zh", trans_result: [{ src: "apple", dst: "result" }] },
    { from: "en", to: "zh", trans_result: [] },
    { from: "en", to: "zh", trans_result: [{ dst: "result" }] },
    { from: "en", to: "zh", trans_result: [{ src: "apple" }] },
  ] as const;

  for (const body of malformedBodies) {
    const adapter = provider({ status: 200, body: JSON.stringify(body) }).provider;
    await expectFailure(adapter.translate(REQUEST, context()), "malformed-response", false);
  }
});

test("rejects response languages that do not match the request or adapter vocabulary", async () => {
  const wrongTarget = provider({
    status: 200,
    body: JSON.stringify({
      from: "en",
      to: "jp",
      trans_result: [{ src: "apple", dst: "wrong target" }],
    }),
  }).provider;
  await expectFailure(wrongTarget.translate(REQUEST, context()), "malformed-response", false);

  const unknownDetectedSource = provider({
    status: 200,
    body: JSON.stringify({
      from: "xx",
      to: "zh",
      trans_result: [{ src: "apple", dst: "result" }],
    }),
  }).provider;
  await expectFailure(unknownDetectedSource.translate(REQUEST, context()), "malformed-response", false);
});

test("maps transport and HTTP failures without retaining response bodies", async () => {
  const network = provider(new BaiduTransportError("network", "secret raw body")).provider;
  const networkFailure = await expectFailure(
    network.translate(REQUEST, context()),
    "network-unavailable",
    true,
  );
  assert.equal(networkFailure.failure.message.includes("secret raw body"), false);

  const rateLimited = provider({ status: 429, body: "secret raw body", retryAfterMs: 2_000 }).provider;
  const rateFailure = await expectFailure(
    rateLimited.translate(REQUEST, context()),
    "rate-limited",
    true,
  );
  assert.equal(rateFailure.failure.retryAfterMs, 2_000);
});

test("maps every HTTP 5xx response to a retryable sanitized provider failure", async () => {
  for (const status of [500, 502, 503, 599]) {
    const retryAfterMs = status === 503 ? 4_000 : undefined;
    const adapter = provider({
      status,
      body: `untrusted-body-${status}`,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    }).provider;
    const error = await expectFailure(
      adapter.translate(REQUEST, context()),
      "provider-unavailable",
      true,
    );
    assert.equal(error.failure.message.includes(`untrusted-body-${status}`), false);
    assert.equal(error.failure.retryAfterMs, retryAfterMs);
  }
});

test("maps Phase 4 en, ja, and ko targets to Baidu codes and preserves app language ids", async () => {
  const cases = [
    ["en", "en"],
    ["ja", "jp"],
    ["ko", "kor"],
  ] as const;

  for (const [targetLanguage, baiduTarget] of cases) {
    const { provider: adapter, transport } = provider({
      status: 200,
      body: JSON.stringify({
        from: "zh",
        to: baiduTarget,
        trans_result: [{ src: "text", dst: `translated-${targetLanguage}` }],
      }),
    });
    const result = await adapter.translate(
      { ...REQUEST, text: "text", targetLanguage },
      context(),
    );

    assert.equal(new URLSearchParams(transport.request?.body).get("to"), baiduTarget);
    assert.equal(result.targetLanguage, targetLanguage);
    assert.equal(result.detectedSourceLanguage, "zh-CN");
  }
});

test("does not trust provider-forged request metadata, time, attribution, or cache state", async () => {
  const adapter = provider({
    status: 200,
    body: JSON.stringify({
      from: "en",
      to: "zh",
      trans_result: [{ src: "forged source", dst: "trusted translation only" }],
      requestId: "provider-request",
      selectionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      originalText: "provider text",
      targetLanguage: "ko",
      receivedAt: "1999-01-01T00:00:00.000Z",
      attribution: {
        providerId: "attacker",
        providerDisplayName: "Attacker",
      },
      fromCache: true,
    }),
  }).provider;

  const result = await adapter.translate(REQUEST, context());
  assert.equal(result.requestId, REQUEST.requestId);
  assert.equal(result.selectionId, REQUEST.selectionId);
  assert.equal(result.originalText, REQUEST.text);
  assert.equal(result.targetLanguage, REQUEST.targetLanguage);
  assert.equal(result.receivedAt, "2026-07-16T12:00:00.000Z");
  assert.deepEqual(result.attribution, {
    providerId: "baidu",
    providerDisplayName: "百度翻译",
  });
  assert.equal(result.fromCache, false);
  assert.equal(result.translatedText, "trusted translation only");
});

test("fetch transport pins HTTPS endpoint, refuses redirects, and enforces response limits", async () => {
  let seenInit: RequestInit | undefined;
  const transport = new FetchBaiduTransport({
    fetch: async (_input, init) => {
      seenInit = init;
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const controller = new AbortController();
  await transport.send({
    url: BAIDU_TRANSLATION_ENDPOINT,
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "q=apple",
    signal: controller.signal,
    timeoutMs: 1_000,
    maxResponseBytes: 64,
  });
  assert.equal(seenInit?.redirect, "error");
  assert.equal(seenInit?.referrerPolicy, "no-referrer");

  await assert.rejects(
    transport.send({
      url: "https://example.com/api/trans/vip/translate",
      method: "POST",
      headers: {},
      body: "",
      signal: controller.signal,
      timeoutMs: 1_000,
      maxResponseBytes: 64,
    }),
    (error: unknown) => error instanceof BaiduTransportError && error.kind === "network",
  );

  const tooLarge = new FetchBaiduTransport({
    fetch: async () => new Response("oversized", { headers: { "content-length": "9" } }),
  });
  await assert.rejects(
    tooLarge.send({
      url: BAIDU_TRANSLATION_ENDPOINT,
      method: "POST",
      headers: {},
      body: "",
      signal: controller.signal,
      timeoutMs: 1_000,
      maxResponseBytes: 8,
    }),
    (error: unknown) => error instanceof BaiduTransportError && error.kind === "response-too-large",
  );
});

test("fetch transport rejects every non-allowlisted endpoint component before fetch", async () => {
  let fetchCalls = 0;
  const transport = new FetchBaiduTransport({
    fetch: async () => {
      fetchCalls += 1;
      return new Response("{}");
    },
  });
  const invalidEndpoints = [
    "http://fanyi-api.baidu.com/api/trans/vip/translate",
    "https://fanyi-api.baidu.com/api/trans/vip/translate/wrong",
    "https://fanyi-api.baidu.com/api/trans/vip/translate?q=apple",
    "https://fanyi-api.baidu.com:444/api/trans/vip/translate",
    "https://user@fanyi-api.baidu.com/api/trans/vip/translate",
    "https://user:password@fanyi-api.baidu.com/api/trans/vip/translate",
  ] as const;

  for (const url of invalidEndpoints) {
    await assert.rejects(
      transport.send({
        url,
        method: "POST",
        headers: {},
        body: "",
        signal: new AbortController().signal,
        timeoutMs: 1_000,
        maxResponseBytes: 64,
      }),
      (error: unknown) => error instanceof BaiduTransportError && error.kind === "network",
    );
  }
  assert.equal(fetchCalls, 0);
});

test("fetch transport bounds a chunked body without content-length at 256 KiB", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(BAIDU_DEFAULT_MAX_RESPONSE_BYTES));
      controller.enqueue(new Uint8Array([0x61]));
    },
    cancel() {
      cancelled = true;
    },
  });
  const transport = new FetchBaiduTransport({
    fetch: async () => {
      const response = new Response(body, { status: 200 });
      assert.equal(response.headers.get("content-length"), null);
      return response;
    },
  });

  await assert.rejects(
    transport.send({
      url: BAIDU_TRANSLATION_ENDPOINT,
      method: "POST",
      headers: {},
      body: "",
      signal: new AbortController().signal,
      timeoutMs: 1_000,
      maxResponseBytes: BAIDU_DEFAULT_MAX_RESPONSE_BYTES,
    }),
    (error: unknown) =>
      error instanceof BaiduTransportError && error.kind === "response-too-large",
  );
  assert.equal(cancelled, true);
});

test("fetch transport rejects invalid UTF-8 response bytes", async () => {
  const transport = new FetchBaiduTransport({
    fetch: async () => new Response(new Uint8Array([0xc3, 0x28]), { status: 200 }),
  });

  await assert.rejects(
    transport.send({
      url: BAIDU_TRANSLATION_ENDPOINT,
      method: "POST",
      headers: {},
      body: "",
      signal: new AbortController().signal,
      timeoutMs: 1_000,
      maxResponseBytes: 64,
    }),
    (error: unknown) =>
      error instanceof BaiduTransportError && error.kind === "malformed-response",
  );
});

test("fetch redirect rejection is classified as a sanitized network failure", async () => {
  let redirectMode: RequestRedirect | undefined;
  const transport = new FetchBaiduTransport({
    fetch: async (_input, init) => {
      redirectMode = init?.redirect;
      throw new TypeError("redirect rejected by fetch");
    },
  });
  const adapter = new BaiduTranslationProvider({
    credentials: { appId: "app", secretKey: "secret" },
    transport,
    createSalt: () => "1",
  });

  const error = await expectFailure(
    adapter.translate(REQUEST, context()),
    "network-unavailable",
    true,
  );
  assert.equal(redirectMode, "error");
  assert.equal(error.failure.message.includes("redirect rejected by fetch"), false);
});

test("fetch transport propagates external cancellation and its own timeout", async () => {
  const hangingFetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  const transport = new FetchBaiduTransport({ fetch: hangingFetch });
  const request = (signal: AbortSignal, timeoutMs: number) => transport.send({
    url: BAIDU_TRANSLATION_ENDPOINT,
    method: "POST",
    headers: {},
    body: "",
    signal,
    timeoutMs,
    maxResponseBytes: 64,
  });

  const controller = new AbortController();
  const cancelled = request(controller.signal, 1_000);
  controller.abort();
  await assert.rejects(
    cancelled,
    (error: unknown) => error instanceof BaiduTransportError && error.kind === "cancelled",
  );

  await assert.rejects(
    request(new AbortController().signal, 5),
    (error: unknown) => error instanceof BaiduTransportError && error.kind === "timeout",
  );
});

test("total deadline and external cancellation settle while credentials are still pending", async () => {
  let resolveCredentials!: (value: { appId: string; secretKey: string }) => void;
  const pendingCredentials = new Promise<{ appId: string; secretKey: string }>((resolve) => {
    resolveCredentials = resolve;
  });
  const transport = new FakeTransport({
    status: 200,
    body: JSON.stringify({
      from: "en",
      to: "zh",
      trans_result: [{ src: "apple", dst: "result" }],
    }),
  });
  const timed = new BaiduTranslationProvider({
    credentials: () => pendingCredentials,
    transport,
    timeoutMs: 5,
  });
  await expectFailure(timed.translate(REQUEST, context()), "network-unavailable", true);
  assert.equal(transport.request, undefined);

  const cancelledTransport = new FakeTransport({ status: 200, body: "{}" });
  const cancelled = new BaiduTranslationProvider({
    credentials: () => pendingCredentials,
    transport: cancelledTransport,
    timeoutMs: 1_000,
  });
  const controller = new AbortController();
  const pending = cancelled.translate(REQUEST, context(controller.signal));
  controller.abort();
  await expectFailure(pending, "cancelled", false);

  // A resolver that ignores cancellation may finish later, but the aborted
  // internal signal must prevent both transport I/O and result publication.
  resolveCredentials({ appId: "late-app", secretKey: "late-secret" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(transport.request, undefined);
  assert.equal(cancelledTransport.request, undefined);
});
