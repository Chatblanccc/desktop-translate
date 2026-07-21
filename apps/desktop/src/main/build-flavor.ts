/**
 * Vite replaces this identifier for bundled Desktop builds. Direct Vitest and
 * tsx execution deliberately fall back to the development/test flavor.
 */
declare const __DESKTOP_TRANSLATE_TEST_HOOKS__: boolean;

export const DESKTOP_TRANSLATE_TEST_HOOKS_ENABLED =
  typeof __DESKTOP_TRANSLATE_TEST_HOOKS__ === 'undefined'
    ? true
    : __DESKTOP_TRANSLATE_TEST_HOOKS__;
