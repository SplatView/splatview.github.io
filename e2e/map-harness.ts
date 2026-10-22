import { admittedExport } from './admitted-export';
// Test-only entry; no renderer/device is needed to exercise the actual worker/WASM transport.
import { CoreClient } from '../src/document/coreClient';
import { ResourceLedger } from '../src/document/resources';
import { validateSelectionMap, type AdoptedSelectionMap, type SelectionMapData } from '../src/document/selectionMap';
import { gaussianPly } from '../tests/fixtures/gaussians';
import type { WorkerRequest } from '../src/document/types';

function mapData(channels = 15, large = false): SelectionMapData {
  const fullWidth = large ? 1025 : 4, fullHeight = large ? 769 : 3;
  const scale = Math.min(1, Math.sqrt(262144 / (fullWidth * fullHeight))), width = Math.floor(fullWidth * scale), height = Math.floor(fullHeight * scale);
  return { width, height, fullWidth, fullHeight, sourceCount: 3,
    depths: new Float32Array(width * height).fill(2), opacities: new Float32Array(width * height).fill(.5),
    colors: channels & 4 ? new Float32Array(width * height * 3).fill(.25) : undefined,
    visible: channels & 8 ? new Uint32Array([7]) : undefined };
}
async function setup(budget = 128 * 1024 * 1024) {
  const client = new CoreClient(), sourceLedger = new ResourceLedger(128 * 1024 * 1024);
  const { documentId, sourceGeneration } = client.revision;
  const { summary: initial } = await client.load(new File([gaussianPly(0)], 'map-fixture.ply'), 3, budget, {
    admit: bytes => sourceLedger.reserve('work', bytes),
    current() {
      if (client.revision.documentId !== documentId || client.revision.sourceGeneration !== sourceGeneration)
        throw new Error('The map fixture source was replaced.');
    },
  });
  if (sourceLedger.usage.bytes || sourceLedger.usage.allocations) throw new Error('The map fixture source retained a read reservation.');
  // Map transfer peak assertions cover the map operation after the admitted
  // source load has released all of its independently measured input work.
  const ledger = new ResourceLedger(128 * 1024 * 1024);
  const options = { admit: (bytes: number) => ledger.reserve('work', bytes), current() {} };
  return { client, ledger, initial, options };
}
function valid(map: AdoptedSelectionMap) { try { map.assertCurrent(); return true; } catch { return false; } }
type Fault = 'cancel-first' | 'cancel-middle' | 'cancel-ready' | 'stale-middle' | 'stale-ready' | 'bad-offset' | 'bad-length' |
  'bad-build' | 'bad-base' | 'nan-depth' | 'tail-bits' | 'post-once' | 'post-all' | 'dispose' | 'detach' | 'wrong-count' | 'wrong-dimensions' | 'early-control' |
  'stale-committed' | 'cancel-committed' | 'initial-post';

