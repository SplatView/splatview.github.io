import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setApp, switchToolsMode, useApp } from '../src/app/store';
import type { NativeSummary } from '../src/document/types';
import { currentDesktopIcons } from '../src/generated/currentDesktopIcons';
import { desktopIcons } from '../src/generated/desktop';
import { SelectionMorphology, morphologyDiameter, morphologyFromRatio, morphologyRatio } from '../src/ui/SelectionMorphology';

vi.mock('../src/app/store', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/app/store')>();
  return { ...actual, useApp: Object.assign(() => actual.useApp.getState(), actual.useApp) };
});
const initial = useApp.getState();
// A presentation-only summary: no claim of native admission or scene math.
const summary = { selected: 1, visible: 3, kind: 0, count: 3, duplicateRange: null, contentRevision: 0 } as unknown as NativeSummary;
function controller(): Parameters<typeof SelectionMorphology>[0]['controller'] {
  return { selectionMorphologyControlsEnabled: true, selectionMorphologyVolumeEnabled: true,
    selectionMorphologyRange: { minimum: .125, maximum: 8, value: .75 },
    ensureSelectionMorphologyRange: vi.fn().mockResolvedValue(true), setSelectionMorphologyMethod: vi.fn(),
    setSelectionDistance: vi.fn(), setSelectionSigma: vi.fn(), command: vi.fn().mockResolvedValue(true) };
}
function button(markup: string, name: string) {
  const tag = [...markup.matchAll(/<button\b[^>]*>/g)].find(([value]) => value.includes(`aria-label="${name}"`))?.[0];
  expect(tag, name).toBeDefined(); return tag!;
}
const render = (target = controller(), displayMode?: 'basic' | 'pro') => renderToStaticMarkup(createElement(SelectionMorphology, { controller: target, displayMode }));
beforeEach(() => setApp({ ...initial, mode: 'pro', ready: true, busy: false, toolsOpen: true, summary,
  selectionMorphologyMethod: 'volume', selectionDistance: null, selectionSigma: 1,
  filter: null, transform: null, opacity: null, pendingMode: null, pendingSelectionCount: 0, selectionDragging: false }, true));
afterEach(() => { setApp(initial, true); vi.unstubAllGlobals(); });

