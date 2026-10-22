import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setApp, switchToolsMode, useApp, type FloorState } from '../src/app/store';
import { useUiPreferences } from '../src/app/uiPreferences';
import type { FloorPlane, FloorSummary } from '../src/document/floorProtocol';
import { desktopIcons } from '../src/generated/desktop';
import { AlignmentActionMenu, AlignmentControls, AlignmentOverlay, alignmentConfirmationReady, floorCancellationEnabled,
  handleAlignmentKey, projectFloorOverlay, placeAlignmentPlanePopup } from '../src/ui/AlignmentControls';

vi.mock('../src/app/store', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/app/store')>();
  return { ...actual, useApp: Object.assign(() => actual.useApp.getState(), actual.useApp) };
});
const initial = useApp.getState(), preference = useUiPreferences.getState(), scene = { current: null };
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const plane: FloorPlane = Object.freeze({ normal: Object.freeze([0, 1, 0] as const), center: Object.freeze([0, 0, .5] as const),
  radius: .5, rms: .01, inliers: 30, tested: 40 });
const candidate: FloorSummary = Object.freeze({ version: 1, id: 7, status: 'ready', stage: 'complete', selectedOnly: false, plane });
const floorState = (phase: FloorState['phase']): FloorState => ({ phase, progress: .4, message: null, candidate: phase === 'candidate' ? candidate : null });
function controller() {
  return { alignmentControlsEnabled: false, alignmentPlaneControlsEnabled: false, floorDetectionEnabled: false,
    floorCandidateReady: false, camera: undefined, startCenterAlignment: vi.fn().mockResolvedValue(true), startScaleAlignment: vi.fn().mockResolvedValue(true),
    startPlaneAlignment: vi.fn().mockResolvedValue(true), startFloorDetection: vi.fn().mockResolvedValue(true), setAlignmentFlip: vi.fn(),
    setAlignmentTargetDistance: vi.fn(), confirmAlignment: vi.fn().mockResolvedValue(true), cancelAlignment: vi.fn(),
    clearAlignmentPoint: vi.fn(), resetAlignment: vi.fn().mockResolvedValue(true) };
}
const key = (name: string, patch = {}) => ({ key: name, repeat: false, ctrlKey: false, metaKey: false, altKey: false,
  defaultPrevented: false, preventDefault: vi.fn(), ...patch });
const button = (markup: string, attribute: string) => markup.match(new RegExp(`<button\\b[^>]*${attribute}[^>]*>`))?.[0];
beforeEach(() => setApp({ ...initial, alignmentTool: 'floor', alignmentFloor: floorState('detecting'), alignmentFlip: false,
  busy: true, settingsOpen: false, exportOpen: false, navigationPrompt: false, outputPending: false, savedViewChoices: [] }, true));
afterEach(() => { setApp(initial, true); useUiPreferences.setState(preference, true); vi.restoreAllMocks(); });

