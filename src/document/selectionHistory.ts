/** Runtime history metadata is worker-local. Recovered history is deliberately
 * unstamped; never infer ownership from counts, canUndo or a revision delta. */
export type SelectionHistoryState = Readonly<{ revision: number; undoSelectionRevision: number; canUndo: boolean }>;
function field(value: object, name: string, optional = false): unknown {
  const data = Object.getOwnPropertyDescriptor(value, name);
  if (!data && optional) return undefined;
  if (!data?.enumerable || !('value' in data) || data.value === undefined) throw new Error('Invalid native selection history metadata.');
  return data.value;
}
function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0) && value >= 0;
}
export function captureSelectionHistoryState(value: unknown): SelectionHistoryState {
  const message = 'Invalid native selection history metadata.';
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(message);
  const loaded = field(value, 'loaded'), kind = field(value, 'kind'), stamp = field(value, 'undoSelectionRevision');
  if (typeof loaded !== 'boolean' || ![0, 1, 2].includes(kind as number) || !integer(stamp)) throw new Error(message);
  const revision = field(value, 'revision', !loaded), canUndo = field(value, 'canUndo', !loaded);
  if (revision !== undefined && !integer(revision) || canUndo !== undefined && typeof canUndo !== 'boolean' ||
      loaded && (revision === undefined || canUndo === undefined) ||
      (!loaded || kind !== 0 || canUndo === false) && stamp !== 0 || revision !== undefined && stamp > Number(revision)) throw new Error(message);
  return Object.freeze({ revision: revision === undefined ? 0 : Number(revision), undoSelectionRevision: stamp, canUndo: canUndo === true });
}
export function validateUndoSelectionRevision(value: unknown): number { return captureSelectionHistoryState(value).undoSelectionRevision; }
export function sameSelectionHistoryState(a: SelectionHistoryState, b: SelectionHistoryState): boolean {
  return a.revision === b.revision && a.undoSelectionRevision === b.undoSelectionRevision && a.canUndo === b.canUndo;
}
export function assertSelectionHistoryUnchanged(before: SelectionHistoryState, summary: unknown, scalarOnly = false): void {
  const after = captureSelectionHistoryState(summary);
  if (scalarOnly ? before.undoSelectionRevision !== after.undoSelectionRevision : !sameSelectionHistoryState(before, after))
    throw new Error('The selection history changed outside its captured request.');
}
export type SelectionHistoryRequest = Readonly<{ before: SelectionHistoryState; policy: 'readonly' | 'preserve' | 'edit' }>;
/** Draft previews can change the ordinary revision while preserving history.
 * Confirm/Undo/Redo/amendments may change the stamp authoritatively. */
export function captureSelectionHistoryRequest(before: SelectionHistoryState, family: string, command?: unknown): SelectionHistoryRequest {
  const name = command && typeof command === 'object' ? Object.getOwnPropertyDescriptor(command, 'command') : undefined;
  const action = name && 'value' in name ? name.value : undefined;
  const readonly = family !== 'command' && family !== 'live-preview' || ['summary', 'morphologyRange', 'transformFocus', 'point', 'planeNormal'].includes(action);
  const preserve = family === 'live-preview' || ['cancel', 'beginSelection', 'cancelSelection', 'beginFilter', 'previewFilter', 'cancelFilter',
    'beginTransaction', 'commitTransaction', 'endTolerance', 'selectionMapBegin', 'selectionMapCommit', 'selectionMapRelease',
    'beginTransform', 'rebaseTransform', 'endTransform'].includes(action);
  return Object.freeze({ before, policy: readonly ? 'readonly' : preserve ? 'preserve' : 'edit' });
}
export function assertSelectionHistoryResponse(proof: SelectionHistoryRequest, summary: unknown): void {
  if (proof.policy === 'edit') { validateUndoSelectionRevision(summary); return; }
  assertSelectionHistoryUnchanged(proof.before, summary, proof.policy === 'preserve');
}
/** Receipt2 does not carry this scalar. Authenticate it independently before
 * accepting or storing an operation result, including no-op terminals. */
export class SelectionHistoryOperation {
  private readonly baseline: number;
  private current: number;
  constructor(before: SelectionHistoryState) { this.baseline = this.current = before.undoSelectionRevision; }
  accept(summary: unknown): void { this.current = validateUndoSelectionRevision(summary); }
  assert(outcome: string, summary: unknown): void {
    if (!['active', 'committed', 'rolled-back', 'not-started'].includes(outcome)) throw new Error('The selection history operation outcome is unknown.');
    if (validateUndoSelectionRevision(summary) !== (['rolled-back', 'not-started'].includes(outcome) ? this.baseline : this.current))
      throw new Error('The selection history changed outside its captured request.');
  }
}
