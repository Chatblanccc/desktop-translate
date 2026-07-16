import type { SelectionResult } from "../../packages/contracts/src/native-ipc.js";
import type { TranslationResult } from "../../packages/contracts/src/translation.js";

export const selectionFixture: SelectionResult = {
  selectionId: "11111111-1111-4111-8111-111111111111",
  source: "uia",
  text: "architecture",
  ranges: [{ start: 0, end: 12, text: "architecture" }],
  confidence: 1,
  physicalRects: [{ x: -320, y: 240, width: 96, height: 22 }],
  releasePoint: { x: -224, y: 262 },
  monitor: {
    id: "DISPLAY2",
    handle: "0x1234",
    bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
    workArea: { x: -1920, y: 0, width: 1920, height: 1040 },
    dpiX: 144,
    dpiY: 144,
    scaleFactor: 1.5,
  },
  target: { pid: "4242", hwnd: "0xABCDEF", processName: "chrome.exe" },
  coordinateSpace: "physical-px",
  timestamp: "2026-07-16T08:00:00.000Z",
};

export const translationFixture: TranslationResult = {
  requestId: "translate:1",
  selectionId: selectionFixture.selectionId,
  originalText: selectionFixture.text,
  translatedText: "架构",
  detectedSourceLanguage: "en",
  targetLanguage: "zh-CN",
  dictionary: [{ partOfSpeech: "noun", definitions: ["架构", "建筑"] }],
  attribution: { providerId: "fixture", providerDisplayName: "Fixture" },
  receivedAt: "2026-07-16T08:00:00.100Z",
  fromCache: false,
};
