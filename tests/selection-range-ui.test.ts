import { Children, createElement, isValidElement, type InputHTMLAttributes, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppController } from '../src/app/controller';
import { webFeatureAllowed } from '../src/app/productPolicy';
import { setApp, useApp } from '../src/app/store';
import { captureSelectionRangePointerOptions, SelectionOptions } from '../src/ui/App';
import { SelectionRangeControl, selectionRangeFromRatio, selectionRangeRatio, type SelectionRangeController } from '../src/ui/SelectionRangeControl';
import { SelectionRangeOverlay } from '../src/ui/SelectionRangeOverlay';
import { currentDesktopIcons } from '../src/generated/currentDesktopIcons';
import { desktopIcons } from '../src/generated/desktop';

// Advanced engine components remain compatible without enabling their web-lite UI.
const retainedFullEditorSelectionFixture = vi.hoisted(() => ({ enabled: false }));
vi.mock('../src/app/productPolicy', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/app/productPolicy')>();
  return { ...actual, webFeatureAllowed(feature: string, capabilities: readonly string[] = []) {
    if (retainedFullEditorSelectionFixture.enabled && feature === 'selection.advanced') return true;
    return actual.webFeatureAllowed(feature, capabilities);
  } };
});
vi.mock('../src/app/store', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/app/store')>();
  return { ...actual, useApp: Object.assign(() => actual.useApp.getState(), actual.useApp) };
});
const initial = useApp.getState(), scene = { current: null };
type Input = InputHTMLAttributes<HTMLInputElement> & { ref?: { current: HTMLInputElement | null } };
type Pointer = Parameters<NonNullable<Input['onPointerDown']>>[0];
type Key = Parameters<NonNullable<Input['onKeyDown']>>[0];
type Change = Parameters<NonNullable<Input['onChange']>>[0];
type Blur = Parameters<NonNullable<Input['onBlur']>>[0];
type Action = { label?: string; icon?: string; active?: boolean; disabled?: boolean; onClick?(): void; children?: ReactNode };
function find<T extends { children?: ReactNode }>(tree: ReactNode, matches: (props: T, type: unknown) => boolean): T | undefined {
  for (const node of Children.toArray(tree)) {
    if (!isValidElement<T>(node)) continue;
    if (matches(node.props, node.type)) return node.props;
    const result = find(node.props.children, matches); if (result) return result;
  }
}
function controller(): SelectionRangeController {
  return { selectionRangeControlsEnabled: true, selectionRangeBounds: vi.fn(() => ({ minimum: .25, maximum: 64, value: 4 })),
    ensureSelectionRangeBounds: vi.fn().mockResolvedValue(true), setSelectionRangeRadius: vi.fn(), setTransformNumericFocus: vi.fn(),
    selectionRangePreview: undefined, camera: undefined, scene: {} as AppController['scene'] };
}
function controls(target = controller(), tool: 'color' | 'fill' = 'color', disabled = false) {
  let tree: ReactNode;
  function Capture() { tree = SelectionRangeControl({ controller: target, tool, scene, disabled }); return tree; }
  const markup = renderToStaticMarkup(createElement(Capture));
  return { markup, input: find<Input>(tree!, (props, type) => type === 'input' && props.type === 'range')! };
}
function numberControls(target: SelectionRangeController, text?: string) {
  let tree: ReactNode, opened = false, changed = false;
  // Server render-phase updates let the actual hook component enter numeric
  // mode and stage text without a DOM or a mirrored event implementation.
  function Capture() {
    tree = SelectionRangeControl({ controller: target, tool: 'color', scene });
    if (!opened) { opened = true; find<Input>(tree, props => props.type === 'range')!.onKeyDown!(key('Enter')); }
    else if (!changed && text !== undefined) {
      changed = true; find<Input>(tree, props => props.type === 'number')!.onChange!({ target: { value: text } } as unknown as Change);
    }
    return tree;
  }
  const markup = renderToStaticMarkup(createElement(Capture));
  return { markup, input: find<Input>(tree!, props => props.type === 'number')!,
    overlay: find<Parameters<typeof SelectionRangeOverlay>[0] & { children?: ReactNode }>(tree!, (_props, type) => type === SelectionRangeOverlay)! };
}
const pointer = (id = 3) => ({ pointerId: id, button: 0, ctrlKey: false, metaKey: false,
  preventDefault: vi.fn(), currentTarget: { setPointerCapture: vi.fn() } }) as unknown as Pointer;
