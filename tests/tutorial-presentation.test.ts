import { createElement, type EffectCallback } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webFeatureAllowed } from '../src/app/productPolicy';
import { setApp, useApp } from '../src/app/store';
import { transformDefaults } from '../src/document/transformProtocol';
import { SelectionActions } from '../src/ui/SelectionControls';
import { TutorialSelectionActions } from '../src/ui/FloatingSelectionActions';
import { SelectionRangeTutorial } from '../src/ui/SelectionRangeControl';
import { SelectionMorphology } from '../src/ui/SelectionMorphology';
import { TransformControls } from '../src/ui/TransformControls';

const lifecycle = vi.hoisted(() => ({ effects: [] as EffectCallback[] }));
// The full-editor target fixture opts in locally; the default remains web-lite.
const retainedFullEditorSelectionFixture = vi.hoisted(() => ({ enabled: false }));
vi.mock('../src/app/productPolicy', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/app/productPolicy')>();
  return { ...actual, webFeatureAllowed(feature: string, capabilities: readonly string[] = []) {
    if (retainedFullEditorSelectionFixture.enabled && feature === 'selection.advanced') return true;
    return actual.webFeatureAllowed(feature, capabilities);
  } };
});
vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof import('react')>(),
  useEffect: (effect: EffectCallback) => { lifecycle.effects.push(effect); },
}));
vi.mock('../src/app/store', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/app/store')>();
  return { ...actual, useApp: Object.assign(() => actual.useApp.getState(), actual.useApp) };
});
const initial = useApp.getState();
beforeEach(() => {
  retainedFullEditorSelectionFixture.enabled = false;
  useApp.setState(initial, true); lifecycle.effects.length = 0;
  setApp({ mode: 'basic', tool: null, toolsOpen: false,
    colorRange: { enabled: false, radius: 1000.123456789 }, fillRange: { enabled: true, radius: .333333333333 } });
});
afterEach(() => { retainedFullEditorSelectionFixture.enabled = false; useApp.setState(initial, true); lifecycle.effects.length = 0; });
const tags = (markup: string, name: string) => markup.match(new RegExp(`<${name}\\b[^>]*>`, 'g')) ?? [];

