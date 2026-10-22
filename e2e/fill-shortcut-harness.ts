// Test-only instrumentation of the real App. No production module imports
// this probe; command results, masks and exports remain actual WASM/WebGPU.
import { AppController } from '../src/app/controller';
import { setSelectionPreferences, useApp } from '../src/app/store';
import type { SceneCommand } from '../src/document/types';
import type { ResourceLease, ResourceLedger } from '../src/document/resources';
import type { CachedSelectionMap } from '../src/document/selectionMapCache';
import type { DocumentSelectionMaps } from '../src/app/selectionMaps';
import { fillPositions } from './fill-fixture';
import { polygonGpu, polygonProjection } from './polygon-harness';
import { exportWorkObservation } from './admitted-export';
import { requireGaussianScene } from './gaussian-harness-scene';

type Session = { started?: Promise<unknown>; draining?: Promise<unknown>; finishing?: Promise<unknown>; cancellation?: Promise<unknown> };
type Internals = {
  selection?: { session: Session }; selectionCleanup: Promise<unknown>; selectionCleanupOwner?: unknown;
  tolerance?: { id: number; active: boolean; session: { flush(): Promise<void> } };
  toleranceCleanup: Promise<unknown>; releasedDrain?: Promise<unknown>; editOperation?: { finished: Promise<unknown> };
  releasedSelections: { cancel: AbortController; seed: number[] }[]; ledger: ResourceLedger; selectionMaps: DocumentSelectionMaps;
};
function gate() {
  let release!: () => void;
  return { held: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}
export function installFillShortcutProbe(controller: AppController) {
  const client = controller.client!, renderer = controller.renderer!, camera = controller.camera!;
  const internals = controller as unknown as Internals, command = client.command.bind(client);
  const traffic: SceneCommand[] = [], counters = { cancel: 0, end: 0, clearInput: 0, maps: 0, picks: 0 };
  const cancel = controller.cancelSelectionGesture.bind(controller), end = controller.endToleranceSelection.bind(controller), clear = camera.clearInput.bind(camera);
  const map = controller.selectionMap.bind(controller), pick = renderer.pick.bind(renderer);
  const submit = controller.command.bind(controller), admittedCommands = new Set<ReturnType<AppController['command']>>();
  const reserve = internals.ledger.reserve.bind(internals.ledger);
  let hold: 'map' | 'pick' | undefined, activeGate: ReturnType<typeof gate> | undefined, refuseCancel = false;
  let cachedMap: CachedSelectionMap | undefined;
  const control = { entered: false, returned: false };
  controller.cancelSelectionGesture = (...args) => { counters.cancel++; return cancel(...args); };
  controller.endToleranceSelection = () => { counters.end++; end(); };
  camera.clearInput = () => { counters.clearInput++; clear(); };
  client.command = request => { traffic.push(structuredClone(request)); return command(request); };
  const preview = client.livePreview.bind(client);
  client.livePreview = request => { traffic.push(structuredClone(request)); return preview(request); };
  controller.command = (...args) => {
    // A toolbar command first joins completed-owner cleanup before creating
    // editOperation. Observe its original promise from admission, so snapshots
    // cannot overtake Undo/Redo during that initial asynchronous boundary.
    const operation = submit(...args); admittedCommands.add(operation);
    // Both observer branches resolve; return the unchanged original promise
    // so its value/rejection still reaches the caller and any flush waiter.
    void operation.then(() => { admittedCommands.delete(operation); }, () => { admittedCommands.delete(operation); });
    return operation;
  };
  internals.ledger.reserve = (kind, bytes) => {
    if (refuseCancel && kind === 'work' && internals.selectionCleanupOwner) throw new Error('Injected Fill-shortcut restoration admission refusal.');
    return reserve(kind, bytes);
  };
  const wait = async (kind: typeof hold) => {
    if (hold !== kind || !activeGate) return;
    hold = undefined; control.entered = true; await activeGate.held; control.returned = true;
  };
  controller.selectionMap = async (...args) => { counters.maps++; const value = await map(...args); cachedMap = value; await wait('map'); return value; };
  renderer.pick = async (...args) => { counters.picks++; const value = await pick(...args); await wait('pick'); return value; };
  const flush = async () => {
    await internals.tolerance?.session.flush();
    const joined = new Set<Promise<unknown>>();
    for (;;) {
      const session = internals.selection?.session;
      const pending = [session?.started, session?.draining, session?.finishing, session?.cancellation, internals.selectionCleanup,
        internals.toleranceCleanup, internals.releasedDrain, internals.editOperation?.finished, ...admittedCommands]
        .filter((value): value is Promise<unknown> => !!value && !joined.has(value));
      if (!pending.length) return;
      for (const value of pending) joined.add(value);
      await Promise.all(pending);
    }
  };
  const state = () => ({ tool: useApp.getState().tool, mode: useApp.getState().mode, fly: useApp.getState().fly,
    autoOrbit: useApp.getState().autoOrbit, pending: useApp.getState().pendingSelectionCount,
    owner: internals.tolerance?.id ?? null, active: controller.selectionActive, recovery: useApp.getState().selectionRecovery,
    cleanupOwned: !!internals.selectionCleanupOwner, editing: controller.editingAvailable,
    records: internals.releasedSelections.map(record => ({ aborted: record.cancel.signal.aborted, seed: record.seed })),
    counters: { ...counters }, traffic: structuredClone(traffic) });
  const snapshot = async () => {
    await flush(); const before = await command({ command: 'summary' }), count = fillPositions.length;
    const stride = 40 + 4 * Math.ceil(3 * (Math.min(before.shDegree, 3) + 1) ** 2 / 2);
    if (before.count !== count || requireGaussianScene(controller.scene).stride !== stride || controller.client !== client)
      throw new Error('The Fill diagnostic lost its native record owner or layout.');
    const records = new Uint8Array(count * stride); let next = 0, masks = new Uint8Array();
    await client.stream(async (first, length, bytes) => {
      if (first !== next || length <= 0 || first + length > count || bytes.byteLength !== length * stride)
        throw new Error('The Fill native stream changed its record range.');
      records.set(new Uint8Array(bytes), first * stride); next += length;
    }, bytes => { masks = new Uint8Array(bytes); });
    if (next !== count || masks.length !== count || controller.client !== client)
      throw new Error('The Fill native stream omitted records or canonical masks.');
    const selectedBytes: number[] = [], allBytes: number[] = [], ids: number[] = [], view = new DataView(records.buffer);
    for (let index = 0; index < count; index++) {
      if (masks[index] & 2) continue;
      const record = records.subarray(index * stride, (index + 1) * stride); allBytes.push(...record);
      if (!(masks[index] & 1)) continue;
      selectedBytes.push(...record);
      const point = [view.getFloat32(index * stride, true), -view.getFloat32(index * stride + 4, true), -view.getFloat32(index * stride + 8, true)];
      const id = fillPositions.findIndex(source => source.every((value, axis) => Math.abs(value - point[axis]) < 1e-5));
      if (id < 0 || ids.includes(id)) throw new Error('The Fill stream has an unknown or repeated source position.');
      ids.push(id);
    }
    const summary = await command({ command: 'summary' });
    const owners = internals.ledger as unknown as {
      entries: Map<symbol, { category: string; bytes: number }>;
      identities: WeakMap<ResourceLease, symbol>;
    };
    const workOwnership = exportWorkObservation(client, internals.ledger);
    const retained = (client as unknown as { exportOutputLease?: ResourceLease }).exportOutputLease;
    const retainedId = retained && owners.identities.get(retained);
    const workLeases = [...owners.entries].filter(([id, entry]) => entry.category === 'work' && id !== retainedId)
      .map(([, entry]) => entry.bytes).sort((a, b) => a - b);
    if (workLeases.length !== workOwnership.transient.allocations || workLeases.reduce((sum, bytes) => sum + bytes, 0) !== workOwnership.transient.bytes)
      throw new Error('Fill shortcut observation omitted a transient work credit.');
    let activeMap: { id: number; width: number; height: number; fullWidth: number; fullHeight: number; colors: boolean; visible: boolean;
      cpuBytes: number; allocationBytes: number } | null = null;
    if (cachedMap) {
      try {
        cachedMap.assertCurrent(); const value = cachedMap.map;
        activeMap = { id: cachedMap.mapId, width: value.width, height: value.height, fullWidth: value.fullWidth, fullHeight: value.fullHeight,
          colors: !!value.colors, visible: !!value.visible, allocationBytes: value.allocationBytes,
          cpuBytes: value.depths.byteLength + value.opacities.byteLength + (value.colors?.byteLength ?? 0) + (value.visible?.byteLength ?? 0) };
      } catch { /* A retired cache has no active CPU owner. */ }
    }
    return { ...state(), summary, ids: ids.sort((a, b) => a - b), gpu: await polygonGpu(controller), selectedBytes, allBytes,
      nativeMasks: Array.from(masks), nativeRecordBytes: Array.from(records), recordStride: stride,
      byteOracle: 'Exact native _sv_pack record bytes, including active SH; visible/selected canonical-mask subsets, not serialized export files.',
      work: workOwnership.transient.bytes, workLeases, workOwnership, activeMap,
      framebuffer: [renderer.canvas.width, renderer.canvas.height], scratch: renderer.surfaceScratch.snapshot,
      error: useApp.getState().error, dirty: useApp.getState().dirty, camera: [...camera.state] };
  };
  return {
    controller, traffic, counters, control, flush, state, snapshot,
    profiles(mode: 'basic' | 'pro') {
      if (useApp.getState().mode !== mode) throw new Error('Unexpected Fill shortcut profile.');
      setSelectionPreferences({ operation: 0, live: true, overlap: false, visibleOnly: false });
      controller.setSelectionTolerance(.1);
    },
    async baseline() {
      await controller.command({ command: 'single', index: 3, operation: 0 });
      await controller.command({ command: 'single', index: 2, operation: 0 });
      await controller.command({ command: 'undo' });
    },
    centers: () => polygonProjection(controller, fillPositions, true),
    outline: () => polygonProjection(controller, [[-.8, -.2, 0], [-.1, -.2, 0], [-.1, .2, 0], [-.8, .2, 0]], true),
    hold(kind: 'map' | 'pick') { activeGate = gate(); hold = kind; control.entered = control.returned = false; },
    release() { activeGate?.release(); },
    refuseCleanup(value: boolean) { refuseCancel = value; },
    async invalidateMaps() { await flush(); await internals.selectionMaps.invalidate(); cachedMap = undefined; },
    set(patch: Partial<ReturnType<typeof useApp.getState>>) { useApp.setState(patch); },
    async tolerance(value: number) { controller.setSelectionTolerance(value); await internals.tolerance?.session.flush(); await flush(); },
  };
}
declare global { interface Window { fillShortcutApp: ReturnType<typeof installFillShortcutProbe> } }
