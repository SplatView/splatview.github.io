import { describe, expect, it } from 'vitest';
import { parseRetentionOptions, retentionMemoryDiagnostic } from '../tools/bench/retention.ts';
import { assertRetentionContinuity, assertRetentionCycle, assertRetentionCompletion, retentionDeclaration, retentionExpectedMask, retentionMemorySummary,
  RETENTION_STEPS, type RetentionCycle, type RetentionBarrier } from '../tools/bench/retention-oracles.ts';
import { acknowledgeProbeExport, type Snapshot } from '../tools/bench/run.ts';
import { selectionMaskIdentity, assertSelectionMask } from '../tools/bench/selection-oracles.ts';
import type { ContributorOwner, ContributorQuery } from '../tools/bench/contributors.ts';

const build = { appInputId: 'a'.repeat(64), deploymentId: 'b'.repeat(64) };
const path = '.build/bench-runs/retention-unit/';
const args = ['--base-url', 'http://127.0.0.1:4173/project/', '--fixture', '.build/bench-fixtures/pinned/fixture.splat', '--out', path.slice(0, -1)];
const camera = [0, 0, 0, 0, 0, 24, 1, 45, 1, 0, 1.6].map(Math.fround), matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const continuity = { sameContext: true, samePage: true, sameBridge: true, pageCount: 1 };
const revision = (documentId = 'original') => ({ documentId, sourceGeneration: 1, contentRevision: 0, selectionRevision: 0, draftRevision: 0 });
function owner(): ContributorOwner { return { clientOwnerId: 1, rendererOwnerId: 2, sceneOwnerId: 3, cameraOwnerId: 4,
  documentRevision: revision(), camera: { revision: 0, state: camera, view: matrix, projection: matrix, eye: [0, 0, 24] },
  scene: { revision: 0, sourceRevision: 0, selectedRevision: 0, count: 256000 }, deviceEpoch: 1, rendererSubmissionSequence: 1,
  framebuffer: { width: 1280, height: 800, devicePixelRatio: 1 }, visibility: 'visible' }; }
