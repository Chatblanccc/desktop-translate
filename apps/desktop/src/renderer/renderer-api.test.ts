// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest';
import { getBallRendererApi } from './ball/ball-api.js';
import { getSettingsRendererApi } from './settings/settings-api.js';
import { getSelectionCardApi } from './card/card-api.js';
import type { BallRendererApi, SettingsRendererApi } from './shared/shell-api.js';
import type { SelectionCardRendererBridge } from '../preload/card-bridge.js';

const ballApi = Object.freeze({ role: 'ball' }) as unknown as BallRendererApi;
const settingsApi = Object.freeze({ role: 'settings' }) as unknown as SettingsRendererApi;
const cardApi = Object.freeze({ role: 'card' }) as unknown as SelectionCardRendererBridge;

afterEach(() => {
  delete (window as Window & { desktopTranslateBall?: BallRendererApi }).desktopTranslateBall;
  delete (window as Window & { desktopTranslateSettings?: SettingsRendererApi })
    .desktopTranslateSettings;
  delete (window as Window & { desktopTranslateCard?: SelectionCardRendererBridge })
    .desktopTranslateCard;
});

describe('renderer role API lookup', () => {
  it('returns only the Ball preload bridge and fails closed when it is absent', () => {
    expect(() => getBallRendererApi()).toThrow(/unavailable/u);
    Object.defineProperty(window, 'desktopTranslateBall', {
      configurable: true,
      value: ballApi
    });
    expect(getBallRendererApi()).toBe(ballApi);
  });

  it('returns only the Settings preload bridge and fails closed when it is absent', () => {
    expect(() => getSettingsRendererApi()).toThrow(/unavailable/u);
    Object.defineProperty(window, 'desktopTranslateSettings', {
      configurable: true,
      value: settingsApi
    });
    expect(getSettingsRendererApi()).toBe(settingsApi);
  });

  it('returns only the Card preload bridge and fails closed when it is absent', () => {
    expect(() => getSelectionCardApi()).toThrow(/unavailable/u);
    Object.defineProperty(window, 'desktopTranslateCard', {
      configurable: true,
      value: cardApi
    });
    expect(getSelectionCardApi()).toBe(cardApi);
  });
});
