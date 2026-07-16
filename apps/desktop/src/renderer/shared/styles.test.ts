import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sharedStyles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
const ballStyles = readFileSync(new URL('../ball/styles.css', import.meta.url), 'utf8');
const settingsStyles = readFileSync(new URL('../settings/styles.css', import.meta.url), 'utf8');

describe('Phase 2 renderer styles', () => {
  it('provides a stable accent fallback and exposes hover and focus states', () => {
    expect(sharedStyles).toMatch(/--color-accent:\s*#005fb8;/u);
    expect(sharedStyles).toMatch(/--color-accent-text:\s*#ffffff;/u);
    expect(ballStyles).toMatch(/\.ball-button:hover/u);
    expect(ballStyles).toMatch(/\.ball-button:focus-visible/u);
    expect(settingsStyles).toMatch(/label\.setting-row:hover/u);
  });

  it('provides forced-colors and reduced-motion fallbacks', () => {
    expect(sharedStyles).toMatch(/@media\s*\(forced-colors:\s*active\)/u);
    expect(sharedStyles).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/u);
    expect(ballStyles).toMatch(/@media\s*\(forced-colors:\s*active\)/u);
    expect(settingsStyles).toMatch(/@media\s*\(forced-colors:\s*active\)/u);
  });
});
