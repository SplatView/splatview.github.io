import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setApp, switchToolsMode, useApp } from '../src/app/store';
import type { NativeSummary } from '../src/document/types';
import { desktopIcons } from '../src/generated/desktop';
import { AlignmentActionMenu, AlignmentControls, AlignmentOverlay, alignmentControlsEnabled, alignmentPlaneControlsEnabled, handleAlignmentDistanceKey, handleAlignmentKey,
  projectAlignmentPoint, projectAlignmentSegment, projectAlignmentNormal, placeAlignmentPlanePopup } from '../src/ui/AlignmentControls';

vi.mock('../src/app/store', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/app/store')>();
  return { ...actual, useApp: Object.assign(() => actual.useApp.getState(), actual.useApp) };
});
const initial = useApp.getState(), scene = { current: null };
const summary: NativeSummary = { ok: true, duplicateRange: null, loaded: true, count: 3, sourceCount: 3, shDegree: 0, format: 'ply', kind: 0, visible: 3,
  selected: 1, pending: false, selectionDraft: false, canUndo: false, canRedo: false, revision: 0, contentRevision: 0,
  transaction: false, sceneChanged: false, progress: 0, center: [0, 0, 0], radius: 1, yUp: true,
  camera: [0, 0, 0, .35, .18, 3, 1, 45, 0, 0, 1], memoryBytes: 0, selectionMapId: null, pendingSelectionMapId: null,
  selectionMapBytes: 0, selectionMapRetainedIds: [], floor: null, filter: null, transformSession: null, opacitySession: null,
  alignment: { version: 2, branchId: 0, frame: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], canReset: false, retainedBranchIds: [0] } };
function controller() {
  return { alignmentControlsEnabled: true, alignmentPlaneControlsEnabled: false, camera: undefined, startCenterAlignment: vi.fn().mockResolvedValue(true),
    floorDetectionEnabled: false, floorCandidateReady: false, startFloorDetection: vi.fn().mockResolvedValue(true),
    startScaleAlignment: vi.fn().mockResolvedValue(true), setAlignmentTargetDistance: vi.fn(),
    startPlaneAlignment: vi.fn().mockResolvedValue(true), setAlignmentFlip: vi.fn(),
    confirmAlignment: vi.fn().mockResolvedValue(true), cancelAlignment: vi.fn(), clearAlignmentPoint: vi.fn(), resetAlignment: vi.fn().mockResolvedValue(true) };
}
const openingButton = (markup: string, label: string) => markup.match(new RegExp(`<button\\b[^>]*aria-label="${label}"[^>]*>`))?.[0];
beforeEach(() => setApp({ ...initial, ready: true, rendererState: 'ready', summary: { ...summary }, busy: false,
  alignmentTool: 'center', alignmentPoint: null, alignmentSecondPoint: null, alignmentThirdPoint: null, alignmentNormal: null, alignmentFlip: false,
  alignmentTargetDistance: null, alignmentPicking: false, settingsOpen: false, exportOpen: false,
  navigationPrompt: false, outputPending: false, savedViewChoices: [], mode: 'basic' }, true));
afterEach(() => { setApp(initial, true); vi.restoreAllMocks(); });