describe('current desktop tutorial presentation without editor ownership', () => {
  it('shows an inert disabled Radius example without reading or changing raw Range preferences', () => {
    const state = useApp.getState(), markup = renderToStaticMarkup(createElement(SelectionRangeTutorial));
    expect(markup).toContain('data-tutorial-demo="range"'); expect(markup).toContain('data-tutorial-target="range"');
    expect(markup).toContain('aria-hidden="true"'); expect(markup).toContain('inert=""');
    const inputs = tags(markup, 'input'); expect(inputs).toHaveLength(1);
    expect(inputs[0]).toContain('aria-label="Radius"'); expect(inputs[0]).toContain('disabled=""');
    expect(inputs[0]).toContain('aria-valuenow="1"'); expect(useApp.getState()).toBe(state);
    expect(useApp.getState().colorRange).toEqual({ enabled: false, radius: 1000.123456789 });
    expect(useApp.getState().fillRange).toEqual({ enabled: true, radius: .333333333333 });
    expect(lifecycle.effects).toHaveLength(0);
  });
  it('shares three disabled Check/Undo/Clear icons without mounting a real tray or its anchor effects', () => {
    const state = useApp.getState(), markup = renderToStaticMarkup(createElement(TutorialSelectionActions, { scale: 1.25 }));
    expect(markup).toContain('data-tutorial-target="selection-finish"'); expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('inert=""'); expect(markup).toContain('--selection-action-scale:1.25');
    const buttons = tags(markup, 'button'); expect(buttons).toHaveLength(3);
    expect(buttons.every(button => button.includes('disabled=""'))).toBe(true);
    expect(buttons[0]).toContain('title="Finish selection tool (keeps selection)"');
    expect(buttons[1]).toContain('aria-label="Undo (Selection)"'); expect(buttons[2]).toContain('aria-label="Clear selection (C)"');
    expect(lifecycle.effects).toHaveLength(0); expect(useApp.getState()).toBe(state);
  });
  it('retains separate full-editor target groups for selection actions, selected edits, current view and duplication', () => {
    retainedFullEditorSelectionFixture.enabled = true;
    const markup = renderToStaticMarkup(createElement(SelectionActions, { enabled: true, selected: 5, pro: true,
      duplicateEnabled: true, onCommand: vi.fn() }));
    const buttons = tags(markup, 'button'), button = (label: string) => buttons.find(tag => tag.includes(`aria-label="${label}"`))!;
    for (const label of ['Select all', 'Clear selection', 'Invert selection']) expect(button(label)).toContain('data-tutorial-target="actions"');
    for (const label of ['Delete selected', 'Keep selected']) expect(button(label)).toContain('data-tutorial-target="selection-edits"');
    expect(button('Current view only')).toContain('data-tutorial-target="current-view"');
    expect(button('Duplicate selection')).toContain('data-tutorial-target="duplicate"');
    expect(button('Selection controls')).not.toContain('data-tutorial-target');
  });
  it('omits the excluded current-view target under actual web-lite policy without removing manual action targets', () => {
    expect(webFeatureAllowed('selection.advanced')).toBe(false);
    const state = useApp.getState(), onCommand = vi.fn(), onCurrentViewOnly = vi.fn();
    const markup = renderToStaticMarkup(createElement(SelectionActions, { enabled: true, selected: 5,
      currentViewOnly: true, onCommand, onCurrentViewOnly }));
    const buttons = tags(markup, 'button'), button = (label: string) => buttons.find(tag => tag.includes(`aria-label="${label}"`))!;
    expect(markup).not.toContain('aria-label="Current view only"');
    expect(markup).not.toContain('data-tutorial-target="current-view"');
    for (const label of ['Select all', 'Clear selection', 'Invert selection']) expect(button(label)).toContain('data-tutorial-target="actions"');
    for (const label of ['Delete selected', 'Keep selected']) expect(button(label)).toContain('data-tutorial-target="selection-edits"');
    expect(button('Selection controls')).not.toContain('disabled=');
    expect(onCommand).not.toHaveBeenCalled(); expect(onCurrentViewOnly).not.toHaveBeenCalled(); expect(useApp.getState()).toBe(state);
  });
  it('presents disabled Euler/pivot controls while preserving a real Matrix representation and profile', () => {
    const parameters = { ...transformDefaults(), mode: 'matrix' as const }, original = structuredClone(parameters), state = useApp.getState();
    const markup = renderToStaticMarkup(createElement(TransformControls, { parameters, mode: 'pro', presentationOnly: true,
      enabled: true, applyEnabled: true, cancelEnabled: true, pending: false, dirty: true,
      gizmoMode: 'scale', gizmoEnabled: true, localAxes: true, snap: true,
      pivotMode: 'custom', pivotChosen: true, pivotPending: false, hasSelected: true,
      onParameters: vi.fn(), onFlip: vi.fn(), onCyclePivot: vi.fn(), onApply: vi.fn(), onCancel: vi.fn(),
      onGizmo: vi.fn(), onLocalAxes: vi.fn(), onSnap: vi.fn() }));
    expect(markup).toContain('data-tutorial-target="gizmo"'); expect(markup).toContain('data-tutorial-target="coordinates"');
    expect(markup).toContain('data-tutorial-target="snap-flips"'); expect(markup).toContain('data-tutorial-target="pivot"');
    expect(markup).toContain('data-tutorial-target="transform-values"'); expect(markup).toContain('aria-label="Rotation XYZ X"');
    expect(markup).not.toContain('Affine matrix row');
    const controls = [...tags(markup, 'input'), ...tags(markup, 'button')];
    expect(controls.length).toBeGreaterThan(12); expect(controls.every(control => control.includes('disabled=""'))).toBe(true);
    expect(parameters).toEqual(original); expect(useApp.getState()).toBe(state); expect(state.mode).toBe('basic');
  });
  it('suppresses Pro morphology query ownership only for presentation, retaining ordinary query behavior', () => {
    const controller: Parameters<typeof SelectionMorphology>[0]['controller'] = {
      selectionMorphologyControlsEnabled: true, selectionMorphologyVolumeEnabled: true, selectionMorphologyRange: null,
      ensureSelectionMorphologyRange: vi.fn(async () => false), setSelectionMorphologyMethod: vi.fn(),
      setSelectionDistance: vi.fn(), setSelectionSigma: vi.fn(), command: vi.fn(async () => true),
    };
    setApp({ selectionMorphologyMethod: 'volume' }); const state = useApp.getState();
    const markup = renderToStaticMarkup(createElement(SelectionMorphology, { controller, displayMode: 'pro', presentationOnly: true }));
    for (const effect of lifecycle.effects.splice(0)) effect();
    expect(controller.ensureSelectionMorphologyRange).not.toHaveBeenCalled(); expect(controller.command).not.toHaveBeenCalled();
    expect([...tags(markup, 'input'), ...tags(markup, 'button')].every(control => control.includes('disabled=""'))).toBe(true);
    expect(useApp.getState()).toBe(state);
    renderToStaticMarkup(createElement(SelectionMorphology, { controller, displayMode: 'pro' }));
    for (const effect of lifecycle.effects.splice(0)) effect();
    expect(controller.ensureSelectionMorphologyRange).toHaveBeenCalledExactlyOnceWith();
  });
});