const key = (value: string) => ({ key: value, preventDefault: vi.fn(), stopPropagation: vi.fn() }) as unknown as Key;
const change = (ratio: number) => ({ target: { value: String(ratio) } }) as unknown as Change;
beforeEach(() => {
  retainedFullEditorSelectionFixture.enabled = false;
  setApp({ ...initial, mode: 'pro', ready: true, busy: false, toolsOpen: true, tool: 'color',
    colorRange: { enabled: true, radius: null }, fillRange: { enabled: false, radius: 123.456789 } }, true);
});
afterEach(() => { retainedFullEditorSelectionFixture.enabled = false; setApp(initial, true); });

describe('desktop Color and Fill Range presentation', () => {
  it.each(['basic', 'pro'] as const)('renders enabled Radius in %s with logarithmic position, physical bounds and the desktop tooltip', mode => {
    setApp({ mode }); const target = controller(), result = controls(target);
    expect(result.markup).toContain('slider-row selection-range-parameter');
    expect(result.markup).toContain('Radius (m)</span>'); // The label keeps the desktop unit outside translation.
    expect(result.markup).toContain('aria-label="Radius"'); expect(result.markup).toContain('aria-valuemin="0.25"');
    expect(result.markup).toContain('aria-valuemax="64"'); expect(result.markup).toContain('aria-valuenow="4"');
    expect(result.input.value).toBe(.5); expect(result.input.disabled).toBe(false);
    expect(result.markup).toContain('Limit matches to a sphere around the picked point. Adjust its radius to update the last selection.');
    expect(target.setSelectionRangeRadius).not.toHaveBeenCalled();
  });
  it('hides Radius when the active tool preference is off, independently of the other tool', () => {
    expect(controls(controller(), 'fill').input).toBeUndefined(); expect(controls().input).toBeDefined();
    setApp({ colorRange: { enabled: false, radius: 50 }, fillRange: { enabled: true, radius: 9 } });
    expect(controls().input).toBeUndefined(); expect(controls(controller(), 'fill').input).toBeDefined();
  });
  it('disables unavailable source bounds and controller ownership without inventing a stored radius', () => {
    const target = controller(); Object.assign(target, { selectionRangeBounds: vi.fn(() => undefined) });
    expect(controls(target).input.disabled).toBe(true); expect(target.setSelectionRangeRadius).not.toHaveBeenCalled();
    Object.assign(target, { selectionRangeBounds: vi.fn(() => ({ minimum: .25, maximum: 64, value: 64 })), selectionRangeControlsEnabled: false });
    expect(controls(target).input.disabled).toBe(true); expect(controls(controller(), 'color', true).input.disabled).toBe(true);
    expect(useApp.getState().colorRange.radius).toBeNull();
  });
  it('shows clamped effective bounds without replacing the raw remembered preference during presentation or source replacement', () => {
    setApp({ colorRange: { enabled: true, radius: 1e9 } }); const target = controller();
    Object.assign(target, { selectionRangeBounds: vi.fn(() => ({ minimum: .25, maximum: 64, value: 64 })) });
    expect(controls(target).input['aria-valuenow']).toBe(64);
    Object.assign(target, { scene: {} as AppController['scene'], selectionRangeBounds: vi.fn(() => ({ minimum: 2, maximum: 8, value: 8 })) });
    expect(controls(target).input['aria-valuenow']).toBe(8);
    expect(useApp.getState().colorRange.radius).toBe(1e9); expect(target.setSelectionRangeRadius).not.toHaveBeenCalled();
  });
  it('uses the desktop six-significant-digit output without converting that display text back into a preference', () => {
    const target = controller(); Object.assign(target, { selectionRangeBounds: vi.fn(() => ({ minimum: .25, maximum: 1e9, value: 1e6 })) });
    expect(controls(target).markup).toContain('<output>1e+06</output>');
    Object.assign(target, { selectionRangeBounds: vi.fn(() => ({ minimum: .25, maximum: 64, value: Math.fround(1.23456789) })) });
    expect(controls(target).markup).toContain('<output>1.23457</output>');
    expect(target.setSelectionRangeRadius).not.toHaveBeenCalled(); expect(useApp.getState().colorRange.radius).toBeNull();
  });
  it.each(['color', 'fill'] as const)('retains the full-editor sphere action and explicit %s preference toggle', tool => {
    retainedFullEditorSelectionFixture.enabled = true;
    setApp({ tool }); const target = { selectionRangeControlsEnabled: true, setSelectionRangeEnabled: vi.fn(), setConnectedColor: vi.fn() };
    let tree: ReactNode;
    function Capture() { tree = SelectionOptions({ controller: target as unknown as AppController, tool, disabled: false,
      polygon: { closeEnabled: false, editEnabled: false, count: 0, close() {}, previous() {}, cancel() {} } }); return tree; }
    const markup = renderToStaticMarkup(createElement(Capture)), action = find<Action>(tree!, props => props.label === 'Range')!;
    expect(action.icon).toBe('Sphere'); expect(markup).toContain(currentDesktopIcons.Sphere ?? desktopIcons.Sphere);
    expect(action.active).toBe(tool === 'color'); action.onClick!();
    expect(target.setSelectionRangeEnabled).toHaveBeenCalledExactlyOnceWith(tool !== 'color', tool);
    expect(target.setConnectedColor).not.toHaveBeenCalled();
  });
  it.each(['color', 'fill'] as const)('omits %s Range under actual web-lite policy while retaining ordinary tool options', tool => {
    expect(webFeatureAllowed('selection.advanced')).toBe(false);
    setApp({ tool, connectedColor: false });
    const state = useApp.getState(), target = { selectionRangeControlsEnabled: true,
      setSelectionRangeEnabled: vi.fn(), setConnectedColor: vi.fn() };
    let tree: ReactNode;
    function Capture() { tree = SelectionOptions({ controller: target as unknown as AppController, tool, disabled: false,
      polygon: { closeEnabled: false, editEnabled: false, count: 0, close() {}, previous() {}, cancel() {} } }); return tree; }
    const markup = renderToStaticMarkup(createElement(Capture));
    expect(find<Action>(tree!, props => props.label === 'Range')).toBeUndefined();
    expect(markup).not.toContain('aria-label="Range"'); expect(markup).not.toContain('data-tutorial-target="range"');
    const labels = tool === 'color' ? ['Connected colors'] : ['Visible only', 'Include splat edges'];
    for (const label of labels) {
      const action = find<Action>(tree!, props => props.label === label);
      expect(action, label).toBeDefined(); expect(action!.disabled).not.toBe(true);
      expect(markup).toContain(`aria-label="${label}"`);
    }
    if (tool === 'color') {
      find<Action>(tree!, props => props.label === 'Connected colors')!.onClick!();
      expect(target.setConnectedColor).toHaveBeenCalledExactlyOnceWith(true);
    }
    expect(target.setSelectionRangeEnabled).not.toHaveBeenCalled(); expect(useApp.getState()).toBe(state);
  });
});