describe('one-point Center UI ownership', () => {
  it('renders the desktop actions in order and enables Center and Scale', () => {
    const markup = renderToStaticMarkup(createElement(AlignmentActionMenu, { active: false, enabled: true, onChoose: vi.fn() }));
    const buttons = markup.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)!;
    expect(buttons).toHaveLength(4);
    for (const [index, [label, icon]] of [['1-point center', 'PickCenter'], ['2-point scale', 'CalibrateScale'], ['3-point align', 'AlignPlane'], ['Level floor', 'LevelFloor']].entries()) {
      expect(buttons[index]).toContain(label); expect(buttons[index]).toContain(desktopIcons[icon]);
      expect(buttons[index].includes('disabled')).toBe(index >= 2);
    }
  });
  it.each(['basic', 'pro'] as const)('shares active point status, whole-scene scope, confirm and cancel in %s', mode => {
    const target = controller(); setApp({ mode });
    let markup = renderToStaticMarkup(createElement(AlignmentOverlay, { controller: target, scene, marker: null }));
    expect(markup).toContain('0 / 1 points'); expect(markup).toContain('Whole scene');
    expect(markup.match(/<button\b[^>]*title="Set center \(Enter\)"[^>]*>/)?.[0]).toContain('disabled');
    expect(openingButton(markup, 'Cancel alignment')).not.toContain('disabled');
    setApp({ alignmentPoint: [2, 3, 4] });
    markup = renderToStaticMarkup(createElement(AlignmentOverlay, { controller: target, scene, marker: [120, 80] }));
    expect(markup).toContain('1 / 1 points'); expect(markup).toContain('class="alignment-marker"');
    expect(markup.match(/<button\b[^>]*title="Set center \(Enter\)"[^>]*>/)?.[0]).not.toContain('disabled');
    expect(target.startCenterAlignment).not.toHaveBeenCalled(); expect(target.confirmAlignment).not.toHaveBeenCalled();
    expect(target.resetAlignment).not.toHaveBeenCalled();
  });
  it('does not offer Reset until the native alignment baseline says it can reset', () => {
    const target = controller();
    const markup = () => renderToStaticMarkup(createElement(AlignmentControls, { controller: target, scene }));
    expect(openingButton(markup(), 'Reset alignment')).toContain('disabled');
    setApp({ summary: { ...summary, alignment: { ...summary.alignment!, canReset: true } } });
    expect(openingButton(markup(), 'Reset alignment')).not.toContain('disabled');
    target.alignmentControlsEnabled = false; setApp({ alignmentPicking: true, busy: true });
    expect(openingButton(markup(), 'Alignment')).toContain('disabled');
    expect(openingButton(markup(), 'Reset alignment')).toContain('disabled');
  });
  it('blocks Reset for an unapplied grade while leaving Center available to settle that grade', () => {
    const target = controller(), applied = [...initial.appliedGrade], grade = [...applied];
    applied[0] = Math.fround(1.3); grade[0] = 1.3;
    setApp({ summary: { ...summary, alignment: { ...summary.alignment!, canReset: true } }, grade, appliedGrade: applied });
    const markup = () => renderToStaticMarkup(createElement(AlignmentControls, { controller: target, scene }));
    expect(openingButton(markup(), 'Reset alignment')).not.toContain('disabled');
    setApp({ grade: [...initial.grade] });
    expect(openingButton(markup(), 'Reset alignment')).toContain('disabled');
    expect(openingButton(markup(), 'Alignment')).not.toContain('disabled');
    expect(target.resetAlignment).not.toHaveBeenCalled(); expect(target.startCenterAlignment).not.toHaveBeenCalled();
  });
  it.each([
    { settingsOpen: true }, { exportOpen: true }, { navigationPrompt: true }, { outputPending: true },
  ])('yields scene alignment to the dialog at boundary %j', patch => {
    setApp(patch); expect(alignmentControlsEnabled(controller())).toBe(false);
  });
  it('uses controller admission for native/source/recovery ownership', () => {
    const target = controller(); target.alignmentControlsEnabled = false;
    expect(openingButton(renderToStaticMarkup(createElement(AlignmentControls, { controller: target, scene })), 'Alignment')).toContain('disabled');
    expect(alignmentControlsEnabled(target)).toBe(false);
  });
  it('consumes Backspace and Enter as point-tool actions before scene deletion or polygon completion', () => {
    const target = controller(), key = (name: string, repeat = false) => ({ key: name, repeat, ctrlKey: false, metaKey: false, altKey: false,
      isComposing: false, defaultPrevented: false, preventDefault: vi.fn() });
    expect(handleAlignmentKey(key('Enter'), target)).toBe(true); expect(target.confirmAlignment).not.toHaveBeenCalled();
    setApp({ alignmentPoint: [2, 3, 4], alignmentPicking: true });
    expect(handleAlignmentKey(key('Enter'), target)).toBe(true); expect(target.confirmAlignment).not.toHaveBeenCalled();
    setApp({ alignmentPicking: false });
    expect(handleAlignmentKey(key('Enter'), target)).toBe(true); expect(target.confirmAlignment).toHaveBeenCalledOnce();
    expect(handleAlignmentKey(key('Enter', true), target)).toBe(true); expect(target.confirmAlignment).toHaveBeenCalledOnce();
    expect(handleAlignmentKey(key('Backspace'), target)).toBe(true); expect(target.clearAlignmentPoint).toHaveBeenCalledOnce();
    expect(handleAlignmentKey(key('Escape'), target)).toBe(true); expect(target.cancelAlignment).toHaveBeenCalledOnce();
    expect(handleAlignmentKey(key('Delete'), target)).toBe(false);
    setApp({ settingsOpen: true }); expect(handleAlignmentKey(key('Enter'), target)).toBe(false);
    setApp({ settingsOpen: false, alignmentTool: null }); expect(handleAlignmentKey(key('Backspace'), target)).toBe(false);
  });
  it('retains a picked world point across Basic/Pro and projects it through current navigation', () => {
    const point: [number, number, number] = [0, 0, .5]; setApp({ alignmentPoint: point });
    switchToolsMode('pro'); expect(useApp.getState().alignmentPoint).toBe(point); expect(useApp.getState().alignmentTool).toBe('center');
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    expect(projectAlignmentPoint(point, identity, identity, 200, 100)).toEqual([100, 50]);
    const movedView = [...identity]; movedView[12] = .5;
    expect(projectAlignmentPoint(point, movedView, identity, 200, 100)).toEqual([150, 50]);
    expect(point).toEqual([0, 0, .5]);
    expect(projectAlignmentPoint([0, 0, -.5], identity, identity, 200, 100)).toBeNull();
    expect(projectAlignmentPoint([5, 0, .5], identity, identity, 200, 100)).toBeNull();
  });
});

