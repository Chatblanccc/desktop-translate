import type { SettingsRendererApi } from '../shared/shell-api.js';

interface SettingsApiWindow extends Window {
  readonly desktopTranslateSettings?: SettingsRendererApi;
}

export function getSettingsRendererApi(): SettingsRendererApi {
  const api = (window as SettingsApiWindow).desktopTranslateSettings;
  if (api === undefined) {
    throw new Error('Settings preload API is unavailable.');
  }

  return api;
}
