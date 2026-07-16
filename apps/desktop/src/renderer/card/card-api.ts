import type { SelectionCardRendererBridge } from '../../preload/card-bridge.js';

interface CardApiWindow extends Window {
  readonly desktopTranslateCard?: SelectionCardRendererBridge;
}

export function getSelectionCardApi(): SelectionCardRendererBridge {
  const api = (window as CardApiWindow).desktopTranslateCard;
  if (api === undefined) throw new Error('Selection card preload API is unavailable.');
  return api;
}