describe('three-point Align UI ownership', () => {
  const points: [number, number, number][] = [[-.3, 0, .3], [.3, 0, .3], [0, 0, .8]], normal: [number, number, number] = [0, -1, 0];
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const key = (name: string) => ({ key: name, repeat: false, ctrlKey: false, metaKey: false, altKey: false,
    defaultPrevented: false, preventDefault: vi.fn() });
  it('enables Align only through native plane admission and keeps Floor disabled', () => {
    const menu = (planeEnabled: boolean) => renderToStaticMarkup(createElement(AlignmentActionMenu,
      { active: false, enabled: true, planeEnabled, onChoose: vi.fn() })).match(/<button\b[^>]*>[\s\S]*?<\/button>/g)!;
    expect(menu(false)[2]).toContain('disabled'); expect(menu(true)[2]).not.toContain('disabled');
    expect(menu(true)[3]).toContain('disabled'); expect(menu(true)[2]).toContain(desktopIcons.AlignPlane);
    const target = controller(); expect(alignmentPlaneControlsEnabled(target)).toBe(false);
    target.alignmentPlaneControlsEnabled = true; expect(alignmentPlaneControlsEnabled(target)).toBe(true);
    setApp({ exportOpen: true }); expect(alignmentPlaneControlsEnabled(target)).toBe(false);
  });
  it.each(['basic', 'pro'] as const)('requires three native-validated points and offers candidate Flip before explicit Confirm in %s', mode => {
    const target = controller(); target.alignmentPlaneControlsEnabled = true; setApp({ mode, alignmentTool: 'align' });
    const markup = () => renderToStaticMarkup(createElement(AlignmentOverlay, { controller: target, scene,
      marker: [30, 60], secondMarker: [80, 60], thirdMarker: [60, 30], segment: [[30, 60], [80, 60]],
      triangleSegments: [[[80, 60], [60, 30]], [[60, 30], [30, 60]]],
      normalProjection: { shaft: [[55, 50], [55, 25]], head: [[55, 25], [51, 35], [59, 35]] } }));
    expect(markup()).toContain('0 / 3 points'); expect(markup()).not.toContain('aria-label="Flip normal"');
    setApp({ alignmentPoint: points[0], alignmentSecondPoint: points[1] });
    expect(markup()).toContain('2 / 3 points');
    expect(markup().match(/<button\b[^>]*title="Align plane \(Enter\)"[^>]*>/)?.[0]).toContain('disabled');
    setApp({ alignmentThirdPoint: points[2], alignmentNormal: normal });
    const ready = markup(); expect(ready).toContain('3 / 3 points'); expect(ready).toContain('>3</text>');
    expect(ready.match(/class="alignment-segment(?: alignment-triangle-edge)?"/g)).toHaveLength(3);
    expect(ready).toContain('class="alignment-normal"'); expect(ready).toContain('class="alignment-normal-head"');
    expect(openingButton(ready, 'Flip normal')).toContain('aria-pressed="false"'); expect(ready).toContain(desktopIcons.FlipUp);
    expect(ready.match(/<button\b[^>]*title="Align plane \(Enter\)"[^>]*>/)?.[0]).not.toContain('disabled');
    expect(openingButton(ready, 'Cancel alignment')).not.toContain('disabled');
    expect(ready).not.toContain('Target distance (m)');
    expect(target.startPlaneAlignment).not.toHaveBeenCalled(); expect(target.setAlignmentFlip).not.toHaveBeenCalled(); expect(target.confirmAlignment).not.toHaveBeenCalled();
    setApp({ alignmentFlip: true }); expect(openingButton(markup(), 'Flip normal')).toContain('aria-pressed="true"');
    setApp({ alignmentThirdPoint: null, alignmentNormal: null });
    expect(markup()).toContain('2 / 3 points'); expect(markup()).not.toContain('alignment-normal-head');
    expect(markup()).not.toContain('alignment-triangle-edge'); expect(markup()).not.toContain('aria-label="Flip normal"');
  });
  it('keeps Enter guarded while native validation is pending, and sends Backspace/Escape to the point owner', () => {
    const target = controller(); target.alignmentPlaneControlsEnabled = true;
    setApp({ alignmentTool: 'align', alignmentPoint: points[0], alignmentSecondPoint: points[1] });
    expect(handleAlignmentKey(key('Enter'), target)).toBe(true); expect(target.confirmAlignment).not.toHaveBeenCalled();
    setApp({ alignmentThirdPoint: points[2], alignmentPicking: true });
    handleAlignmentKey(key('Enter'), target); expect(target.confirmAlignment).not.toHaveBeenCalled();
    setApp({ alignmentPicking: false }); handleAlignmentKey(key('Enter'), target); expect(target.confirmAlignment).not.toHaveBeenCalled();
    setApp({ alignmentNormal: normal }); handleAlignmentKey(key('Enter'), target); expect(target.confirmAlignment).toHaveBeenCalledOnce();
    handleAlignmentKey(key('Backspace'), target); expect(target.clearAlignmentPoint).toHaveBeenCalledOnce();
    handleAlignmentKey(key('Escape'), target); expect(target.cancelAlignment).toHaveBeenCalledOnce();
    target.alignmentPlaneControlsEnabled = false; handleAlignmentKey(key('Enter'), target); expect(target.confirmAlignment).toHaveBeenCalledOnce();
  });
  it('retains native points/normal/Flip across profiles and reverses only the raw candidate arrow', () => {
    setApp({ alignmentTool: 'align', alignmentPoint: points[0], alignmentSecondPoint: points[1], alignmentThirdPoint: points[2], alignmentNormal: normal, alignmentFlip: true });
    switchToolsMode('pro'); const state = useApp.getState();
    expect(state.alignmentThirdPoint).toBe(points[2]); expect(state.alignmentNormal).toBe(normal); expect(state.alignmentFlip).toBe(true);
    const forward = projectAlignmentNormal(points[0], points[1], points[2], normal, false, identity, identity, 200, 100)!;
    const flipped = projectAlignmentNormal(points[0], points[1], points[2], normal, true, identity, identity, 200, 100)!;
    expect(forward.shaft![1][1]).toBeGreaterThan(forward.shaft![0][1]); expect(flipped.shaft![1][1]).toBeLessThan(flipped.shaft![0][1]);
    expect(normal).toEqual([0, -1, 0]); expect(points).toEqual([[-.3, 0, .3], [.3, 0, .3], [0, 0, .8]]);
  });
  it('clips the normal shaft and keeps its head off a clipped endpoint', () => {
    const result = projectAlignmentNormal([0, -10, .2], [0, 10, .2], [0, 0, .8], [1, 0, 0], false, identity, identity, 200, 100)!;
    expect(result.shaft![1][0]).toBe(200); expect(result.head).toBeNull();
  });
  it('puts the ready Basic plane action left of a normal obscured by the preferred quadrant', () => {
    const position = placeAlignmentPlanePopup([451, 351], { width: 252, height: 147 }, { width: 1280, height: 800 },
      [{ x: 630, y: 380, width: 18, height: 28 }, { x: 968, y: 12, width: 300, height: 737 }]);
    expect(position).toEqual({ left: 187, top: 363 });
    expect(position.left + 252).toBeLessThan(451); expect(position.left + 252).toBeLessThan(630);
  });
  it('keeps the compact Pro action and normal separate from Tools and wrapped toolbar controls', () => {
    const position = placeAlignmentPlanePopup([249, 132], { width: 252, height: 147 }, { width: 640, height: 300 }, [
      { x: 318, y: 150, width: 10, height: 20 }, { x: 328, y: 12, width: 300, height: 276 },
      { x: 12, y: 12, width: 293, height: 78 }, { x: 12, y: 96, width: 36, height: 36 },
    ]);
    expect(position).toEqual({ left: 12, top: 141 }); expect(position.left + 252).toBeLessThan(318);
    expect(position.top).toBeGreaterThan(132); expect(position.top + 147).toBe(288);
  });
  it('keeps a clear action stationary through Flip and moves it only if the new normal obstructs it', () => {
    const previous = { left: 187, top: 363 }, extent = { width: 252, height: 147 }, viewport = { width: 1280, height: 800 };
    expect(placeAlignmentPlanePopup([451, 351], extent, viewport, [{ x: 630, y: 350, width: 18, height: 28 }], 1, previous)).toEqual(previous);
    const moved = placeAlignmentPlanePopup([451, 351], extent, viewport, [{ x: 300, y: 400, width: 18, height: 28 }], 1, previous);
    expect(moved).toEqual({ left: 463, top: 363 }); expect(previous).toEqual({ left: 187, top: 363 });
  });
  it('clamps a clear retained action after resize and keeps a reachable fallback when every quadrant is blocked', () => {
    const extent = { width: 252, height: 147 }, viewport = { width: 640, height: 300 };
    expect(placeAlignmentPlanePopup([249, 132], extent, viewport, [], 1, { left: 900, top: 600 })).toEqual({ left: 376, top: 141 });
    const fallback = placeAlignmentPlanePopup([249, 132], extent, viewport, [{ x: 0, y: 0, width: 640, height: 300 }]);
    expect(fallback).toEqual({ left: 261, top: 141 }); expect(fallback.left + extent.width).toBeLessThanOrEqual(628);
    expect(fallback.top + extent.height).toBeLessThanOrEqual(288);
  });
});

