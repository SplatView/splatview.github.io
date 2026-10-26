import { requireWebGpuRenderer } from './gaussian-harness-scene';
import { admittedExport, exportWorkObservation } from './admitted-export';
// Test-only real-controller entry. Production builds only include index.html.
import { AppController } from '../src/app/controller';
import { requireGaussianScene } from './gaussian-harness-scene';
import { useApp } from '../src/app/store';
import { AdmissionError, type ResourceLedger } from '../src/document/resources';
import type { AdoptedSelectionMap } from '../src/document/selectionMap';
import { connectedPly } from './connected-fixture';

async function gpuMasks(controller: AppController) {
  const renderer = requireWebGpuRenderer(controller.renderer), scene = requireGaussianScene(controller.scene), size = Math.max(4, scene.count * 4);
  const buffer = renderer.device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    const encoder = renderer.device.createCommandEncoder(); encoder.copyBufferToBuffer(scene.buffers.states, 0, buffer, 0, size);
    renderer.device.queue.submit([encoder.finish()]); await buffer.mapAsync(GPUMapMode.READ);
    const result = Array.from(new Uint32Array(buffer.getMappedRange().slice(0))); buffer.unmap(); return result;
  } finally { buffer.destroy(); }
}
function gate() {
  let resume!: () => void, entered!: () => void;
  return { release: new Promise<void>(resolve => { resume = resolve; }), waiting: new Promise<void>(resolve => { entered = resolve; }),
    resume: () => resume(), enter: () => entered() };
}
async function selectionReady(controller: AppController) {
  const deadline = performance.now() + 10_000;
  // A completed edit can queue automatic pivot work before its next frame.
  // Join that frame, then test the actual controller admission predicate.
  do {
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    if (controller.colorControlsEnabled) return;
  } while (performance.now() < deadline);
  throw new Error('Connected Color fixture selection admission did not become ready.');
}
async function setup() {
  const canvas = document.createElement('canvas'); canvas.style.width = '480px'; canvas.style.height = '300px'; document.body.append(canvas);
  const controller = new AppController(); await controller.initialize(canvas);
  await controller.openFiles([new File([connectedPly()], 'connected-contracts.ply')]);
  if (!controller.client || !controller.renderer || !controller.scene || !controller.camera)
    throw new Error(useApp.getState().error || 'No Connected Color scene opened.');
  controller.camera.set([0, 0, 0, 0, 0, 3, 1, 45, 0, 0, canvas.width / canvas.height]);
  useApp.setState({ tool: 'color', connectedColor: false, colorTolerance: .01, tolerance: .01, operation: 0, selectionDragging: false });
  await selectionReady(controller);
  const x = Math.floor(canvas.width / 2 - .6 / 3 * (canvas.height / 2 / Math.tan(Math.PI / 8))), y = Math.floor(canvas.height / 2);
  let picks = 0; const pick = controller.renderer.pick.bind(controller.renderer);
  controller.renderer.pick = async (...args) => { picks++; return pick(...args); };
  const flush = () => (controller as unknown as { tolerance?: { session: { flush(): Promise<void> } } }).tolerance?.session.flush();
  const ordinaryPick = async (operation: number) => {
    await selectionReady(controller);
    const accepted = await controller.selectColorPixel(x, y, operation);
    if (accepted) await selectionReady(controller);
    return accepted;
  };
  return { controller, client: controller.client, renderer: controller.renderer, scene: requireGaussianScene(controller.scene), x, y, flush, ordinaryPick, picks: () => picks,
    dispose: () => { controller.dispose(); canvas.remove(); } };
}
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((value, i) => value === b[i]);
function createHarness() {
  return {
    async refusal(kind: 'map' | 'publication') {
      const h = await setup(), { controller, client, scene } = h;
      const ledger = (controller as unknown as { ledger: ResourceLedger }).ledger, reserve = ledger.reserve.bind(ledger), stage = scene.stageMasks.bind(scene);
      try {
        await controller.command({ command: 'single', index: 0 }); await controller.command({ command: 'single', index: 3, operation: 1 });
        await controller.command({ command: 'delete' }); await controller.command({ command: 'undo' });
        // A no-op ordinary click captures the existing mask and Redo branch.
        if (!await h.ordinaryPick(0)) throw new Error('Ordinary checkpoint was refused.');
        const output = new Uint8Array(await admittedExport(client, 0, 1)), before = await client.command({ command: 'summary' }), masks = await gpuMasks(controller);
        if (kind === 'map') ledger.reserve = (kind, bytes) => {
          if (kind === 'work') throw new AdmissionError('Injected Connected map admission refusal.'); return reserve(kind, bytes);
        };
        else scene.stageMasks = async () => { throw new Error('Injected Connected mask publication refusal.'); };
        controller.setConnectedColor(true); await h.flush();
        ledger.reserve = reserve; scene.stageMasks = stage;
        const afterOutput = new Uint8Array(await admittedExport(client, 0, 1)), after = await client.command({ command: 'summary' }), afterMasks = await gpuMasks(controller);
        const error = useApp.getState().error, busy = useApp.getState().busy, modeAfter = useApp.getState().connectedColor;
        controller.setConnectedColor(true); await h.flush(); const connected = useApp.getState().summary?.selected;
        controller.setSelectionTolerance(.35); await h.flush(); const expanded = useApp.getState().summary?.selected;
        controller.setConnectedColor(false); await h.flush(); const ordinary = useApp.getState().summary?.selected;
        return { before, after, sameOutput: same(output, afterOutput), sameGpuMasks: masks.every((value, i) => value === afterMasks[i]),
          error, busy, modeAfter, connected, expanded, ordinary, picks: h.picks() };
      } finally { ledger.reserve = reserve; scene.stageMasks = stage; h.dispose(); }
    },
    async exportBarrier(kind: 'initial' | 'toggle' | 'amendment') {
      const h = await setup(), { controller, client, scene } = h, held = gate();
      try {
        let picking: Promise<boolean> | undefined;
        if (kind !== 'initial' && !await h.ordinaryPick(0)) throw new Error('Ordinary checkpoint was refused.');
        if (kind === 'amendment') {
          controller.setConnectedColor(true); await h.flush();
          const stage = scene.stageMasks.bind(scene); scene.stageMasks = async bytes => { held.enter(); await held.release; return stage(bytes); };
          controller.setSelectionTolerance(.35);
        } else {
          const map = controller.selectionMap.bind(controller);
          // Hold delivery of a genuine RGB/visibility map, without replacing
          // contribution, compositing, flood or source matching correctness.
          controller.selectionMap = async (...args) => { const result = await map(...args); held.enter(); await held.release; return result; };
          controller.setConnectedColor(true);
          if (kind === 'initial') picking = controller.selectColorPixel(h.x, h.y, 0);
        }
        await Promise.race([held.waiting, ...(picking ? [picking.then(() => { throw new Error('Connected pick ended before its held map.'); })] : [])]);
        controller.setSelectionTolerance(.35); controller.setConnectedColor(false); controller.setConnectedColor(true);
        let rows: number | undefined, exportCalls = 0; const output = client.exportOwned.bind(client);
        client.exportOwned = async (...args) => { exportCalls++; const owned = await output(...args); rows = new TextDecoder().decode(owned.bytes).trim().split(/\r?\n/).length - 1; return owned; };
        const exporting = controller.exportScene(5, 1); await new Promise(resolve => setTimeout(resolve, 20)); const blocked = exportCalls === 0;
        held.resume(); await picking; await exporting;
        const after = await client.command({ command: 'summary' }), mode = useApp.getState().connectedColor, busy = useApp.getState().busy, error = useApp.getState().error;
        await controller.command({ command: 'undo' });
        return { blocked, exportCalls, rows, after, mode, busy, error, picks: h.picks(), undone: useApp.getState().summary! };
      } finally { held.resume(); h.dispose(); }
    },
    async nativeEmpty(operation: number, ordinaryNoop = false) {
      const h = await setup(), { controller, client, scene } = h;
      const ledger = (controller as unknown as { ledger: ResourceLedger }).ledger;
      const map = controller.selectionMap.bind(controller); let adopted: AdoptedSelectionMap | undefined, mapRequests = 0;
      const workBytes = () => exportWorkObservation(client, ledger).transient.bytes;
      try {
        // The baseline differs from every ordinary Combine result. A separate
        // no-op fixture checks that the existing Redo branch survives too.
        await controller.command({ command: 'single', index: ordinaryNoop ? 0 : 1 });
        await controller.command({ command: 'single', index: 3, operation: 1 });
        await controller.command({ command: 'delete' }); await controller.command({ command: 'undo' });
        const baselineOutput = new Uint8Array(await admittedExport(client, 5, 1)), baseline = await client.command({ command: 'summary' }), baselineMasks = await gpuMasks(controller);
        if (!await h.ordinaryPick(operation)) throw new Error('Ordinary checkpoint was refused.');
        const output = new Uint8Array(await admittedExport(client, 5, 1)), before = await client.command({ command: 'summary' }), masks = await gpuMasks(controller);
        const workBefore = workBytes(), workOwnershipBefore = exportWorkObservation(client, ledger);
        controller.selectionMap = async (...args) => {
          mapRequests++;
          const real = await map(...args), pixels = real.map.width * real.map.height;
          // A valid independent empty map reaches the real native wrapper.
          // Its selector makes no edits, so the wrapper must publish the
          // ORIGINAL checkpoint mask, unlike an actual acquisition refusal.
          adopted = await client.adoptSelectionMap({ ...real.map, sourceCount: scene.count,
            depths: new Float32Array(pixels), opacities: new Float32Array(pixels), colors: new Float32Array(pixels * 3),
            visible: new Uint32Array(Math.ceil(scene.count / 32)) },
          { admit: bytes => ledger.reserve('work', bytes), current: () => real.map.assertCurrent() });
          controller.selectionMap = map;
          const owner = adopted;
          return { mapId: owner.mapId, map: real.map, sourceCount: scene.count, assertCurrent: () => owner.assertCurrent() };
        };
        controller.setConnectedColor(true); await h.flush();
        if (!adopted) throw new Error('The independent native empty map was not adopted.');
        const afterOutput = new Uint8Array(await admittedExport(client, 5, 1)), after = await client.command({ command: 'summary' }), afterMasks = await gpuMasks(controller);
        const mode = useApp.getState().connectedColor, error = useApp.getState().error, emptyMapId = adopted.mapId, emptyMapBytes = adopted.nativeBytes;
        // Changing tolerance and enabling repeatedly must reuse this same
        // empty map and retain the baseline, without a new history item.
        controller.setSelectionTolerance(.35); await h.flush();
        const repeated = await client.command({ command: 'summary' }), repeatedMasks = await gpuMasks(controller);
        controller.setSelectionTolerance(.01); await h.flush();
        controller.setConnectedColor(false); await h.flush();
        const ordinaryOutput = new Uint8Array(await admittedExport(client, 5, 1)), ordinary = await client.command({ command: 'summary' }), ordinaryMasks = await gpuMasks(controller);
        controller.setConnectedColor(true); await h.flush();
        const emptyAgain = await client.command({ command: 'summary' });
        // Active-cache release cannot release the checkpoint's retained map.
        await adopted.dispose(); adopted = undefined;
        await (controller as unknown as { selectionMaps: { invalidate(): Promise<void> } }).selectionMaps.invalidate();
        const retained = await client.command({ command: 'summary' });
        // With the originating click returned to baseline, Undo must remove
        // the LAST baseline command, not an extra Color history item.
        await controller.command({ command: 'undo' });
        const undone = await client.command({ command: 'summary' }), undoneMasks = await gpuMasks(controller);
        const released = await client.command({ command: 'summary' }), workAfter = workBytes();
        return { baseline, before, after, baselineOutput: same(baselineOutput, afterOutput), baselineMasks, afterMasks,
          ordinaryOutput: same(output, ordinaryOutput), originalOrdinaryMasks: masks, ordinaryMasks,
          mode, error, emptyMapId, emptyMapBytes, repeated, repeatedMasks, ordinary, emptyAgain, retained, undone, undoneMasks,
          released, workBefore, workAfter, workOwnershipBefore, workOwnershipAfter: exportWorkObservation(client, ledger), mapRequests, picks: h.picks(), busy: useApp.getState().busy };
      } finally { controller.selectionMap = map; await adopted?.dispose(); h.dispose(); }
    },
    async initialEmptyReplacement() {
      const h = await setup(), { controller, client, scene } = h;
      const ledger = (controller as unknown as { ledger: ResourceLedger }).ledger, map = controller.selectionMap.bind(controller);
      let adopted: AdoptedSelectionMap | undefined, mapRequests = 0;
      try {
        if (!await h.ordinaryPick(0)) throw new Error('The preceding ordinary owner was refused.');
        const beforeOutput = new Uint8Array(await admittedExport(client, 5, 1)), before = await client.command({ command: 'summary' }), beforeMasks = await gpuMasks(controller);
        controller.selectionMap = async (...args) => {
          mapRequests++;
          const real = await map(...args), pixels = real.map.width * real.map.height;
          adopted = await client.adoptSelectionMap({ ...real.map, sourceCount: scene.count,
            depths: new Float32Array(pixels), opacities: new Float32Array(pixels), colors: new Float32Array(pixels * 3),
            visible: new Uint32Array(Math.ceil(scene.count / 32)) },
          { admit: bytes => ledger.reserve('work', bytes), current: () => real.map.assertCurrent() });
          controller.selectionMap = map;
          const owner = adopted;
          return { mapId: owner.mapId, map: real.map, sourceCount: scene.count, assertCurrent: () => owner.assertCurrent() };
        };
        // Stage the initial-pick preference without invoking the separate
        // completed-owner checkbox amendment that the fixture is not testing.
        useApp.setState({ connectedColor: true });
        const accepted = await controller.selectColorPixel(h.x, h.y, 2);
        if (!adopted) throw new Error('The initial Connected empty map was not adopted.');
        const afterOutput = new Uint8Array(await admittedExport(client, 5, 1)), after = await client.command({ command: 'summary' }), afterMasks = await gpuMasks(controller);
        const emptyMapId = adopted.mapId, emptyMapBytes = adopted.nativeBytes;
        controller.setConnectedColor(false); await h.flush();
        const ordinary = await client.command({ command: 'summary' }), ordinaryMasks = await gpuMasks(controller);
        controller.setConnectedColor(true); await h.flush(); const emptyAgain = await client.command({ command: 'summary' });
        await adopted.dispose(); adopted = undefined;
        await (controller as unknown as { selectionMaps: { invalidate(): Promise<void> } }).selectionMaps.invalidate();
        const retained = await client.command({ command: 'summary' });
        await controller.command({ command: 'undo' });
        const undone = await client.command({ command: 'summary' });
        return { accepted, before, after, beforeMasks, afterMasks, sameOutput: same(beforeOutput, afterOutput),
          emptyMapId, emptyMapBytes, ordinary, ordinaryMasks, emptyAgain, retained, undone, mapRequests, picks: h.picks(),
          mode: useApp.getState().connectedColor, busy: useApp.getState().busy, error: useApp.getState().error };
      } finally { controller.selectionMap = map; await adopted?.dispose(); h.dispose(); }
    },
    async cancelUpgrade(kind: 'view' | 'tool' | 'history') {
      const h = await setup(), { controller, client } = h, held = gate();
      try {
        if (!await h.ordinaryPick(0)) throw new Error('Ordinary checkpoint was refused.');
        const map = controller.selectionMap.bind(controller);
        controller.selectionMap = async (...args) => { const result = await map(...args); held.enter(); await held.release; return result; };
        controller.setConnectedColor(true); await held.waiting;
        let changing: Promise<unknown> | undefined;
        if (kind === 'view') { controller.camera!.orbit(.1, 0); controller.invalidate(); }
        else if (kind === 'tool') { useApp.setState({ tool: 'fill' }); controller.endToleranceSelection(); }
        else changing = controller.command({ command: 'undo' });
        held.resume(); await changing; await h.flush();
        // Join queued native owner release before querying its authoritative token.
        await (controller as unknown as { toleranceCleanup: Promise<void> }).toleranceCleanup;
        const after = await client.command({ command: 'summary' });
        controller.setSelectionTolerance(.35); await h.flush(); const late = await client.command({ command: 'summary' });
        return { after, late, picks: h.picks(), busy: useApp.getState().busy, error: useApp.getState().error };
      } finally { held.resume(); h.dispose(); }
    },
    async cancelBeforeNewGesture() {
      const h = await setup(), { controller, client } = h, held = gate();
      try {
        if (!await h.ordinaryPick(0)) throw new Error('Ordinary checkpoint was refused.');
        const map = controller.selectionMap.bind(controller);
        // The old cancellation is deliberately still joining the first RGB
        // delivery when the user starts a new, independently owned gesture.
        controller.selectionMap = async (...args) => { const result = await map(...args); held.enter(); await held.release; return result; };
        controller.setConnectedColor(true); await held.waiting;
        const cancelling = controller.cancelSelectionGesture();
        useApp.setState({ tool: 'brush', visibleOnly: false, overlap: false });
        const began = controller.beginSelectionGesture(), activeBefore = controller.selectionActive;
        held.resume(); await cancelling;
        const activeAfter = controller.selectionActive;
        const accepted = await controller.finishSelectionGesture({ command: 'brush', camera: controller.camera!.state,
          width: requireWebGpuRenderer(controller.renderer).canvas.width, height: requireWebGpuRenderer(controller.renderer).canvas.height,
          points: [[h.x, h.y]], radius: 3, operation: 0, overlap: false, visibleOnly: false });
        const after = await client.command({ command: 'summary' }), masks = await gpuMasks(controller);
        await controller.command({ command: 'undo' }); const undone = await client.command({ command: 'summary' });
        await controller.command({ command: 'undo' }); const original = await client.command({ command: 'summary' });
        return { began, activeBefore, activeAfter, accepted, after, masks, undone, original,
          requested: useApp.getState().connectedColor, busy: useApp.getState().busy, error: useApp.getState().error };
      } finally { held.resume(); h.dispose(); }
    },
  };
}
export type ConnectedHarness = ReturnType<typeof createHarness>;
declare global { interface Window { connectedHarness: ConnectedHarness; connectedHarnessError?: string } }
try { window.connectedHarness = createHarness(); }
catch (error) { window.connectedHarnessError = String(error); }
