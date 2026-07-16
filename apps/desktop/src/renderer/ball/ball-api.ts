import type { BallRendererApi } from '../shared/shell-api.js';

interface BallApiWindow extends Window {
  readonly desktopTranslateBall?: BallRendererApi;
}

export function getBallRendererApi(): BallRendererApi {
  const api = (window as BallApiWindow).desktopTranslateBall;
  if (api === undefined) {
    throw new Error('Ball preload API is unavailable.');
  }

  return api;
}
