import type { Rectangle } from 'electron';

export const CARD_WIDTH_DIP = 380;
export const CARD_HEIGHT_DIP = 320;
export const CARD_GAP_DIP = 10;
export const CARD_WORK_AREA_MARGIN_DIP = 8;

export function unionRectangles(rectangles: readonly Rectangle[]): Rectangle | undefined {
  if (rectangles.length === 0) return undefined;
  const left = Math.min(...rectangles.map((rect) => rect.x));
  const top = Math.min(...rectangles.map((rect) => rect.y));
  const right = Math.max(...rectangles.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rectangles.map((rect) => rect.y + rect.height));
  if (![left, top, right, bottom].every(Number.isFinite) || right <= left || bottom <= top) {
    return undefined;
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function resolveSelectionCardBounds(
  anchor: Rectangle,
  workArea: Rectangle,
  size: Readonly<{ width: number; height: number }> = {
    width: CARD_WIDTH_DIP,
    height: CARD_HEIGHT_DIP
  }
): Rectangle {
  const minX = workArea.x + CARD_WORK_AREA_MARGIN_DIP;
  const maxX = Math.max(minX, workArea.x + workArea.width - size.width - CARD_WORK_AREA_MARGIN_DIP);
  const centeredX = anchor.x + anchor.width / 2 - size.width / 2;
  const x = Math.round(Math.min(maxX, Math.max(minX, centeredX)));
  const below = anchor.y + anchor.height + CARD_GAP_DIP;
  const maximumBottom = workArea.y + workArea.height - CARD_WORK_AREA_MARGIN_DIP;
  const above = anchor.y - CARD_GAP_DIP - size.height;
  const preferredY = below + size.height <= maximumBottom ? below : above;
  const minY = workArea.y + CARD_WORK_AREA_MARGIN_DIP;
  const maxY = Math.max(minY, maximumBottom - size.height);
  const y = Math.round(Math.min(maxY, Math.max(minY, preferredY)));
  return { x, y, width: size.width, height: size.height };
}
