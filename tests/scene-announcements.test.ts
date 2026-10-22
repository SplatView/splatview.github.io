import { describe, expect, it } from 'vitest';
import { translate, TRANSLATED_LOCALES } from '../src/app/i18n';
import type { UiLocale } from '../src/app/languagePreferences';
import { CANVAS_INSTRUCTIONS, sceneAnnouncement } from '../src/app/sceneAnnouncements';
import { useApp } from '../src/app/store';
import { accessibilityTranslations } from '../src/app/translations/accessibility';
import type { NativeSummary } from '../src/document/types';

type State = ReturnType<typeof useApp.getState>;
const initial = useApp.getState();
const summary = (patch: Partial<NativeSummary> = {}): NativeSummary => ({
  ok: true, duplicateRange: null, loaded: true, count: 12, sourceCount: 12, shDegree: 0, format: 'ply', kind: 0, selected: 3, visible: 10,
  canUndo: true, canRedo: false, revision: 1, contentRevision: 1, transaction: false, selectionDraft: false,
  sceneChanged: false, pending: false, progress: 0, center: [0, 0, 0], radius: 1, yUp: true, camera: [], memoryBytes: 0,
  selectionMapId: null, pendingSelectionMapId: null, selectionMapBytes: 0, selectionMapRetainedIds: [],
  floor: null, filter: null, transformSession: null, opacitySession: null, ...patch,
});
const state = (patch: Partial<State> = {}): State => ({ ...initial,
  ready: true, busy: false, stage: '', progress: 0, error: null, rendererState: 'ready', bootstrapState: 'ready',
  selectionRecovery: 'idle', memoryOverageBytes: 0, sourceName: 'retained.ply', summary: summary(), mode: 'basic', pendingMode: null,
  tool: 'brush', operation: 1, selectionOperation: null, selectionModifiers: 0, fly: false, autoOrbit: false,
  settingsOpen: false, exportOpen: false, navigationPrompt: false, outputPending: false, savedViewChoices: [],
  thumbnailPending: false, viewTransferPending: false, selectionDragging: false, pendingSelectionCount: 0,
  filter: null, transform: null, opacity: null, alignmentTool: null, alignmentPicking: false,
  filterGizmoDragging: false, transformGizmoDragging: false, filterCenterPending: false, ...patch,
});
const filter = (operation = 0, phase: NonNullable<State['filter']>['phase'] = 'ready'): NonNullable<State['filter']> => ({
  kind: 'box', phase, parameters: initial.filterParameters, operation, dirty: false, desiredRevision: 0, previewRevision: null, id: 1,
});
const transform = (phase: NonNullable<State['transform']>['phase']): NonNullable<State['transform']> => ({
  phase, kind: 'gizmo', selectedOnly: false, id: 1, baseId: 2, dirty: false, desiredRevision: 0, appliedRevision: null,
});
const opacity = (phase: NonNullable<State['opacity']>['phase']): NonNullable<State['opacity']> => ({
  phase, selectedOnly: false, id: 1, baseId: 2, dirty: false, desiredRevision: 0, appliedRevision: null,
});