export const mapHarness = {
  async connectedHeldUpgrade() {
    const { client, ledger, initial, options } = await setup();
    try {
      const ordinary = await client.command({ command: 'colorPick', sessionId: 1, index: 0, camera: initial.camera,
        width: 4, height: 3, seed: [1, 1], operation: 0, tolerance: 1, connected: false });
      const first = await client.adoptSelectionMap(mapData(15), options);
      const enabled = await client.command({ command: 'colorTolerance', sessionId: 1, tolerance: 1, connected: true, mapId: first.mapId });
      const disabled = await client.command({ command: 'colorTolerance', sessionId: 1, tolerance: .5, connected: false });
      const second = await client.adoptSelectionMap(mapData(15), options), upgraded = await client.command({ command: 'summary' });
      await first.dispose(); const oldReleased = await client.command({ command: 'summary' }), upgradedBytes = ledger.usage.bytes;
      const wrongEnd = await client.command({ command: 'endTolerance', sessionId: 999 });
      await second.dispose(); const activeReleased = await client.command({ command: 'summary' }), heldBytes = ledger.usage.bytes;
      const reenabled = await client.command({ command: 'colorTolerance', sessionId: 1, tolerance: 1, connected: true });
      const ended = await client.command({ command: 'endTolerance', sessionId: 1 });
      return { ordinary, enabled, disabled, firstId: first.mapId, secondId: second.mapId, firstBytes: first.nativeBytes, secondBytes: second.nativeBytes,
        upgraded, oldReleased, upgradedBytes, wrongEnd, activeReleased, heldBytes, reenabled, ended, endBytes: ledger.usage.bytes,
        firstValid: valid(first), secondValid: valid(second) };
    } finally { client.dispose(); }
  },
  async connectedRefusals() {
    const { client, ledger, initial, options } = await setup();
    try {
      await client.command({ command: 'colorPick', sessionId: 1, index: 0, camera: initial.camera,
        width: 4, height: 3, seed: [1, 1], operation: 0, tolerance: 1, connected: false });
      const errors: Record<string, string> = {};
      const refuse = async (name: string, command: Record<string, unknown> & { command: string }) => {
        try { await client.command(command); errors[name] = ''; } catch (error) { errors[name] = String(error); }
        return client.command({ command: 'summary' });
      };
      const incomplete = await client.adoptSelectionMap(mapData(3), options);
      const missingChannels = await refuse('channels', { command: 'colorTolerance', sessionId: 1, tolerance: 1, connected: true, mapId: incomplete.mapId });
      const incompatible = await client.adoptSelectionMap({ ...mapData(15), width: 8, height: 6, fullWidth: 8, fullHeight: 6,
        depths: new Float32Array(48).fill(2), opacities: new Float32Array(48).fill(.5), colors: new Float32Array(144).fill(.25) }, options);
      const mismatchedView = await refuse('view', { command: 'colorTolerance', sessionId: 1, tolerance: 1, connected: true, mapId: incompatible.mapId });
      const first = await client.adoptSelectionMap(mapData(15), options);
      const staleMap = await refuse('stale', { command: 'colorTolerance', sessionId: 1, tolerance: 1, connected: true, mapId: incomplete.mapId });
      const enabled = await client.command({ command: 'colorTolerance', sessionId: 1, tolerance: 1, connected: true, mapId: first.mapId });
      const masks: number[][] = []; await client.readMasks(bytes => masks.push(Array.from(new Uint8Array(bytes))));
      const output = new Uint8Array(await admittedExport(client, 0, 0));
      const second = await client.adoptSelectionMap(mapData(15), options);
      const wrongKind = await refuse('kind', { command: 'fillTolerance', sessionId: 1, tolerance: 0 });
      const wrongSession = await refuse('session', { command: 'colorTolerance', sessionId: 999, tolerance: 0, connected: false });
      const substitutedMap = await refuse('substitute', { command: 'colorTolerance', sessionId: 1, tolerance: 0, connected: true, mapId: second.mapId });
      const afterMasks: number[][] = []; await client.readMasks(bytes => afterMasks.push(Array.from(new Uint8Array(bytes))));
      const saved = new Uint8Array(await admittedExport(client, 0, 0));
      const beforeEndBytes = ledger.usage.bytes;
      await first.dispose(); await second.dispose(); await client.command({ command: 'endTolerance', sessionId: 1 });
      return { errors, missingChannels, mismatchedView, staleMap, enabled, wrongKind, wrongSession, substitutedMap,
        firstId: first.mapId, secondId: second.mapId, firstBytes: first.nativeBytes, secondBytes: second.nativeBytes, masks, afterMasks,
        sameOutput: output.length === saved.length && output.every((value, index) => value === saved[index]), beforeEndBytes, endBytes: ledger.usage.bytes };
    } finally { client.dispose(); }
  },
  async connectedFillRollbackRetention() {
    const { client, ledger, initial, options } = await setup();
    try {
      await client.command({ command: 'selectAll' }); await client.command({ command: 'delete' }); await client.command({ command: 'undo' });
      const first = await client.adoptSelectionMap(mapData(15), options);
      const original = await client.command({ command: 'colorPick', sessionId: 1, index: 0, camera: initial.camera,
        width: 4, height: 3, seed: [1, 1], operation: 0, tolerance: 1, connected: true, mapId: first.mapId });
      const second = await client.adoptSelectionMap(mapData(3), options); await first.dispose();
      const masks: number[][] = []; await client.readMasks(bytes => masks.push(Array.from(new Uint8Array(bytes))));
      const output = new Uint8Array(await admittedExport(client, 0, 0));
      const before = await client.command({ command: 'summary' }), beforeBytes = ledger.usage.bytes;
      const owner = client.createOperation(); await client.beginOperation(owner);
      const endedInside = await client.command({ command: 'endTolerance', sessionId: 1 });
      const replacement = await client.command({ command: 'fillPick', sampleRadiusPixels: 1, sessionId: 2, mapId: second.mapId, camera: initial.camera,
        width: 4, height: 3, seed: [1, 1], operation: 2, tolerance: 0, overlap: true, visibleOnly: false });
      const replacementBytes = ledger.usage.bytes;
      const restored = await client.rollbackOperation(owner), restoredBytes = ledger.usage.bytes; await client.finishOperation(owner);
      const afterMasks: number[][] = []; await client.readMasks(bytes => afterMasks.push(Array.from(new Uint8Array(bytes))));
      const saved = new Uint8Array(await admittedExport(client, 0, 0));
      const wrongEnd = await client.command({ command: 'endTolerance', sessionId: 2 });
      await second.dispose(); const held = await client.command({ command: 'summary' }), heldBytes = ledger.usage.bytes;
      const amended = await client.command({ command: 'colorTolerance', sessionId: 1, tolerance: 1, connected: true });
      const ended = await client.command({ command: 'endTolerance', sessionId: 1 });
      return { original, before, beforeBytes, endedInside, replacement, replacementBytes, restored, restoredBytes, wrongEnd, held, heldBytes, amended, ended,
        firstId: first.mapId, secondId: second.mapId, firstBytes: first.nativeBytes, secondBytes: second.nativeBytes, masks, afterMasks,
        sameOutput: output.length === saved.length && output.every((value, index) => value === saved[index]), endBytes: ledger.usage.bytes };
    } finally { client.dispose(); }
  },
  async fillHeldUpgrade() {
    const { client, ledger, initial, options } = await setup();
    try {
      const first = await client.adoptSelectionMap(mapData(3), options);
      const picked = await client.command({ command: 'fillPick', sampleRadiusPixels: 1, sessionId: 1, mapId: first.mapId, camera: initial.camera,
        width: 4, height: 3, seed: [1, 1], operation: 0, tolerance: 0, overlap: true, visibleOnly: false });
      const second = await client.adoptSelectionMap(mapData(15), options), upgraded = await client.command({ command: 'summary' });
      const upgradedBytes = ledger.usage.bytes;
      await first.dispose(); const oldReleased = await client.command({ command: 'summary' }), oldReleasedBytes = ledger.usage.bytes;
      const wrongEnd = await client.command({ command: 'endTolerance', sessionId: 999 });
      await second.dispose(); const activeReleased = await client.command({ command: 'summary' }), heldBytes = ledger.usage.bytes;
      const amended = await client.command({ command: 'fillTolerance', sessionId: 1, tolerance: 1 });
      const ended = await client.command({ command: 'endTolerance', sessionId: 1 });
      return { firstId: first.mapId, secondId: second.mapId, firstBytes: first.nativeBytes, secondBytes: second.nativeBytes,
        picked, upgraded, upgradedBytes, oldReleased, oldReleasedBytes, wrongEnd, activeReleased, heldBytes, amended, ended,
        endBytes: ledger.usage.bytes, firstValid: valid(first), secondValid: valid(second) };
    } finally { client.dispose(); }
  },
  async fillRollbackRetention() {
    const { client, ledger, initial, options } = await setup();
    try {
      await client.command({ command: 'selectAll' }); await client.command({ command: 'delete' }); await client.command({ command: 'undo' });
      const first = await client.adoptSelectionMap(mapData(3), options);
      const pick = (sessionId: number, mapId: number, operation: number) => client.command({ command: 'fillPick', sampleRadiusPixels: 1, sessionId, mapId,
        camera: initial.camera, width: 4, height: 3, seed: [1, 1], operation, tolerance: 0, overlap: true, visibleOnly: false });
      const original = await pick(1, first.mapId, 0);
      const second = await client.adoptSelectionMap(mapData(15), options); await first.dispose();
      const before = await client.command({ command: 'summary' }), beforeBytes = ledger.usage.bytes;
      const owner = client.createOperation(); await client.beginOperation(owner);
      const endedInside = await client.command({ command: 'endTolerance', sessionId: 1 }), endedInsideBytes = ledger.usage.bytes;
      const replacement = await pick(2, second.mapId, 2), replacementBytes = ledger.usage.bytes;
      const restored = await client.rollbackOperation(owner), restoredBytes = ledger.usage.bytes; await client.finishOperation(owner);
      const wrongEnd = await client.command({ command: 'endTolerance', sessionId: 2 });
      const amended = await client.command({ command: 'fillTolerance', sessionId: 1, tolerance: 0 });
      await second.dispose(); const held = await client.command({ command: 'summary' }), heldBytes = ledger.usage.bytes;
      const ended = await client.command({ command: 'endTolerance', sessionId: 1 });
      return { firstId: first.mapId, secondId: second.mapId, firstBytes: first.nativeBytes, secondBytes: second.nativeBytes,
        original, before, beforeBytes, endedInside, endedInsideBytes, replacement, replacementBytes, restored, restoredBytes,
        wrongEnd, amended, held, heldBytes, ended, endBytes: ledger.usage.bytes };
    } finally { client.dispose(); }
  },
  async adopt(channels: number, large: boolean) {
    const { client, ledger, initial, options } = await setup();
    try {
      const data = mapData(channels, large), layout = validateSelectionMap(data, 1), lengths: number[] = [], transferCounts: number[] = [];
      const worker = (client as unknown as { worker: Worker }).worker, post = worker.postMessage.bind(worker);
      worker.postMessage = ((request: WorkerRequest, transfer: Transferable[]) => {
        if (request.type === 'map-chunk') { lengths.push(request.bytes.byteLength); transferCounts.push(transfer.length); }
        post(request, transfer);
      }) as typeof worker.postMessage;
      const handle = await client.adoptSelectionMap(data, options), retained = ledger.usage.bytes;
      const summary = await client.command({ command: 'summary' }), active = valid(handle);
      const unchanged = ['revision', 'contentRevision', 'canUndo', 'canRedo', 'selected', 'visible'].every(key => initial[key as keyof typeof initial] === summary[key as keyof typeof initial]);
      const callerBytes = data.depths.byteLength + data.opacities.byteLength + (data.colors?.byteLength ?? 0) + (data.visible?.byteLength ?? 0);
      await handle.dispose(); await handle.dispose(); const released = await client.command({ command: 'summary' });
      return { layout, lengths, transferCounts, retained, peak: ledger.usage.peakBytes, active, unchanged, callerBytes,
        nativeBytes: summary.selectionMapBytes, activeId: summary.selectionMapId, releasedId: released.selectionMapId, endBytes: ledger.usage.bytes, disposedValid: valid(handle) };
    } finally { client.dispose(); }
  },
  async replacement() {
    const { client, ledger, options } = await setup();
    try {
      const first = await client.adoptSelectionMap(mapData(3), options), firstBytes = ledger.usage.bytes;
      const second = await client.adoptSelectionMap(mapData(15), options), afterReplace = ledger.usage.bytes;
      const firstValid = valid(first), secondValid = valid(second); await first.dispose();
      const summary = await client.command({ command: 'summary' }); await second.dispose();
      return { firstBytes, afterReplace, peak: ledger.usage.peakBytes, firstValid, secondValid, active: summary.selectionMapId, secondId: second.mapId, endBytes: ledger.usage.bytes };
    } finally { client.dispose(); }
  },
  async failure(kind: Fault) {
    const { client, ledger, options } = await setup();
    const old = await client.adoptSelectionMap(mapData(3), options), oldBytes = ledger.usage.bytes;
    const abort = new AbortController(), data = mapData(15, true); let stale = false, chunks = 0, fired = false, blocked = false;
    const worker = (client as unknown as { worker: Worker }).worker, post = worker.postMessage.bind(worker);
    worker.postMessage = ((request: WorkerRequest, transfer: Transferable[] = []) => {
      if (blocked) throw new Error('Injected persistent post failure');
      if (request.type === 'selection-map') {
        if (kind === 'initial-post') throw new Error('Injected initial post failure');
        if (kind === 'wrong-count') request.descriptor.sourceCount = 2;
        if (kind === 'wrong-dimensions') request.descriptor.mapWidth++;
        if (kind === 'early-control') {
          post(request, transfer); post({ ...request, type: 'map-commit', mapId: request.descriptor.mapId } as WorkerRequest); return;
        }
      }
      if (request.type === 'map-commit' && !fired) {
        if (kind === 'cancel-ready') { fired = true; abort.abort(); }
      }
      if (request.type === 'map-commit') {
        if (kind === 'stale-committed') stale = true;
        if (kind === 'cancel-committed') abort.abort();
      }
      if (request.type === 'map-chunk') {
        chunks++;
        if (!fired && ((kind.endsWith('middle') || kind === 'detach') ? chunks === 2 : true)) {
          fired = true;
          if (kind === 'cancel-first' || kind === 'cancel-middle') abort.abort();
          if (kind === 'stale-middle') stale = true;
          if (kind === 'bad-offset') request.offset += 4;
          if (kind === 'bad-length') request.bytes = request.bytes.slice(0, request.bytes.byteLength - 4);
          if (kind === 'bad-build') request.buildId = 'obsolete';
          if (kind === 'bad-base') request.base.documentId = 'other';
          if (kind === 'nan-depth') new Float32Array(request.bytes)[0] = NaN;
          if (kind === 'tail-bits') data.visible![0] = 8;
          if (kind === 'post-once') throw new Error('Injected one post failure');
          if (kind === 'post-all') { blocked = true; throw new Error('Injected persistent post failure'); }
          if (kind === 'dispose') client.dispose();
          if (kind === 'detach') structuredClone(data.opacities.buffer, { transfer: [data.opacities.buffer] });
        }
        if (request.offset + request.bytes.byteLength === validateSelectionMap(mapData(15, true), 1).payloadBytes) {
          if (kind === 'stale-ready') stale = true;
          // Cancel at the final pre-commit guard, before committing becomes linearized.
          if (kind === 'cancel-ready') abort.abort();
        }
      }
      post(request, transfer);
    }) as typeof worker.postMessage;
    let error = '', succeeded = false;
    try { await client.adoptSelectionMap(data, { ...options, signal: abort.signal, current() { if (stale) throw new Error('View expired'); } }); succeeded = true; }
    catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
    // Restore the testing interceptor before inspecting recoverable native state.
    worker.postMessage = post;
    let summary, usable = true;
    try { summary = await client.command({ command: 'summary' }); } catch { usable = false; }
    const beforeDispose = ledger.usage.bytes, oldValid = valid(old); await old.dispose(); client.dispose();
    return { kind, error, succeeded, chunks, usable, oldValid, oldBytes, beforeDispose, active: summary?.selectionMapId,
      pending: summary?.pendingSelectionMapId, retained: summary?.selectionMapRetainedIds, oldId: old.mapId, endBytes: ledger.usage.bytes };
  },
  async serialized() {
    const { client, ledger, options } = await setup();
    try {
      const phases: string[] = [], worker = (client as unknown as { worker: Worker }).worker, post = worker.postMessage.bind(worker);
      worker.postMessage = ((request: WorkerRequest, transfer: Transferable[] = []) => {
        if (request.type === 'selection-map') phases.push(`begin:${request.descriptor.mapId}`);
        if (request.type === 'map-chunk') phases.push(`chunk:${request.mapId}`);
        if (request.type === 'map-commit') phases.push(`commit:${request.mapId}`);
        if (request.type === 'command') phases.push(`command:${request.command.command}`);
        post(request, transfer);
      }) as typeof worker.postMessage;
      const firstWork = client.adoptSelectionMap(mapData(15, true), options), secondWork = client.adoptSelectionMap(mapData(3), options);
      const summaryWork = client.command({ command: 'summary' });
      const [first, second, summary] = await Promise.all([firstWork, secondWork, summaryWork]);
      const firstValid = valid(first), secondValid = valid(second); await first.dispose(); await second.dispose();
      return { phases, firstId: first.mapId, secondId: second.mapId, firstValid, secondValid, active: summary.selectionMapId, endBytes: ledger.usage.bytes };
    } finally { client.dispose(); }
  },
  async refusal(native: boolean) {
    const { client, ledger, options } = await setup(native ? 4 * 1024 * 1024 : undefined);
    try {
      const old = await client.adoptSelectionMap(mapData(3), options); let error = '';
      const candidateLedger = native ? ledger : new ResourceLedger(1);
      try { await client.adoptSelectionMap(mapData(15, true), { ...options, admit: bytes => candidateLedger.reserve('work', bytes) }); }
      catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
      const summary = await client.command({ command: 'summary' }), oldValid = valid(old), bytes = ledger.usage.bytes;
      await old.dispose(); return { error, oldValid, bytes, oldId: old.mapId, active: summary.selectionMapId, pending: summary.pendingSelectionMapId,
        retained: summary.selectionMapRetainedIds, endBytes: ledger.usage.bytes, candidateBytes: candidateLedger.usage.bytes };
    } finally { client.dispose(); }
  },
  async ownership(action: 'commit' | 'rollback' | 'delete' | 'select' | 'worker-error') {
    const { client, ledger, options } = await setup();
    try {
      const handle = await client.adoptSelectionMap(mapData(15), options), originalBytes = ledger.usage.bytes;
      if (action === 'worker-error') {
        const worker = (client as unknown as { worker: Worker }).worker;
        worker.onerror!(new ErrorEvent('error', { message: 'Injected worker fault', cancelable: true }));
        return { originalBytes, retainedBytes: ledger.usage.bytes, endBytes: ledger.usage.bytes, valid: valid(handle) };
      }
      if (action === 'select' || action === 'delete') {
        await client.command({ command: 'single', index: 0 });
        if (action === 'delete') await client.command({ command: 'delete' });
        const summary = await client.command({ command: 'summary' }), retainedBytes = ledger.usage.bytes, active = valid(handle);
        await handle.dispose(); return { originalBytes, retainedBytes, active: summary.selectionMapId, endBytes: ledger.usage.bytes, valid: active };
      }
      await client.command({ command: 'beginTransaction' }); await handle.dispose();
      const held = await client.command({ command: 'summary' }), retainedBytes = ledger.usage.bytes;
      await client.command({ command: action === 'commit' ? 'commitTransaction' : 'rollbackTransaction' });
      const finished = await client.command({ command: 'summary' }); await handle.dispose();
      return { originalBytes, retainedBytes, heldId: held.selectionMapId, heldIds: held.selectionMapRetainedIds, handleId: handle.mapId,
        finishedId: finished.selectionMapId, finishedIds: finished.selectionMapRetainedIds, endBytes: ledger.usage.bytes, valid: valid(handle) };
    } finally { client.dispose(); }
  },
  async deletedVisibility() {
    const { client, ledger, options } = await setup();
    try {
      await client.command({ command: 'single', index: 1 }); await client.command({ command: 'delete' });
      let error = '';
      try { await client.adoptSelectionMap(mapData(15), options); } catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
      const data = mapData(15); data.visible![0] = 5;
      const validMap = await client.adoptSelectionMap(data, options), summary = await client.command({ command: 'summary' });
      await validMap.dispose(); return { error, active: summary.selectionMapId, count: summary.count, visible: summary.visible, endBytes: ledger.usage.bytes };
    } finally { client.dispose(); }
  },
};
(window as unknown as { mapHarness: typeof mapHarness }).mapHarness = mapHarness;
