import { canonicalJson } from '../build/verification';
import { sameOperationOwner, validateOperationOwner, type OperationOwner } from './operationProtocol';
import { PreparedRecoveryCheckpoint, RecoveryCheckpointSnapshot,
  type RecoveryCheckpointDescription, type RecoveryCheckpointReader } from './recoveryCheckpoint';
import type { ResourceLedger } from './resources';
import type { Revision } from './types';

/** A decision proves possession of the admitted external successor, not that
 * any worker acknowledged or committed an operation. It cannot cross a worker
 * message or be reconstructed from public revision counters.
 */
declare const externalCommitDecisionBrand: unique symbol;
export type ExternalCommitDecision = Readonly<{ readonly [externalCommitDecisionBrand]: true }>;
type RecoveryState = {
  released: boolean;
  snapshot: RecoveryCheckpointSnapshot | undefined;
  description: RecoveryCheckpointDescription | undefined;
  owner: OperationOwner | undefined;
};
type Decision = Readonly<{
  state: RecoveryState; snapshot: RecoveryCheckpointSnapshot;
  owner: OperationOwner; description: RecoveryCheckpointDescription;
}>;
const decisions = new WeakMap<ExternalCommitDecision, Decision>();
const preparedDescription = Object.getOwnPropertyDescriptor(PreparedRecoveryCheckpoint.prototype, 'description')!.get!;
const acceptPrepared = PreparedRecoveryCheckpoint.prototype.accept;
const releaseSnapshot = RecoveryCheckpointSnapshot.prototype.release;
const openSnapshot = RecoveryCheckpointSnapshot.prototype.openRestore;
const failure = (detail: string) => new Error(`Invalid external recovery decision: ${detail}.`);

/** Compare only data descriptors. A caller's accessors/toJSON/valueOf are never
 * invoked. The trusted description supplies the finite shape and depth.
 */
function sameData(actual: unknown, expected: unknown): boolean {
  if (Object.is(actual, expected)) return true;
  if (!actual || !expected || typeof actual !== 'object' || typeof expected !== 'object') return false;
  const expectedArray = Array.isArray(expected);
  if (Array.isArray(actual) !== expectedArray ||
      Object.getPrototypeOf(actual) !== (expectedArray ? Array.prototype : Object.prototype)) return false;
  const expectedKeys = Reflect.ownKeys(expected), actualKeys = Reflect.ownKeys(actual);
  if (actualKeys.length !== expectedKeys.length) return false;
  for (const key of expectedKeys) {
    const a = Object.getOwnPropertyDescriptor(actual, key), b = Object.getOwnPropertyDescriptor(expected, key)!;
    if (!a || !('value' in a) || a.enumerable !== b.enumerable || !sameData(a.value, b.value)) return false;
  }
  return true;
}
function sourceIdentity(description: RecoveryCheckpointDescription): string {
  const { core, source, subset, revision } = description.binding;
  return canonicalJson({ core, source, subset, documentId: revision.documentId, sourceGeneration: revision.sourceGeneration });
}

/** Validate the exact currently owned external decision and return its trusted,
 * immutable description. Replacing/releasing the store invalidates old proofs.
 */
export function assertExternalCommitDecision(decision: ExternalCommitDecision, owner: OperationOwner,
  description?: RecoveryCheckpointDescription): RecoveryCheckpointDescription {
  const accepted = decisions.get(decision);
  if (!accepted) throw failure('unrecognized token');
  const expected = validateOperationOwner(owner);
  if (!sameOperationOwner(accepted.owner, expected)) throw failure('operation owner');
  const { state } = accepted;
  if (state.released || state.snapshot !== accepted.snapshot || state.description !== accepted.description ||
      state.owner !== accepted.owner) throw failure('the accepted snapshot is no longer owned');
  const revision = accepted.description.binding.revision;
  if (expected.documentId !== revision.documentId || expected.sourceGeneration !== revision.sourceGeneration)
    throw failure('document or source generation');
  if (description !== undefined && !sameData(description, accepted.description)) throw failure('checkpoint description or root');
  return accepted.description;
}

/** In-tab committed-state owner. The caller authenticates the active client
 * generation before decide(); a verified replacement client may begin a fresh
 * generation at operation 1. No unbounded retired-client journal is retained.
 */