describe('bounded current scene announcements', () => {
  it('describes the retained current scene without treating readiness as an edit receipt', () => {
    const before = state();
    const expected = 'Ready. retained.ply. 3 selected of 10 visible. Basic mode. Brush. Combine: Add.';
    expect(sceneAnnouncement(before, 'en')).toBe(expected);
    expect(sceneAnnouncement({ ...before, dirty: true, summary: summary({ canRedo: true, revision: 90, contentRevision: 82 }) }, 'en')).toBe(expected);
    expect(sceneAnnouncement({ ...before, dirty: false, summary: summary({ sceneChanged: true, revision: 91 }) }, 'en')).toBe(expected);
    expect(expected).not.toMatch(/saved|opened|succeeded|completed/i);
  });

  it('keeps an unsuccessful or cancelled replacement distinct from the retained old source', () => {
    const opening = state({ busy: true, stage: 'Opening scene', sourceName: 'old-source.ply' });
    expect(sceneAnnouncement(opening, 'en')).toBe('Opening a scene.');
    expect(sceneAnnouncement({ ...opening, error: 'New source refused' }, 'en')).toBe('');
    const retained = sceneAnnouncement({ ...opening, busy: false, stage: '', error: null }, 'en');
    expect(retained).toContain('Ready. old-source.ply.');
    expect(retained).not.toMatch(/new|opened|loaded|succeeded/i);
    const replaced = sceneAnnouncement({ ...opening, busy: false, stage: '', sourceName: 'new-source.ply', summary: summary({ selected: 0, visible: 8 }) }, 'en');
    expect(replaced).toContain('Ready. new-source.ply. 0 selected of 8 visible.');
  });

  it.each(['Finding scene files', 'Opening scene', 'Reading SOG metadata', 'Reading scene', 'Decoding scene', 'Preparing scene'])('normalizes %s and its numeric progress without naming the retained source', stage => {
    const opening = state({ busy: true, stage, sourceName: 'old-source.ply', summary: summary({ selectionDraft: true }) });
    for (const progress of [0, .02, .4, .99, 1]) expect(sceneAnnouncement({ ...opening, progress }, 'en')).toBe('Opening a scene.');
  });

  it.each([
    ['pointer gesture', { selectionDragging: true }],
    ['native draft', { summary: summary({ selectionDraft: true, selected: 9 }) }],
    ['native pending selection', { summary: summary({ pending: true, selected: 8 }) }],
    ['filter gizmo', { filterGizmoDragging: true }],
    ['transform gizmo', { transformGizmoDragging: true }],
    ['alignment pick', { alignmentPicking: true }],
    ['filter center pick', { filterCenterPending: true }],
    ['filter preview', { filter: filter(0, 'previewing') }],
    ['transform preview', { transform: transform('applying') }],
    ['opacity preview', { opacity: opacity('applying') }],
  ] satisfies [string, Partial<State>][])('holds the settled message during %s instead of publishing live counts', (_label, patch) => {
    const preview = state({ ...patch, busy: true, stage: 'Applying edit' });
    expect(sceneAnnouncement(preview, 'en')).toBeNull();
    expect(sceneAnnouncement({ ...preview, progress: .99, gradeRevision: 999, selectionOptionsRevision: 101,
      opacityPreviewRevision: 222 }, 'en')).toBeNull();
  });

  it('does not turn a transient live rollback into an operation completion announcement', () => {
    const retained = sceneAnnouncement(state(), 'en');
    expect(sceneAnnouncement(state({ selectionDragging: true, selectionRecovery: 'restoring', busy: true }), 'en')).toBeNull();
    expect(sceneAnnouncement(state({ selectionDragging: true, pendingSelectionCount: 2, busy: true }), 'en')).toBeNull();
    expect(sceneAnnouncement(state({ busy: false, summary: summary({ canRedo: true, revision: 12 }) }), 'en')).toBe(retained);
  });

  it.each([
    ['error', { error: 'Unrelated native error' }],
    ['required restoration', { selectionRecovery: 'required' }],
    ['bootstrap failure', { bootstrapState: 'failed' }],
    ['unknown edit outcome', { operationRecovery: 'required' }],
    ['memory admission', { memoryOverageBytes: 1 }],
    ['filter restoration', { filter: filter(0, 'required') }],
    ['transform restoration', { transform: transform('required') }],
    ['opacity restoration', { opacity: opacity('required') }],
    ['Settings', { settingsOpen: true }],
    ['Save', { exportOpen: true }],
    ['Unsaved', { navigationPrompt: true }],
    ['output acknowledgement', { outputPending: true }],
    ['saved-view chooser', { savedViewChoices: [{ recordId: 'choice' } as State['savedViewChoices'][number]] }],
  ] satisfies [string, Partial<State>][])('clears the scene message for %s even during recovery or preview', (_label, patch) => {
    expect(sceneAnnouncement(state({ ...patch, busy: true, rendererState: 'recovering', selectionDragging: true }), 'en')).toBe('');
  });

  it('gives source closing and graphics recovery stable priority over transient old drafts', () => {
    expect(sceneAnnouncement(state({ busy: true, stage: 'Closing scene', selectionDragging: true }), 'en')).toBe('Closing the scene.');
    expect(sceneAnnouncement(state({ rendererState: 'recovering', summary: summary({ selectionDraft: true }), ready: false }), 'en')).toBe('Restoring graphics.');
    expect(sceneAnnouncement(state({ bootstrapState: 'initializing', ready: false }), 'en')).toBe('Starting viewer.');
    expect(sceneAnnouncement(state({ ready: false, rendererState: 'unavailable' }), 'en')).toBe('Viewer is not ready.');
    expect(sceneAnnouncement(state({ selectionRecovery: 'restoring' }), 'en')).toBe('Restoring selection.');
  });

  it.each([
    { busy: true, stage: 'Applying edit' }, { busy: true, stage: 'Detecting floor' },
    { busy: true, stage: 'Finishing current operation' }, { busy: true, stage: 'Exporting scene' },
    { busy: true, stage: 'Opaque technical stage 0xABCD' }, { thumbnailPending: true }, { viewTransferPending: true },
    { pendingSelectionCount: 2, tool: 'color', summary: summary({ pending: true }) },
  ] satisfies Partial<State>[])('case %#: describes stable work without treating a busy flag as success: %o', patch => {
    expect(sceneAnnouncement(state(patch), 'en')).toBe('Scene work in progress.');
    expect(sceneAnnouncement(state({ ...patch, progress: .99 }), 'en')).toBe('Scene work in progress.');
  });

  it('reports no scene when an idle unpopulated summary retains an obsolete filename', () => {
    const result = sceneAnnouncement(state({ summary: summary({ loaded: false }), sourceName: 'obsolete.ply', tool: null }), 'en');
    expect(result).toBe('No scene open. Basic mode. Orbit navigation.');
    expect(result).not.toContain('obsolete');
    expect(sceneAnnouncement(state({ summary: null, tool: null, fly: true, mode: 'pro' }), 'en'))
      .toBe('No scene open. Pro mode. Look navigation.');
  });

  it.each([
    [{ operation: 2 }, 'Subtract'], [{ operation: 2, selectionModifiers: 1 }, 'Add'],
    [{ operation: 1, selectionModifiers: 2 }, 'Subtract'], [{ operation: 0, selectionModifiers: 3 }, 'Intersect'],
    [{ operation: 2, selectionModifiers: 3, selectionOperation: 0 }, 'Replace'],
    [{ operation: 0, selectionModifiers: 3, selectionOperation: 2, filter: filter(1) }, 'Add'],
  ] satisfies [Partial<State>, string][])('uses the same effective Combine precedence as the visible controls: %o', (patch, name) => {
    expect(sceneAnnouncement(state(patch), 'en')).toContain(`Combine: ${name}.`);
  });

  it('uses the current mode rather than a deferred requested mode and ignores render-only revisions', () => {
    const original = state({ mode: 'basic', pendingMode: 'pro' });
    const expected = sceneAnnouncement(original, 'en');
    expect(expected).toContain('Basic mode.');
    expect(sceneAnnouncement({ ...original, progress: 1, gradeRevision: 200, opacityPreviewRevision: 300,
      selectionOptionsRevision: 80, histogramUnavailable: true, brushSize: 80 }, 'en')).toBe(expected);
    expect(sceneAnnouncement({ ...original, mode: 'pro', pendingMode: null }, 'en')).toContain('Pro mode.');
  });

  it.each([
    ['single', 'Single splat'], ['brush', 'Brush'], ['volume', 'Volume brush'], ['rectangle', 'Box select'],
    ['polygon', 'Polygon'], ['color', 'Color picker'], ['fill', 'Fill'],
  ] as const)('names the actual %s selection tool', (tool, label) => {
    expect(sceneAnnouncement(state({ tool }), 'en')).toContain(`mode. ${label}. Combine:`);
  });

  it('names the active owner rather than a stale selection tool', () => {
    expect(sceneAnnouncement(state({ filter: filter() }), 'en')).toContain('mode. Selection filter.');
    expect(sceneAnnouncement(state({ transform: transform('ready') }), 'en')).toContain('mode. Transform.');
    expect(sceneAnnouncement(state({ opacity: opacity('ready') }), 'en')).toContain('mode. Opacity.');
    for (const [alignmentTool, label] of [['center', 'center'], ['scale', 'scale'], ['align', 'points'], ['floor', 'floor']] as const) {
      expect(sceneAnnouncement(state({ alignmentTool }), 'en')).toContain(`mode. Alignment: ${label}.`);
    }
  });

  it('omits irrelevant Combine defaults from camera navigation and nonselection owners', () => {
    expect(sceneAnnouncement(state({ tool: null, operation: 2 }), 'en')).toBe('Ready. retained.ply. 3 selected of 10 visible. Basic mode. Orbit navigation.');
    expect(sceneAnnouncement(state({ tool: null, fly: true, operation: 3 }), 'en')).toBe('Ready. retained.ply. 3 selected of 10 visible. Basic mode. Look navigation.');
    for (const patch of [{ transform: transform('ready') }, { opacity: opacity('ready') }, { alignmentTool: 'center' }] satisfies Partial<State>[]) {
      expect(sceneAnnouncement(state(patch), 'en')).not.toContain('Combine');
    }
  });

  it('preserves opaque source names and holds rather than inventing invalid counts or operations', () => {
    expect(sceneAnnouncement(state({ sourceName: '<scene>%u.ply' }), 'en')).toContain('<scene>%u.ply');
    expect(sceneAnnouncement(state({ sourceName: '' }), 'en')).toContain('Ready. Current scene.');
    for (const selected of [-1, .5, NaN, Infinity]) expect(sceneAnnouncement(state({ summary: summary({ selected }) }), 'en')).toBeNull();
    expect(sceneAnnouncement(state({ summary: summary({ visible: -1 }) }), 'en')).toBeNull();
    expect(sceneAnnouncement(state({ operation: 7 }), 'en')).toBeNull();
  });

  it.each(['en', ...TRANSLATED_LOCALES] as const)('provides localized current status and canvas guidance in %s', locale => {
    const ready = sceneAnnouncement(state(), locale);
    expect(ready).toContain('retained.ply');
    expect(ready).toContain('3'); expect(ready).toContain('10');
    expect(ready).toContain(translate('Basic', locale));
    expect(ready).toContain(translate('Brush', locale));
    expect(ready).toContain(translate('Add', locale));
    expect(sceneAnnouncement(state({ busy: true, stage: 'Reading scene' }), locale)).toBe(translate('Opening a scene.', locale));
    expect(translate(CANVAS_INSTRUCTIONS, locale)).not.toContain('\uFFFD');
    if (locale !== 'en') {
      expect(ready).not.toBe(sceneAnnouncement(state(), 'en'));
      expect(translate(CANVAS_INSTRUCTIONS, locale)).not.toBe(CANVAS_INSTRUCTIONS);
      expect(translate('Scene status', locale)).not.toBe('Scene status');
    }
  });

  it('keeps all authored accessibility translations complete and their formatted argument order intact', () => {
    const tokens = (text: string) => text.match(/%(?:s|u)/g) ?? [];
    for (const [english, row] of Object.entries(accessibilityTranslations)) {
      expect(row).toHaveLength(7);
      for (const [index, translated] of row.entries()) {
        expect(translated.trim()).not.toBe('');
        expect(tokens(translated)).toEqual(tokens(english));
        expect(translate(english, TRANSLATED_LOCALES[index] as UiLocale)).toBe(translated);
      }
    }
  });
});
