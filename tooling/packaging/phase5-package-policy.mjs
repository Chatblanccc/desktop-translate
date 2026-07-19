export const FORBIDDEN_PRODUCTION_MARKERS = Object.freeze([
  'DESKTOP_TRANSLATE_E2E',
  '__desktopTranslateTestApi',
  'e2e-baidu-transport',
  '--fake-mode',
  'DESKTOP_TRANSLATE_E2E_NATIVE_FIXTURE'
]);

export function assertNoProductionTestMarkers(entries) {
  for (const entry of entries) {
    for (const marker of FORBIDDEN_PRODUCTION_MARKERS) {
      if (entry.content.includes(marker)) {
        throw new Error(`production main bundle/chunk contains forbidden test injection marker '${marker}': ${entry.path}`);
      }
    }
  }
}
