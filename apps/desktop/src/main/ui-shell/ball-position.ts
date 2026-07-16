import type { BallAnchor } from '@desktop-translate/contracts/ui-shell';

export const BALL_SIZE_DIP = 56;
export const BALL_MARGIN_DIP = 12;
export const DEFAULT_BALL_VERTICAL_RATIO = 0.6;

export interface RectangleLike {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DisplayLike {
  readonly id: string | number;
  readonly workArea: RectangleLike;
}

export interface BallPlacement {
  readonly anchor: BallAnchor;
  readonly bounds: RectangleLike;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

function availableTravel(length: number): number {
  return Math.max(0, length - BALL_SIZE_DIP - BALL_MARGIN_DIP * 2);
}

function findDisplay(anchor: BallAnchor | undefined, displays: readonly DisplayLike[]): DisplayLike {
  if (displays.length === 0) throw new Error('At least one display is required');
  return displays.find((display) => String(display.id) === anchor?.displayId) ?? displays[0]!;
}

export function createDefaultBallAnchor(primaryDisplay: DisplayLike): BallAnchor {
  return {
    displayId: String(primaryDisplay.id),
    edge: 'right',
    verticalRatio: DEFAULT_BALL_VERTICAL_RATIO
  };
}

export function resolveBallBounds(
  anchor: BallAnchor | undefined,
  displays: readonly DisplayLike[]
): RectangleLike {
  const display = findDisplay(anchor, displays);
  const effectiveAnchor = anchor ?? createDefaultBallAnchor(display);
  const verticalTravel = availableTravel(display.workArea.height);
  const x = effectiveAnchor.edge === 'left'
    ? display.workArea.x + BALL_MARGIN_DIP
    : display.workArea.x + display.workArea.width - BALL_MARGIN_DIP - BALL_SIZE_DIP;
  const y = display.workArea.y + BALL_MARGIN_DIP + verticalTravel * effectiveAnchor.verticalRatio;
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: BALL_SIZE_DIP,
    height: BALL_SIZE_DIP
  };
}

function squaredDistanceToRectangle(pointX: number, pointY: number, rectangle: RectangleLike): number {
  const nearestX = clamp(pointX, rectangle.x, rectangle.x + rectangle.width);
  const nearestY = clamp(pointY, rectangle.y, rectangle.y + rectangle.height);
  return (pointX - nearestX) ** 2 + (pointY - nearestY) ** 2;
}

function intersectionArea(first: RectangleLike, second: RectangleLike): number {
  const width = Math.max(
    0,
    Math.min(first.x + first.width, second.x + second.width) - Math.max(first.x, second.x)
  );
  const height = Math.max(
    0,
    Math.min(first.y + first.height, second.y + second.height) - Math.max(first.y, second.y)
  );
  return width * height;
}

export function findNearestDisplay(
  bounds: RectangleLike,
  displays: readonly DisplayLike[]
): DisplayLike {
  if (displays.length === 0) throw new Error('At least one display is required');
  const intersecting = displays.reduce(
    (best, candidate) => {
      const area = intersectionArea(bounds, candidate.workArea);
      return area > best.area ? { display: candidate, area } : best;
    },
    { display: displays[0]!, area: intersectionArea(bounds, displays[0]!.workArea) }
  );
  if (intersecting.area > 0) return intersecting.display;

  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  return displays.reduce((nearest, candidate) =>
    squaredDistanceToRectangle(centerX, centerY, candidate.workArea) <
    squaredDistanceToRectangle(centerX, centerY, nearest.workArea)
      ? candidate
      : nearest
  );
}

export function deriveBallPlacement(
  requestedBounds: RectangleLike,
  displays: readonly DisplayLike[],
  edgeSnap: boolean
): BallPlacement {
  const display = findNearestDisplay(requestedBounds, displays);
  const verticalTravel = availableTravel(display.workArea.height);
  const clampedX = clamp(
    requestedBounds.x,
    display.workArea.x + BALL_MARGIN_DIP,
    display.workArea.x + display.workArea.width - BALL_MARGIN_DIP - BALL_SIZE_DIP
  );
  const clampedY = clamp(
    requestedBounds.y,
    display.workArea.y + BALL_MARGIN_DIP,
    display.workArea.y + display.workArea.height - BALL_MARGIN_DIP - BALL_SIZE_DIP
  );
  const verticalRatio = verticalTravel === 0
    ? 0
    : (clampedY - display.workArea.y - BALL_MARGIN_DIP) / verticalTravel;
  const leftX = display.workArea.x + BALL_MARGIN_DIP;
  const rightX = display.workArea.x + display.workArea.width - BALL_MARGIN_DIP - BALL_SIZE_DIP;
  const edge = Math.abs(clampedX - leftX) <= Math.abs(clampedX - rightX) ? 'left' : 'right';
  const x = edgeSnap ? (edge === 'left' ? leftX : rightX) : clampedX;
  const anchor: BallAnchor = { displayId: String(display.id), edge, verticalRatio };

  return {
    anchor,
    bounds: { x: Math.round(x), y: Math.round(clampedY), width: BALL_SIZE_DIP, height: BALL_SIZE_DIP }
  };
}