describe('explicit Floor actions and input ownership', () => {
  it('enables the desktop Floor action only through separate admission and keeps menu order', () => {
    const menu = (floorEnabled: boolean) => renderToStaticMarkup(createElement(AlignmentActionMenu,
      { active: true, activeTool: 'floor', enabled: false, floorEnabled, onChoose: vi.fn() })).match(/<button\b[^>]*>[\s\S]*?<\/button>/g)!;
    const disabled = menu(false), admitted = menu(true);
    expect(disabled).toHaveLength(4); expect(disabled[3]).toContain('disabled');
    expect(admitted.slice(0, 3).every(value => value.includes('disabled'))).toBe(true);
    expect(admitted[3]).not.toContain('disabled'); expect(admitted[3]).toContain('aria-checked="true"');
    expect(admitted[3]).toContain('Level floor'); expect(admitted[3]).toContain(desktopIcons.LevelFloor);
  });
  it.each(['detecting', 'cancelling'] as const)('keeps Cancel reachable during %s without offering early Confirm or Flip', phase => {
    setApp({ alignmentFloor: floorState(phase) }); const target = controller();
    const markup = renderToStaticMarkup(createElement(AlignmentOverlay, { controller: target, scene, marker: [5, 5] }));
    expect(markup).toContain(phase === 'detecting' ? 'Detecting floor... | Esc cancel' : 'Cancelling floor detection...');
    expect(markup).toContain('aria-label="Floor detection progress"'); expect(markup).toContain('value="0.4"');
    expect(button(markup, 'title="Level floor \\(Enter\\)"')).toContain('disabled');
    expect(button(markup, 'aria-label="Cancel alignment"')).not.toContain('disabled');
    expect(markup).not.toContain('Flip normal'); expect(markup).not.toContain('Undo point'); expect(markup).not.toContain('points');
    expect(alignmentConfirmationReady(target)).toBe(false); handleAlignmentKey(key('Enter'), target);
    expect(target.confirmAlignment).not.toHaveBeenCalled(); expect(target.startFloorDetection).not.toHaveBeenCalled();
    const menu = renderToStaticMarkup(createElement(AlignmentControls, { controller: target, scene }));
    expect(button(menu, 'aria-label="Alignment"')).not.toContain('disabled');
    expect(button(menu, 'aria-label="Reset alignment"')).toContain('disabled');
  });
  it('offers explicit Retry for a failed candidate, with no automatic detection from Enter or rendering', () => {
    const target = controller(); target.floorDetectionEnabled = true;
    setApp({ busy: false, alignmentFloor: { ...floorState('failed'), message: 'Select a wider floor region and retry.' } });
    const markup = renderToStaticMarkup(createElement(AlignmentOverlay, { controller: target, scene, marker: null }));
    expect(markup).toContain('Select a wider floor region and retry.'); expect(markup).toContain('Re-detect floor');
    expect(button(markup, 'title="Re-detect floor"')).not.toContain('disabled'); expect(markup).toContain(desktopIcons.Reset);
    expect(markup).not.toContain('title="Level floor (Enter)"'); expect(markup).not.toContain('Flip normal');
    const enter = key('Enter'); expect(handleAlignmentKey(enter, target)).toBe(false); expect(enter.preventDefault).not.toHaveBeenCalled();
    expect(target.startFloorDetection).not.toHaveBeenCalled(); expect(target.confirmAlignment).not.toHaveBeenCalled();
    target.floorDetectionEnabled = false;
    expect(button(renderToStaticMarkup(createElement(AlignmentOverlay, { controller: target, scene, marker: null })), 'title="Re-detect floor"')).toContain('disabled');
  });
  it.each([{ mode: 'basic', size: 'small' }, { mode: 'basic', size: 'large' }, { mode: 'pro', size: 'small' }, { mode: 'pro', size: 'large' }] as const)(
    'shows the retained candidate, Flip/Confirm/Cancel in desktop order and no point controls in $mode/$size', ({ mode, size }) => {
    const target = controller(); target.floorCandidateReady = true;
    setApp({ mode, busy: false, alignmentFloor: floorState('candidate'), alignmentPoint: [1, 2, 3] });
    useUiPreferences.setState({ size, previewSize: null });
    const projected = projectFloorOverlay(plane, false, identity, identity, 200, 100);
    const markup = renderToStaticMarkup(createElement(AlignmentOverlay, { controller: target, scene, marker: [1, 1], floorGrid: projected.grid, normalProjection: projected.normal }));
    expect(markup.match(/class="alignment-floor-grid"/g)).toHaveLength(18);
    expect(markup).toContain('class="alignment-normal"'); expect(markup).toContain('class="alignment-normal-head"');
    expect(markup.indexOf('aria-label="Flip normal"')).toBeLessThan(markup.indexOf('title="Level floor (Enter)"'));
    expect(markup.indexOf('title="Level floor (Enter)"')).toBeLessThan(markup.indexOf('aria-label="Cancel alignment"'));
    expect(button(markup, 'aria-label="Flip normal"')).toContain('aria-pressed="false"');
    expect(button(markup, 'title="Level floor \\(Enter\\)"')).not.toContain('disabled');
    expect(markup).toContain('Whole scene'); expect(markup).not.toContain('Undo point'); expect(markup).not.toContain('<circle');
    expect(markup).not.toContain('alignment-triangle-edge'); expect(markup).not.toContain('Target distance');
    expect(target.confirmAlignment).not.toHaveBeenCalled(); expect(target.startFloorDetection).not.toHaveBeenCalled(); expect(target.setAlignmentFlip).not.toHaveBeenCalled();
  });
  it('identifies selected detection input while keeping the leveling action scoped to the whole scene', () => {
    const target = controller(); target.floorCandidateReady = true;
    setApp({ busy: false, alignmentFloor: { ...floorState('candidate'), candidate: { ...candidate, selectedOnly: true } } });
    const markup = renderToStaticMarkup(createElement(AlignmentOverlay, { controller: target, scene, marker: null }));
    expect(markup).toContain('Whole scene'); expect(markup).toContain('Detected from selected points');
    expect(button(markup, 'title="Level floor \\(Enter\\)"')).not.toContain('disabled');
  });
  it('joins keyboard confirmation only to a ready candidate and excludes point undo', () => {
    const target = controller(), backspace = key('Backspace');
    expect(handleAlignmentKey(backspace, target)).toBe(false); expect(backspace.preventDefault).not.toHaveBeenCalled();
    expect(target.clearAlignmentPoint).not.toHaveBeenCalled();
    setApp({ busy: false, alignmentFloor: floorState('candidate') }); target.floorCandidateReady = true;
    expect(handleAlignmentKey(key('Enter'), target)).toBe(true); expect(target.confirmAlignment).toHaveBeenCalledOnce();
    expect(handleAlignmentKey(key('Enter', { repeat: true }), target)).toBe(true); expect(target.confirmAlignment).toHaveBeenCalledOnce();
    setApp({ alignmentFloor: { ...floorState('candidate'), candidate: { ...candidate, status: 'none', plane: null } } });
    handleAlignmentKey(key('Enter'), target); expect(target.confirmAlignment).toHaveBeenCalledOnce();
    setApp({ alignmentFloor: floorState('detecting'), busy: true }); handleAlignmentKey(key('Escape'), target);
    handleAlignmentKey(key('Escape', { repeat: true }), target); expect(target.cancelAlignment).toHaveBeenCalledOnce();
  });
  it('blocks candidate Confirm/Flip/Cancel during commit and respects modal/composition input owners', () => {
    const target = controller(); target.floorCandidateReady = true; setApp({ alignmentFloor: floorState('candidate') });
    const markup = renderToStaticMarkup(createElement(AlignmentOverlay, { controller: target, scene, marker: null }));
    expect(button(markup, 'aria-label="Flip normal"')).toContain('disabled'); expect(button(markup, 'aria-label="Cancel alignment"')).toContain('disabled');
    expect(alignmentConfirmationReady(target)).toBe(false); expect(floorCancellationEnabled()).toBe(false);
    handleAlignmentKey(key('Escape'), target); expect(target.cancelAlignment).not.toHaveBeenCalled();
    setApp({ busy: false, settingsOpen: true }); expect(handleAlignmentKey(key('Enter'), target)).toBe(false);
    setApp({ settingsOpen: false }); expect(handleAlignmentKey(key('Enter', { isComposing: true }), target)).toBe(false);
    expect(handleAlignmentKey(key('Enter', { ctrlKey: true }), target)).toBe(false); expect(target.confirmAlignment).not.toHaveBeenCalled();
  });
  it('keeps the fixed native candidate and Flip through profile and size changes without issuing analysis', () => {
    const target = controller(); target.floorCandidateReady = true;
    setApp({ busy: false, alignmentFloor: floorState('candidate'), alignmentFlip: true }); const owner = useApp.getState().alignmentFloor;
    switchToolsMode('pro'); useUiPreferences.getState().preview('large');
    const markup = renderToStaticMarkup(createElement(AlignmentOverlay, { controller: target, scene, marker: null }));
    expect(useApp.getState().alignmentFloor).toBe(owner); expect(useApp.getState().alignmentFloor?.candidate).toBe(candidate);
    expect(button(markup, 'aria-label="Flip normal"')).toContain('aria-pressed="true"');
    expect(target.startFloorDetection).not.toHaveBeenCalled(); expect(target.confirmAlignment).not.toHaveBeenCalled();
  });
});

