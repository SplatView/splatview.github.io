import { requireWebGpuRenderer } from './gaussian-harness-scene';
import { admittedExport, exportWorkObservation } from './admitted-export';
import { DocumentSelectionMaps, type SelectionMapContext, type SelectionMapDiagnosticEvent } from '../src/app/selectionMaps';
import { CoreClient } from '../src/document/coreClient';
import { estimateSceneBytes, MiB, ResourceLedger, type ResourceLease } from '../src/document/resources';
import { IDENTITY_MATRIX, NEUTRAL_COLOR } from '../src/renderer/defaults';
import { CameraController } from '../src/input/camera';
import { GaussianRenderer } from '../src/renderer/webgpu/renderer';
import { gaussianPly } from '../tests/fixtures/gaussians';
import { AppController } from '../src/app/controller';
import { requireGaussianScene } from './gaussian-harness-scene';
import { useApp } from '../src/app/store';
import type { CachedSelectionMap } from '../src/document/selectionMapCache';
import { compositedSurface } from '../src/renderer/webgpu/surface';
import { surfaceDimensions, type SurfaceMap } from '../src/renderer/webgpu/surfaceQuery';
import { containsSurfaceRegion, volumeSurfaceRegion } from '../src/renderer/webgpu/surfaceCoverage';
import { prepareSurfacePipelines } from '../src/renderer/webgpu/surfacePipelines';

