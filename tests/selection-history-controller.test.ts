import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppController } from '../src/app/controller';
import { setApp, switchToolsMode, useApp } from '../src/app/store';
import type { CoreClient } from '../src/document/coreClient';
import type { NativeSummary } from '../src/document/types';

const initial = useApp.getState(), watches = new Set<() => void>();
function summary(revision = 10, undoSelectionRevision = 6): NativeSummary {
  return { ok: true, loaded: true, kind: 0, count: 5, sourceCount: 5, selected: 0, visible: 5,
    duplicateRange: null, shDegree: 0, format: 'PLY', revision, undoSelectionRevision, contentRevision: 0,
    canUndo: true, canRedo: false, transaction: false, selectionDraft: false, sceneChanged: false, pending: false, progress: 1,
    center: [0, 0, 0], radius: 1, yUp: false, camera: [0, 0, 0, 0, 0, 3, 1, 45, 0, 0, 1], memoryBytes: 720,
    selectionMapId: null, pendingSelectionMapId: null, selectionMapBytes: 0, selectionMapRetainedIds: [],
    floor: null, filter: null, transformSession: null, opacitySession: null,
    toleranceSessionId: null, toleranceTool: null, toleranceRange: null, toleranceRecorded: null };
}
beforeEach(() => setApp({ ...initial, ready: true, busy: false, mode: 'pro', tool: null, summary: summary() }, true));
afterEach(() => { for (const unwatch of watches) unwatch(); watches.clear(); setApp(initial, true); vi.restoreAllMocks(); });
function fixture() {
  const controller = new AppController();
  const client = { revision: { documentId: 'ea000001-0000-4000-8000-000000000001', sourceGeneration: 1,
    selectionRevision: 10, contentRevision: 0, draftRevision: 0 } };
  controller.client = client as unknown as CoreClient;
  const unwatch = controller.trackManualSelectionHistory(); watches.add(unwatch);
  const publish = (patch: Partial<NativeSummary>) => {
    if (patch.revision !== undefined) client.revision.selectionRevision = patch.revision;
    setApp({ summary: { ...useApp.getState().summary!, ...patch } });
  };
  return { controller, client, publish, unwatch };
}

describe('native top-entry selection history and continuous manual sessions', () => {
  it('hides pre-entry history, then retains any new zero-result selection stroke', () => {
    const f = fixture(); setApp({ tool: 'brush' });
    expect(f.controller.manualSelectionActionsVisible).toBe(false);
    f.publish({ revision: 11, undoSelectionRevision: 11 });
    expect(f.controller.manualSelectionActionsVisible).toBe(true);
  });
  it('does not turn a no-op or unrelated revision advance into selection history', () => {
    const f = fixture(); setApp({ tool: 'single' });
    f.publish({ revision: 100, undoSelectionRevision: 6 });
    expect(f.controller.manualSelectionActionsVisible).toBe(false);
    f.publish({ revision: 101, undoSelectionRevision: 0 });
    expect(f.controller.manualSelectionActionsVisible).toBe(false);
  });
  it('preserves one boundary across all manual tool switches, rearm, and Basic/Pro changes', () => {
    const f = fixture(); setApp({ tool: 'single' }); f.publish({ revision: 11, undoSelectionRevision: 11 });
    for (const tool of ['brush', 'volume', 'rectangle', 'polygon', 'color', 'fill', 'fill'] as const) {
      setApp({ tool }); expect(f.controller.manualSelectionActionsVisible).toBe(true);
    }
    switchToolsMode('basic'); expect(f.controller.manualSelectionActionsVisible).toBe(true);
    switchToolsMode('pro'); expect(f.controller.manualSelectionActionsVisible).toBe(true);
  });
  it('starts a fresh boundary after Orbit and does not reclassify old Redo as a new stroke', () => {
    const f = fixture(); setApp({ tool: 'single' }); f.publish({ revision: 11, undoSelectionRevision: 11 });
    f.publish({ revision: 12, undoSelectionRevision: 6, canRedo: true });
    expect(f.controller.manualSelectionActionsVisible).toBe(false);
    f.publish({ revision: 13, undoSelectionRevision: 11 });
    expect(f.controller.manualSelectionActionsVisible).toBe(true);
    setApp({ tool: null }); setApp({ tool: 'brush' });
    expect(f.controller.manualSelectionActionsVisible).toBe(false);
    f.publish({ revision: 14, undoSelectionRevision: 6, canRedo: true });
    f.publish({ revision: 15, undoSelectionRevision: 11 });
    expect(f.controller.manualSelectionActionsVisible).toBe(false);
    f.publish({ revision: 16, undoSelectionRevision: 16 });
    expect(f.controller.manualSelectionActionsVisible).toBe(true);
  });
  it('uses only the top entry, excluding a draft, a nonselection entry, and exhausted history', () => {
    const f = fixture(); setApp({ tool: 'rectangle' }); f.publish({ revision: 11, undoSelectionRevision: 11 });
    expect(f.controller.manualSelectionActionsVisible).toBe(true);
    f.publish({ selectionDraft: true }); expect(f.controller.manualSelectionActionsVisible).toBe(false);
    f.publish({ selectionDraft: false, revision: 12, undoSelectionRevision: 0 });
    expect(f.controller.manualSelectionActionsVisible).toBe(false);
    f.publish({ canUndo: false }); expect(f.controller.manualSelectionActionsVisible).toBe(false);
  });
  it('preserves a native session through graphics-only generation and temporary readiness changes', () => {
    const f = fixture(); setApp({ tool: 'polygon' }); f.publish({ revision: 11, undoSelectionRevision: 11 });
    (f.controller as unknown as { generation: number }).generation++;
    setApp({ ready: false, rendererState: 'recovering' }); setApp({ ready: true, rendererState: 'ready' });
    expect(f.controller.manualSelectionActionsVisible).toBe(true);
  });
  it('does not carry a session into another source, even if its tool name remains', () => {
    const f = fixture(); setApp({ tool: 'color' }); f.publish({ revision: 11, undoSelectionRevision: 11 });
    f.client.revision.sourceGeneration++; f.publish({ revision: 20, undoSelectionRevision: 19 });
    expect(f.controller.manualSelectionActionsVisible).toBe(false);
    f.publish({ revision: 21, undoSelectionRevision: 21 }); expect(f.controller.manualSelectionActionsVisible).toBe(true);
  });
  it('accepts recovered old history with zero stamps and starts a new session after worker replacement', () => {
    const f = fixture(); setApp({ tool: 'fill' }); f.publish({ revision: 11, undoSelectionRevision: 11 });
    setApp({ tool: null }); controllerReplace(); setApp({ tool: 'fill' });
    expect(f.controller.manualSelectionActionsVisible).toBe(false);
    function controllerReplace() {
      f.controller.client = { revision: { ...f.client.revision, selectionRevision: 50, documentId: 'ea000002-0000-4000-8000-000000000002' } } as unknown as CoreClient;
      setApp({ summary: { ...summary(50, 0), canUndo: true } });
    }
  });
  it('retires the lifecycle observer instead of retaining a viewer subscription', () => {
    const f = fixture(); setApp({ tool: 'brush' }); f.publish({ revision: 11, undoSelectionRevision: 11 });
    expect(f.controller.manualSelectionActionsVisible).toBe(true); f.unwatch(); watches.delete(f.unwatch);
    f.publish({ revision: 12, undoSelectionRevision: 12 });
    expect(f.controller.manualSelectionActionsVisible).toBe(false);
  });
});