describe('committed Pro morphology presentation', () => {
  it('starts in Volume with automatic reach and sigma 1, outside both profile preference objects', () => {
    expect(initial).toMatchObject({ selectionMorphologyMethod: 'volume', selectionDistance: null, selectionSigma: 1 });
    for (const profile of Object.values(initial.selectionPreferences)) {
      expect(profile).not.toHaveProperty('selectionMorphologyMethod'); expect(profile).not.toHaveProperty('selectionDistance');
      expect(profile).not.toHaveProperty('selectionSigma');
    }
  });
  it('hides all refinement controls in Basic and permits Pro tutorial presentation without changing that profile', () => {
    setApp({ mode: 'basic' }); expect(render()).toBe('');
    expect(render(controller(), 'pro')).toContain('aria-label="Morphology volume"');
    expect(useApp.getState().mode).toBe('basic');
  });
  it('orders Grow, Shrink, Volume and Sigma with the committed icons and one full-width Diameter row', () => {
    const markup = render();
    expect([...markup.matchAll(/<button\b[^>]*aria-label="([^"]+)"/g)].map(match => match[1]))
      .toEqual(['Grow selection', 'Shrink selection', 'Morphology volume', 'Morphology sigma']);
    for (const name of ['Grow', 'Shrink', 'Sphere', 'Ellipsoid']) {
      const svg = currentDesktopIcons[name] ?? desktopIcons[name];
      expect(svg, `Explicit desktop icon ${name} must resolve`).toBeDefined();
      expect(svg.trim().length).toBeGreaterThan(0); expect(svg).toMatch(/^<svg\b/);
      expect(svg).not.toBe(desktopIcons.Help); expect(markup).toContain(svg);
    }
    expect(markup).toContain('slider-row selection-morphology-parameter');
    expect(markup).toContain('aria-label="Diameter"'); expect(markup).toContain('aria-valuemin="0.25"');
    expect(markup).toContain('aria-valuemax="16"'); expect(markup).toContain('aria-valuenow="1.5"');
    expect(button(markup, 'Morphology volume')).toContain('aria-pressed="true"');
    expect(button(markup, 'Morphology sigma')).toContain('aria-pressed="false"');
  });
  it('renders Sigma half-step bounds independently of source distance availability', () => {
    setApp({ selectionMorphologyMethod: 'sigma', selectionSigma: 2.5 }); const target = controller();
    Object.assign(target, { selectionMorphologyRange: null, selectionMorphologyVolumeEnabled: false });
    const markup = render(target);
    expect(markup).toContain('aria-label="Sigma"'); expect(markup).toContain('min="0.5"');
    expect(markup).toContain('max="10"'); expect(markup).toContain('step="0.5"');
    expect(button(markup, 'Grow selection')).not.toContain('disabled'); expect(markup).not.toContain('aria-label="Diameter"');
  });
  it.each([0, 3])('keeps method and parameter controls available without a live boundary (selected=%d)', selected => {
    setApp({ summary: { ...summary, selected } }); const markup = render();
    expect(button(markup, 'Grow selection')).toContain('disabled'); expect(button(markup, 'Shrink selection')).toContain('disabled');
    expect(button(markup, 'Morphology volume')).not.toContain('disabled'); expect(button(markup, 'Morphology sigma')).not.toContain('disabled');
    expect(markup.match(/<input\b[^>]*aria-label="Diameter"[^>]*>/)?.[0]).not.toContain('disabled');
    if (selected === 3) { setApp({ currentViewOnly: true }); expect(button(render(), 'Grow selection')).not.toContain('disabled'); }
  });
  it('does not dispatch or manufacture source bounds while rendering an unavailable Volume range', () => {
    const target = controller(); Object.assign(target, { selectionMorphologyRange: null, selectionMorphologyVolumeEnabled: false });
    const markup = render(target); expect(button(markup, 'Grow selection')).toContain('disabled');
    expect(markup.match(/<input\b[^>]*aria-label="Diameter"[^>]*>/)?.[0]).toContain('disabled');
    expect(button(markup, 'Morphology sigma')).not.toContain('disabled');
    expect(target.command).not.toHaveBeenCalled(); expect(target.ensureSelectionMorphologyRange).not.toHaveBeenCalled();
    expect(target.setSelectionDistance).not.toHaveBeenCalled();
  });
  it('disables every method and parameter when controller ownership refuses input', () => {
    const target = controller(); Object.assign(target, { selectionMorphologyControlsEnabled: false }); const markup = render(target);
    for (const name of ['Grow selection', 'Shrink selection', 'Morphology volume', 'Morphology sigma']) expect(button(markup, name)).toContain('disabled');
    expect(markup.match(/<input\b[^>]*aria-label="Diameter"[^>]*>/)?.[0]).toContain('disabled');
  });
  it('retains raw session preferences through profile and source reset patches without serializing them', () => {
    const setItem = vi.fn(); vi.stubGlobal('localStorage', { setItem });
    setApp({ selectionDistance: 125.123456789, selectionMorphologyMethod: 'sigma', selectionSigma: 4.5 });
    switchToolsMode('basic'); setApp({ summary: null, sourceName: '', dirty: false }); switchToolsMode('pro');
    expect(useApp.getState()).toMatchObject({ selectionDistance: 125.123456789, selectionMorphologyMethod: 'sigma', selectionSigma: 4.5 });
    expect(setItem.mock.calls).toEqual([['splatview.tools-mode.v1', 'basic'], ['splatview.tools-mode.v1', 'pro']]);
  });
  it('preserves float precision and logarithmic endpoints without using formatted display text as the reach', () => {
    const reach = Math.fround(.123456789); expect(morphologyDiameter(reach)).toBe(Math.fround(.246913578));
    expect(morphologyFromRatio(0, .25, 64)).toBe(.25); expect(morphologyFromRatio(1, .25, 64)).toBe(64);
    expect(morphologyFromRatio(.5, .25, 64)).toBe(4); expect(morphologyRatio(4, .25, 64)).toBe(.5);
    expect(morphologyFromRatio(morphologyRatio(1.23456789, .25, 64), .25, 64)).toBeCloseTo(1.23456789, 12);
    expect(morphologyRatio(.25, .25, .25)).toBe(0);
  });
});