type ControllerInternals = { ledger: ResourceLedger; selectionMaps: DocumentSelectionMaps };
const categoryClients = new WeakMap<ResourceLedger, () => CoreClient | undefined>();
const categoryRenderers = new WeakMap<ResourceLedger, () => GaussianRenderer | undefined>();
function categories(ledger: ResourceLedger) {
  const entries = (ledger as unknown as { entries: Map<symbol, { category: string; bytes: number }> }).entries;
  const result: Record<string, number> = {};
  for (const entry of entries.values()) result[entry.category] = (result[entry.category] ?? 0) + entry.bytes;
  result.scratch = categoryRenderers.get(ledger)?.()?.surfaceScratch.snapshot.allocatedBytes ?? 0;
  const client = categoryClients.get(ledger)?.();
  if (client) {
    const work = exportWorkObservation(client, ledger);
    result.work = work.transient.bytes;
    result.retainedExportWork = work.retainedExport.bytes;
    result.totalWork = work.total.bytes;
  } else {
    if (ledger.categorySnapshot.work.allocations) throw new Error('Work remains without a current controller owner.');
    result.work = 0; result.retainedExportWork = 0; result.totalWork = 0;
  }
  return result;
}
function valid(map: CachedSelectionMap) { try { map.assertCurrent(); return true; } catch { return false; } }
async function nativeMasks(client: CoreClient) {
  let result: number[] = [];
  await client.readMasks(bytes => { result = Array.from(new Uint8Array(bytes)); });
  return result;
}
function surfaceDifference(actual: SurfaceMap, expected: SurfaceMap) {
  const difference = (a: Float32Array | Uint32Array | undefined, b: Float32Array | Uint32Array | undefined) => {
    if (!a || !b) return a === b ? 0 : Infinity;
    if (a.length !== b.length) return Infinity;
    let maximum = 0;
    for (let index = 0; index < a.length; index++) maximum = Math.max(maximum, Math.abs(a[index] - b[index]));
    return maximum;
  };
  return { depth: difference(actual.depths, expected.depths), opacity: difference(actual.opacities, expected.opacities),
    color: difference(actual.colors, expected.colors), visible: difference(actual.visible, expected.visible) };
}
function equalBytes(a: Uint8Array, b: Uint8Array) { return a.length === b.length && a.every((value, i) => value === b[i]); }
async function digest(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('');
}
function surfaceSeed(map: CachedSelectionMap): [number, number] {
  let index = -1, opacity = 0;
  for (let i = 0; i < map.map.opacities.length; i++) if (map.map.opacities[i] > opacity) { index = i; opacity = map.map.opacities[i]; }
  if (index < 0 || opacity < 1 / 255) throw new Error('The Fill retention fixture has no positive surface.');
  return [Math.floor((index % map.map.width + .5) * map.map.fullWidth / map.map.width),
    Math.floor((Math.floor(index / map.map.width) + .5) * map.map.fullHeight / map.map.height)];
}
function fillPreferences() { useApp.setState({ tool: 'fill', operation: 0, overlap: true, visibleOnly: false, fillTolerance: .01, tolerance: .01 }); }
function colorPreferences() { useApp.setState({ tool: 'color', operation: 0, overlap: false, visibleOnly: false, connectedColor: false, colorTolerance: 1, tolerance: 1 }); }
async function selectionReady(controller: AppController) {
  const deadline = performance.now() + 10_000;
  // Native publication can queue automatic pivot work in the next frame.
  do {
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    if (controller.colorControlsEnabled) return;
  } while (performance.now() < deadline);
  throw new Error('Map-cache fixture selection admission did not become ready.');
}
const flushTolerance = (controller: AppController) => (controller as unknown as { tolerance?: { session: { flush(): Promise<void> } } }).tolerance?.session.flush();
const endTolerance = async (controller: AppController) => {
  controller.endToleranceSelection(); await (controller as unknown as { toleranceCleanup: Promise<void> }).toleranceCleanup;
};
async function gpuMasks(controller: AppController) {
  const renderer = requireWebGpuRenderer(controller.renderer), scene = requireGaussianScene(controller.scene), bytes = scene.count * 4;
  const read = renderer.device.createBuffer({ label: 'Map lifecycle mask oracle', size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    const encoder = renderer.device.createCommandEncoder(); encoder.copyBufferToBuffer(scene.buffers.states, 0, read, 0, bytes);
    renderer.device.queue.submit([encoder.finish()]); await read.mapAsync(GPUMapMode.READ);
    const result = Array.from(new Uint32Array(read.getMappedRange())); read.unmap(); return result;
  } finally { read.destroy(); }
}
async function controllerFixture() {
  const target = document.createElement('canvas'); target.width = 320; target.height = 200;
  target.style.width = '320px'; target.style.height = '200px'; document.body.append(target);
  const controller = new AppController();
  await controller.initialize(target); await controller.openFiles([new File([gaussianPly(3)], 'controller-map.ply')]);
  if (!controller.client || !controller.scene || !controller.renderer || !controller.camera) {
    controller.dispose(); target.remove(); throw new Error(useApp.getState().error || 'The controller fixture did not open.');
  }
  const internals = controller as unknown as ControllerInternals, client = controller.client, renderer = requireWebGpuRenderer(controller.renderer);
  categoryClients.set(internals.ledger, () => controller.client);
  categoryRenderers.set(internals.ledger, () => controller.renderer ? requireWebGpuRenderer(controller.renderer) : undefined);
  await selectionReady(controller);
  const baseline = internals.ledger.usage.bytes;
  const identities = new Map<symbol, number>();
  const accounting = () => {
    const memory = client.nativeMemory;
    if (!memory) throw new Error('The controller map fixture requires measured native accounting.');
    const entries = [...(internals.ledger as unknown as { entries: Map<symbol, { category: string; bytes: number }> }).entries]
      .map(([identity, entry]) => {
        let id = identities.get(identity);
        if (id === undefined) { id = identities.size + 1; identities.set(identity, id); }
        return { id, category: entry.category, bytes: entry.bytes };
      }).sort((a, b) => a.id - b.id);
    const owners = internals.ledger as unknown as {
      entries: Map<symbol, { category: string; bytes: number }>;
      identities: WeakMap<ResourceLease, symbol>;
    };
    const nativeIdentity = owners.identities.get(memory.remainder), nativeEntry = nativeIdentity && owners.entries.get(nativeIdentity);
    const nativeRemainderLeaseId = nativeIdentity && identities.get(nativeIdentity);
    if (!internals.ledger.owns(memory.remainder, 'source') || !nativeEntry || nativeEntry.category !== 'source' ||
        nativeEntry.bytes !== memory.state.remainderBytes || nativeRemainderLeaseId === undefined)
      throw new Error('The actual native map accounting owner must retain its measured source remainder lease.');
    const workOwnership = exportWorkObservation(client, internals.ledger);
    const output = (client as unknown as { exportOutputLease?: ResourceLease }).exportOutputLease;
    const outputIdentity = output && owners.identities.get(output);
    const retainedExportLeaseId = outputIdentity === undefined ? null : identities.get(outputIdentity);
    if (retainedExportLeaseId === undefined) throw new Error('The retained native export has no observed ledger identity.');
    const scratchOwner = requireWebGpuRenderer(controller.renderer ?? renderer).surfaceScratch;
    const scratchEntries = [...(scratchOwner as unknown as { entries: Set<{ credit: ResourceLease; size: number; busy: boolean }> }).entries];
    const scratchLeases = scratchEntries.map(entry => {
      const identity = owners.identities.get(entry.credit), id = identity === undefined ? undefined : identities.get(identity);
      if (id === undefined || !internals.ledger.owns(entry.credit, 'work') || entry.credit.bytes !== entry.size)
        throw new Error('The physical surface buffer must own its actual work reservation.');
      return { id, bytes: entry.size, busy: entry.busy };
    });
    return { native: { ...memory.state }, nativeRemainderLeaseId, retainedExportLeaseId, workOwnership, entries,
      surfaceScratch: { ...scratchOwner.snapshot, leases: scratchLeases } };
  };
  let closeTask: Promise<ResourceLedger['usage']> | undefined;
  return { controller, client, renderer, target, baseline, accounting, ready: () => selectionReady(controller),
    ledger: internals.ledger, maps: internals.selectionMaps,
    close() {
      if (!closeTask) closeTask = (async () => {
        // A replacement may have a different current client. Observe only
        // the controller's real retirement after its map/edit/GPU joins.
        const retiring = controller.client;
        if (!retiring) throw new Error('The map fixture has no current client to retire.');
        const original = retiring.retireNativeMemory;
        let nativeRetirement: Promise<void> | undefined, entered!: () => void;
        const nativeRetirementEntered = new Promise<void>(resolve => { entered = resolve; });
        retiring.retireNativeMemory = () => {
          nativeRetirement = original.call(retiring); entered(); return nativeRetirement;
        };
        try {
          controller.dispose(); await nativeRetirementEntered;
          if (!nativeRetirement) throw new Error('Controller native retirement was not observed.');
          await nativeRetirement;
          return internals.ledger.usage;
        } finally { retiring.retireNativeMemory = original; target.remove(); }
      })();
      return closeTask;
    },
  };
}

async function createHarness() {
  const canvas = document.querySelector<HTMLCanvasElement>('#scene')!;
  const [renderer, camera] = await Promise.all([GaussianRenderer.create(canvas), CameraController.create()]);
  const errors: string[] = []; renderer.onLost = message => errors.push(message);
  async function fixture() {
    const client = new CoreClient(), ledger = new ResourceLedger(256 * MiB), maps = new DocumentSelectionMaps();
    let closed = false;
    const { summary } = await client.load(new File([gaussianPly(3)], 'map-cache.ply'), 100, 128 * MiB, {
      admit: bytes => ledger.reserve('work', bytes),
      current() { if (closed || renderer.lost) throw new Error('The map-cache fixture source was closed.'); },
    });
    const sceneLease = ledger.reserve('decoded', estimateSceneBytes(summary.count, summary.shDegree));
    const scene = await renderer.allocateScene(summary.count, summary.shDegree);
    await client.stream((first, count, bytes) => scene.upload(first, count, bytes), bytes => scene.masks(bytes));
    camera.set(summary.camera); camera.aspect(canvas.width / canvas.height);
    const context: SelectionMapContext = { client, renderer, camera, scene, ledger, current() {} };
    return { client, ledger, maps, context, baseline: ledger.usage.bytes,
      async close() { closed = true; await maps.invalidate(); client.dispose(); await scene.dispose(); sceneLease(); } };
  }
  return {
    async interactionRegions(options: { width: number; height: number }) {
      const f = await fixture(), previous = { width: canvas.width, height: canvas.height };
      let oracle: SurfaceMap | undefined, nativeOracle: Awaited<ReturnType<CoreClient['adoptSelectionMap']>> | undefined;
      try {
        canvas.width = options.width; canvas.height = options.height;
        canvas.style.width = `${options.width / devicePixelRatio}px`; canvas.style.height = `${options.height / devicePixelRatio}px`;
        camera.set([0, 0, 0, 0, 0, 3, 1, 45, 0, 0, options.width / options.height]);
        renderer.render(f.context.scene, camera, NEUTRAL_COLOR, false);
        oracle = await compositedSurface(renderer, requireGaussianScene(f.context.scene), { admit: bytes => f.ledger.reserve('work', bytes) });
        const focal = options.height / 2 / Math.tan(Math.PI / 8), cx = Math.floor(options.width / 2), cy = Math.floor(options.height / 2);
        const left = Math.round(options.width / 2 - .4 * focal / 3), right = Math.round(options.width / 2 + .4 * focal / 3);
        const top = Math.round(options.height / 2 - .4 * focal / 2.9);
        const paths = [
          { name: 'tap', points: [[left, cy]] },
          { name: 'growing', points: [[left, cy], [right, cy]] },
          { name: 'diagonal', points: [[left, cy], [cx, top]] },
          { name: 'outside-crossing', points: [[-24, cy], [options.width + 24, cy]] },
          { name: 'outside-empty', points: [[-20, -20]] },
        ];
        const rows = [];
        for (const path of paths) {
          const region = volumeSurfaceRegion({ points: path.points, viewportWidth: options.width, viewportHeight: options.height,
            mapWidth: oracle.width, mapHeight: oracle.height });
          const command = { command: 'volume', camera: camera.state, width: options.width, height: options.height,
            points: path.points, radius: 24, operation: 0, overlap: true, visibleOnly: false };
          // The native core has one active map. Run the independent full-map
          // oracle first, then adopt this path's local map through the cache.
          await nativeOracle?.dispose();
          nativeOracle = await f.client.adoptSelectionMap({ ...oracle, sourceCount: f.context.scene.count },
            { admit: bytes => f.ledger.reserve('work', bytes), current: () => oracle!.assertCurrent() });
          await f.client.command({ command: 'single', index: null, operation: 0 });
          await f.client.command({ ...command, mapId: nativeOracle.mapId }); const fullMasks = await nativeMasks(f.client);
          await f.client.command({ command: 'single', index: null, operation: 0 });
          const local = await f.maps.request(f.context, { region });
          let insideError = 0, outsideNonzero = 0, insidePixels = 0;
          for (let y = 0; y < local.map.height; y++) for (let x = 0; x < local.map.width; x++) {
            const index = y * local.map.width + x, coverage = local.map.region;
            const inside = !coverage || x >= coverage.x && x < coverage.x + coverage.width && y >= coverage.y && y < coverage.y + coverage.height;
            if (inside) {
              insidePixels++;
              insideError = Math.max(insideError, Math.abs(local.map.depths[index] - oracle.depths[index]),
                Math.abs(local.map.opacities[index] - oracle.opacities[index]));
            } else if (local.map.depths[index] !== 0 || local.map.opacities[index] !== 0) outsideNonzero++;
          }
          const selected = await f.client.command({ ...command, mapId: local.mapId }); const localMasks = await nativeMasks(f.client);
          let undoMasks: number[] | undefined, redoMasks: number[] | undefined;
          if (selected.selected) {
            await f.client.command({ command: 'undo' }); undoMasks = await nativeMasks(f.client);
            await f.client.command({ command: 'redo' }); redoMasks = await nativeMasks(f.client);
          }
          rows.push({ name: path.name, region, actualRegion: local.map.region, insideError, outsideNonzero, insidePixels,
            covered: containsSurfaceRegion(local.map.region, region), fullMasks, localMasks, undoMasks, redoMasks,
            selected: selected.selected, width: local.map.width, height: local.map.height,
            fullWidth: local.map.fullWidth, fullHeight: local.map.fullHeight, profile: local.map.profile });
        }
        return { rows, dimensions: surfaceDimensions(options.width, options.height), fullReadbackBytes: oracle.profile?.readbackBytes,
          dpr: devicePixelRatio, cssWidth: canvas.getBoundingClientRect().width, errors: [...errors] };
      } finally {
        await f.maps.invalidate(); await nativeOracle?.dispose(); oracle?.dispose(); await f.close();
        canvas.width = previous.width; canvas.height = previous.height;
      }
    },
    async interactionCoverageUpgrade() {
      const f = await fixture(), events: SelectionMapDiagnosticEvent[] = [];
      try {
        const context = { ...f.context, observe: (event: Parameters<NonNullable<SelectionMapContext['observe']>>[0]) => events.push(event) };
        const first = await f.maps.request(context, { region: { x: 64, y: 48, width: 32, height: 32 } });
        const firstRegion = first.map.region && { ...first.map.region };
        const growing = await f.maps.request(context, { region: { x: 160, y: 80, width: 32, height: 32 } });
        const contained = await f.maps.request(context, { region: { x: 80, y: 64, width: 16, height: 16 } });
        const full = await f.maps.request(context, { colors: true, visible: true, region: { x: 80, y: 64, width: 16, height: 16 } });
        const fromFull = await f.maps.request(context, { region: { x: 64, y: 48, width: 32, height: 32 } });
        const rows = { firstId: first.mapId, growingId: growing.mapId, containedId: contained.mapId, fullId: full.mapId, fromFullId: fromFull.mapId,
          firstRegion, firstRegionUnchanged: JSON.stringify(first.map.region) === JSON.stringify(firstRegion), growingRegion: growing.map.region,
          firstRetired: !valid(first), growingRetired: !valid(growing), fullValid: valid(full),
          fullRegion: full.map.region ?? null, hasColors: !!full.map.colors, hasVisible: !!full.map.visible, events, errors: [...errors] };
        await f.maps.invalidate(); return { ...rows, released: f.ledger.usage.bytes - f.baseline, scratch: renderer.surfaceScratch.snapshot };
      } finally { await f.close(); }
    },
    async interactionScratchReuse() {
      const f = await fixture();
      try {
        const rows = [];
        for (const stage of ['initial', 'camera', 'one-deleted', 'all-deleted', 'restored'] as const) {
          if (stage === 'camera') camera.orbit(.025, -.01);
          if (stage === 'one-deleted') {
            await f.client.command({ command: 'single', index: 0, operation: 0 }); await f.client.command({ command: 'delete' });
          } else if (stage === 'all-deleted') {
            await f.client.command({ command: 'selectAll' }); await f.client.command({ command: 'delete' });
          } else if (stage === 'restored') await f.client.command({ command: 'undo' });
          if (stage !== 'initial' && stage !== 'camera') await f.client.readMasks(bytes => f.context.scene.masks(bytes));
          const pooled = await f.maps.request(f.context, { colors: true, visible: true });
          const fresh = await compositedSurface(renderer, requireGaussianScene(f.context.scene), {
            colors: true, visible: true, admit: bytes => f.ledger.reserve('work', bytes),
          });
          const difference = surfaceDifference(pooled.map, fresh); fresh.dispose();
          const summary = await f.client.command({ command: 'summary' }), scratch = renderer.surfaceScratch.snapshot;
          rows.push({ stage, difference, profile: pooled.map.profile, scratch, visible: Array.from(pooled.map.visible!),
            nonempty: pooled.map.opacities.reduce((count, value) => count + Number(value > 0), 0),
            ledgerDelta: f.ledger.usage.bytes - f.baseline, expectedDelta: pooled.map.allocationBytes + summary.selectionMapBytes + scratch.allocatedBytes });
        }
        await f.maps.invalidate();
        return { rows, released: f.ledger.usage.bytes - f.baseline, scratch: renderer.surfaceScratch.snapshot, errors: [...errors] };
      } finally { await f.close(); }
    },
    async interactionPreparation() {
      const original = GPUDevice.prototype.createComputePipelineAsync, entries: string[] = [];
      GPUDevice.prototype.createComputePipelineAsync = function(descriptor) {
        if (descriptor.label?.startsWith('Surface ')) entries.push(descriptor.compute.entryPoint!);
        return original.call(this, descriptor);
      };
      let f: Awaited<ReturnType<typeof controllerFixture>> | undefined;
      try {
        f = await controllerFixture();
        const deadline = performance.now() + 10_000;
        while (entries.length < 5 && performance.now() < deadline) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        const prewarmed = [...entries], frames = f.renderer.frameSubmissionSequence;
        const [first, second] = await Promise.all([prepareSurfacePipelines(f.renderer), prepareSurfacePipelines(f.renderer)]);
        const width = f.target.width, height = f.target.height;
        f.controller.camera!.set([0, 0, 0, 0, 0, 3, 1, 45, 0, 0, width / height]); f.controller.invalidate(); await f.ready();
        useApp.setState({ tool: 'volume', operation: 0, overlap: true, visibleOnly: false, live: false });
        const point = [Math.round(width / 2 - .4 / 3 * (height / 2 / Math.tan(Math.PI / 8))), Math.floor(height / 2)];
        const dimensions = surfaceDimensions(width, height), region = volumeSurfaceRegion({ points: [point], viewportWidth: width,
          viewportHeight: height, mapWidth: dimensions.width, mapHeight: dimensions.height });
        if (!f.controller.beginSelectionGesture()) throw new Error('The prepared local Volume gesture was refused.');
        const gestureAccepted = await f.controller.finishSelectionGesture({ command: 'volume', camera: f.controller.camera!.state,
          width, height, points: [point], radius: 24, visibleOnly: false, overlap: true, operation: 0 });
        await f.ready();
        const gestureMap = f.maps.diagnosticSnapshot(() => 1).active;
        const depth = await f.controller.selectionMap({ region }), afterDepth = [...entries];
        const visible = await f.controller.selectionMap({ colors: true, visible: true });
        return { prewarmed, frames, sharedPipelines: first.bin === second.bin, afterDepth, entries,
          gestureAccepted, gestureRegion: gestureMap?.region, expectedRegion: region, selected: useApp.getState().summary?.selected,
          depth: depth.map.profile, visible: visible.map.profile, scratch: f.renderer.surfaceScratch.snapshot,
          error: useApp.getState().error };
      } finally { GPUDevice.prototype.createComputePipelineAsync = original; await f?.close(); }
    },
    async controllerConnectedHeldUpgrade() {
      const f = await controllerFixture();
      try {
        colorPreferences();
        let adoptions = 0; const adopt = f.client.adoptSelectionMap.bind(f.client);
        f.client.adoptSelectionMap = (...args) => { adoptions++; return adopt(...args); };
        const ordinaryMap = await f.controller.selectionMap(), seed = surfaceSeed(ordinaryMap);
        if (!await f.controller.selectColorPixel(...seed, 0)) throw new Error('The ordinary Color pick was refused.');
        await f.ready();
        const ordinary = await f.client.command({ command: 'summary' });
        f.controller.setConnectedColor(true); await flushTolerance(f.controller);
        await f.ready();
        const connectedMap = await f.controller.selectionMap({ colors: true, visible: true });
        const output = new Uint8Array(await admittedExport(f.client, 0, 0));
        const enabled = await f.client.command({ command: 'summary' }), enabledCategories = categories(f.ledger), enabledMasks = await gpuMasks(f.controller);
        const enabledAdoptions = adoptions;
        f.controller.setConnectedColor(false); await flushTolerance(f.controller);
        const disabled = await f.client.command({ command: 'summary' });
        await f.maps.invalidate(); const activeReleased = await f.client.command({ command: 'summary' }), heldCategories = categories(f.ledger);
        f.controller.setConnectedColor(true); await flushTolerance(f.controller);
        const saved = new Uint8Array(await admittedExport(f.client, 0, 0));
        const reenabled = await f.client.command({ command: 'summary' }), reenabledCategories = categories(f.ledger), afterMasks = await gpuMasks(f.controller);
        await endTolerance(f.controller);
        const ended = await f.client.command({ command: 'summary' }), endedCategories = categories(f.ledger);
        return { ordinary, ordinaryId: ordinaryMap.mapId, connectedId: connectedMap.mapId, enabled, enabledCategories,
          cpuBytes: connectedMap.map.allocationBytes, enabledAdoptions, adoptions, disabled, activeReleased, heldCategories, reenabled, reenabledCategories,
          enabledMasks, afterMasks, sameOutput: equalBytes(output, saved), ended, endedCategories,
          ordinaryValid: valid(ordinaryMap), connectedValid: valid(connectedMap), busy: useApp.getState().busy, error: useApp.getState().error };
      } finally { await f.close(); }
    },
    async controllerConnectedPublicationFailure() {
      const f = await controllerFixture();
      try {
        colorPreferences();
        const initialMap = await f.controller.selectionMap(), seed = surfaceSeed(initialMap);
        if (!await f.controller.selectColorPixel(...seed, 0)) throw new Error('The initial ordinary Color pick was refused.');
        await f.controller.command({ command: 'delete' }); await f.controller.command({ command: 'undo' });
        const map = await f.controller.selectionMap({ colors: true, visible: true });
        if (!await f.controller.selectColorPixel(...seed, 0)) throw new Error('The no-op ordinary Color pick was refused.');
        const output = new Uint8Array(await admittedExport(f.client, 0, 0));
        const before = await f.client.command({ command: 'summary' }), masks = await gpuMasks(f.controller), beforeUsage = f.ledger.usage, beforeCategories = categories(f.ledger);
        const accountingBefore = f.accounting();
        const scene = requireGaussianScene(f.controller.scene), stage = scene.stageMasks.bind(scene);
        let held: typeof before | undefined, accountingHeld: ReturnType<typeof f.accounting> | undefined;
        scene.stageMasks = async () => {
          held = await f.client.command({ command: 'summary' }); accountingHeld = f.accounting();
          throw new Error('Injected Connected Color publication refusal');
        };
        try { f.controller.setConnectedColor(true); await flushTolerance(f.controller); } finally { scene.stageMasks = stage; }
        const saved = new Uint8Array(await admittedExport(f.client, 0, 0)), after = await f.client.command({ command: 'summary' }), afterMasks = await gpuMasks(f.controller);
        const result = { before, after, held, accountingBefore, accountingHeld, accountingAfter: f.accounting(),
          masks, afterMasks, sameOutput: equalBytes(output, saved), beforeUsage, afterUsage: f.ledger.usage,
          beforeCategories, afterCategories: categories(f.ledger), mapValid: valid(map), sameMap: map === await f.controller.selectionMap({ colors: true, visible: true }),
          busy: useApp.getState().busy, error: useApp.getState().error };
        f.controller.setConnectedColor(false); await flushTolerance(f.controller);
        const amended = await f.client.command({ command: 'summary' }), accountingAmended = f.accounting();
        await endTolerance(f.controller); await f.maps.invalidate();
        const ended = await f.client.command({ command: 'summary' });
        const accountingEnded = f.accounting(), finalWorkBytes = categories(f.ledger).work ?? 0;
        const redone = await f.controller.command({ command: 'redo' });
        return { ...result, amended, ended, accountingAmended, accountingEnded, finalWorkBytes,
          redone, redoneVisible: useApp.getState().summary?.visible };
      } finally { await f.close(); }
    },
    async controllerConnectedHeldClose(replace: boolean) {
      const f = await controllerFixture();
      try {
        colorPreferences(); const map = await f.controller.selectionMap({ colors: true, visible: true }), seed = surfaceSeed(map);
        if (!await f.controller.selectColorPixel(...seed, 0)) throw new Error('The close-retention Color pick was refused.');
        f.controller.setConnectedColor(true); await flushTolerance(f.controller);
        await f.maps.invalidate(); const held = await f.client.command({ command: 'summary' }), heldBytes = categories(f.ledger).work ?? 0;
        if (replace) {
          await f.controller.openFiles([new File([gaussianPly(0)], 'connected-held-replacement.ply')]);
          const after = await f.controller.client!.command({ command: 'summary' });
          let oldWorkerAlive = true; try { await f.client.command({ command: 'summary' }); } catch { oldWorkerAlive = false; }
          return { replace, held, heldBytes, after, afterUsage: f.ledger.usage, workBytes: categories(f.ledger).work ?? 0,
            oldWorkerAlive, oldValid: valid(map), error: useApp.getState().error };
        }
        const afterUsage = await f.close();
        let oldWorkerAlive = true; try { await f.client.command({ command: 'summary' }); } catch { oldWorkerAlive = false; }
        return { replace, held, heldBytes, afterUsage, workBytes: categories(f.ledger).work ?? 0,
          oldWorkerAlive, oldValid: valid(map), error: useApp.getState().error };
      } finally { await f.close(); }
    },
    async controllerFillHeldUpgrade() {
      const f = await controllerFixture();
      try {
        fillPreferences();
        const first = await f.controller.selectionMap(), seed = surfaceSeed(first), firstCpuBytes = first.map.allocationBytes;
        if (!await f.controller.fillPixel(...seed, 0)) throw new Error(useApp.getState().error || 'The initial Fill was refused.');
        await f.ready();
        const picked = await f.client.command({ command: 'summary' }), firstNativeBytes = picked.selectionMapBytes;
        const second = await f.controller.selectionMap({ colors: true, visible: true });
        const upgraded = await f.client.command({ command: 'summary' }), upgradedCategories = categories(f.ledger);
        const secondCpuBytes = second.map.allocationBytes;
        await f.maps.invalidate();
        const activeReleased = await f.client.command({ command: 'summary' }), heldCategories = categories(f.ledger);
        f.controller.setSelectionTolerance(.5); await flushTolerance(f.controller);
        const amended = await f.client.command({ command: 'summary' }), amendedCategories = categories(f.ledger);
        await endTolerance(f.controller);
        const ended = await f.client.command({ command: 'summary' }), endedCategories = categories(f.ledger);
        return { picked, upgraded, upgradedCategories, firstId: first.mapId, secondId: second.mapId, firstNativeBytes, firstCpuBytes, secondCpuBytes,
          firstValid: valid(first), secondValid: valid(second), activeReleased, heldCategories, amended, amendedCategories, ended, endedCategories,
          busy: useApp.getState().busy, error: useApp.getState().error };
      } finally { await f.close(); }
    },
    async controllerFillReplacementFailure() {
      const f = await controllerFixture();
      try {
        fillPreferences();
        const initialMap = await f.controller.selectionMap(), seed = surfaceSeed(initialMap);
        if (!await f.controller.fillPixel(...seed, 0)) throw new Error('The initial Fill was refused.');
        await f.controller.command({ command: 'delete' }); await f.controller.command({ command: 'undo' });
        const map = await f.controller.selectionMap();
        if (!await f.controller.fillPixel(...seed, 0)) throw new Error('The no-op Fill with Redo was refused.');
        const output = new Uint8Array(await admittedExport(f.client, 0, 0));
        const before = await f.client.command({ command: 'summary' }), masks = await gpuMasks(f.controller), beforeUsage = f.ledger.usage, beforeCategories = categories(f.ledger);
        const scene = requireGaussianScene(f.controller.scene), stage = scene.stageMasks.bind(scene);
        let held: typeof before | undefined;
        scene.stageMasks = async () => { held = await f.client.command({ command: 'summary' }); throw new Error('Injected Fill checkpoint publication refusal'); };
        let accepted: boolean;
        try { accepted = await f.controller.fillPixel(...seed, 2); } finally { scene.stageMasks = stage; }
        const saved = new Uint8Array(await admittedExport(f.client, 0, 0)), after = await f.client.command({ command: 'summary' }), afterMasks = await gpuMasks(f.controller);
        const result = { accepted, before, after, held, masks, afterMasks, sameOutput: equalBytes(output, saved), beforeUsage, afterUsage: f.ledger.usage,
          beforeCategories, afterCategories: categories(f.ledger), mapValid: valid(map), sameMap: map === await f.controller.selectionMap(),
          busy: useApp.getState().busy, error: useApp.getState().error };
        f.controller.setSelectionTolerance(.01); await flushTolerance(f.controller);
        const amended = await f.client.command({ command: 'summary' });
        await endTolerance(f.controller); await f.maps.invalidate();
        const ended = await f.client.command({ command: 'summary' });
        return { ...result, amended, ended, finalWorkBytes: categories(f.ledger).work ?? 0 };
      } finally { await f.close(); }
    },
    async controllerFillHeldClose(replace: boolean) {
      const f = await controllerFixture();
      try {
        fillPreferences(); const first = await f.controller.selectionMap(), seed = surfaceSeed(first);
        if (!await f.controller.fillPixel(...seed, 0)) throw new Error('The close-retention Fill was refused.');
        const second = await f.controller.selectionMap({ colors: true, visible: true });
        await f.maps.invalidate(); const held = await f.client.command({ command: 'summary' }), heldBytes = categories(f.ledger).work ?? 0;
        if (replace) {
          await f.controller.openFiles([new File([gaussianPly(0)], 'fill-held-replacement.ply')]);
          const after = await f.controller.client!.command({ command: 'summary' });
          let oldWorkerAlive = true; try { await f.client.command({ command: 'summary' }); } catch { oldWorkerAlive = false; }
          return { replace, held, heldBytes, after, afterUsage: f.ledger.usage, workBytes: categories(f.ledger).work ?? 0,
            oldWorkerAlive, oldValid: valid(first), upgradedValid: valid(second), error: useApp.getState().error };
        }
        const afterUsage = await f.close();
        let oldWorkerAlive = true; try { await f.client.command({ command: 'summary' }); } catch { oldWorkerAlive = false; }
        return { replace, held, heldBytes, afterUsage, workBytes: categories(f.ledger).work ?? 0,
          oldWorkerAlive, oldValid: valid(first), upgradedValid: valid(second), error: useApp.getState().error };
      } finally { await f.close(); }
    },
    async controllerReuse() {
      const f = await controllerFixture();
      try {
        const before = await f.client.command({ command: 'summary' }), beforeCategories = categories(f.ledger);
        let adoptions = 0; const adopt = f.client.adoptSelectionMap.bind(f.client);
        f.client.adoptSelectionMap = (...args) => { adoptions++; return adopt(...args); };
        const first = await f.controller.selectionMap({ colors: true, visible: true });
        const adopted = await f.client.command({ command: 'summary' }), afterAdoption = categories(f.ledger);
        const selectionAccepted = await f.controller.command({ command: 'single', index: 1, operation: 0 });
        await f.ready();
        const selected = await f.client.command({ command: 'summary' }), selectedCategories = categories(f.ledger);
        const second = await f.controller.selectionMap({ colors: true, visible: true });
        const undoAccepted = await f.controller.command({ command: 'undo' });
        await f.ready();
        const undone = await f.client.command({ command: 'summary' }), undoneCategories = categories(f.ledger);
        const third = await f.controller.selectionMap({ colors: true, visible: true });
        const beforeReleaseSummary = await f.client.command({ command: 'summary' });
        const beforeRelease = f.ledger.usage.bytes, cpuBytes = first.map.allocationBytes, accountingBefore = f.accounting();
        await f.maps.invalidate(); const released = await f.client.command({ command: 'summary' }), afterRelease = categories(f.ledger);
        return { before, adopted, selected, undone, released, beforeCategories, afterAdoption, selectedCategories, undoneCategories, afterRelease,
          selectionAccepted, undoAccepted, sameOwner: first === second && first === third, adoptions,
          beforeReleaseSummary, accountingBefore, accountingAfter: f.accounting(),
          mapShape: { width: first.map.width, height: first.map.height, sourceCount: adopted.count },
          cpuBytes, beforeRelease, afterReleaseBytes: f.ledger.usage.bytes, oldValid: valid(first), busy: useApp.getState().busy, error: useApp.getState().error };
      } finally { await f.close(); }
    },
    async controllerColorBoundary() {
      const f = await controllerFixture();
      try {
        const observe = async () => {
          let nativeMasks: number[] = [];
          await f.client.stream(async () => {}, bytes => { nativeMasks = Array.from(new Uint8Array(bytes)); });
          const exported = await digest(await admittedExport(f.client, 0, 0)), summary = await f.client.command({ command: 'summary' });
          const state = useApp.getState();
          return { summary, nativeMasks, gpuMasks: await gpuMasks(f.controller), exported,
            grade: [...state.grade], appliedGrade: [...state.appliedGrade], colorSession: state.colorSession,
            colorSelectedOnly: state.colorSelectedOnly, colorPending: f.controller.colorPending, categories: categories(f.ledger) };
        };
        let adoptions = 0; const adopt = f.client.adoptSelectionMap.bind(f.client);
        f.client.adoptSelectionMap = (...args) => { adoptions++; return adopt(...args); };
        const oldScene = requireGaussianScene(f.controller.scene), first = await f.controller.selectionMap({ colors: true, visible: true });
        if (!first.map.colors) throw new Error('The color-boundary fixture requires actual surface colors.');
        const firstColors = Array.from(first.map.colors), before = await observe();
        const values = [...NEUTRAL_COLOR]; values[0] = 1.5; f.controller.setGrade(values);
        const pending = await observe(), pendingSameScene = f.controller.scene === oldScene;
        const second = await f.controller.selectionMap({ colors: true, visible: true }), after = await observe();
        if (!second.map.colors) throw new Error('The settled color-boundary map lost its surface colors.');
        const boundary = { sameOwner: first === second, oldValid: valid(first), newValid: valid(second), adoptions,
          sceneChanged: oldScene !== f.controller.scene, oldSceneRetired: oldScene.retired,
          colorsChanged: firstColors.some((value, index) => value !== second.map.colors![index]) };
        const beforeRelease = f.ledger.usage.bytes, accountingBefore = f.accounting(), cpuBytes = second.map.allocationBytes;
        await f.maps.invalidate();
        const released = await observe(), afterReleaseBytes = f.ledger.usage.bytes, accountingAfter = f.accounting();
        const newValidAfterRelease = valid(second);
        const undoAccepted = await f.controller.command({ command: 'undo' }), undone = await observe();
        const redoAccepted = await f.controller.command({ command: 'redo' }), redone = await observe();
        return { before, pending, pendingSameScene, values, after, ...boundary, released, beforeRelease, afterReleaseBytes,
          accountingBefore, accountingAfter, cpuBytes, newValidAfterRelease,
          mapShape: { width: second.map.width, height: second.map.height, sourceCount: after.summary.count },
          undoAccepted, redoAccepted, undone, redone, busy: useApp.getState().busy, error: useApp.getState().error };
      } finally { await f.close(); }
    },
    async controllerFailure(kind: 'delete' | 'geometry' | 'history') {
      const f = await controllerFixture();
      try {
        await f.controller.command({ command: 'single', index: 1 });
        await f.controller.command({ command: 'delete' }); await f.controller.command({ command: 'undo' });
        const originalScene = requireGaussianScene(f.controller.scene), first = await f.controller.selectionMap({ colors: true, visible: true });
        const output = new Uint8Array(await admittedExport(f.client, 0, 0)), before = await f.client.command({ command: 'summary' });
        const masks = await gpuMasks(f.controller), usage = f.ledger.usage, originalCategories = categories(f.ledger);
        const originalNativeStamp = f.client.nativeContentRevision, originalBrowserStamp = f.client.revision.contentRevision;
        const stage = originalScene.stageMasks.bind(originalScene), allocate = f.renderer.allocateScene.bind(f.renderer);
        const transfer = f.ledger.transferRetainedNativeCoverage.bind(f.ledger);
        let historyPublicationRefused = false;
        let held: typeof before | undefined, heldCategories: Record<string, number> | undefined;
        const observe = async () => { held = await f.client.command({ command: 'summary' }); heldCategories = categories(f.ledger); };
        if (kind === 'geometry') f.renderer.allocateScene = async () => { await observe(); throw new Error('Injected map geometry publication refusal'); };
        else originalScene.stageMasks = async bytes => {
          await observe();
          if (kind === 'delete') throw new Error('Injected map deletion publication refusal');
          return stage(bytes);
        };
        if (kind === 'history') f.ledger.transferRetainedNativeCoverage = (remainder, bytes, updates) => {
          if (updates.some(update => f.ledger.owns(update.lease, 'history')) &&
              updates.some(update => f.ledger.owns(update.lease, 'work'))) {
            f.ledger.transferRetainedNativeCoverage = transfer;
            historyPublicationRefused = true;
            throw new Error('Injected map history publication refusal');
          }
          return transfer(remainder, bytes, updates);
        };
        let accepted: boolean;
        try { accepted = await f.controller.command(kind === 'geometry' ? { command: 'transform', matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, .2, 0, 0, 1] } : { command: 'delete' }); }
        finally { originalScene.stageMasks = stage; f.renderer.allocateScene = allocate; f.ledger.transferRetainedNativeCoverage = transfer; }
        const saved = new Uint8Array(await admittedExport(f.client, 0, 0)), after = await f.client.command({ command: 'summary' });
        const afterMasks = await gpuMasks(f.controller), mapValid = valid(first), again = await f.controller.selectionMap({ colors: true, visible: true });
        const result = { kind, accepted, before, after, held, heldCategories, historyPublicationRefused, originalCategories, afterCategories: categories(f.ledger),
          usageBefore: usage, usageAfter: f.ledger.usage, originalNativeStamp, restoredNativeStamp: f.client.nativeContentRevision,
          originalBrowserStamp, browserStampAfter: f.client.revision.contentRevision, sameScene: f.controller.scene === originalScene,
          sameOutput: equalBytes(output, saved), masks, afterMasks, mapValid, sameMap: again === first,
          busy: useApp.getState().busy, error: useApp.getState().error };
        const redone = await f.controller.command({ command: 'redo' });
        await f.maps.invalidate();
        return { ...result, redone, redoneVisible: useApp.getState().summary?.visible, released: await f.client.command({ command: 'summary' }) };
      } finally { await f.close(); }
    },
    async controllerInvalidation(kind: 'camera' | 'viewport' | 'geometry' | 'delete') {
      const f = await controllerFixture();
      try {
        if (kind === 'delete') await f.controller.command({ command: 'single', index: 1 });
        const oldScene = requireGaussianScene(f.controller.scene), first = await f.controller.selectionMap({ colors: true, visible: true });
        const before = await f.client.command({ command: 'summary' }); let accepted = true;
        if (kind === 'camera') { f.controller.camera!.orbit(5, 0); f.controller.invalidate(); }
        if (kind === 'viewport') {
          // Disconnect the fixture observer so its CSS measurement cannot undo
          // the deliberate framebuffer/DPR change during this boundary test.
          (f.controller as unknown as { resize?: ResizeObserver }).resize?.disconnect();
          f.target.width += 2; f.controller.camera!.aspect(f.target.width / f.target.height); f.controller.invalidate();
        }
        if (kind === 'geometry') accepted = await f.controller.command({ command: 'transform', matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, .2, 0, 0, 1] });
        if (kind === 'delete') accepted = await f.controller.command({ command: 'delete' });
        const oldValid = valid(first); await f.maps.invalidate();
        const retired = await f.client.command({ command: 'summary' }), releasedWork = categories(f.ledger).work ?? 0;
        const second = await f.controller.selectionMap({ colors: true, visible: true }), after = await f.client.command({ command: 'summary' });
        return { kind, accepted, before, retired, after, oldValid, releasedWork, sameOwner: first === second, newValid: valid(second),
          sceneChanged: oldScene !== f.controller.scene, width: second.map.fullWidth, height: second.map.fullHeight, busy: useApp.getState().busy, error: useApp.getState().error };
      } finally { await f.close(); }
    },
    async controllerReplacement(refused: boolean) {
      const f = await controllerFixture();
      try {
        const oldClient = f.client, oldScene = requireGaussianScene(f.controller.scene), first = await f.controller.selectionMap({ colors: true, visible: true });
        const before = await oldClient.command({ command: 'summary' }), usage = f.ledger.usage, documentId = oldClient.revision.documentId;
        const allocate = f.renderer.allocateScene.bind(f.renderer);
        if (refused) f.renderer.allocateScene = async () => { throw new Error('Injected replacement map publication refusal'); };
        try { await f.controller.openFiles([new File([gaussianPly(0)], 'replacement-map.ply')]); }
        finally { f.renderer.allocateScene = allocate; }
        if (refused) {
          const after = await oldClient.command({ command: 'summary' }), again = await f.controller.selectionMap({ colors: true, visible: true });
          return { refused, before, after, oldValid: valid(first), sameOwner: again === first, sameClient: f.controller.client === oldClient,
            sameScene: f.controller.scene === oldScene, usageBefore: usage, usageAfter: f.ledger.usage, error: useApp.getState().error };
        }
        const oldValid = valid(first); await f.maps.invalidate();
        let oldWorkerAlive = true; try { await oldClient.command({ command: 'summary' }); } catch { oldWorkerAlive = false; }
        const nextClient = f.controller.client!, retired = await nextClient.command({ command: 'summary' }), releasedWork = categories(f.ledger).work ?? 0;
        const second = await f.controller.selectionMap({ colors: true, visible: true }), after = await nextClient.command({ command: 'summary' });
        return { refused, before, retired, after, oldValid, sameOwner: second === first, sameClient: nextClient === oldClient,
          sameScene: f.controller.scene === oldScene, oldSceneRetired: oldScene.retired, oldWorkerAlive, releasedWork,
          newDocument: nextClient.revision.documentId !== documentId, newValid: valid(second), error: useApp.getState().error };
      } finally { await f.close(); }
    },
    async controllerRecovery() {
      const f = await controllerFixture();
      try {
        await f.controller.command({ command: 'single', index: 1 });
        const first = await f.controller.selectionMap({ colors: true, visible: true });
        const output = new Uint8Array(await admittedExport(f.client, 0, 0)), before = await f.client.command({ command: 'summary' }), masks = await gpuMasks(f.controller), view = [...f.controller.camera!.state];
        const retainedBytesBefore = f.ledger.usage.bytes, cpuBytes = first.map.allocationBytes, accountingBefore = f.accounting();
        const oldScene = requireGaussianScene(f.controller.scene), oldEpoch = f.renderer.deviceEpoch;
        f.renderer.device.destroy(); await f.renderer.device.lost;
        const accepted = await f.controller.retryRenderer();
        const afterOutput = new Uint8Array(await admittedExport(f.client, 0, 0)), after = await f.client.command({ command: 'summary' }), afterMasks = await gpuMasks(f.controller);
        const bytesBeforeReacquire = f.ledger.usage.bytes, oldValid = valid(first), accountingAfter = f.accounting();
        const second = await f.controller.selectionMap({ colors: true, visible: true });
        return { accepted, before, after, retainedBytesBefore, cpuBytes, accountingBefore, accountingAfter,
          mapShape: { width: first.map.width, height: first.map.height, sourceCount: before.count },
          bytesBeforeReacquire, oldValid, newValid: valid(second), sameOwner: first === second,
          sameClient: f.controller.client === f.client, sceneChanged: f.controller.scene !== oldScene, oldSceneRetired: oldScene.retired,
          sameOutput: equalBytes(output, afterOutput), masks, afterMasks, oldEpoch, newEpoch: requireWebGpuRenderer(f.controller.renderer).deviceEpoch,
          sameView: f.controller.camera!.state.every((value, i) => value === view[i]), busy: useApp.getState().busy, error: useApp.getState().error };
      } finally { await f.close(); }
    },
    async controllerDispose() {
      const f = await controllerFixture(), first = await f.controller.selectionMap({ colors: true, visible: true });
      const before = await f.client.command({ command: 'summary' }), retainedBytes = f.ledger.usage.bytes;
      const oldScene = requireGaussianScene(f.controller.scene);
      const after = await f.close(); let workerAlive = true;
      try { await f.client.command({ command: 'summary' }); } catch { workerAlive = false; }
      return { before, retainedBytes, after, workerAlive, oldValid: valid(first), sceneRetired: oldScene.retired };
    },
    async controllerPendingCancellation() {
      const f = await controllerFixture(), original = GPUBuffer.prototype.mapAsync;
      let release!: () => void, entered!: () => void;
      const waiting = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
      try {
        await f.controller.command({ command: 'single', index: 1 });
        await f.controller.command({ command: 'delete' }); await f.controller.command({ command: 'undo' });
        await selectionReady(f.controller);
        const before = await f.client.command({ command: 'summary' }), masks = await gpuMasks(f.controller), beforeBytes = f.ledger.usage.bytes;
        let adoptions = 0; const adopt = f.client.adoptSelectionMap.bind(f.client);
        f.client.adoptSelectionMap = (...args) => { adoptions++; return adopt(...args); };
        GPUBuffer.prototype.mapAsync = function(mode, offset, size) {
          const work = original.call(this, mode, offset, size);
          return this.label === 'Surface capacity readback' ? work.then(async () => { entered(); await gate; return undefined; }) : work;
        };
        useApp.setState({ tool: 'volume' });
        if (!f.controller.beginSelectionGesture()) throw new Error('The mapped gesture was refused.');
        f.controller.previewSelection({ command: 'volume', camera: f.controller.camera!.state, width: f.target.width, height: f.target.height,
          points: [[160, 100]], radius: 24, visibleOnly: true, overlap: true, operation: 0 });
        await waiting; const duringBytes = f.ledger.usage.bytes;
        const cancellation = f.controller.cancelSelectionGesture(), endedImmediately = !f.controller.selectionActive;
        const restartBlocked = !f.controller.beginSelectionGesture(); release(); await cancellation; await f.maps.invalidate();
        const after = await f.client.command({ command: 'summary' }), afterMasks = await gpuMasks(f.controller);
        return { before, after, masks, afterMasks, beforeBytes, duringBytes, afterBytes: f.ledger.usage.bytes, adoptions,
          endedImmediately, restartBlocked, busy: useApp.getState().busy, error: useApp.getState().error };
      } finally { release?.(); GPUBuffer.prototype.mapAsync = original; await f.close(); }
    },
    async reuse() {
      const f = await fixture();
      try {
        const before = await f.client.command({ command: 'summary' });
        const first = await f.maps.request(f.context, { colors: true, visible: true });
        const adoption = await f.client.command({ command: 'summary' }), retained = f.ledger.usage.bytes - f.baseline;
        const scratchBytes = renderer.surfaceScratch.snapshot.allocatedBytes;
        const selected = await f.client.command({ command: 'single', index: 0, operation: 0 });
        await f.client.readMasks(bytes => f.context.scene.masks(bytes));
        const grade = [...NEUTRAL_COLOR]; grade[0] = 1.5;
        renderer.render(f.context.scene, camera, grade, true, IDENTITY_MATRIX, selected.selected > 0);
        f.maps.validate(); first.assertCurrent();
        const second = await f.maps.request({ ...f.context, grade }, { colors: true, visible: true });
        const after = await f.client.command({ command: 'summary' });
        const cpuBytes = first.map.allocationBytes;
        await f.maps.invalidate(); const released = f.ledger.usage.bytes - f.baseline;
        const nativeReleased = await f.client.command({ command: 'summary' });
        return { before, adoption, after, sameOwner: first === second, retained, cpuBytes, scratchBytes, released, nativeReleased,
          releasedScratchBytes: renderer.surfaceScratch.snapshot.allocatedBytes, errors };
      } finally { await f.close(); }
    },
    async upgradeRefusal() {
      const f = await fixture();
      try {
        const first = await f.maps.request(f.context), retained = f.ledger.usage.bytes;
        const retainedScratchBytes = renderer.surfaceScratch.snapshot.allocatedBytes;
        const adopt = f.client.adoptSelectionMap.bind(f.client);
        let error = '';
        f.client.adoptSelectionMap = (data, options) => { data.opacities[0] = NaN; return adopt(data, options); };
        try { await f.maps.request(f.context, { colors: true, visible: true }); } catch (value) { error = String(value); }
        finally { f.client.adoptSelectionMap = adopt; }
        first.assertCurrent();
        const refused = await f.client.command({ command: 'summary' }), refusedBytes = f.ledger.usage.bytes;
        const refusedScratchBytes = renderer.surfaceScratch.snapshot.allocatedBytes;
        const again = await f.maps.request(f.context);
        const upgraded = await f.maps.request(f.context, { colors: true, visible: true });
        upgraded.assertCurrent(); let retired = false; try { first.assertCurrent(); } catch { retired = true; }
        const committed = await f.client.command({ command: 'summary' });
        await f.maps.invalidate();
        return { firstId: first.mapId, error, retained, refusedBytes, retainedScratchBytes, refusedScratchBytes, refused, sameAfterRefusal: first === again,
          upgradedId: upgraded.mapId, hasColors: !!upgraded.map.colors, hasVisible: !!upgraded.map.visible,
          retired, committed, released: f.ledger.usage.bytes - f.baseline, errors };
      } finally { await f.close(); }
    },
    async cancelled() {
      const f = await fixture(), original = GPUBuffer.prototype.mapAsync, abort = new AbortController();
      let entered!: () => void, release!: () => void;
      const pending = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
      GPUBuffer.prototype.mapAsync = function(mode, offset, size) {
        const work = original.call(this, mode, offset, size);
        return this.label === 'Surface capacity readback' ? work.then(async () => { entered(); await gate; return undefined; }) : work;
      };
      try {
        const before = await f.client.command({ command: 'summary' });
        const work = f.maps.request(f.context, { colors: true, visible: true }, abort.signal).then(() => 'accepted', error => error.name);
        await pending; const during = f.ledger.usage.bytes - f.baseline;
        abort.abort(); const outcome = await work; release(); await f.maps.invalidate();
        const after = await f.client.command({ command: 'summary' });
        return { before, after, outcome, during, released: f.ledger.usage.bytes - f.baseline, errors };
      } finally { release?.(); GPUBuffer.prototype.mapAsync = original; await f.close(); }
    },
  };
}
export type MapCacheHarness = Awaited<ReturnType<typeof createHarness>>;
declare global { interface Window { mapCacheHarness: MapCacheHarness; mapCacheHarnessError?: string } }
try { window.mapCacheHarness = await createHarness(); }
catch (error) { window.mapCacheHarnessError = String(error); }
