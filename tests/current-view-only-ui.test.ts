import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webFeatureAllowed } from '../src/app/productPolicy';
import { setApp, setSelectionPreferences, switchToolsMode, useApp } from '../src/app/store';
import { desktopIcons } from '../src/generated/desktop';
import { SelectionActions } from '../src/ui/App';

// Opt in only the retained full-editor component fixtures; other policies stay real.
const retainedFullEditorSelectionFixture = vi.hoisted(() => ({ enabled: false }));
vi.mock('../src/app/productPolicy', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/app/productPolicy')>();
  return { ...actual, webFeatureAllowed(feature: string, capabilities: readonly string[] = []) {
    if (retainedFullEditorSelectionFixture.enabled && feature === 'selection.advanced') return true;
    return actual.webFeatureAllowed(feature, capabilities);
  } };
});

const initial = useApp.getState();
beforeEach(() => {
  retainedFullEditorSelectionFixture.enabled = false;
  setApp({ ...initial, mode: 'basic', currentViewOnly: false, pendingMode: null,
  busy: false, summary: null, selectionDragging: false, pendingSelectionCount: 0,
  filter: null, transform: null, opacity: null,
  operation: 1, visibleOnly: true, overlap: true, live: false,
  selectionPreferences: { basic: { operation: 1, visibleOnly: true, overlap: true, live: false },
    pro: { operation: 0, visibleOnly: false, overlap: false, live: false } } }, true);
});
afterEach(() => { retainedFullEditorSelectionFixture.enabled = false; setApp(initial, true); vi.unstubAllGlobals(); });

function button(markup: string, name: string) {
  const tag = [...markup.matchAll(/<button\b[^>]*>/g)].find(([value]) => value.includes(`aria-label="${name}"`))?.[0];
  expect(tag, name).toBeDefined(); return tag!;
}

describe('viewer-wide current-view selection scope', () => {
  it('starts off independently of both tool profiles', () => {
    expect(initial.currentViewOnly).toBe(false);
    for (const preferences of Object.values(useApp.getState().selectionPreferences))
      expect(preferences).not.toHaveProperty('currentViewOnly');
  });

  it('preserves accepted scope across Basic/Pro changes without adding a persisted preference', () => {
    const setItem = vi.fn(); vi.stubGlobal('localStorage', { setItem });
    setSelectionPreferences({ operation: 2, visibleOnly: false, overlap: true, live: true });
    const basic = { ...useApp.getState().selectionPreferences.basic };
    setApp({ currentViewOnly: true });
    switchToolsMode('pro');
    expect(useApp.getState()).toMatchObject({ currentViewOnly: true, operation: 0, visibleOnly: false, overlap: false, live: false });
    setSelectionPreferences({ operation: 3, visibleOnly: true, overlap: false, live: true });
    const pro = { ...useApp.getState().selectionPreferences.pro };
    switchToolsMode('basic');
    expect(useApp.getState()).toMatchObject({ ...basic, currentViewOnly: true });
    setApp({ currentViewOnly: false }); switchToolsMode('pro');
    expect(useApp.getState()).toMatchObject({ ...pro, currentViewOnly: false });
    expect(useApp.getState().selectionPreferences).toEqual({ basic, pro });
    expect(setItem.mock.calls).toEqual([
      ['splatview.tools-mode.v1', 'pro'], ['splatview.tools-mode.v1', 'basic'], ['splatview.tools-mode.v1', 'pro'],
    ]);
  });

  it('keeps current-view scope while profile option assignments advance their own cancellation boundary', () => {
    setApp({ currentViewOnly: true, selectionOptionsRevision: 7 });
    setSelectionPreferences({ visibleOnly: false });
    expect(useApp.getState()).toMatchObject({ currentViewOnly: true, selectionOptionsRevision: 8 });
    expect(useApp.getState().selectionPreferences.basic).toEqual({ operation: 1, visibleOnly: false, overlap: true, live: false });
    expect(useApp.getState().selectionPreferences.pro).toEqual({ operation: 0, visibleOnly: false, overlap: false, live: false });
  });

  it.each([false, true])('retains full-editor rendering of pressed=%s as the fourth joined desktop action without an active tool', currentViewOnly => {
    retainedFullEditorSelectionFixture.enabled = true;
    const markup = renderToStaticMarkup(createElement(SelectionActions, {
      enabled: true, selected: 0, currentViewOnly, onCommand() {}, onCurrentViewOnly() {},
    }));
    const selection = markup.match(/role="group" aria-label="Selection actions">(.*?)<\/div>/s)?.[1];
    expect(selection).toBeDefined();
    expect([...selection!.matchAll(/<button\b[^>]*aria-label="([^"]+)"/g)].map(match => match[1]))
      .toEqual(['Select all', 'Clear selection', 'Invert selection', 'Current view only']);
    expect(button(markup, 'Current view only')).toContain(`aria-pressed="${currentViewOnly}"`);
    expect(button(markup, 'Current view only')).toContain('title="Current view only\nLimit selection and selected edits to the camera frustum"');
    expect(selection).toContain(desktopIcons.Frustum);
    expect(button(markup, 'Current view only')).not.toContain('disabled=');
    expect(button(markup, 'Clear selection')).toContain('disabled=');
  });

  it.each([false, true])('retains full-editor controller readiness=%s independently of ordinary edit-action availability', currentViewOnlyEnabled => {
    retainedFullEditorSelectionFixture.enabled = true;
    const markup = renderToStaticMarkup(createElement(SelectionActions, {
      enabled: false, selected: 3, currentViewOnly: true, currentViewOnlyEnabled, onCommand() {}, onCurrentViewOnly() {},
    }));
    expect(button(markup, 'Current view only').includes('disabled=')).toBe(!currentViewOnlyEnabled);
    expect(markup.startsWith('<fieldset disabled=""')).toBe(!currentViewOnlyEnabled);
    for (const label of ['Select all', 'Clear selection', 'Invert selection', 'Delete selected', 'Keep selected'])
      expect(button(markup, label)).toContain('disabled=');
  });

  it('omits Current view only under actual web-lite policy while preserving manual selection and cleanup actions', () => {
    expect(webFeatureAllowed('selection.advanced')).toBe(false);
    const onCommand = vi.fn(), onCurrentViewOnly = vi.fn();
    const markup = renderToStaticMarkup(createElement(SelectionActions, {
      enabled: true, selected: 3, currentViewOnly: true, onCommand, onCurrentViewOnly,
    }));
    const selection = markup.match(/role="group" aria-label="Selection actions">(.*?)<\/div>/s)?.[1];
    expect(selection).toBeDefined();
    expect([...selection!.matchAll(/<button\b[^>]*aria-label="([^"]+)"/g)].map(match => match[1]))
      .toEqual(['Select all', 'Clear selection', 'Invert selection']);
    expect(markup).not.toContain('aria-label="Current view only"');
    expect(markup).not.toContain('data-tutorial-target="current-view"');
    for (const label of ['Select all', 'Clear selection', 'Invert selection', 'Delete selected', 'Keep selected', 'Selection controls'])
      expect(button(markup, label)).not.toContain('disabled=');
    expect(onCommand).not.toHaveBeenCalled(); expect(onCurrentViewOnly).not.toHaveBeenCalled();
  });
});