describe('settled Radius input dispatch', () => {
  it.each([1000, .3333333333333333])('commits the raw numeric value %s while limiting only the display sphere operand', raw => {
    const target = controller(), value = numberControls(target, String(raw));
    expect(value.input.value).toBe(String(raw)); expect(target.setSelectionRangeRadius).not.toHaveBeenCalled();
    expect(value.overlay.radius).toBe(Math.fround(Math.max(.25, Math.min(64, raw))));
    value.input.onBlur!({} as Blur);
    expect(target.setSelectionRangeRadius).toHaveBeenCalledExactlyOnceWith(raw, 'color');
    const activity = vi.mocked(target.setTransformNumericFocus), radius = vi.mocked(target.setSelectionRangeRadius);
    expect(activity.mock.calls.map(call => call[1])).toEqual([true, false]);
    expect(radius.mock.invocationCallOrder[0]).toBeLessThan(activity.mock.invocationCallOrder[1]);
  });
  it('opens remembered raw text and Escape keeps it unchanged without any native amendment', () => {
    setApp({ colorRange: { enabled: true, radius: 1000.123456789 } });
    const target = controller(), opened = numberControls(target);
    expect(opened.input.value).toBe('1000.123456789');
    opened.input.onBlur!({} as Blur);
    const changed = numberControls(target, '.3333333333333333');
    changed.input.onKeyDown!({ ...key('Escape'), currentTarget: { blur: () => changed.input.onBlur!({} as Blur) } } as unknown as Key);
    expect(target.setSelectionRangeRadius).not.toHaveBeenCalled();
    expect(useApp.getState().colorRange.radius).toBe(1000.123456789);
  });
  it('stages a drag without native work, then commits once before releasing its activity token', () => {
    const target = controller(), input = controls(target).input, event = pointer();
    input.onPointerDown!(event); input.onChange!(change(.25)); input.onChange!(change(.5));
    expect(target.setSelectionRangeRadius).not.toHaveBeenCalled(); expect(target.setTransformNumericFocus).toHaveBeenCalledTimes(1);
    input.onPointerUp!(event); input.onLostPointerCapture!(event);
    expect(target.setSelectionRangeRadius).toHaveBeenCalledExactlyOnceWith(4, 'color');
    const activity = vi.mocked(target.setTransformNumericFocus), radius = vi.mocked(target.setSelectionRangeRadius);
    expect(activity.mock.calls.map(call => call[1])).toEqual([true, false]);
    expect(radius.mock.invocationCallOrder[0]).toBeLessThan(activity.mock.invocationCallOrder[1]);
  });
  it('commits once after the last held adjustment key releases, including repeated keydowns', () => {
    const target = controller(), input = controls(target).input;
    input.onKeyDown!(key('ArrowRight')); input.onKeyDown!(key('ArrowRight')); input.onKeyDown!(key('ArrowUp'));
    input.onChange!(change(.25)); input.onChange!(change(.75)); input.onKeyUp!(key('ArrowRight'));
    expect(target.setSelectionRangeRadius).not.toHaveBeenCalled(); input.onKeyUp!(key('ArrowUp')); input.onKeyUp!(key('ArrowUp'));
    expect(target.setSelectionRangeRadius).toHaveBeenCalledExactlyOnceWith(16, 'color');
    expect(vi.mocked(target.setTransformNumericFocus).mock.calls.map(call => call[1])).toEqual([true, false]);
  });
  it.each(['cancel', 'lost', 'escape'] as const)('discards a staged pointer value on %s without any amendment', reason => {
    const target = controller(), input = controls(target).input, event = pointer();
    input.onPointerDown!(event); input.onChange!(change(.75));
    if (reason === 'cancel') input.onPointerCancel!(event);
    else if (reason === 'lost') input.onLostPointerCapture!(event);
    else input.onKeyDown!(key('Escape'));
    input.onPointerUp!(event); input.onBlur!({} as Blur);
    expect(target.setSelectionRangeRadius).not.toHaveBeenCalled();
    expect(vi.mocked(target.setTransformNumericFocus).mock.calls.map(call => call[1])).toEqual([true, false]);
  });
  it('discards an Escape-canceled held-key value and releases activity without a command on later keyup or blur', () => {
    const target = controller(), input = controls(target).input;
    input.onKeyDown!(key('ArrowRight')); input.onChange!(change(.75)); input.onKeyDown!(key('Escape'));
    input.onKeyUp!(key('ArrowRight')); input.onBlur!({} as Blur);
    expect(target.setSelectionRangeRadius).not.toHaveBeenCalled();
    expect(vi.mocked(target.setTransformNumericFocus).mock.calls.map(call => call[1])).toEqual([true, false]);
  });
  it('does not commit an old source draft from a late physical release', () => {
    const target = controller(), input = controls(target).input, event = pointer();
    input.onPointerDown!(event); input.onChange!(change(.75)); Object.assign(target, { scene: {} as AppController['scene'] });
    input.onPointerUp!(event); expect(target.setSelectionRangeRadius).not.toHaveBeenCalled();
    expect(vi.mocked(target.setTransformNumericFocus).mock.calls.map(call => call[1])).toEqual([true, false]);
  });
  it('commits a standalone assistive change immediately and does not amend again on blur', () => {
    const target = controller(), input = controls(target).input;
    input.onChange!(change(.75)); input.onBlur!({} as Blur);
    expect(target.setSelectionRangeRadius).toHaveBeenCalledExactlyOnceWith(16, 'color');
    expect(target.setTransformNumericFocus).not.toHaveBeenCalled();
  });
});