export class DocumentRecoveryStore {
  readonly #ledger: ResourceLedger;
  readonly #state: RecoveryState = { released: false, snapshot: undefined, description: undefined, owner: undefined };
  constructor(ledger: ResourceLedger) {
    this.#ledger = ledger;
    Object.freeze(this);
  }
  get description(): RecoveryCheckpointDescription | undefined { return this.#state.description; }
  #current() {
    if (this.#state.released) throw failure('released store');
    return this.#state;
  }
  installInitial(prepared: PreparedRecoveryCheckpoint): void {
    const state = this.#current();
    if (state.snapshot) throw failure('an initial checkpoint is already owned');
    // Intrinsic methods/getters authenticate private fields without executing
    // caller overrides. Ledger admission is checked before ownership transfer.
    const description = preparedDescription.call(prepared) as RecoveryCheckpointDescription;
    const snapshot = acceptPrepared.call(prepared, this.#ledger);
    state.snapshot = snapshot; state.description = description;
  }
  decide(owner: OperationOwner, prepared: PreparedRecoveryCheckpoint): ExternalCommitDecision {
    const state = this.#current();
    if (!state.snapshot || !state.description) throw failure('missing initial checkpoint');
    const acceptedOwner = validateOperationOwner(owner);
    const description = preparedDescription.call(prepared) as RecoveryCheckpointDescription;
    const revision = description.binding.revision;
    if (acceptedOwner.documentId !== revision.documentId || acceptedOwner.sourceGeneration !== revision.sourceGeneration ||
        sourceIdentity(description) !== sourceIdentity(state.description)) throw failure('source, core, subset or document binding');
    if (state.owner?.clientGeneration === acceptedOwner.clientGeneration && acceptedOwner.operationId <= state.owner.operationId)
      throw failure('the operation ID did not advance');
    const snapshot = acceptPrepared.call(prepared, this.#ledger);
    const previous = state.snapshot;
    const token = Object.freeze({}) as ExternalCommitDecision;
    // Record the irreversible external decision before retiring its predecessor.
    // Reader references independently retain predecessor bytes until joined.
    decisions.set(token, Object.freeze({ state, snapshot, owner: acceptedOwner, description }));
    state.snapshot = snapshot; state.description = description; state.owner = acceptedOwner;
    releaseSnapshot.call(previous);
    return token;
  }
  async openRestore(signal?: AbortSignal): Promise<RecoveryCheckpointReader> {
    const state = this.#current();
    if (!state.snapshot || !state.description) throw failure('missing initial checkpoint');
    return openSnapshot.call(state.snapshot, state.description.binding, this.#ledger, signal);
  }
  release(): void {
    const state = this.#state;
    if (state.released) return;
    state.released = true;
    const snapshot = state.snapshot;
    state.snapshot = undefined; state.description = undefined; state.owner = undefined;
    if (snapshot) releaseSnapshot.call(snapshot);
  }
}

function revision(value: Revision): Readonly<Revision> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype)
    throw failure('revision');
  const names = ['documentId', 'sourceGeneration', 'contentRevision', 'selectionRevision', 'draftRevision'] as const;
  if (Reflect.ownKeys(value).length !== names.length) throw failure('revision fields');
  const data: Record<string, unknown> = {};
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor?.enumerable || !('value' in descriptor)) throw failure('revision fields');
    data[name] = descriptor.value;
  }
  if (typeof data.documentId !== 'string' || data.documentId.length === 0 || data.documentId.length > 128)
    throw failure('revision document');
  for (const name of names.slice(1)) {
    const number = data[name];
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || Object.is(number, -0) ||
        number < (name === 'sourceGeneration' ? 1 : 0)) throw failure('revision integer');
  }
  return data as Revision;
}
function advanced(a: number, b: number): number {
  const result = Math.max(a, b) + 1;
  if (!Number.isSafeInteger(result)) throw failure('restored revision overflow');
  return result;
}
/** Explicit restore publication policy, separate from ordinary native summary
 * acceptance. A quiescent restore preserves public counters. Restoring another
 * committed content/selection state advances past both observed counters;
 * cancelling an unfinished draft advances selection and clears draft ownership.
 */
export function recoveryPublicationRevision(checkpoint: Revision, failed: Revision): Revision {
  const saved = revision(checkpoint), observed = revision(failed);
  if (saved.documentId !== observed.documentId || saved.sourceGeneration !== observed.sourceGeneration)
    throw failure('restored document or source generation');
  const contentRevision = saved.contentRevision === observed.contentRevision ? saved.contentRevision :
    advanced(saved.contentRevision, observed.contentRevision);
  const selectionRevision = saved.selectionRevision !== observed.selectionRevision ||
      saved.draftRevision > 0 || observed.draftRevision > 0 ? advanced(saved.selectionRevision, observed.selectionRevision) :
    saved.selectionRevision;
  return Object.freeze({ documentId: saved.documentId, sourceGeneration: saved.sourceGeneration,
    contentRevision, selectionRevision, draftRevision: 0 });
}
