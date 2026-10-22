import { describe, expect, it } from 'vitest';
import { assertSelectionHistoryResponse, captureSelectionHistoryRequest, captureSelectionHistoryState,
  SelectionHistoryOperation, validateUndoSelectionRevision } from '../src/document/selectionHistory';

const scene = (patch: Record<string, unknown> = {}) => ({ loaded: true, kind: 0, revision: 10, canUndo: true, undoSelectionRevision: 3, ...patch });
describe('runtime top selection Undo revision contract', () => {
  it('requires exact own safe integers bounded by the ordinary clock and permits unstamped restored history', () => {
    expect(validateUndoSelectionRevision(scene())).toBe(3);
    expect(validateUndoSelectionRevision(scene({ undoSelectionRevision: 0 }))).toBe(0);
    expect(validateUndoSelectionRevision(scene({ canUndo: false, undoSelectionRevision: 0 }))).toBe(0);
    expect(captureSelectionHistoryState(scene({ revision: Number.MAX_SAFE_INTEGER, undoSelectionRevision: Number.MAX_SAFE_INTEGER }))).toEqual({
      revision: Number.MAX_SAFE_INTEGER, undoSelectionRevision: Number.MAX_SAFE_INTEGER, canUndo: true });
    for (const undoSelectionRevision of [undefined, null, true, '3', -1, -0, .5, NaN, Infinity, 11, Number.MAX_SAFE_INTEGER + 1])
      expect(() => validateUndoSelectionRevision(scene({ undoSelectionRevision }))).toThrow('Invalid native selection history metadata.');
    for (const patch of [{ canUndo: false }, { kind: 1 }, { kind: 2 }, { loaded: false }, { revision: 2 }, { revision: undefined }, { canUndo: undefined }])
      expect(() => validateUndoSelectionRevision(scene(patch))).toThrow();
  });
  it('requires neutral zero for compact unloaded and loaded geometry without inventing an Undo frame', () => {
    expect(captureSelectionHistoryState({ loaded: false, kind: 0, undoSelectionRevision: 0 })).toEqual({ revision: 0, canUndo: false, undoSelectionRevision: 0 });
    for (const kind of [1, 2]) expect(validateUndoSelectionRevision(scene({ kind, undoSelectionRevision: 0 }))).toBe(0);
    expect(() => validateUndoSelectionRevision({ loaded: false, kind: 0 })).toThrow();
    expect(() => validateUndoSelectionRevision({ loaded: false, kind: 0, undoSelectionRevision: 0, revision: undefined })).toThrow();
  });
  it('rejects inherited/accessor fields without reading them and does not enforce monotonic Undo/rollback order', () => {
    let reads = 0; const accessor = scene(); Object.defineProperty(accessor, 'undoSelectionRevision', { enumerable: true, get() { reads++; return 3; } });
    expect(() => validateUndoSelectionRevision(accessor)).toThrow(); expect(reads).toBe(0);
    const inherited = Object.assign(Object.create({ undoSelectionRevision: 3 }), { loaded: true, kind: 0, revision: 10, canUndo: true });
    expect(() => validateUndoSelectionRevision(inherited)).toThrow();
    for (const undoSelectionRevision of [3, 7, 2, 0, 3]) expect(validateUndoSelectionRevision(scene({ undoSelectionRevision }))).toBe(undoSelectionRevision);
    expect(Object.isFrozen(captureSelectionHistoryState(scene()))).toBe(true);
  });
  it('keeps readonly tuples exact while draft previews preserve the stamp across ordinary revision changes', () => {
    const before = captureSelectionHistoryState(scene());
    for (const [family, command] of [['command', { command: 'summary' }], ['command', { command: 'morphologyRange' }], ['command', { command: 'point' }], ['command', { command: 'planeNormal' }], ['stream', undefined], ['export', undefined]] as const) {
      const request = captureSelectionHistoryRequest(before, family, command);
      expect(() => assertSelectionHistoryResponse(request, scene())).not.toThrow();
      expect(() => assertSelectionHistoryResponse(request, scene({ undoSelectionRevision: 4 }))).toThrow('outside its captured request');
      expect(() => assertSelectionHistoryResponse(request, scene({ revision: 11 }))).toThrow('outside its captured request');
      expect(() => assertSelectionHistoryResponse(request, scene({ canUndo: false, undoSelectionRevision: 0 }))).toThrow('outside its captured request');
    }
    for (const [family, command] of [['live-preview', undefined], ['command', { command: 'previewFilter' }], ['command', { command: 'cancelSelection' }]] as const) {
      const request = captureSelectionHistoryRequest(before, family, command);
      expect(() => assertSelectionHistoryResponse(request, scene({ revision: 11 }))).not.toThrow();
      expect(() => assertSelectionHistoryResponse(request, scene({ revision: 11, undoSelectionRevision: 11 }))).toThrow();
    }
    const confirm = captureSelectionHistoryRequest(before, 'command', { command: 'confirmFilter' });
    expect(() => assertSelectionHistoryResponse(confirm, scene({ undoSelectionRevision: 10 }))).not.toThrow();
  });
  it('authenticates commit/status versus rollback independently of unchanged receipt2 fields', () => {
    const before = captureSelectionHistoryState(scene()), proof = new SelectionHistoryOperation(before);
    proof.assert('active', scene()); proof.accept(scene({ undoSelectionRevision: 7 }));
    proof.assert('active', scene({ undoSelectionRevision: 7 })); proof.assert('committed', scene({ undoSelectionRevision: 7 }));
    proof.assert('rolled-back', scene()); proof.assert('not-started', scene());
    expect(() => proof.assert('committed', scene())).toThrow('outside its captured request');
    expect(() => proof.assert('rolled-back', scene({ undoSelectionRevision: 7 }))).toThrow('outside its captured request');
    expect(() => proof.assert('expired-conflict', scene())).toThrow('outcome is unknown');
  });
});
