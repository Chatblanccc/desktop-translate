import { describe, expect, it } from 'vitest';
import {
  resolveSelectionCardBounds,
  unionRectangles
} from './selection-card-position.js';

describe('selection card positioning', () => {
  it('unions multi-line selection rectangles', () => {
    expect(unionRectangles([
      { x: -900, y: 100, width: 200, height: 24 },
      { x: -880, y: 132, width: 300, height: 24 }
    ])).toEqual({ x: -900, y: 100, width: 320, height: 56 });
    expect(unionRectangles([])).toBeUndefined();
    expect(unionRectangles([{ x: 0, y: 0, width: 0, height: 10 }])).toBeUndefined();
  });

  it('places below when possible and flips above at the bottom edge', () => {
    const workArea = { x: 0, y: 0, width: 1920, height: 1040 };
    expect(resolveSelectionCardBounds(
      { x: 700, y: 300, width: 200, height: 30 },
      workArea
    )).toEqual({ x: 650, y: 340, width: 300, height: 160 });
    expect(resolveSelectionCardBounds(
      { x: 700, y: 990, width: 200, height: 30 },
      workArea
    )).toEqual({ x: 650, y: 820, width: 300, height: 160 });
  });

  it('clamps inside negative-coordinate and narrow work areas', () => {
    expect(resolveSelectionCardBounds(
      { x: -1275, y: 20, width: 20, height: 20 },
      { x: -1280, y: 0, width: 1280, height: 984 }
    )).toEqual({ x: -1272, y: 50, width: 300, height: 160 });
    expect(resolveSelectionCardBounds(
      { x: 10, y: 10, width: 10, height: 10 },
      { x: 0, y: 0, width: 300, height: 180 },
      { width: 380, height: 220 }
    )).toEqual({ x: 8, y: 8, width: 380, height: 220 });
  });
});
