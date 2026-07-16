import { describe, expect, it } from 'vitest';
import {
  BALL_MARGIN_DIP,
  BALL_SIZE_DIP,
  createDefaultBallAnchor,
  deriveBallPlacement,
  resolveBallBounds,
  type DisplayLike
} from './ball-position.js';

const PRIMARY: DisplayLike = {
  id: 1,
  workArea: { x: 0, y: 0, width: 1920, height: 1032 }
};

describe('ball position', () => {
  it('places the default ball on the primary right edge at 60 percent height', () => {
    const bounds = resolveBallBounds(createDefaultBallAnchor(PRIMARY), [PRIMARY]);
    expect(bounds.x).toBe(1920 - BALL_MARGIN_DIP - BALL_SIZE_DIP);
    expect(bounds.y).toBe(
      Math.round(BALL_MARGIN_DIP + (1032 - BALL_SIZE_DIP - BALL_MARGIN_DIP * 2) * 0.6)
    );
  });

  it('snaps to the closest edge and clamps outside coordinates', () => {
    const placement = deriveBallPlacement(
      { x: -500, y: 5_000, width: BALL_SIZE_DIP, height: BALL_SIZE_DIP },
      [PRIMARY],
      true
    );
    expect(placement.anchor.edge).toBe('left');
    expect(placement.bounds).toEqual({
      x: BALL_MARGIN_DIP,
      y: 1032 - BALL_MARGIN_DIP - BALL_SIZE_DIP,
      width: BALL_SIZE_DIP,
      height: BALL_SIZE_DIP
    });
  });

  it('selects a negative-coordinate display and restores it by id', () => {
    const left: DisplayLike = {
      id: 'left',
      workArea: { x: -1600, y: -200, width: 1600, height: 900 }
    };
    const placement = deriveBallPlacement(
      { x: -1500, y: 200, width: BALL_SIZE_DIP, height: BALL_SIZE_DIP },
      [PRIMARY, left],
      true
    );
    expect(placement.anchor.displayId).toBe('left');
    expect(resolveBallBounds(placement.anchor, [PRIMARY, left])).toEqual(placement.bounds);
  });

  it('selects the display with the largest intersection while crossing a boundary', () => {
    const right: DisplayLike = {
      id: 'right',
      workArea: { x: 1920, y: 0, width: 1600, height: 900 }
    };
    const placement = deriveBallPlacement(
      { x: 1900, y: 300, width: 56, height: 56 },
      [PRIMARY, right],
      false
    );

    expect(placement.anchor.displayId).toBe('right');
    expect(placement.bounds.x).toBe(1920 + BALL_MARGIN_DIP);
  });

  it('keeps the current free position while edge snapping is disabled', () => {
    const placement = deriveBallPlacement(
      { x: 800, y: 400, width: BALL_SIZE_DIP, height: BALL_SIZE_DIP },
      [PRIMARY],
      false
    );
    expect(placement.anchor).toEqual({
      displayId: '1',
      edge: 'left',
      verticalRatio: expect.any(Number)
    });
    expect(placement.bounds.x).toBe(800);
  });

  it('falls back to the primary display when a saved display is removed', () => {
    const bounds = resolveBallBounds(
      { displayId: 'removed', edge: 'left', verticalRatio: 0.25 },
      [PRIMARY]
    );
    expect(bounds.x).toBe(BALL_MARGIN_DIP);
    expect(bounds.y).toBeGreaterThanOrEqual(BALL_MARGIN_DIP);
  });

  it.each([
    ['100% / bottom taskbar', 1, { x: 0, y: 0, width: 1920, height: 1032 }],
    ['150% / top taskbar', 1.5, { x: 0, y: 32, width: 1280, height: 688 }],
    ['200% / left taskbar', 2, { x: 40, y: 0, width: 920, height: 540 }],
    ['150% / right taskbar on negative display', 1.5, { x: -1280, y: -160, width: 1240, height: 720 }]
  ])('keeps the ball inside the current work area for %s', (_label, scaleFactor, workArea) => {
    const display = { id: `dpi-${scaleFactor}`, scaleFactor, workArea };
    const placement = deriveBallPlacement(
      { x: workArea.x - 5_000, y: workArea.y + 5_000, width: BALL_SIZE_DIP, height: BALL_SIZE_DIP },
      [display],
      true
    );

    expect(placement.bounds.x).toBe(workArea.x + BALL_MARGIN_DIP);
    expect(placement.bounds.y).toBe(
      workArea.y + workArea.height - BALL_MARGIN_DIP - BALL_SIZE_DIP
    );
    expect(placement.bounds.x + BALL_SIZE_DIP).toBeLessThanOrEqual(
      workArea.x + workArea.width - BALL_MARGIN_DIP
    );
    expect(placement.bounds.y + BALL_SIZE_DIP).toBeLessThanOrEqual(
      workArea.y + workArea.height - BALL_MARGIN_DIP
    );
  });
});