describe('constant-size native Floor candidate display', () => {
  it('projects eighteen grid lines at half native radius without modifying metadata', () => {
    const face: FloorPlane = { ...plane, normal: [0, 0, 1], radius: 1 };
    const before = structuredClone(face), result = projectFloorOverlay(face, false, identity, identity, 200, 100);
    expect(result.grid).toHaveLength(18); expect(result.grid.every(Boolean)).toBe(true);
    const points = result.grid.flatMap(edge => edge!);
    expect(Math.min(...points.map(point => point[0]))).toBe(50); expect(Math.max(...points.map(point => point[0]))).toBe(150);
    expect(Math.min(...points.map(point => point[1]))).toBe(25); expect(Math.max(...points.map(point => point[1]))).toBe(75);
    expect(face).toEqual(before); expect(projectFloorOverlay(face, true, identity, identity, 200, 100).grid).toEqual(result.grid);
  });
  it('reverses only the raw native normal and reprojects a fixed candidate as navigation changes', () => {
    const forward = projectFloorOverlay(plane, false, identity, identity, 200, 100), flipped = projectFloorOverlay(plane, true, identity, identity, 200, 100);
    expect(forward.normal!.shaft![1][1]).toBeLessThan(forward.normal!.shaft![0][1]);
    expect(flipped.normal!.shaft![1][1]).toBeGreaterThan(flipped.normal!.shaft![0][1]); expect(flipped.grid).toEqual(forward.grid);
    const moved = [...identity]; moved[12] = .25;
    const navigated = projectFloorOverlay(plane, false, moved, identity, 200, 100);
    expect(navigated.normal!.shaft![0][0]).toBe(forward.normal!.shaft![0][0] + 25); expect(plane.center).toEqual([0, 0, .5]);
  });
  it('clips grid and shaft at the viewport and omits a head at a clipped tip', () => {
    const result = projectFloorOverlay({ ...plane, normal: [1, 0, 0], radius: 4 }, false, identity, identity, 200, 100);
    expect(result.grid).toHaveLength(18); expect(result.normal!.shaft![1][0]).toBe(200); expect(result.normal!.head).toBeNull();
    for (const edge of result.grid) for (const point of edge ?? []) {
      expect(point[0]).toBeGreaterThanOrEqual(0); expect(point[0]).toBeLessThanOrEqual(200);
      expect(point[1]).toBeGreaterThanOrEqual(0); expect(point[1]).toBeLessThanOrEqual(100);
    }
    expect(projectFloorOverlay({ ...plane, center: [0, 0, -4] }, false, identity, identity, 200, 100).grid.every(edge => edge === null)).toBe(true);
  });
  it('keeps the Floor action inside compact viewport bounds and clear of a normal and controls when a quadrant is available', () => {
    const extent = { width: 252, height: 137 }, obstacles = [{ x: 328, y: 12, width: 300, height: 276 },
      { x: 12, y: 12, width: 293, height: 78 }, { x: 318, y: 150, width: 10, height: 20 }];
    const at = placeAlignmentPlanePopup([316, 132], extent, { width: 640, height: 300 }, obstacles);
    expect(at.left).toBeGreaterThanOrEqual(12); expect(at.top).toBeGreaterThanOrEqual(12);
    expect(at.left + extent.width).toBeLessThanOrEqual(628); expect(at.top + extent.height).toBeLessThanOrEqual(288);
    expect(obstacles.every(box => at.left + extent.width < box.x || at.left > box.x + box.width ||
      at.top + extent.height < box.y || at.top > box.y + box.height)).toBe(true);
    expect(placeAlignmentPlanePopup([316, 132], extent, { width: 640, height: 300 }, obstacles, 1, at)).toEqual(at);
  });
});
