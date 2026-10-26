import { requireWebGpuRenderer } from './gaussian-harness-scene';
import { admittedExport } from './admitted-export';
// Test-only controller entry; no hooks or fixtures enter the production bundle.
import { AppController } from '../src/app/controller';
import { requireGaussianScene } from './gaussian-harness-scene';
import { setSelectionPreferences, useApp } from '../src/app/store';
import { AdmissionError, type ResourceLedger } from '../src/document/resources';
import { fillPly } from './fill-fixture';

async function gpuMasks(controller: AppController) {
  const renderer = requireWebGpuRenderer(controller.renderer), scene = requireGaussianScene(controller.scene), size = Math.max(4, scene.count * 4);
  const buffer = renderer.device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    const encoder = renderer.device.createCommandEncoder(); encoder.copyBufferToBuffer(scene.buffers.states, 0, buffer, 0, size);
    renderer.device.queue.submit([encoder.finish()]); await buffer.mapAsync(GPUMapMode.READ);
    const result = Array.from(new Uint32Array(buffer.getMappedRange().slice(0))); buffer.unmap(); return result;
  } finally { buffer.destroy(); }
}
async function selectionReady(controller: AppController) {
  const deadline = performance.now() + 10_000;
  // Drain the queued pivot/render frame before testing actual admission.
  do {
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    if (controller.colorControlsEnabled) return;
  } while (performance.now() < deadline);
  throw new Error('Fill fixture selection admission did not become ready.');
}
async function setup() {
  const canvas = document.createElement('canvas'); canvas.style.width = '480px'; canvas.style.height = '300px'; document.body.append(canvas);
  const controller = new AppController(); await controller.initialize(canvas);
  await controller.openFiles([new File([fillPly()], 'fill-contracts.ply')]);
  if (!controller.client || !controller.renderer || !controller.scene || !controller.camera)
    throw new Error(useApp.getState().error || 'The Fill fixture did not open.');
  controller.camera.set([0, 0, 0, 0, 0, 3, 1, 45, 0, 0, canvas.width / canvas.height]);
  useApp.setState({ tool: 'fill', fillTolerance: .01, tolerance: .01, operation: 0, overlap: false, visibleOnly: false, live: false, selectionDragging: false });
  await selectionReady(controller);
  // Pick the integer map cell containing the projected center. At 1% displayed
  // tolerance the native opacity threshold is .0001, so the neighboring cell
  // can legitimately exclude the center of a Gaussian with a steep gradient.
  const pixel = (x: number) => [Math.floor(canvas.width / 2 + x / 3 * (canvas.height / 2 / Math.tan(Math.PI / 8))), Math.floor(canvas.height / 2)] as const;
  const flush = () => (controller as unknown as { tolerance?: { session: { flush(): Promise<void> } } }).tolerance?.session.flush();
  return { canvas, controller, client: controller.client, renderer: controller.renderer, scene: requireGaussianScene(controller.scene), pixel, flush,
    ready: () => selectionReady(controller),
    dispose: () => { controller.dispose(); canvas.remove(); } };
}
function gate() {
  let resume!: () => void, entered!: () => void;
  return { release: new Promise<void>(resolve => { resume = resolve; }), waiting: new Promise<void>(resolve => { entered = resolve; }),
    resume: () => resume(), enter: () => entered() };
}
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((value, i) => value === b[i]);
function createHarness() {
  return {
    async failure(boundary: 'cancel' | 'view' | 'options' | 'admission') {
      const h = await setup(), { controller, client } = h, held = gate(), originalMap = GPUBuffer.prototype.mapAsync;
      const ledger = (controller as unknown as { ledger: ResourceLedger }).ledger, reserve = ledger.reserve.bind(ledger);
      try {
        await controller.command({ command: 'single', index: 3 }); await controller.command({ command: 'delete' }); await controller.command({ command: 'undo' });
        const output = new Uint8Array(await admittedExport(client, 0, 0)), before = await client.command({ command: 'summary' }), masks = await gpuMasks(controller);
        if (boundary === 'admission') ledger.reserve = (kind, bytes) => {
          if (kind === 'work') throw new AdmissionError('Injected Fill map admission refusal.'); return reserve(kind, bytes);
        };
        else GPUBuffer.prototype.mapAsync = function(mode, offset, size) {
          const result = originalMap.call(this, mode, offset, size);
          return this.label === 'Surface capacity readback' ? result.then(async () => { held.enter(); await held.release; return undefined; }) : result;
        };
        const picking = controller.fillPixel(...h.pixel(-.6), 0);
        if (boundary !== 'admission') {
          await Promise.race([held.waiting, picking.then(() => { throw new Error('Fill ended before the real surface readback.'); })]);
          if (boundary === 'cancel') { const cancelling = controller.cancelSelectionGesture(); held.resume(); await cancelling; }
          else if (boundary === 'view') { controller.camera!.orbit(.1, 0); controller.invalidate(); held.resume(); }
          else { setSelectionPreferences({ overlap: false }); controller.endToleranceSelection(); held.resume(); }
        }
        const accepted = await picking; GPUBuffer.prototype.mapAsync = originalMap; ledger.reserve = reserve;
        const afterOutput = new Uint8Array(await admittedExport(client, 0, 0)), after = await client.command({ command: 'summary' }), afterMasks = await gpuMasks(controller);
        return { before, after, accepted, sameOutput: same(output, afterOutput), sameGpuMasks: masks.every((value, i) => value === afterMasks[i]),
          busy: useApp.getState().busy, error: useApp.getState().error };
      } finally { held.resume(); GPUBuffer.prototype.mapAsync = originalMap; ledger.reserve = reserve; h.dispose(); }
    },
    async pending(empty: boolean) {
      const h = await setup(), { controller, client } = h, held = gate();
      try {
        if (!await controller.fillPixel(...h.pixel(-.6), 0)) throw new Error('The preceding Fill click was refused.');
        await h.ready();
        const before = await client.command({ command: 'summary' }), map = controller.selectionMap.bind(controller);
        // Hold delivery of an actual, current cached map. Geometry and opacity
        // remain real GPU results, including the independently empty seed.
        controller.selectionMap = async (...args) => { const result = await map(...args); held.enter(); await held.release; return result; };
        const picking = controller.fillPixel(...(empty ? [0, 0] as const : h.pixel(-.6)), 0);
        await Promise.race([held.waiting, picking.then(() => { throw new Error('The replacement did not await its map.'); })]);
        controller.setSelectionTolerance(1); await h.flush();
        const whilePending = await client.command({ command: 'summary' }), remembered = useApp.getState().fillTolerance;
        let rows: number | undefined, exportCalls = 0;
        const output = client.exportOwned.bind(client); client.exportOwned = async (...args) => {
          exportCalls++; const owned = await output(...args); rows = new TextDecoder().decode(owned.bytes).trim().split(/\r?\n/).length - 1; return owned;
        };
        const exporting = controller.exportScene(5, 1); await new Promise(resolve => setTimeout(resolve, 20)); const blocked = exportCalls === 0;
        held.resume(); const accepted = await picking; await exporting;
        const after = await client.command({ command: 'summary' }); let expanded: number | undefined, shrunk: number | undefined;
        if (empty) {
          controller.setSelectionTolerance(1); await h.flush(); expanded = useApp.getState().summary?.selected;
          controller.setSelectionTolerance(.01); await h.flush(); shrunk = useApp.getState().summary?.selected;
        }
        await controller.command({ command: 'undo' });
        return { before, whilePending, remembered, blocked, accepted, rows, after, expanded, shrunk,
          undone: useApp.getState().summary!, busy: useApp.getState().busy, error: useApp.getState().error };
      } finally { held.resume(); h.dispose(); }
    },
    async publication(kind: 'pick' | 'amendment') {
      const h = await setup(), { controller, client, scene } = h;
      try {
        if (!await controller.fillPixel(...h.pixel(-.6), 0)) throw new Error('The preceding Fill click was refused.');
        const output = new Uint8Array(await admittedExport(client, 0, 1)), before = await client.command({ command: 'summary' }), masks = await gpuMasks(controller);
        const stage = scene.stageMasks.bind(scene); scene.stageMasks = async () => { throw new Error(`Injected Fill ${kind} publication refusal.`); };
        try {
          if (kind === 'pick') await controller.fillPixel(...h.pixel(.7), 0);
          else { controller.setSelectionTolerance(1); await h.flush(); }
        } finally { scene.stageMasks = stage; }
        const afterOutput = new Uint8Array(await admittedExport(client, 0, 1)), after = await client.command({ command: 'summary' }), afterMasks = await gpuMasks(controller);
        const error = useApp.getState().error, busy = useApp.getState().busy;
        controller.setSelectionTolerance(1); await h.flush(); const expanded = useApp.getState().summary?.selected;
        controller.setSelectionTolerance(.01); await h.flush(); const shrunk = useApp.getState().summary?.selected;
        await controller.command({ command: 'undo' });
        return { before, after, sameOutput: same(output, afterOutput), sameGpuMasks: masks.every((value, i) => value === afterMasks[i]),
          expanded, shrunk, undone: useApp.getState().summary!, error, busy };
      } finally { h.dispose(); }
    },
    async authoritativeEmpty() {
      const h = await setup(), { controller, client } = h;
      try {
        if (!await controller.fillPixel(...h.pixel(-.6), 0)) throw new Error('The preceding Fill click was refused.');
        const output = new Uint8Array(await admittedExport(client, 0, 1)), before = await client.command({ command: 'summary' }), masks = await gpuMasks(controller);
        // Deliberately disagree with the browser's already valid seed precheck.
        // The native result token must remain authoritative when the worker
        // receives an empty seed and preserves its previous checkpoint.
        const command = client.command.bind(client);
        client.command = request => command(request.command === 'fillPick' ? { ...request, seed: [0, 0] } : request);
        let accepted: boolean;
        try { accepted = await controller.fillPixel(...h.pixel(.7), 0); }
        finally { client.command = command; }
        const afterOutput = new Uint8Array(await admittedExport(client, 0, 1)), after = await client.command({ command: 'summary' }), afterMasks = await gpuMasks(controller);
        controller.setSelectionTolerance(1); await h.flush(); const expanded = useApp.getState().summary?.selected;
        controller.setSelectionTolerance(.01); await h.flush(); const shrunk = useApp.getState().summary?.selected;
        await controller.command({ command: 'undo' });
        return { before, after, accepted, sameOutput: same(output, afterOutput), sameGpuMasks: masks.every((value, i) => value === afterMasks[i]),
          expanded, shrunk, undone: useApp.getState().summary!, busy: useApp.getState().busy, error: useApp.getState().error };
      } finally { h.dispose(); }
    },
    async fractionalCell() {
      const h = await setup(), { controller, client } = h;
      try {
        const [x, y] = h.pixel(-.6);
        const integerAccepted = await controller.fillPixel(x, y, 0);
        const output = new Uint8Array(await admittedExport(client, 0, 1));
        const integer = await client.command({ command: 'summary' });
        await controller.command({ command: 'undo' });
        // Both positions lie inside one framebuffer pixel. A fractional
        // event coordinate must not move the opacity seed into its neighbor.
        const fractionalAccepted = await controller.fillPixel(x + .75, y + .75, 0);
        const afterOutput = new Uint8Array(await admittedExport(client, 0, 1));
        const fractional = await client.command({ command: 'summary' });
        await controller.command({ command: 'undo' });
        return { integerAccepted, fractionalAccepted, integer, fractional, sameOutput: same(output, afterOutput),
          undone: useApp.getState().summary!, busy: useApp.getState().busy, error: useApp.getState().error };
      } finally { h.dispose(); }
    },
    async exportBarrier(kind: 'pick' | 'amendment' | 'cancelled') {
      const h = await setup(), { controller, client, scene } = h, held = gate();
      try {
        let picking: Promise<boolean> | undefined;
        if (kind === 'amendment') {
          if (!await controller.fillPixel(...h.pixel(-.6), 0)) throw new Error('The preceding Fill click was refused.');
          await h.ready();
          const stage = scene.stageMasks.bind(scene); scene.stageMasks = async bytes => { held.enter(); await held.release; return stage(bytes); };
          controller.setSelectionTolerance(1);
        } else {
          await controller.command({ command: 'selectAll' }); controller.setSelectionTolerance(1);
          await h.ready();
          const map = controller.selectionMap.bind(controller);
          controller.selectionMap = async (...args) => { const result = await map(...args); held.enter(); await held.release; return result; };
          picking = controller.fillPixel(...h.pixel(-.6), 0);
        }
        await Promise.race([held.waiting, ...(picking ? [picking.then(() => { throw new Error('Fill ended before its held work.'); })] : [])]);
        let rows: number | undefined, exportCalls = 0; const output = client.exportOwned.bind(client);
        client.exportOwned = async (...args) => { exportCalls++; const owned = await output(...args); rows = new TextDecoder().decode(owned.bytes).trim().split(/\r?\n/).length - 1; return owned; };
        const exporting = controller.exportScene(5, 1); await new Promise(resolve => setTimeout(resolve, 20)); const blocked = exportCalls === 0;
        if (kind === 'cancelled') controller.endToleranceSelection();
        held.resume(); await picking; await exporting;
        const after = await client.command({ command: 'summary' }), receipt = useApp.getState().outputPending, busy = useApp.getState().busy, error = useApp.getState().error;
        await controller.command({ command: 'undo' });
        return { blocked, exportCalls, rows, after, receipt, busy, error, undone: useApp.getState().summary! };
      } finally { held.resume(); h.dispose(); }
    },
  };
}
export type FillHarness = ReturnType<typeof createHarness>;
declare global { interface Window { fillHarness: FillHarness; fillHarnessError?: string } }
try { window.fillHarness = createHarness(); }
catch (error) { window.fillHarnessError = String(error); }