describe('physical Color and Fill press capture', () => {
  it('detaches both independent raw preferences and physical brush radius even when Range is off', () => {
    const state = { brushSize: 27.5, colorRange: { enabled: false, radius: null }, fillRange: { enabled: true, radius: 123.456789 } };
    const capture = captureSelectionRangePointerOptions(state, 2.25);
    state.colorRange.enabled = true; state.fillRange.radius = 1;
    expect(capture).toEqual({ colorRange: { enabled: false, radius: null }, fillRange: { enabled: true, radius: 123.456789 }, sampleRadiusPixels: 30.9375 });
    expect(Object.isFrozen(capture.colorRange)).toBe(true); expect(Object.isFrozen(capture.fillRange)).toBe(true);
  });
  it('preserves exact float-effective radius mapping without formatting a stored value', () => {
    expect(selectionRangeFromRatio(0, .25, 64)).toBe(.25); expect(selectionRangeFromRatio(1, .25, 64)).toBe(64);
    expect(selectionRangeFromRatio(.5, .25, 64)).toBe(4); expect(selectionRangeRatio(4, .25, 64)).toBe(.5);
    expect(selectionRangeFromRatio(selectionRangeRatio(1.23456789, .25, 64), .25, 64)).toBeCloseTo(1.23456789, 12);
    expect(selectionRangeRatio(8, 8, 8)).toBe(0); expect(selectionRangeFromRatio(.5, 8, 8)).toBe(8);
  });
});