describe('two-point Scale UI ownership', () => {
  it.each(['basic', 'pro'] as const)('shows measured segment and editable meter target without applying geometry in %s', mode => {
    const target = controller(); setApp({ mode, alignmentTool: 'scale' });
    const markup = () => renderToStaticMarkup(createElement(AlignmentOverlay, { controller: target, scene, marker: [50, 80], secondMarker: [150, 80],
      segment: [[50, 80], [150, 80]], distanceMarker: [100, 80] }));
    expect(markup()).toContain('0 / 2 points');
    expect(markup().match(/<button\b[^>]*title="Set scale \(Enter\)"[^>]*>/)?.[0]).toContain('disabled');
    setApp({ alignmentPoint: [0, 0, .5] });
    expect(markup()).toContain('1 / 2 points'); expect(markup()).not.toContain('aria-label="Target distance (m)"');
    setApp({ alignmentSecondPoint: [3, 4, .5], alignmentTargetDistance: 5 });
    const ready = markup(); expect(ready).toContain('2 / 2 points'); expect(ready).toContain('Distance: 5 m');
    expect(ready).toContain('class="alignment-segment"'); expect(ready).toContain('>2</text>');
    expect(ready.match(/<input\b[^>]*aria-label="Target distance \(m\)"[^>]*>/)?.[0]).toContain('value="5"');
    expect(ready.match(/<button\b[^>]*title="Set scale \(Enter\)"[^>]*>/)?.[0]).not.toContain('disabled');
    expect(target.confirmAlignment).not.toHaveBeenCalled(); expect(target.setAlignmentTargetDistance).not.toHaveBeenCalled();
    expect(target.startScaleAlignment).not.toHaveBeenCalled(); expect(target.startCenterAlignment).not.toHaveBeenCalled();
  });
  it.each([null, 0, -1, NaN, Infinity])('keeps target editable and confirmation disabled for target %s', alignmentTargetDistance => {
    const target = controller(); setApp({ alignmentTool: 'scale', alignmentPoint: [0, 0, .5], alignmentSecondPoint: [3, 4, .5], alignmentTargetDistance });
    const markup = renderToStaticMarkup(createElement(AlignmentOverlay, { controller: target, scene, marker: null }));
    expect(markup.match(/<input\b[^>]*aria-label="Target distance \(m\)"[^>]*>/)?.[0]).not.toContain('disabled');
    expect(markup.match(/<button\b[^>]*title="Set scale \(Enter\)"[^>]*>/)?.[0]).toContain('disabled');
    expect(target.confirmAlignment).not.toHaveBeenCalled();
  });
  it('keeps numeric Backspace for editing and uses Enter only with two points and positive target', () => {
    const target = controller(), key = (name: string) => ({ key: name, repeat: false, ctrlKey: false, metaKey: false, altKey: false,
      defaultPrevented: false, preventDefault: vi.fn() });
    setApp({ alignmentTool: 'scale', alignmentPoint: [0, 0, .5], alignmentTargetDistance: 5 });
    expect(handleAlignmentDistanceKey(key('Backspace'), target)).toBe(false); expect(target.clearAlignmentPoint).not.toHaveBeenCalled();
    expect(handleAlignmentDistanceKey(key('Enter'), target)).toBe(true); expect(target.confirmAlignment).not.toHaveBeenCalled();
    setApp({ alignmentSecondPoint: [3, 4, .5], alignmentTargetDistance: 0 });
    expect(handleAlignmentDistanceKey(key('Enter'), target)).toBe(true); expect(target.confirmAlignment).not.toHaveBeenCalled();
    setApp({ alignmentTargetDistance: 5 });
    expect(handleAlignmentDistanceKey(key('Enter'), target)).toBe(true); expect(target.confirmAlignment).toHaveBeenCalledOnce();
    expect(handleAlignmentDistanceKey(key('Escape'), target)).toBe(true); expect(target.cancelAlignment).toHaveBeenCalledOnce();
  });
  it('keeps both world points and target across profiles and clips their segment without modifying them', () => {
    const first: [number, number, number] = [-2, 0, .5], second: [number, number, number] = [.5, 0, .5];
    setApp({ alignmentTool: 'scale', alignmentPoint: first, alignmentSecondPoint: second, alignmentTargetDistance: 7 });
    switchToolsMode('pro'); const state = useApp.getState();
    expect(state.alignmentPoint).toBe(first); expect(state.alignmentSecondPoint).toBe(second); expect(state.alignmentTargetDistance).toBe(7);
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    expect(projectAlignmentSegment(first, second, identity, identity, 200, 100)).toEqual([[0, 50], [150, 50]]);
    expect(projectAlignmentSegment([0, 0, -.5], [1, 0, -.5], identity, identity, 200, 100)).toBeNull();
    expect(first).toEqual([-2, 0, .5]); expect(second).toEqual([.5, 0, .5]);
  });
});
