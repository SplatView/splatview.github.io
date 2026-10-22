import { describe, expect, it } from 'vitest';
import { intersectTutorialRect, mergeTutorialRects, positionTutorialCard, tutorialCardWidth, tutorialTargetBounds,
  tutorialViewportBounds, type TutorialRect } from '../src/ui/tutorialLayout';

const viewport = { left: 0, top: 0, width: 1000, height: 800 };
const rect = (left: number, top: number, right: number, bottom: number): TutorialRect => ({ left, top, right, bottom });

describe('desktop tutorial geometry in the browser viewport', () => {
  it('joins adjacent controls while retaining separate wrapped rows and distant controls', () => {
    expect(mergeTutorialRects([rect(12, 12, 48, 48), rect(48, 12, 84, 48), rect(90, 12, 126, 48),
      rect(12, 54, 48, 90), rect(150, 12, 186, 48)])).toEqual([
      rect(12, 12, 126, 48), rect(150, 12, 186, 48), rect(12, 54, 48, 90),
    ]);
  });
  it('unifies overlapping anchors without accepting empty or nonfinite geometry', () => {
    expect(mergeTutorialRects([rect(80, 10, 100, 30), rect(10, 10, 40, 30), rect(40, 10, 80, 30),
      rect(0, 0, 0, 10), rect(NaN, 0, 1, 1)])).toEqual([rect(10, 10, 100, 30)]);
    expect(tutorialTargetBounds([])).toBeNull();
  });
  it('clips outlines at their scroll owner instead of outlining hidden controls', () => {
    expect(intersectTutorialRect(rect(700, 100, 980, 200), rect(688, 150, 988, 300))).toEqual(rect(700, 150, 980, 200));
    expect(intersectTutorialRect(rect(700, 10, 980, 100), rect(688, 150, 988, 300))).toBeNull();
  });
  it('uses the native below-first toolbar and left-first Tools placements', () => {
    expect(positionTutorialCard([rect(12, 12, 90, 48)], { width: 300, height: 180 }, viewport, false)).toEqual({ left: 12, top: 60 });
    expect(positionTutorialCard([rect(720, 280, 960, 310)], { width: 300, height: 180 }, viewport, true)).toEqual({ left: 376, top: 280 });
  });
  it('tries the next clear candidate when a clamped card would overlap its target', () => {
    expect(positionTutorialCard([rect(400, 600, 500, 650)], { width: 300, height: 180 }, { ...viewport, height: 700 }, false)).toEqual({ left: 512, top: 508 });
    expect(positionTutorialCard([rect(88, 200, 100, 300)], { width: 300, height: 180 }, viewport, true)).toEqual({ left: 88, top: 312 });
  });
  it('places the card above a toolbar target when right and below are blocked', () => {
    expect(positionTutorialCard([rect(700, 600, 950, 650)], { width: 300, height: 180 }, { ...viewport, height: 700 }, false)).toEqual({ left: 688, top: 408 });
  });
  it('keeps controls within compact viewports even when every candidate overlaps', () => {
    const display = { left: 0, top: 0, width: 360, height: 240 };
    expect(positionTutorialCard([rect(0, 0, 360, 240)], { width: 300, height: 180 }, display, false)).toEqual({ left: 12, top: 48 });
    expect(tutorialCardWidth([], { ...display, width: 180 }, false, 1.25)).toBe(156);
    expect(tutorialViewportBounds({ left: 3, top: 5, width: 10, height: 8 })).toEqual(rect(7.5, 8.5, 8.5, 9.5));
  });
  it('reduces the Tools card only when at least the native 200-pixel column fits', () => {
    expect(tutorialCardWidth([rect(320, 150, 600, 200)], { ...viewport, width: 620 }, true)).toBe(284);
    expect(tutorialCardWidth([rect(90, 150, 300, 200)], { ...viewport, width: 420 }, true, 1.25)).toBe(375);
  });
  it('honors visual-viewport offsets and gives unavailable targets a bounded position', () => {
    const display = { left: 50, top: 100, width: 400, height: 250 };
    expect(positionTutorialCard([], { width: 300, height: 180 }, display, false)).toEqual({ left: 62, top: 112 });
    expect(positionTutorialCard([], { width: 300, height: 180 }, viewport, false, 144)).toEqual({ left: 12, top: 156 });
    expect(positionTutorialCard([rect(420, 300, 440, 330)], { width: 300, height: 180 }, display, false)).toEqual({ left: 138, top: 112 });
  });
});