function empty(): Snapshot {
  const counts = ['sourceLoadTasks', 'collectionCleanupTasks', 'thumbnailTasks', 'savedViewTransferTasks', 'imageTasks', 'filterTasks', 'transformTasks', 'opacityTasks',
    'floorTasks', 'tolerancePickTasks', 'releasedSelectionOwners', 'selectionBarriers', 'viewDownloadCallbacks', 'imageDownloadCallbacks', 'exportDownloadCallbacks', 'benchmarkMaskReads', 'benchmarkPickTasks'];
  const flags = ['candidateClient', 'bootstrapClient', 'collectionIntakeOwner', 'recoveryTask', 'closeRequest', 'closeDocumentTask', 'editOperation', 'exportOperation',
    'filterOwner', 'transformOwner', 'opacityOwner', 'floorOwner', 'selectionCleanupOwner', 'opacityEntryTask', 'transformGradeTask', 'transformNumericTask', 'releasedSelectionDrain'];
  return { schemaVersion: 1, kind: 'splatview-production-benchmark-snapshot', clock: { id: 'performance.now:100', timeOrigin: 100, now: 0 },
    runtime: { mode: 'production-verified', ...build, artifacts: [] }, controller: { schemaVersion: 1, kind: 'splatview-controller-benchmark-observation',
      state: { ready: true, busy: false, error: null, bootstrapState: 'ready', rendererState: 'ready', runtimeMode: 'production-verified', hasScene: false, hasClient: false, summary: null, documentRevision: null },
      framebuffer: null, renderer: { ready: true, negotiation: { status: 'ready' } }, camera: null,
      observation: { enabled: true, disabledReason: null, lastFrameSequence: 0, lastOperationSequence: 0, droppedFrames: 0, droppedOperations: 0, droppedNegotiations: 0, operations: [], frames: [] },
      memory: { logicalLedger: { bytes: 0, peakBytes: 1000, allocations: 0, overageBytes: 0, categories: Object.fromEntries(['source', 'decoded', 'work', 'history', 'render', 'image', 'recovery'].map(key => [key, { bytes: 0, allocations: 0 }])) }, nativeAccounts: [] },
      knownPending: { ...Object.fromEntries(counts.map(key => [key, 0])), ...Object.fromEntries(flags.map(key => [key, false])), drawing: false, scheduledAnimationFrame: false } } };
}
/** Deliberately synthetic policy fixture; never passed off as browser/performance evidence. */
function sequence(): { baseline: Snapshot; cycle: RetentionCycle } {
  const baseline = empty();
  const history: Record<string, boolean[]> = { open: [false, false], selected: [true, false], deleted: [true, false], undo: [true, true], redo: [true, false], replaced: [false, false] };
  const barriers: RetentionBarrier[] = RETENTION_STEPS.map((step, index) => {
    const snapshot = empty(), documentId = step === 'replaced' ? 'replacement' : 'original', state = snapshot.controller.state, ring = snapshot.controller.observation;
    snapshot.clock.now = 20 + index * 10; ring.lastFrameSequence = index + 1; ring.lastOperationSequence = step === 'closed' ? 3 : step === 'replaced' ? 2 : 1;
    const first = { sequence: 1, kind: 'open-files', status: 'settled', startedAtMs: 1, settledAtMs: 5, closed: null, after: { hasScene: true, hasClient: true, documentRevision: revision() } };
    const second = { ...first, sequence: 2, startedAtMs: 85, settledAtMs: 86, after: { ...first.after, documentRevision: revision('replacement') } };
    ring.operations = [first]; if (ring.lastOperationSequence >= 2) ring.operations.push(second);
    if (step === 'closed') ring.operations.push({ sequence: 3, kind: 'close-scene', status: 'settled', startedAtMs: 95, settledAtMs: 96, closed: true, after: { hasScene: false, hasClient: false, documentRevision: null } });
    if (step !== 'closed') {
      state.hasScene = true; state.hasClient = true; state.documentRevision = revision(documentId); state.summary = { count: 256000, sourceCount: 256000, shDegree: 0 };
      snapshot.controller.memory.logicalLedger.bytes = 500; snapshot.controller.memory.logicalLedger.allocations = 1;
      ring.frames = [{ sequence: index + 1, status: 'completed', drawStartedAtMs: step === 'replaced' ? 87 : 6, submissionObservedAtMs: step === 'replaced' ? 88 : 7,
        queueCompletedAtMs: step === 'replaced' ? 89 : 8, documentRevision: revision(documentId), presentation: { available: false } }];
    }
    if (step === 'closed') return { step, snapshot, continuity: { ...continuity }, checkpoint: null };
    const identity = selectionMaskIdentity(retentionExpectedMask(step));
    return { step, snapshot, continuity: { ...continuity }, checkpoint: { oracleStatus: 'passed', oracleError: null, independentIdentity: identity,
      artifact: { path: `${path}cycle-01-${step}.state`, bytes: 256000, sha256: identity.stateMaskSha256 },
      maskObservation: { schemaVersion: 1, kind: 'splatview-production-benchmark-mask', clock: { ...snapshot.clock }, runtime: { ...snapshot.runtime }, observation: {
        schemaVersion: 1, kind: 'splatview-controller-benchmark-mask', status: 'completed', clock: 'performance.now', startedAtMs: 11, settledAtMs: 12,
        before: owner(), after: owner(), sourceCount: 256000, byteLength: 256000, encoding: 'base64', bytesBase64: null, callbacks: 1,
        summary: { selected: identity.selectedCount, visible: identity.visibleCount, pending: false, transaction: false, selectionDraft: false,
          canUndo: history[step]?.[0] ?? true, canRedo: history[step]?.[1] ?? false }, error: null, staleReason: null } } } };
  });
  const artifact = { path: `${path}cycle-01.splat`, bytes: 8191968, sha256: 'c'.repeat(64) }, membership = selectionMaskIdentity(retentionExpectedMask('redo')).visibleMembershipSha256;
  const query: ContributorQuery = { sequence: 1, status: 'completed', clock: 'performance.now', startedAtMs: 21, settledAtMs: 22, path: 'ordinary-single',
    request: { x: 961.5, y: 400.5, centerRadius: 0, sample: { x: 961.5, y: 400.5 } },
    renderState: { grade: [1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], highlight: true, geometry: matrix, selectedOnly: false, geometrySelectedOnly: false, opacityScale: 1, opacitySelectedOnly: false },
    before: owner(), after: owner(), result: { index: 1, depth: 24, opacity: 1, contribution: 0.8, deviceEpoch: 1 }, error: null, staleReason: null, representation: 'decoded-production-GpuPick-not-raw-readback' };
  return { baseline, cycle: { id: 'cycle-01', index: 1, status: 'observed', barriers,
    query: { beforeQuery: 0, actual: query, point: { rect: { x: 0, y: 0, left: 0, top: 0, right: 1280, bottom: 800, width: 1280, height: 800 },
      framebuffer: { width: 1280, height: 800, devicePixelRatio: 1 }, requestedPoint: [961.5, 400.5], clientPoint: [961.5, 400.5], elementFromPointCanvas: true } },
    camera: {}, openObservation: {}, replacementObservation: {}, closeObservation: {}, error: null,
    export: { artifact, oracleStatus: 'passed', oracleError: null, independentOracle: { count: 255999, scope: 'all', encodedSha256: artifact.sha256,
      membershipSha256: membership, expectedMembershipSha256: membership, sourceOrderSha256: membership }, outputAcknowledgement: { status: 'acknowledged', artifact, error: null } },
    capture: { status: 'downloaded-and-decoded', suggestedFilename: 'SplatView.jpg', completedAtMs: 75, artifact: { path: `${path}cycle-01.jpg`, bytes: 100, sha256: 'd'.repeat(64) },
      decode: { mimeType: 'image/jpeg', width: 1280, height: 800, bitmapClosed: true } } } };
}
describe('same-page retention tooling policy (synthetic, not benchmark acceptance)', () => {
  it('defaults to the full twenty-cycle sequence and labels smaller tooling requests explicitly', () => {
    expect(parseRetentionOptions(args)).toMatchObject({ baseUrl: 'http://127.0.0.1:4173/project/', cycles: 20 });
    expect(parseRetentionOptions([...args, '--cycles', '1']).cycles).toBe(1);
    expect(retentionDeclaration().steps).toEqual(RETENTION_STEPS); expect(retentionDeclaration().requiredCycles).toBe(20);
  });
  it('refuses fresh-context flags, duplicate cycles, missing values and unbounded cycle counts', () => {
    for (const tail of [['--attempts', '20'], ['--cycles'], ['--cycles', '0'], ['--cycles', '21'], ['--cycles', '02'], ['--cycles', '1.5'], ['--cycles', '1', '--cycles', '2']])
      expect(() => parseRetentionOptions([...args, ...tail])).toThrow();
  });
  it('accepts only a complete independently bound sequence with native history and actual download acknowledgements', () => {
    const { baseline, cycle } = sequence(); expect(() => assertRetentionCycle(cycle, baseline, build)).not.toThrow();
  });
  it('rejects missing, repeated and misordered lifecycle barriers', () => {
    for (const mutate of [(value: RetentionCycle) => { value.barriers.splice(3, 1); }, (value: RetentionCycle) => { value.barriers[4] = value.barriers[3]!; },
      (value: RetentionCycle) => { [value.barriers[1], value.barriers[2]] = [value.barriers[2]!, value.barriers[1]!]; }]) {
      const { baseline, cycle } = sequence(); mutate(cycle); expect(() => assertRetentionCycle(cycle, baseline, build)).toThrow(/Incomplete or misordered/);
    }
  });
  it('checks full independent mask bytes, including unselected members outside the target anchor', () => {
    const expected = retentionExpectedMask('deleted'); expect(expected[1]).toBe(2); expect(expected.reduce((sum, value) => sum + Number(value !== 0), 0)).toBe(1);
    const actual = expected.slice(); actual[200000] = 1; expect(() => assertSelectionMask(actual, expected)).toThrow(/200000/);
    const { baseline, cycle } = sequence(); cycle.barriers[2]!.checkpoint!.independentIdentity = selectionMaskIdentity(actual);
    expect(() => assertRetentionCycle(cycle, baseline, build)).toThrow(/independently declared membership/);
  });
  it('refuses a missing source-state artifact and an edited artifact with an unbound hash', () => {
    for (const corrupt of [(value: RetentionCycle) => { value.barriers[2]!.checkpoint!.artifact = null; },
      (value: RetentionCycle) => { value.barriers[4]!.checkpoint!.artifact!.sha256 = 'f'.repeat(64); }]) {
      const { baseline, cycle } = sequence(); corrupt(cycle); expect(() => assertRetentionCycle(cycle, baseline, build)).toThrow(/Mask artifact/);
    }
  });
  it('requires native Undo and Redo baselines instead of matching only counts', () => {
    const { baseline, cycle } = sequence(); const observation = cycle.barriers[3]!.checkpoint!.maskObservation!.observation as Record<string, unknown>;
    (observation.summary as Record<string, unknown>).canRedo = false; expect(() => assertRetentionCycle(cycle, baseline, build)).toThrow(/Redo baseline/);
  });
  it('requires the same page/context/controller bridge and refuses a changed clock domain', () => {
    for (const field of ['samePage', 'sameContext', 'sameBridge'] as const) {
      const value = empty(); expect(() => assertRetentionContinuity(value, empty(), { ...continuity, [field]: false })).toThrow(/replaced/);
    }
    const value = empty(); value.clock.timeOrigin++; value.clock.id = `performance.now:${value.clock.timeOrigin}`;
    expect(() => assertRetentionContinuity(value, empty(), continuity)).toThrow(/clock domain/);
    expect(() => assertRetentionContinuity(empty(), empty(), { ...continuity, pageCount: 2 })).toThrow(/replaced/);
  });
  it('refuses controller counter or cumulative-peak resets within the same clock', () => {
    const before = empty(), after = empty(); before.controller.observation.lastOperationSequence = 4;
    expect(() => assertRetentionContinuity(after, before, continuity)).toThrow(/operation sequence reset/);
    before.controller.observation.lastOperationSequence = 0; before.controller.observation.lastFrameSequence = 2;
    expect(() => assertRetentionContinuity(after, before, continuity)).toThrow(/frame sequence reset/);
    before.controller.observation.lastFrameSequence = 0; after.controller.memory.logicalLedger.peakBytes = 999;
    expect(() => assertRetentionContinuity(after, before, continuity)).toThrow(/logical peak reset/);
  });
  it('refuses substituted contributor results and replacement that kept the old native document', () => {
    const first = sequence(); ((first.cycle.query!.actual as unknown as ContributorQuery).result!).index = 0;
    expect(() => assertRetentionCycle(first.cycle, first.baseline, build)).toThrow();
    const second = sequence(); const replacement = second.cycle.barriers[7]!.snapshot;
    replacement.controller.state.documentRevision = revision(); replacement.controller.observation.operations[1]!.after!.documentRevision = revision();
    replacement.controller.observation.frames[0]!.documentRevision = revision();
    expect(() => assertRetentionCycle(second.cycle, second.baseline, build)).toThrow(/new native document/);
  });
  it('refuses missing output acknowledgement and full-scene membership that resurrected the deleted anchor', () => {
    const first = sequence(); (first.cycle.export!.outputAcknowledgement as Record<string, unknown>).status = 'pending';
    expect(() => assertRetentionCycle(first.cycle, first.baseline, build)).toThrow(/acknowledgement/);
    const second = sequence(); (second.cycle.export!.independentOracle as Record<string, unknown>).membershipSha256 = selectionMaskIdentity(retentionExpectedMask('open')).visibleMembershipSha256;
    expect(() => assertRetentionCycle(second.cycle, second.baseline, build)).toThrow();
  });
  it('refuses wrong image dimensions, unfinished decoding and image completion outside the sequence', () => {
    for (const mutate of [(value: RetentionCycle) => { (value.capture!.decode as Record<string, unknown>).width = 1; },
      (value: RetentionCycle) => { (value.capture!.decode as Record<string, unknown>).bitmapClosed = false; },
      (value: RetentionCycle) => { value.capture!.completedAtMs = 500; }]) {
      const { baseline, cycle } = sequence(); mutate(cycle); expect(() => assertRetentionCycle(cycle, baseline, build)).toThrow();
    }
  });
  it('refuses retained logical allocations, native accounts, download callbacks and observation owners at Close', () => {
    for (const mutate of [(value: Snapshot) => { value.controller.memory.logicalLedger.bytes = 1; },
      (value: Snapshot) => { value.controller.memory.nativeAccounts.push({}); },
      (value: Snapshot) => { value.controller.knownPending.imageDownloadCallbacks = 1; },
      (value: Snapshot) => { value.controller.knownPending.benchmarkMaskReads = 1; }]) {
      const { baseline, cycle } = sequence(); mutate(cycle.barriers[8]!.snapshot); expect(() => assertRetentionCycle(cycle, baseline, build)).toThrow();
    }
  });
  it('distinguishes sampled barrier maximum from the cumulative ledger peak without inventing a physical-memory value', () => {
    const first = empty(), last = empty(); first.controller.memory.logicalLedger.bytes = 400; first.controller.memory.logicalLedger.allocations = 2;
    const summary = retentionMemorySummary([first, last]); expect(summary.observedBarrierMaximumBytes).toBe(400); expect(summary.finalCumulativeLedgerPeakBytes).toBe(1000);
    expect(summary).not.toHaveProperty('physicalBytes'); expect(summary).not.toHaveProperty('perCyclePeakBytes');
  });
  it('preserves malformed or decreasing raw ledger evidence without fabricating a valid summary or throwing away its terminal record', () => {
    for (const corrupt of [(value: Snapshot) => { value.controller.memory.logicalLedger.peakBytes = 999; },
      (value: Snapshot) => { value.controller.memory.logicalLedger.bytes = -1; }]) {
      const snapshots = [empty(), empty()]; corrupt(snapshots[1]!); const raw = structuredClone(snapshots);
      const memory = retentionMemoryDiagnostic(snapshots);
      expect(memory.status).toBe('failed'); expect(memory.error).toEqual(expect.any(String)); expect(memory).toHaveProperty('summary', null);
      expect(memory).not.toHaveProperty('observedBarrierMaximumBytes'); expect(memory).not.toHaveProperty('finalCumulativeLedgerPeakBytes');
      // The same raw snapshots and diagnostic can still be serialized by both
      // cycle-finally and the terminal report writer; this is policy evidence only.
      expect(JSON.parse(JSON.stringify({ status: 'failed', snapshots, memory }))).toEqual({ status: 'failed', snapshots: raw, memory });
      expect(snapshots).toEqual(raw);
    }
    expect(retentionMemoryDiagnostic([empty()])).toMatchObject({ status: 'observed', error: null, observedBarrierMaximumBytes: 0, finalCumulativeLedgerPeakBytes: 1000 });
  });
  it('rejects incomplete cycles and leaked context/browser cleanup at the terminal completion boundary', () => {
    const cycle = sequence().cycle, cleanup = { contextJoined: true, browserJoined: true, contextError: null, browserError: null };
    expect(() => assertRetentionCompletion([cycle], 1, cleanup)).not.toThrow();
    expect(() => assertRetentionCompletion([cycle], 20, cleanup)).toThrow(/not completed/);
    for (const field of ['contextJoined', 'browserJoined'] as const) expect(() => assertRetentionCompletion([cycle], 1, { ...cleanup, [field]: false })).toThrow(/cleanup did not join/);
    expect(() => assertRetentionCompletion([cycle], 1, { ...cleanup, browserError: 'actual close failed' })).toThrow(/cleanup did not join/);
    cycle.status = 'failed'; expect(() => assertRetentionCompletion([cycle], 1, cleanup)).toThrow();
  });
  it('preserves default probe acknowledgement and supports only an exact bound private edited SPLAT', async () => {
    const artifact = { path: `${path}cycle-01.splat`, bytes: 8191968, sha256: 'e'.repeat(64) };
    const target = () => ({ artifact: { ...artifact }, oracleStatus: 'passed', oracleError: null, independentOracle: { encodedSha256: artifact.sha256 } });
    await expect(acknowledgeProbeExport(target(), async () => undefined)).rejects.toThrow();
    let acknowledged = false; const value = target(); await acknowledgeProbeExport(value, async () => { acknowledged = true; }, { path: artifact.path, bytes: artifact.bytes }); expect(acknowledged).toBe(true);
    for (const expected of [{ path: 'dist/cycle-01.splat', bytes: artifact.bytes }, { path: `${path}cycle-02.splat`, bytes: artifact.bytes },
      { path: artifact.path, bytes: 8192000 }, { path: artifact.path, bytes: 0 }, { path: artifact.path, bytes: 8191969 }]) {
      let clicked = false; await expect(acknowledgeProbeExport(target(), async () => { clicked = true; }, expected)).rejects.toThrow(); expect(clicked).toBe(false);
    }
    const full = { artifact: { path: `${path}attempt-01.splat`, bytes: 8192000, sha256: artifact.sha256 }, oracleStatus: 'passed', oracleError: null, independentOracle: { encodedSha256: artifact.sha256 } };
    await expect(acknowledgeProbeExport(full, async () => undefined)).resolves.toBeUndefined();
  });
});
