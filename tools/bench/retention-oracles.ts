/** Sequence/ownership policy for raw retention observations, not a performance budget. */
import assert from 'node:assert/strict';
import { assertProbeClock, assertProbeClosed, assertProbeSnapshot, settledProbeOpen, completedProbeFrame, type Snapshot } from './run.ts';
import { contributorAnchorCase, expectedContributorAnchorMask, contributorDeletedAnchorMask } from './contributor-oracles.ts';
import { selectionBaselineMask, selectionMaskIdentity, type SelectionMaskIdentity } from './selection-oracles.ts';
import { assertContributorQuery, type ContributorCheckpoint, type ContributorMaskSnapshot, type ContributorPoint, type ContributorQuery } from './contributors.ts';

type Json = Record<string, unknown>;
export const RETENTION_STEPS = ['open', 'selected', 'deleted', 'undo', 'redo', 'export-acknowledged', 'image-downloaded', 'replaced', 'closed'] as const;
export type RetentionStep = typeof RETENTION_STEPS[number];
export interface RetentionContinuity {
  sameContext: boolean; samePage: boolean; sameBridge: boolean; pageCount: number;
}
export interface RetentionBarrier {
  step: RetentionStep; snapshot: Snapshot; continuity: RetentionContinuity; checkpoint: ContributorCheckpoint | null;
}
export interface RetentionCycle {
  id: string; index: number; status: 'pending' | 'observed' | 'failed'; barriers: RetentionBarrier[];
  export: Json | null; capture: Json | null; query: Json | null; camera: Json | null;
  openObservation: Json | null; replacementObservation: Json | null; closeObservation: Json | null;
  error: string | null;
}
const object = (value: unknown): Json => { assert(value !== null && typeof value === 'object' && !Array.isArray(value), 'Missing retention record'); return value as Json; };
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** Complete independently declared source-state membership; never seeded from measured masks. */
export function retentionExpectedMask(step: RetentionStep): Uint8Array {
  if (step === 'open' || step === 'replaced') return selectionBaselineMask('none');
  if (step === 'selected' || step === 'undo') return expectedContributorAnchorMask(1);
  if (['deleted', 'redo', 'export-acknowledged', 'image-downloaded'].includes(step)) return contributorDeletedAnchorMask();
  throw new Error('A closed document has no native source mask.');
}
export function retentionDeclaration() {
  return { schemaVersion: 1, kind: 'splatview-predeclared-same-page-retention-sequence', requiredCycles: 20,
    steps: [...RETENTION_STEPS], contributor: contributorAnchorCase(1),
    masks: Object.fromEntries(RETENTION_STEPS.filter(step => step !== 'closed').map(step => [step, selectionMaskIdentity(retentionExpectedMask(step))])),
    history: { open: [false, false], selected: [true, false], deleted: [true, false], undo: [true, true], redo: [true, false], replaced: [false, false] },
    export: { format: 'SPLAT', scope: 'all', count: 255_999, bytes: 8_191_968, deletedSourceIds: [1] },
    capture: { format: 'image/jpeg', width: 1280, height: 800, actualBrowserDownloadRequired: true },
    continuity: 'One context, page and retained opt-in bridge object. The installed bridge closes over the same controller; no reload or bridge reinstall is permitted.',
    memory: 'Logical ledger/categories, currently addressable native accounts and named pending owners only; no physical process/JS/GPU memory measurement.' };
}
export function assertRetentionContinuity(current: Snapshot, previous: Snapshot, continuity: RetentionContinuity): void {
  assert.deepEqual(continuity, { sameContext: true, samePage: true, sameBridge: true, pageCount: 1 }, 'Retention page/context/controller bridge was replaced');
  assertProbeClock(current, previous);
  assert(current.controller.observation.lastOperationSequence >= previous.controller.observation.lastOperationSequence, 'Controller operation sequence reset');
  assert(current.controller.observation.lastFrameSequence >= previous.controller.observation.lastFrameSequence, 'Controller frame sequence reset');
  assert(current.controller.memory.logicalLedger.peakBytes >= previous.controller.memory.logicalLedger.peakBytes, 'Controller cumulative logical peak reset');
}
export function retentionMemorySummary(snapshots: readonly Snapshot[]) {
  assert(snapshots.length > 0, 'No observed memory barriers');
  let maximumBytes = 0, maximumAllocations = 0, previousPeak = 0;
  for (const snapshot of snapshots) {
    const ledger = snapshot.controller.memory.logicalLedger;
    for (const value of [ledger.bytes, ledger.peakBytes, ledger.allocations, ledger.overageBytes]) assert(integer(value), 'Invalid observed ledger amount');
    assert(ledger.peakBytes >= ledger.bytes && ledger.peakBytes >= previousPeak, 'Invalid cumulative ledger peak');
    maximumBytes = Math.max(maximumBytes, ledger.bytes); maximumAllocations = Math.max(maximumAllocations, ledger.allocations); previousPeak = ledger.peakBytes;
  }
  return { scope: 'logical-controller-ledger-only', observedBarrierMaximumBytes: maximumBytes, observedBarrierMaximumAllocations: maximumAllocations,
    finalCumulativeLedgerPeakBytes: previousPeak, peakMeaning: 'Cumulative ledger high-water mark may exceed every sampled barrier; it is not a per-cycle or physical memory peak.' };
}
function assertCheckpoint(checkpoint: ContributorCheckpoint | null, expected: SelectionMaskIdentity, history?: readonly boolean[]): void {
  assert(checkpoint && checkpoint.oracleStatus === 'passed' && checkpoint.oracleError === null, 'Missing independent complete-mask proof');
  assert.deepEqual(checkpoint.independentIdentity, expected, 'Mask proof differs from the independently declared membership');
  assert(checkpoint.artifact && checkpoint.artifact.bytes === 256_000 && checkpoint.artifact.sha256 === expected.stateMaskSha256, 'Mask artifact is not bound to the independently expected bytes');
  const envelope = object(checkpoint.maskObservation), observation = object(envelope.observation), summary = object(observation.summary);
  assert.equal(observation.status, 'completed'); assert.equal(summary.pending, false); assert.equal(summary.transaction, false); assert.equal(summary.selectionDraft, false);
  assert.equal(summary.selected, expected.selectedCount); assert.equal(summary.visible, expected.visibleCount);
  if (history) { assert.equal(summary.canUndo, history[0], 'Native Undo baseline differs'); assert.equal(summary.canRedo, history[1], 'Native Redo baseline differs'); }
}
/** Validate a completed sequence. Partial/diagnostic evidence cannot silently become a completed cycle. */
export function assertRetentionCycle(cycle: RetentionCycle, baseline: Snapshot, expected: Parameters<typeof assertProbeSnapshot>[1]): void {
  assert.equal(cycle.id, `cycle-${String(cycle.index).padStart(2, '0')}`); assert(Number.isSafeInteger(cycle.index) && cycle.index >= 1 && cycle.index <= 20);
  assert.equal(cycle.error, null); assert.deepEqual(cycle.barriers.map(value => value.step), RETENTION_STEPS, 'Incomplete or misordered retention cycle');
  const history: Partial<Record<RetentionStep, readonly boolean[]>> = { open: [false, false], selected: [true, false], deleted: [true, false], undo: [true, true], redo: [true, false], replaced: [false, false] };
  let previous = baseline;
  for (const barrier of cycle.barriers) {
    assertProbeSnapshot(barrier.snapshot, expected); assertRetentionContinuity(barrier.snapshot, previous, barrier.continuity);
    if (barrier.step === 'closed') {
      assert.equal(barrier.checkpoint, null); assertProbeClosed(barrier.snapshot, previous.controller.observation.lastOperationSequence);
      assert.equal(barrier.snapshot.controller.knownPending.benchmarkMaskReads, 0); assert.equal(barrier.snapshot.controller.knownPending.benchmarkPickTasks, 0);
    }
    else assertCheckpoint(barrier.checkpoint, selectionMaskIdentity(retentionExpectedMask(barrier.step)), history[barrier.step]);
    previous = barrier.snapshot;
  }
  const open = cycle.barriers[0]!.snapshot, replaced = cycle.barriers[7]!.snapshot;
  const opened = settledProbeOpen(open, baseline.controller.observation.lastOperationSequence);
  assert(opened && completedProbeFrame(open, baseline.controller.observation.lastFrameSequence, opened), 'Missing actual initial open/frame settlement');
  assert.equal(opened.sequence, baseline.controller.observation.lastOperationSequence + 1);
  const replacement = settledProbeOpen(replaced, cycle.barriers[6]!.snapshot.controller.observation.lastOperationSequence);
  assert(replacement && completedProbeFrame(replaced, cycle.barriers[6]!.snapshot.controller.observation.lastFrameSequence, replacement), 'Missing actual replacement/frame settlement');
  assert.equal(replacement.sequence, opened.sequence + 1);
  assert.equal(cycle.barriers[8]!.snapshot.controller.observation.lastOperationSequence, replacement.sequence + 1);
  assert.notEqual(replaced.controller.state.documentRevision!.documentId, open.controller.state.documentRevision!.documentId, 'Replacement did not install a new native document');
  const query = object(cycle.query); assert(integer(query.beforeQuery));
  assertContributorQuery(query.actual as ContributorQuery, query.beforeQuery as number,
    cycle.barriers[0]!.checkpoint!.maskObservation as unknown as ContributorMaskSnapshot, contributorAnchorCase(1), query.point as ContributorPoint);
  const saved = object(cycle.export), artifact = object(saved.artifact), oracle = object(saved.independentOracle), acknowledgement = object(saved.outputAcknowledgement);
  assert.equal(saved.oracleStatus, 'passed'); assert.equal(saved.oracleError, null);
  assert.equal(artifact.bytes, 8_191_968); assert.equal(oracle.count, 255_999); assert.equal(oracle.scope, 'all'); assert.equal(oracle.encodedSha256, artifact.sha256);
  assert.equal(oracle.membershipSha256, selectionMaskIdentity(contributorDeletedAnchorMask()).visibleMembershipSha256);
  assert.equal(oracle.expectedMembershipSha256, oracle.membershipSha256); assert.equal(oracle.sourceOrderSha256, oracle.membershipSha256);
  assert.equal(acknowledgement.status, 'acknowledged', 'Actual output acknowledgement is missing'); assert.equal(acknowledgement.error, null);
  assert.deepEqual(acknowledgement.artifact, artifact);
  assert(typeof artifact.path === 'string' && new RegExp('^\\.build/bench-runs/[A-Za-z0-9][A-Za-z0-9._-]{0,95}/' + cycle.id + '\\.splat$', 'u').test(artifact.path));
  const prefix = (artifact.path as string).slice(0, -(cycle.id.length + '.splat'.length));
  for (const barrier of cycle.barriers) if (barrier.checkpoint) assert.equal(barrier.checkpoint.artifact!.path, `${prefix}${cycle.id}-${barrier.step}.state`);
  const capture = object(cycle.capture), image = object(capture.artifact), decode = object(capture.decode);
  assert.equal(image.path, `${prefix}${cycle.id}.jpg`);
  assert(integer(image.bytes) && image.bytes > 4 && typeof image.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(image.sha256));
  assert.equal(capture.status, 'downloaded-and-decoded'); assert.equal(capture.suggestedFilename, 'SplatView.jpg');
  assert.equal(decode.mimeType, 'image/jpeg'); assert.equal(decode.width, 1280); assert.equal(decode.height, 800); assert.equal(decode.bitmapClosed, true);
  assert(finite(capture.completedAtMs) && (capture.completedAtMs as number) <= cycle.barriers[6]!.snapshot.clock.now &&
    (capture.completedAtMs as number) >= cycle.barriers[5]!.snapshot.clock.now, 'Image download is outside the declared sequence');
  retentionMemorySummary([baseline, ...cycle.barriers.map(value => value.snapshot)]);
}
export function assertRetentionCompletion(cycles: readonly RetentionCycle[], requestedCycles: number,
  cleanup: { contextJoined: boolean; browserJoined: boolean; contextError: string | null; browserError: string | null }): void {
  assert(Number.isSafeInteger(requestedCycles) && requestedCycles >= 1 && requestedCycles <= 20);
  assert.equal(cycles.length, requestedCycles, 'Requested retention cycles were not completed');
  cycles.forEach((cycle, index) => { assert.equal(cycle.index, index + 1); assert.equal(cycle.status, 'observed'); assert.equal(cycle.error, null); });
  assert.deepEqual(cleanup, { contextJoined: true, browserJoined: true, contextError: null, browserError: null }, 'Browser/context cleanup did not join');
}
