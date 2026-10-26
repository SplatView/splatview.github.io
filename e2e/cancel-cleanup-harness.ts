import { requireWebGpuRenderer } from './gaussian-harness-scene';
// Test-only fault boundaries around the real App, worker, WASM and WebGPU.
// The production entry does not import this module or expose the controller.
import { AppController } from '../src/app/controller';
import { requireGaussianScene } from './gaussian-harness-scene';
import { setSelectionPreferences, useApp } from '../src/app/store';
import { AdmissionError, type ResourceLease, type ResourceLedger } from '../src/document/resources';
import type { NativeSummary, SceneCommand } from '../src/document/types';
import type { SelectionRunResult } from '../src/input/selectionSession';
import { polygonGpu, polygonProjection } from './polygon-harness';
import { polygonPly, polygonPositions } from './polygon-fixture';
import { GaussianRenderer } from '../src/renderer/webgpu/renderer';
import type { OperationOwner } from '../src/document/operationProtocol';
import { exportWorkObservation } from './admitted-export';
import type { RecoveryCheckpointDescription } from '../src/document/recoveryCheckpoint';

export type CleanupFault = 'admission' | 'native' | 'acknowledgement' | 'publication' | 'throw' | 'unknown';
type Session = {
  started?: Promise<unknown>; draining?: Promise<unknown>; finishing?: Promise<unknown>; cancellation?: Promise<unknown>;
  closed: boolean;
};
type Internals = {
  ledger: ResourceLedger;
  selection?: { session: Session };
  selectionCleanupOwner?: unknown;
  selectionCleanup: Promise<unknown>;
  toleranceCleanup: Promise<unknown>;
  releasedDrain?: Promise<unknown>;
  cancelReleasedSelections(): Promise<void>;
  editOperation?: { finished: Promise<unknown> };
  recovery?: Promise<boolean>;
  documentRecovery?: { description?: RecoveryCheckpointDescription };
  runSelectionCommand(owner: unknown, command: SceneCommand, livePreview?: boolean): Promise<SelectionRunResult>;
};
function gate() {
  let release!: () => void;
  return { held: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}
export function installCancelCleanupProbe(controller: AppController) {
  const client = controller.client!, scene = requireGaussianScene(controller.scene), renderer = requireWebGpuRenderer(controller.renderer);
  const internals = controller as unknown as Internals, ledger = internals.ledger;
  const command = client.command.bind(client), preview = client.livePreview.bind(client), stage = scene.stageMasks.bind(scene), reserve = ledger.reserve.bind(ledger);
  const beginOperation = client.beginOperation.bind(client), commitOperation = client.commitOperation.bind(client),
    rollbackOperation = client.rollbackOperation.bind(client), finishOperation = client.finishOperation.bind(client);
  const run = internals.runSelectionCommand.bind(controller), exporting = client.exportOwned.bind(client);
  const pick = renderer.pick.bind(renderer), map = controller.selectionMap.bind(controller), capture = renderer.capture.bind(renderer);
  const traffic: SceneCommand[] = [];
  let fault: CleanupFault | undefined, last = '', cancelling = false, activeGate: ReturnType<typeof gate> | undefined;
  const counters = { attempts: 0, nativeCancels: 0, admissions: 0, publications: 0, exports: 0, picks: 0, maps: 0, captures: 0 };
  const control = { entered: false, released: false, confirmEntered: false, graphicsEntered: false, creations: 0 };
  let olderTail: ReturnType<typeof gate> | undefined, retryResults: Promise<{ first: boolean; second: boolean; fresh: boolean }> | undefined;
  let olderCancellation: Promise<boolean> | undefined, olderSettled = false;
  let confirmGate: ReturnType<typeof gate> | undefined, confirmation: Promise<boolean> | undefined;
  let graphicsGate: ReturnType<typeof gate> | undefined, graphicsRecovery: Promise<boolean> | undefined;
  let latestNativeCancellation: NativeSummary | undefined;
  const originalRenderer = renderer, originalScene = scene, originalDocument = client.revision.documentId, originalView = controller.camera!.state;
  const readiness: { editing: boolean; cleanupOwned: boolean; recovering: boolean; selectionRecovery: string }[] = [];
  // Zustand notifies synchronously inside the ready publication. Capture the
  // controller authority at that boundary, before later React commits or
  // pointer activity can conceal an inconsistent readiness notification.
  useApp.subscribe((state, previous) => {
    if (state.ready && state.rendererState === 'ready' && (!previous.ready || previous.rendererState !== 'ready'))
      readiness.push({ editing: controller.editingAvailable, cleanupOwned: !!internals.selectionCleanupOwner,
        recovering: !!internals.recovery, selectionRecovery: state.selectionRecovery });
  });
  const retryRenderer = controller.retryRenderer.bind(controller);
  controller.retryRenderer = () => { graphicsRecovery = retryRenderer(); return graphicsRecovery; };
  ledger.reserve = (kind, bytes) => {
    if (cancelling && kind === 'work' && fault === 'admission') {
      counters.admissions++; throw new AdmissionError('Injected terminal cancellation admission refusal.');
    }
    return reserve(kind, bytes);
  };
  client.command = async request => {
    traffic.push(structuredClone(request)); last = request.command;
    if (request.command === 'cancelSelection' && fault === 'native') throw new Error('Injected terminal native cancellation refusal.');
    const result = await command(request);
    if (request.command === 'cancelSelection') {
      counters.nativeCancels++;
      latestNativeCancellation = structuredClone(result);
      if (fault === 'acknowledgement') throw new Error('Injected terminal cancellation acknowledgement loss.');
    }
    return result;
  };
  // Observe the actual typed lifecycle with recognizable transaction labels.
  // Keep `last` on the semantic scene command that owns mask publication.
  const operationTraffic = (command: string, operationOwner: OperationOwner) => {
    traffic.push({ command, operationOwner: structuredClone(operationOwner) });
  };
  client.beginOperation = owner => { operationTraffic('beginTransaction', owner); return beginOperation(owner); };
  client.commitOperation = owner => { operationTraffic('commitTransaction', owner); return commitOperation(owner); };
  client.rollbackOperation = owner => { operationTraffic('rollbackTransaction', owner); return rollbackOperation(owner); };
  client.finishOperation = owner => { operationTraffic('operationRetire', owner); return finishOperation(owner); };
  client.livePreview = request => { traffic.push(structuredClone(request)); last = request.command; return preview(request); };
  scene.stageMasks = async bytes => {
    if (last === 'confirmSelection' && confirmGate) {
      const held = confirmGate; control.confirmEntered = true; await held.held; confirmGate = undefined;
      throw new Error('Injected confirmation publication refusal.');
    }
    if (last === 'cancelSelection') {
      counters.publications++;
      if (fault === 'publication') throw new Error('Injected terminal cancellation publication refusal.');
    }
    return stage(bytes);
  };
  internals.runSelectionCommand = async (owner, request, livePreview) => {
    if (request.command !== 'cancelSelection') return run(owner, request, livePreview);
    counters.attempts++; cancelling = true;
    try {
      if (activeGate) { control.entered = true; await activeGate.held; activeGate = undefined; }
      if (fault === 'throw') throw new Error('Injected terminal cancellation adapter exception.');
      if (fault === 'unknown') return undefined as unknown as boolean;
      return await run(owner, request, livePreview);
    } finally { cancelling = false; }
  };
  client.exportOwned = async (...args) => { counters.exports++; return exporting(...args); };
  renderer.pick = async (...args) => { counters.picks++; return pick(...args); };
  renderer.capture = async (...args) => { counters.captures++; return capture(...args); };
  controller.selectionMap = async (...args) => { counters.maps++; return map(...args); };
  const flush = async () => {
    const joined = new Set<Promise<unknown>>();
    for (;;) {
      const session = internals.selection?.session;
      const pending = [session?.started, session?.draining, session?.finishing, session?.cancellation,
        internals.selectionCleanup, internals.toleranceCleanup, internals.releasedDrain, internals.editOperation?.finished]
        .filter((value): value is Promise<unknown> => !!value && !joined.has(value));
      if (!pending.length) return;
      for (const value of pending) joined.add(value);
      await Promise.allSettled(pending);
    }
  };
  const leases = () => {
    const owners = ledger as unknown as {
      entries: Map<symbol, { category: string; bytes: number }>;
      identities: WeakMap<ResourceLease, symbol>;
    };
    const workOwnership = exportWorkObservation(client, ledger);
    const retained = (client as unknown as { exportOutputLease?: ResourceLease }).exportOutputLease;
    const retainedId = retained && owners.identities.get(retained), entries = [...owners.entries];
    // The exact surviving native-output owner is reported separately from
    // transient cleanup work. Totals and accounting retain every real lease.
    const work = entries.filter(([id, entry]) => entry.category === 'work' && id !== retainedId).map(([, entry]) => entry.bytes).sort((a, b) => a - b);
    if (work.length !== workOwnership.transient.allocations || work.reduce((sum, bytes) => sum + bytes, 0) !== workOwnership.transient.bytes)
      throw new Error('Cleanup observation omitted a transient work credit.');
    return { bytes: ledger.usage.bytes, allocations: ledger.usage.allocations,
      work, workOwnership,
      history: entries.filter(([, entry]) => entry.category === 'history').map(([, entry]) => entry.bytes).sort((a, b) => a - b) };
  };
  const leaseIdentities = new Map<symbol, number>();
  const histogramIdentities = new Set<symbol>();
  const observeHistogramLease = () => {
    const release = (controller.renderer as unknown as {
      histogram?: { resources?: { release?: ResourceLease } };
    } | undefined)?.histogram?.resources?.release;
    if (!release) return false;
    const owners = ledger as unknown as {
      entries: Map<symbol, { category: string; bytes: number }>;
      identities: WeakMap<ResourceLease, symbol>;
    };
    const identity = owners.identities.get(release), entry = identity && owners.entries.get(identity);
    if (!ledger.owns(release, 'render') || !identity || !entry || entry.category !== 'render' || entry.bytes !== 12_304)
      throw new Error('The actual histogram resource must own its admitted 12,304-byte render lease.');
    histogramIdentities.add(identity);
    return true;
  };
  const accounting = () => {
    if (!client.nativeMemory) throw new Error('The cleanup fixture requires native heap accounting.');
    // Export scalar copies and stable test-local IDs, never mutable ledger
    // entries or the accounting owner. Keep this separate from legacy leases
    // comparisons, whose contract covers reservation totals and capacities.
    observeHistogramLease();
    const entries = [...(ledger as unknown as { entries: Map<symbol, { category: string; bytes: number }> }).entries]
      .map(([identity, entry]) => {
        let id = leaseIdentities.get(identity);
        if (id === undefined) { id = leaseIdentities.size + 1; leaseIdentities.set(identity, id); }
        return { id, category: entry.category, bytes: entry.bytes };
      }).sort((a, b) => a.id - b.id);
    // Remember confirmed physical identities after retirement. A replacement
    // renderer gets its own identity; size alone never identifies this owner.
    const histogramLeaseIds = [...histogramIdentities].map(identity => leaseIdentities.get(identity)).filter((id): id is number => id !== undefined).sort((a, b) => a - b);
    const owners = ledger as unknown as {
      entries: Map<symbol, { category: string; bytes: number }>;
      identities: WeakMap<ResourceLease, symbol>;
    };
    const nativeLease = client.nativeMemory.remainder, nativeIdentity = owners.identities.get(nativeLease);
    const nativeEntry = nativeIdentity && owners.entries.get(nativeIdentity);
    const nativeRemainderLeaseId = nativeIdentity && leaseIdentities.get(nativeIdentity);
    if (!ledger.owns(nativeLease, 'source') || !nativeEntry || nativeEntry.category !== 'source' ||
        nativeEntry.bytes !== client.nativeMemory.state.remainderBytes || nativeRemainderLeaseId === undefined)
      throw new Error('The actual native accounting owner must retain its measured source remainder lease.');
    // The checkpoint predates this probe. Observe the actual sole ledger
    // entry and accepted store description; its private lease is not exposed.
    const retainedRecovery = [...owners.entries].filter(([, entry]) => entry.category === 'recovery');
    if (retainedRecovery.length !== 1) throw new Error('The cleanup observation requires one actual retained recovery entry.');
    const [recoveryIdentity, recoveryEntry] = retainedRecovery[0], recoveryId = leaseIdentities.get(recoveryIdentity);
    const category = ledger.categorySnapshot.recovery, description = internals.documentRecovery?.description;
    if (!description || recoveryId === undefined || category.allocations !== 1 || category.bytes !== recoveryEntry.bytes ||
        description.binding.revision.documentId !== originalDocument ||
        description.binding.revision.sourceGeneration !== client.revision.sourceGeneration ||
        description.binding.source.assetDigest !== controller.sourceFingerprint?.assetDigest)
      throw new Error('The accounted recovery checkpoint entry does not match its category or document/source owner.');
    return { native: { ...client.nativeMemory.state }, nativeRemainderLeaseId, entries, histogramLeaseIds,
      recoveryOwner: { id: recoveryId, category: recoveryEntry.category, bytes: recoveryEntry.bytes,
        categoryBytes: category.bytes, categoryAllocations: category.allocations, checkpointRoot: description.rootSha256,
        observation: 'Actual sole retained ledger entry plus accepted checkpoint description; the private ResourceLease handle is not exposed.',
        checkpointBytes: description.plan.byteLength, maximumChunkBytes: description.plan.maximumChunkBytes,
        chunkCount: description.chunks.length, documentId: description.binding.revision.documentId,
        sourceGeneration: description.binding.revision.sourceGeneration, sourceDigest: description.binding.source.assetDigest } };
  };
  const finalPolygon = () => ({ command: 'polygon', points: polygonProjection(controller), camera: controller.camera!.state,
    width: requireWebGpuRenderer(controller.renderer).canvas.width, height: requireWebGpuRenderer(controller.renderer).canvas.height, operation: 0, overlap: false });
  const nativeRecords = async () => {
    const before = await command({ command: 'summary' }), count = polygonPositions.length;
    const stride = 40 + 4 * Math.ceil(3 * (Math.min(before.shDegree, 3) + 1) ** 2 / 2);
    if (before.count !== count || stride !== scene.stride || controller.client !== client)
      throw new Error('The cleanup diagnostic lost its native record owner or layout.');
    const records = new Uint8Array(count * stride); let next = 0, masks = new Uint8Array();
    await client.stream(async (first, length, bytes) => {
      if (first !== next || length <= 0 || first + length > count || bytes.byteLength !== length * stride)
        throw new Error('The cleanup native stream changed its record range.');
      records.set(new Uint8Array(bytes), first * stride); next += length;
    }, bytes => { masks = new Uint8Array(bytes); });
    if (next !== count || masks.length !== count || controller.client !== client)
      throw new Error('The cleanup native stream omitted records or canonical masks.');
    const selectedBytes: number[] = [], allBytes: number[] = [], ids: number[] = [], view = new DataView(records.buffer);
    for (let index = 0; index < count; index++) {
      // Document masks use bit0=selected, bit1=deleted. Preserve canonical
      // record order and exclude deleted members from both visible scopes.
      if (masks[index] & 2) continue;
      const record = records.subarray(index * stride, (index + 1) * stride); allBytes.push(...record);
      if (!(masks[index] & 1)) continue;
      selectedBytes.push(...record);
      // Native RUB positions -> the fixture's independently declared RDF
      // coordinates; IDs do not come from masks or an assumed selected list.
      const point = [view.getFloat32(index * stride, true), -view.getFloat32(index * stride + 4, true), -view.getFloat32(index * stride + 8, true)];
      const id = polygonPositions.findIndex(source => source.every((value, axis) => Math.abs(value - point[axis]) < 1e-5));
      if (id < 0 || ids.includes(id)) throw new Error('The cleanup stream has an unknown or repeated source position.');
      ids.push(id);
    }
    return { summary: await command({ command: 'summary' }), ids: ids.sort((a, b) => a - b), selectedBytes, allBytes,
      nativeMasks: Array.from(masks), nativeRecordBytes: Array.from(records), recordStride: stride,
      byteOracle: 'Exact native _sv_pack record bytes, including active SH; visible/selected canonical-mask subsets, not serialized export files.' };
  };
  const nativeSnapshot = async () => {
    const state = useApp.getState(), native = await nativeRecords();
    return { ...native,
      leases: leases(), accounting: accounting(), active: controller.selectionActive, editing: controller.editingAvailable, busy: state.busy, recovery: state.selectionRecovery,
      rendererState: state.rendererState, error: state.error, cleanupOwned: !!internals.selectionCleanupOwner,
      sameClient: controller.client === client && client.revision.documentId === originalDocument,
      sameView: controller.camera!.state.every((value, axis) => value === originalView[axis]),
      originalRenderer: controller.renderer === originalRenderer, originalScene: controller.scene === originalScene,
      epoch: requireWebGpuRenderer(controller.renderer).deviceEpoch, originalEpoch: originalRenderer.deviceEpoch, readiness: structuredClone(readiness),
      readyExposures: readiness.map(state => state.editing && !state.cleanupOwned && !state.recovering && state.selectionRecovery === 'idle') };
  };
  return {
    controller, traffic, counters, control, flush, nativeSnapshot,
    histogramLeaseReady: observeHistogramLease,
    outline: () => polygonProjection(controller, undefined, true).map(point => point.map(Math.round)),
    setFault(value?: CleanupFault) { fault = value; },
    hold() { activeGate = gate(); control.entered = control.released = false; },
    release() { control.released = true; activeGate?.release(); },
    profiles(mode: 'basic' | 'pro') {
      // App already selected the desired profile. Explicit options align both
      // independent fixtures while preserving the actual profile UI state.
      if (useApp.getState().mode !== mode) throw new Error('Unexpected cleanup test profile.');
      setSelectionPreferences({ operation: 0, live: true, overlap: false, visibleOnly: false });
    },
    async baseline() {
      await controller.command({ command: 'single', index: 0, operation: 0 });
      await controller.command({ command: 'single', index: 2, operation: 1 });
      await controller.command({ command: 'single', index: 3, operation: 1 });
      await controller.command({ command: 'undo' });
    },
    async snapshot() {
      await flush(); const state = useApp.getState();
      const native = await nativeRecords();
      return { ...native, gpu: await polygonGpu(controller), leases: leases(), accounting: accounting(), active: controller.selectionActive,
        editing: controller.editingAvailable, busy: state.busy, error: state.error, dragging: state.selectionDragging,
        captured: state.selectionOperation, outputPending: state.outputPending, recovery: state.selectionRecovery };
    },
    async blocked() {
      const before = { ...counters }, trafficBefore = traffic.length;
      const polygon = controller.beginPolygonGesture(0), geometric = controller.beginSelectionGesture(0);
      const mutation = await controller.command({ command: 'selectAll' });
      const tool = useApp.getState().tool;
      try {
        // Meet each path's ordinary tool precondition independently. Actual
        // App buttons are disabled; this probes dispatched/programmatic work
        // without allowing tool mismatch to masquerade as cleanup protection.
        useApp.setState({ tool: 'single' }); await controller.selectPixel(1, 1, 0);
        useApp.setState({ tool: 'color' }); await controller.selectColorPixel(1, 1, 0);
        useApp.setState({ tool: 'fill' }); await controller.fillPixel(1, 1, 0);
      } finally { useApp.setState({ tool }); }
      await controller.exportScene(5, 1);
      await controller.openFiles([new File([polygonPly()], 'blocked-replacement.ply')]);
      let captureError: string | undefined, mapError: string | undefined;
      try { await controller.capture(); }
      catch (error) { captureError = String(error); }
      try { await map(); }
      catch (error) { mapError = String(error); }
      return { polygon, geometric, mutation, traffic: traffic.slice(trafficBefore),
        counters: Object.fromEntries(Object.entries(counters).map(([key, value]) => [key, value - before[key as keyof typeof before]])),
        outputPending: useApp.getState().outputPending, sameClient: controller.client === client,
        sourceName: useApp.getState().sourceName, captureError, mapError };
    },
    concurrentRetry() {
      const first = controller.retrySelectionCleanup(), second = controller.retrySelectionCleanup();
      olderTail = gate(); olderSettled = false;
      const original = internals.cancelReleasedSelections;
      internals.cancelReleasedSelections = () => olderTail!.held;
      try { olderCancellation = controller.cancelSelectionGesture(true).then(result => { olderSettled = true; return result; }); }
      finally { internals.cancelReleasedSelections = original; }
      retryResults = first.then(async accepted => {
        const fresh = controller.beginPolygonGesture(0);
        return { first: accepted, second: await second, fresh };
      });
    },
    async joinedRetry() { return { ...await retryResults!, olderSettled }; },
    async previewFresh() {
      const canvas = renderer.canvas;
      await controller.updatePolygon({ command: 'polygon', points: polygonProjection(controller), camera: controller.camera!.state,
        width: canvas.width, height: canvas.height, operation: 0, overlap: false }, true);
    },
    async releaseOlder() { olderTail!.release(); return olderCancellation; },
    async finishFresh() {
      return controller.finishPolygonGesture(finalPolygon());
    },
    holdConfirmationFailure() { fault = 'admission'; confirmGate = gate(); control.confirmEntered = false; },
    startConfirmation() { confirmation = controller.confirmSelectionGesture(); },
    async duplicateFinish() {
      const before = traffic.length, ownedBefore = !!internals.selection;
      const results = await Promise.all([controller.confirmSelectionGesture(), controller.finishPolygonGesture(finalPolygon()),
        controller.finishSelectionGesture(finalPolygon()), controller.finishSinglePixel(1, 1, 0)]);
      return { results, ownedBefore, ownedAfter: !!internals.selection, closed: internals.selection?.session.closed,
        traffic: traffic.slice(before), summary: await command({ command: 'summary' }) };
    },
    async releaseConfirmation() { confirmGate!.release(); return confirmation ? await confirmation : undefined; },
    async loseGraphicsWithUploadFailure() {
      graphicsGate = gate(); control.graphicsEntered = false; control.creations = 0;
      const create = GaussianRenderer.create;
      GaussianRenderer.create = async canvas => {
        GaussianRenderer.create = create; control.creations++;
        const replacement = await create(canvas), allocate = replacement.allocateScene.bind(replacement);
        replacement.allocateScene = async (...args) => {
          const candidate = await allocate(...args), upload = candidate.upload.bind(candidate);
          candidate.upload = async (...chunk) => {
            await upload(...chunk); control.graphicsEntered = true; await graphicsGate!.held;
            throw new Error('Injected replacement scene upload refusal.');
          };
          return candidate;
        };
        return replacement;
      };
      renderer.device.destroy(); await renderer.device.lost;
      graphicsRecovery = controller.retryRenderer();
    },
    async releaseGraphicsFailure() { graphicsGate!.release(); return graphicsRecovery; },
    graphicsHeldState() {
      const state = useApp.getState();
      return { nativeCancellation: latestNativeCancellation, cleanupOwned: !!internals.selectionCleanupOwner,
        originalRenderer: controller.renderer === originalRenderer, originalScene: controller.scene === originalScene,
        editing: controller.editingAvailable, busy: state.busy, recovery: state.selectionRecovery, rendererState: state.rendererState,
        creations: control.creations };
    },
    async loseGraphicsWithCheckpoint() {
      await client.command({ command: 'cancelSelection' });
      const checkpoint = await client.command({ command: 'beginTransaction' });
      control.creations = 0;
      const create = GaussianRenderer.create;
      GaussianRenderer.create = async canvas => { GaussianRenderer.create = create; control.creations++; return create(canvas); };
      renderer.device.destroy(); await renderer.device.lost;
      graphicsRecovery = controller.retryRenderer();
      return { checkpoint, recovered: await graphicsRecovery };
    },
    async rollbackCheckpoint() { return client.command({ command: 'rollbackTransaction' }); },
    async joinGraphicsRecovery() { return graphicsRecovery; },
    async graphicsBlocked() {
      const before = traffic.length, exportsBefore = counters.exports;
      const mutation = await controller.command({ command: 'selectAll' });
      await controller.exportScene(5, 1);
      return { mutation, traffic: traffic.slice(before), exports: counters.exports - exportsBefore,
        polygon: controller.beginPolygonGesture(0), geometric: controller.beginSelectionGesture(0) };
    },
  };
}
declare global { interface Window { cancelCleanupApp: ReturnType<typeof installCancelCleanupProbe> } }
