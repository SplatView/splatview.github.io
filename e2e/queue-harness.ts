import { admittedExport, exportWorkObservation } from './admitted-export';
// Test-only real worker/native/WebGPU controller. No shipping test hooks.
import { AppController } from '../src/app/controller';
import { requireGaussianScene } from './gaussian-harness-scene';
import { setSelectionPreferences, useApp } from '../src/app/store';
import { AdmissionError, type ResourceLedger, type ResourceLease } from '../src/document/resources';
import { NEUTRAL_COLOR, type SceneCommand } from '../src/document/types';
import { queuePly, queuePositions } from './queue-fixture';

type Tool = 'color' | 'fill';
function gate() {
  let release!: () => void, enter!: () => void;
  return { wait: new Promise<void>(resolve => { enter = resolve; }), held: new Promise<void>(resolve => { release = resolve; }), enter: () => enter(), release: () => release() };
}
async function gpuMasks(controller: AppController) {
  const renderer = controller.renderer!, scene = requireGaussianScene(controller.scene), size = scene.count * 4;
  const read = renderer.device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    const encoder = renderer.device.createCommandEncoder(); encoder.copyBufferToBuffer(scene.buffers.states, 0, read, 0, size);
    renderer.device.queue.submit([encoder.finish()]); await read.mapAsync(GPUMapMode.READ);
    const result = Array.from(new Uint32Array(read.getMappedRange().slice(0))); read.unmap(); return result;
  } finally { read.destroy(); }
}
function csvIds(data: ArrayBuffer) {
  return new TextDecoder().decode(data).trim().split(/\r?\n/).slice(1).map(row => {
    const point = row.split(',').slice(0, 3).map(Number);
    return queuePositions.findIndex(source => source.every((value, axis) => Math.abs(value - point[axis]) < 1e-5));
  }).sort((a, b) => a - b);
}
const count = () => (useApp.getState() as unknown as { pendingSelectionCount: number }).pendingSelectionCount;
async function setup(tool: Tool) {
  const canvas = document.createElement('canvas'); canvas.style.width = '480px'; canvas.style.height = '300px'; document.body.append(canvas);
  const controller = new AppController(); await controller.initialize(canvas); await controller.openFiles([new File([queuePly()], 'queue-sh0.ply')]);
  if (!controller.client || !controller.scene || !controller.renderer || !controller.camera) throw new Error(useApp.getState().error || 'Queue fixture unavailable.');
  const client = controller.client, scene = requireGaussianScene(controller.scene), renderer = controller.renderer;
  controller.camera.set([0, 0, 0, 0, 0, 3, 1, 45, 0, 0, canvas.width / canvas.height]);
  useApp.setState({ tool, operation: 1, visibleOnly: false, overlap: false, live: false, connectedColor: false,
    colorTolerance: .01, fillTolerance: .01, tolerance: .01, selectionDragging: false });
  const pixel = (id: number) => {
    if (id < 0) return [0, 0] as [number, number];
    const [x, y, z] = queuePositions[id];
    const multiply = (point: number[], matrix: Float32Array) => Array.from({ length: 4 }, (_, column) =>
      point.reduce((sum, value, row) => sum + value * matrix[row * 4 + column], 0));
    const clip = multiply(multiply([x, -y, -z, 1], controller.camera!.view), controller.camera!.projection);
    return [Math.floor((clip[0] / clip[3] + 1) * canvas.width / 2), Math.floor((1 - clip[1] / clip[3]) * canvas.height / 2)] as [number, number];
  };
  let picks = 0, queries = 0, serial = 0;
  const commands: SceneCommand[] = [], traffic: SceneCommand[] = [], masks: number[][] = [];
  const pick = renderer.pick.bind(renderer), map = controller.selectionMap.bind(controller), command = client.command.bind(client), stage = scene.stageMasks.bind(scene);
  renderer.pick = async (...args) => { picks++; return pick(...args); };
  controller.selectionMap = async (...args) => { queries++; return map(...args); };
  client.command = async request => {
    traffic.push({ ...request });
    if (request.command === 'colorPick' || request.command === 'fillPick') { serial++; commands.push({ ...request }); }
    return command(request);
  };
  const preview = client.livePreview.bind(client);
  client.livePreview = request => { traffic.push({ ...request }); return preview(request); };
  scene.stageMasks = async bytes => { if (serial) masks.push(Array.from(new Uint8Array(bytes))); return stage(bytes); };
  const ledger = (controller as unknown as { ledger: ResourceLedger }).ledger;
  const work = () => exportWorkObservation(controller.client!, ledger).transient.bytes;
  const workState = () => {
    const workOwnership = exportWorkObservation(controller.client!, ledger);
    const owners = ledger as unknown as { entries: Map<symbol, { category: string; bytes: number }>; identities: WeakMap<ResourceLease, symbol> };
    const retained = (controller.client! as unknown as { exportOutputLease?: ResourceLease }).exportOutputLease;
    const retainedId = retained && owners.identities.get(retained);
    const entries = [...owners.entries].filter(([id, entry]) => entry.category === 'work' && id !== retainedId)
      .map(([, entry]) => entry.bytes).sort((a, b) => a - b);
    return { ...workOwnership.transient, entries, workOwnership };
  };
  const flush = () => (controller as unknown as { tolerance?: { session: { flush(): Promise<void> } } }).tolerance?.session.flush();
  const releaseMaps = async () => {
    controller.endToleranceSelection(); await (controller as unknown as { toleranceCleanup: Promise<void> }).toleranceCleanup;
    await (controller as unknown as { selectionMaps: { invalidate(): Promise<void> } }).selectionMaps.invalidate();
    return { summary: await controller.client!.command({ command: 'summary' }), work: work(), workOwnership: exportWorkObservation(controller.client!, ledger) };
  };
  const holdHead = () => {
    const held = gate();
    if (tool === 'color') {
      const real = renderer.pick.bind(renderer); let first = true;
      renderer.pick = async (...args) => { const result = await real(...args); if (first) { first = false; held.enter(); await held.held; } return result; };
    } else {
      const real = controller.selectionMap.bind(controller); let first = true;
      controller.selectionMap = async (...args) => { const result = await real(...args); if (first) { first = false; held.enter(); await held.held; } return result; };
    }
    return held;
  };
  const select = (id: number, operation: number) => tool === 'color' ? controller.selectColorPixel(...pixel(id), operation) : controller.fillPixel(...pixel(id), operation);
  const snapshot = async () => {
    const activeClient = controller.client!;
    let ids: number[] = [], exportError: string | undefined;
    try { ids = csvIds(await admittedExport(activeClient, 5, 1)); }
    catch (error) {
      const summary = await activeClient.command({ command: 'summary' });
      if (summary.selected || !(error instanceof Error) || !error.message.includes('There are no visible Gaussians to save')) throw error;
      exportError = error.message;
    }
    const summary = await activeClient.command({ command: 'summary' }), gpu = await gpuMasks(controller);
    return { summary, gpu, ids, exportError, workOwnership: exportWorkObservation(activeClient, ledger) };
  };
  return { controller, client, scene, renderer, canvas, ledger, pixel, select, snapshot, holdHead, releaseMaps, flush, commands, traffic, masks, workState,
    picks: () => picks, queries: () => queries, dispose: () => { controller.dispose(); canvas.remove(); } };
}
async function probeAdmissions(h: Awaited<ReturnType<typeof setup>>) {
  const tool = useApp.getState().tool, picks = h.picks(), queries = h.queries(), pending = count();
  useApp.setState({ tool: 'single' });
  const single = h.controller.selectPixel(...h.pixel(0), 1), singleGesture = h.controller.beginSelectionGesture();
  useApp.setState({ tool: 'rectangle' }); const geometric = h.controller.beginSelectionGesture();
  useApp.setState({ tool: 'color' }); const color = h.controller.selectColorPixel(...h.pixel(0), 1);
  useApp.setState({ tool: 'fill' }); const fill = h.controller.fillPixel(...h.pixel(0), 1);
  let exportCalls = 0, exportSettled = false;
  const exportReal = h.controller.client!.exportOwned.bind(h.controller.client!);
  h.controller.client!.exportOwned = async (...args) => { exportCalls++; return exportReal(...args); };
  const exporting = h.controller.exportScene(5, 1).then(() => { exportSettled = true; });
  await Promise.resolve(); await Promise.resolve();
  h.controller.client!.exportOwned = exportReal;
  useApp.setState({ tool });
  const held = { singleGesture, geometric, active: h.controller.selectionActive, pendingBefore: pending, pendingAfter: count(),
    picks: h.picks() - picks, queries: h.queries() - queries, exportCalls, exportSettled };
  return { held, finish: async () => { await single; await exporting; return { color: await color, fill: await fill }; } };
}
async function dirty(h: Awaited<ReturnType<typeof setup>>) {
  if (!await h.select(4, 1)) throw new Error('The dirty-document baseline selection was refused.');
  const values = [...NEUTRAL_COLOR]; values[0] = 1.1;
  if (!await h.controller.command({ command: 'grade', values, selectedOnly: true }) || !useApp.getState().dirty)
    throw new Error('The real selected-only grade did not make the document dirty.');
}
function createHarness() {
  return {
    async immediateReplacement(tool: Tool) {
      const h = await setup(tool);
      try {
        if (!await h.select(4, 1)) throw new Error('The preceding completed owner was refused.');
        const originalId = h.client.revision.documentId, previous = await h.snapshot(), held = h.holdHead();
        try {
          const selecting = h.select(0, 1); await held.wait;
          let replaced = false;
          const replacing = h.controller.openFiles([new File([queuePly()], 'queue-immediate.ply')]).then(() => { replaced = true; });
          const admission = await probeAdmissions(h), beforeRelease = await h.snapshot();
          const waiting = { replaced, sameDocument: h.controller.client!.revision.documentId === originalId,
            prompt: useApp.getState().navigationPrompt, dirty: useApp.getState().dirty, source: useApp.getState().sourceName };
          held.release(); const accepted = await selecting; await replacing;
          const refused = await admission.finish(), after = await h.snapshot(), state = {
            replaced, newDocument: h.controller.client!.revision.documentId !== originalId, source: useApp.getState().sourceName,
            dirty: useApp.getState().dirty, prompt: useApp.getState().navigationPrompt, outputPending: useApp.getState().outputPending,
          }, released = await h.releaseMaps();
          return { previous, beforeRelease, held: admission.held, refused, waiting, accepted, after, state, released,
            pendingAfter: count(), busy: useApp.getState().busy, error: useApp.getState().error };
        } finally { held.release(); }
      } finally { h.dispose(); }
    },
    async externalFence(tool: Tool) {
      const h = await setup(tool);
      try {
        if (!await h.select(4, 1)) throw new Error('The preceding completed owner was refused.');
        const previous = await h.snapshot(), held = h.holdHead();
        try {
          const selecting = h.select(0, 1); await held.wait;
          const changing = h.controller.command({ command: 'single', index: 4, operation: 0 });
          const admission = await probeAdmissions(h), beforeRelease = await h.snapshot();
          held.release(); const accepted = await selecting, changed = await changing, refused = await admission.finish(), after = await h.snapshot();
          await h.controller.command({ command: 'undo' }); const undone = await h.snapshot(), released = await h.releaseMaps();
          return { previous, beforeRelease, held: admission.held, refused, accepted, changed, after, undone, released,
            pendingAfter: count(), busy: useApp.getState().busy, error: useApp.getState().error };
        } finally { held.release(); }
      } finally { h.dispose(); }
    },
    async dirtyNavigation(tool: Tool, choice: 'discard' | 'save') {
      const h = await setup(tool);
      try {
        await dirty(h);
        const originalId = h.client.revision.documentId, original = await h.snapshot();
        await h.controller.openFiles([new File([queuePly()], 'queue-replacement.ply')]);
        const prompt = { shown: useApp.getState().navigationPrompt, dirty: useApp.getState().dirty,
          sameDocument: h.controller.client!.revision.documentId === originalId };
        let exported: number[] | undefined, exportCalls = 0;
        const realExport = h.client.exportOwned.bind(h.client);
        h.client.exportOwned = async (...args) => {
          const output = await realExport(...args);
          if (args[1] === 0) { exportCalls++; exported = csvIds(output.bytes); }
          return output;
        };
        const held = h.holdHead();
        try {
          const selecting = h.select(0, 1); await held.wait;
          const changing = choice === 'save' ? h.controller.exportScene(5, 0) : h.controller.discardAndContinue();
          const admission = await probeAdmissions(h), callsWhileHeld = exportCalls;
          held.release(); const accepted = await selecting; await changing;
          const refused = await admission.finish();
          let receipt: { outputPending: boolean; prompt: boolean; dirty: boolean; sameDocument: boolean; snapshot: Awaited<ReturnType<typeof h.snapshot>> } | undefined;
          let acknowledgement: { held: typeof admission.held; refused: Awaited<ReturnType<typeof admission.finish>>; accepted: boolean;
            resumeCallsWhileHeld: number; resumeCalls: number } | undefined;
          if (choice === 'save') {
            receipt = { outputPending: useApp.getState().outputPending, prompt: useApp.getState().navigationPrompt,
              dirty: useApp.getState().dirty, sameDocument: h.controller.client!.revision.documentId === originalId, snapshot: await h.snapshot() };
            const resumed = gate(), action = (h.controller as unknown as {
              pendingNavigation?: { kind: 'replace' | 'close'; run(): Promise<void> };
            }).pendingNavigation;
            if (!action || action.kind !== 'replace' || typeof action.run !== 'function')
              throw new Error('The dirty replacement has no deferred navigation callback.');
            const run = action.run.bind(action); let resumeCalls = 0;
            // Observe the real queued action without replacing its kind/identity.
            action.run = async () => { resumeCalls++; try { await run(); } finally { resumed.enter(); } };
            const again = h.holdHead();
            try {
              const next = h.select(0, 1); await again.wait;
              h.controller.acknowledgeOutput(); const blocked = await probeAdmissions(h), resumeCallsWhileHeld = resumeCalls;
              again.release(); const rejected = await next; await resumed.wait;
              acknowledgement = { held: blocked.held, refused: await blocked.finish(), accepted: rejected, resumeCallsWhileHeld, resumeCalls };
            } finally { again.release(); }
          }
          const after = await h.snapshot(), state = { source: useApp.getState().sourceName, dirty: useApp.getState().dirty,
            prompt: useApp.getState().navigationPrompt, outputPending: useApp.getState().outputPending,
            newDocument: h.controller.client!.revision.documentId !== originalId }, released = await h.releaseMaps();
          return { original, prompt, held: admission.held, refused, callsWhileHeld, accepted, receipt, acknowledgement,
            exported, exportCalls, after, state, released, pendingAfter: count(), busy: useApp.getState().busy, error: useApp.getState().error };
        } finally { held.release(); }
      } finally { h.dispose(); }
    },
    async saturation(tool: Tool) {
      const h = await setup(tool);
      try {
        if (!await h.select(4, 1)) throw new Error('The preceding completed owner was refused.');
        const previous = await h.snapshot(), baselineWork = h.workState();
        const retain = async () => {
          const held = h.holdHead(), records = [h.select(0, 1)]; await held.wait;
          for (let i = 1; i < 1024; i++) records.push(h.select(0, 1));
          const pending = count(), work = h.workState(), refused = await h.select(0, 1), overflowError = useApp.getState().error;
          return { held, records, pending, work, refused, overflowError };
        };
        const first = await retain();
        let cancelled: boolean[], afterCancellation: Awaited<ReturnType<typeof h.snapshot>>, cancellationWork: ReturnType<typeof h.workState>;
        try {
          const cancelling = h.controller.cancelSelectionGesture(); first.held.release();
          cancelled = await Promise.all(first.records); await cancelling;
          afterCancellation = await h.snapshot(); cancellationWork = h.workState();
        } finally { first.held.release(); }
        const second = await retain();
        let accepted: boolean[];
        try { second.held.release(); accepted = await Promise.all(second.records); }
        finally { second.held.release(); }
        const after = await h.snapshot(), drainedWork = h.workState(), captured = [...h.commands];
        await h.controller.command({ command: 'undo' }); const undone = await h.snapshot();
        await h.controller.command({ command: 'undo' }); const original = await h.snapshot(), released = await h.releaseMaps();
        return { previous, baselineWork, first: { pending: first.pending, work: first.work, refused: first.refused, error: first.overflowError },
          cancelled, afterCancellation, cancellationWork, second: { pending: second.pending, work: second.work, refused: second.refused, error: second.overflowError },
          accepted, after, drainedWork, captured, undone, original, released,
          pendingAfter: count(), busy: useApp.getState().busy, error: useApp.getState().error };
      } finally { h.dispose(); }
    },
    async executingTail(tool: Tool, connected: boolean, boundary: 'successor' | 'export') {
      const h = await setup(tool), held = gate(), real = h.scene.stageMasks.bind(h.scene); let firstStage = true;
      h.scene.stageMasks = async bytes => { if (firstStage) { firstStage = false; held.enter(); await held.held; } return real(bytes); };
      try {
        const first = h.select(0, 1); await held.wait;
        const pendingBeforeUpdate = count(), dispatched = { ...h.commands[0] }, gpuWhileHeld = await gpuMasks(h.controller);
        h.controller.setSelectionTolerance(tool === 'color' ? .35 : 1);
        if (connected) h.controller.setConnectedColor(true);
        const pendingAfterUpdate = count(); let successor: Promise<boolean> | undefined, exporting: Promise<void> | undefined;
        let exported: number[] | undefined, exportCalls = 0;
        const realExport = h.client.exportOwned.bind(h.client);
        if (boundary === 'successor') successor = h.select(tool === 'color' ? 4 : 3, 1);
        else {
          h.client.exportOwned = async (...args) => { exportCalls++; const output = await realExport(...args); exported = csvIds(output.bytes); return output; };
          exporting = h.controller.exportScene(5, 1);
        }
        const pendingAfterBoundary = count(), callsWhileHeld = exportCalls;
        held.release(); const accepted = [await first, ...(successor ? [await successor] : [])]; await exporting;
        h.client.exportOwned = realExport;
        const after = await h.snapshot(), traffic = [...h.traffic], captured = [...h.commands], pickMasks = h.masks.slice();
        await h.controller.command({ command: 'undo' }); const undone = await h.snapshot();
        if (boundary === 'successor') await h.controller.command({ command: 'undo' });
        const original = await h.snapshot(), released = await h.releaseMaps();
        return { pendingBeforeUpdate, pendingAfterUpdate, dispatched, gpuWhileHeld, pendingAfterBoundary, callsWhileHeld, accepted,
          after, traffic, captured, pickMasks, exported, exportCalls, undone, original, released,
          pendingAfter: count(), busy: useApp.getState().busy, error: useApp.getState().error };
      } finally { held.release(); h.dispose(); }
    },
    async ordered(tool: Tool, scenario: 'add' | 'remove' | 'tolerance' | 'connected' | 'empty') {
      const h = await setup(tool), held = h.holdHead();
      try {
        const first = h.select(0, 1); await held.wait;
        const second = h.select(scenario === 'add' ? (tool === 'color' ? 4 : 3) : scenario === 'empty' ? -1 : 0, scenario === 'remove' ? 2 : 1);
        const pending = count();
        if (scenario === 'tolerance' || scenario === 'connected') h.controller.setSelectionTolerance(tool === 'color' ? .35 : 1);
        if (scenario === 'connected' || scenario === 'empty' && tool === 'color') h.controller.setConnectedColor(true);
        if (scenario === 'empty') h.controller.setSelectionTolerance(1);
        const beforeRelease = await h.snapshot(); held.release(); const accepted = await Promise.all([first, second]);
        const after = await h.snapshot(), pickMasks = h.masks.slice(0, accepted.filter(Boolean).length), captured = [...h.commands];
        let amended: Awaited<ReturnType<typeof h.snapshot>> | undefined, sameConnected: typeof amended, offConnected: typeof amended, onConnected: typeof amended;
        if (scenario === 'empty') {
          h.controller.setSelectionTolerance(.99); await h.flush(); amended = await h.snapshot();
          if (tool === 'color') {
            h.controller.setConnectedColor(true); await h.flush(); sameConnected = await h.snapshot();
            h.controller.setConnectedColor(false); await h.flush(); offConnected = await h.snapshot();
            h.controller.setConnectedColor(true); await h.flush(); onConnected = await h.snapshot();
          }
        }
        await h.controller.command({ command: 'undo' }); const undone = await h.snapshot();
        await h.controller.command({ command: 'undo' }); const original = await h.snapshot(), released = await h.releaseMaps();
        return { pending, beforeRelease, accepted, after, pickMasks, captured, amended, sameConnected, offConnected, onConnected, undone, original, released,
          picks: h.picks(), queries: h.queries(), pendingAfter: count(), busy: useApp.getState().busy, error: useApp.getState().error };
      } finally { held.release(); h.dispose(); }
    },
    async refusal(tool: Tool, boundary: 'query' | 'publication', at: number) {
      const h = await setup(tool); let queries = 0, stages = 0;
      if (boundary === 'query') {
        if (tool === 'color') { const real = h.renderer.pick.bind(h.renderer); h.renderer.pick = async (...args) => { const hit = await real(...args); if (++queries === at) throw new Error('Injected queued query refusal.'); return hit; }; }
        else { const real = h.controller.selectionMap.bind(h.controller); h.controller.selectionMap = async (...args) => { const map = await real(...args); if (++queries === at) throw new Error('Injected queued query refusal.'); return map; }; }
      } else { const real = h.scene.stageMasks.bind(h.scene); h.scene.stageMasks = async bytes => { if (++stages === at) throw new Error('Injected queued publication refusal.'); return real(bytes); }; }
      const held = h.holdHead();
      try {
        const first = h.select(0, 1);
        // At a refused first query there is no deliverable result to hold.
        // Both releases still enter during the genuine asynchronous query.
        if (!(boundary === 'query' && at === 1)) await held.wait;
        const second = h.select(tool === 'color' ? 4 : 3, 1); held.release();
        const accepted = await Promise.all([first, second]), after = await h.snapshot();
        await h.controller.command({ command: 'undo' }); const undone = await h.snapshot(), released = await h.releaseMaps();
        return { accepted, after, undone, released, captured: [...h.commands], pendingAfter: count(), busy: useApp.getState().busy, error: useApp.getState().error };
      } finally { held.release(); h.dispose(); }
    },
    async invalidate(tool: Tool, boundary: 'cancel' | 'view' | 'tool' | 'history' | 'options' | 'resize') {
      const h = await setup(tool);
      try {
        await h.controller.command({ command: 'single', index: 4 }); await h.controller.command({ command: 'delete' }); await h.controller.command({ command: 'undo' });
        // Undo starts the automatic pivot query; let it finish before the next pick.
        for (const deadline = performance.now() + 5000; (useApp.getState().busy || useApp.getState().transformPivotPending) && performance.now() < deadline;)
          await new Promise(resolve => setTimeout(resolve, 10));
        if (!await h.select(4, 0)) throw new Error('Previous no-op owner was refused.');
        const before = await h.snapshot(), held = h.holdHead();
        try {
          const first = h.select(0, 1); await held.wait; const second = h.select(tool === 'color' ? 4 : 3, 1);
          let changing: Promise<unknown> | undefined;
          if (boundary === 'cancel') changing = h.controller.cancelSelectionGesture();
          else if (boundary === 'view') { h.controller.camera!.orbit(.1, 0); h.controller.invalidate(); }
          else if (boundary === 'tool') { useApp.setState({ tool: tool === 'color' ? 'fill' : 'color' }); h.controller.endToleranceSelection(); }
          else if (boundary === 'history') changing = h.controller.command({ command: 'undo' });
          else if (boundary === 'options') { setSelectionPreferences({ overlap: false }); h.controller.endToleranceSelection(); }
          else { h.canvas.width += 1; h.controller.invalidate(); }
          held.release(); await changing; const accepted = await Promise.all([first, second]);
          await h.flush(); const after = await h.snapshot(), released = await h.releaseMaps();
          return { before, after, accepted, released, pendingAfter: count(), busy: useApp.getState().busy, error: useApp.getState().error };
        } finally { held.release(); }
      } finally { h.dispose(); }
    },
    async exporting(tool: Tool) {
      const h = await setup(tool), held = h.holdHead();
      try {
        const first = h.select(0, 1); await held.wait; const second = h.select(tool === 'color' ? 4 : 3, 1);
        let calls = 0, ids: number[] = []; const real = h.client.exportOwned.bind(h.client);
        h.client.exportOwned = async (...args) => { calls++; const output = await real(...args); ids = csvIds(output.bytes); return output; };
        const exporting = h.controller.exportScene(5, 1); await new Promise(resolve => setTimeout(resolve, 20));
        const blocked = calls === 0, rejected = await h.select(1, 1), pending = count();
        h.controller.setSelectionTolerance(1); const remembered = tool === 'color' ? useApp.getState().colorTolerance : useApp.getState().fillTolerance;
        held.release(); const accepted = await Promise.all([first, second]); await exporting;
        h.client.exportOwned = real; const after = await h.snapshot(), exported = ids;
        await h.controller.command({ command: 'undo' }); const undone = await h.snapshot();
        await h.controller.command({ command: 'undo' }); const original = await h.snapshot(), released = await h.releaseMaps();
        return { blocked, rejected, pending, remembered, accepted, calls, exported, after, undone, original, released, pendingAfter: count(), busy: useApp.getState().busy, error: useApp.getState().error };
      } finally { held.release(); h.dispose(); }
    },
    async publicationAdmission(tool: Tool) {
      const h = await setup(tool), held = gate(), real = h.scene.stageMasks.bind(h.scene);
      let firstStage = true;
      h.scene.stageMasks = async bytes => { if (firstStage) { firstStage = false; held.enter(); await held.held; } return real(bytes); };
      try {
        const first = h.select(0, 1); await held.wait;
        const ownedBusy = (h.controller as unknown as { isReleasedSelectionBusy: boolean }).isReleasedSelectionBusy;
        const second = h.select(0, 1); h.controller.setSelectionTolerance(tool === 'color' ? .35 : 1);
        const pending = count(), gpuWhileHeld = await gpuMasks(h.controller);
        held.release(); const accepted = await Promise.all([first, second]), after = await h.snapshot(), captured = [...h.commands], pickMasks = h.masks.slice(0, 2);
        await h.controller.command({ command: 'undo' }); const undone = await h.snapshot();
        await h.controller.command({ command: 'undo' }); const original = await h.snapshot(), released = await h.releaseMaps();
        return { ownedBusy, pending, gpuWhileHeld, accepted, after, captured, pickMasks, undone, original, released, pendingAfter: count(), busy: useApp.getState().busy, error: useApp.getState().error };
      } finally { held.release(); h.dispose(); }
    },
    async previousAmendment(tool: Tool) {
      const h = await setup(tool), held = gate();
      try {
        if (!await h.select(0, 1)) throw new Error('The previous completed click was refused.');
        const previous = await h.snapshot(), real = h.scene.stageMasks.bind(h.scene); let firstStage = true;
        h.scene.stageMasks = async bytes => { if (firstStage) { firstStage = false; held.enter(); await held.held; } return real(bytes); };
        // Admit the new release before the previous owner's asynchronous
        // amendment enters busy publication. Its baseline must wait for it.
        h.controller.setSelectionTolerance(tool === 'color' ? .35 : 1);
        const selecting = h.select(tool === 'color' ? 4 : 3, 1);
        await held.wait; const pending = count(), gpuWhileHeld = await gpuMasks(h.controller);
        held.release(); const accepted = await selecting, after = await h.snapshot();
        await h.controller.command({ command: 'undo' }); const undone = await h.snapshot();
        await h.controller.command({ command: 'undo' }); const original = await h.snapshot(), released = await h.releaseMaps();
        return { previous, pending, gpuWhileHeld, accepted, after, undone, original, released, pendingAfter: count(), busy: useApp.getState().busy, error: useApp.getState().error };
      } finally { held.release(); h.dispose(); }
    },
    async admissionRefusal(tool: Tool) {
      const h = await setup(tool), held = h.holdHead(), reserve = h.ledger.reserve.bind(h.ledger);
      try {
        const first = h.select(0, 1); await held.wait;
        h.ledger.reserve = (kind, bytes) => { if (kind === 'work') throw new AdmissionError('Injected released record admission refusal.'); return reserve(kind, bytes); };
        const rejected = await h.select(tool === 'color' ? 4 : 3, 1), afterRefusal = count(), admissionError = useApp.getState().error;
        h.ledger.reserve = reserve;
        const third = h.select(tool === 'color' ? 4 : 3, 1), afterRetry = count();
        held.release(); const accepted = await Promise.all([first, third]), after = await h.snapshot();
        await h.controller.command({ command: 'undo' }); const undone = await h.snapshot();
        await h.controller.command({ command: 'undo' }); const original = await h.snapshot(), released = await h.releaseMaps();
        return { rejected, afterRefusal, admissionError, afterRetry, accepted, after, undone, original, released, pendingAfter: count(), busy: useApp.getState().busy, error: useApp.getState().error };
      } finally { h.ledger.reserve = reserve; held.release(); h.dispose(); }
    },
    async cancellationGeneration(tool: Tool, boundary: 'query' | 'publication') {
      const h = await setup(tool), old = gate(), fresh = gate();
      let queries = 0, stages = 0;
      if (tool === 'color') {
        const real = h.renderer.pick.bind(h.renderer);
        h.renderer.pick = async (...args) => {
          const hit = await real(...args), sequence = ++queries;
          if (sequence === 1 && boundary === 'query') { old.enter(); await old.held; }
          if (sequence === 2) { fresh.enter(); await fresh.held; }
          return hit;
        };
      } else {
        const real = h.controller.selectionMap.bind(h.controller);
        h.controller.selectionMap = async (...args) => {
          const map = await real(...args), sequence = ++queries;
          if (sequence === 1 && boundary === 'query') { old.enter(); await old.held; }
          if (sequence === 2) { fresh.enter(); await fresh.held; }
          return map;
        };
      }
      if (boundary === 'publication') {
        const real = h.scene.stageMasks.bind(h.scene);
        h.scene.stageMasks = async bytes => {
          if (++stages === 1) { old.enter(); await old.held; }
          return real(bytes);
        };
      }
      try {
        const first = h.select(0, 1); await old.wait;
        const cancelling = h.controller.cancelSelectionGesture();
        const second = h.select(tool === 'color' ? 4 : 3, 1), pendingAtAdmission = count();
        old.release(); await fresh.wait;
        // The cancellation joins its entry snapshot, not the newly admitted
        // record. Keep that successor genuinely waiting while joining it.
        await cancelling;
        const oldAccepted = await first, pendingAfterOldCleanup = count(), afterOldCleanup = await h.snapshot();
        fresh.release(); const newAccepted = await second, after = await h.snapshot(), captured = [...h.commands];
        await h.controller.command({ command: 'undo' }); const undone = await h.snapshot(), released = await h.releaseMaps();
        return { pendingAtAdmission, pendingAfterOldCleanup, oldAccepted, newAccepted, afterOldCleanup, after, captured, undone, released,
          pendingAfter: count(), busy: useApp.getState().busy, error: useApp.getState().error };
      } finally { old.release(); fresh.release(); h.dispose(); }
    },
    async cancelledOwner(tool: Tool, connected: boolean, boundary: 'query' | 'publication') {
      const h = await setup(tool);
      try {
        if (!await h.select(0, 1)) throw new Error('The preceding completed owner was refused.');
        const previous = await h.snapshot(), held = boundary === 'query' ? h.holdHead() : gate();
        if (boundary === 'publication') {
          const real = h.scene.stageMasks.bind(h.scene); let first = true;
          h.scene.stageMasks = async bytes => { if (first) { first = false; held.enter(); await held.held; } return real(bytes); };
        }
        try {
          const selecting = h.select(tool === 'color' ? 4 : 3, 1); await held.wait;
          const cancelling = h.controller.cancelSelectionGesture();
          h.controller.setSelectionTolerance(tool === 'color' ? .35 : 1);
          if (connected) h.controller.setConnectedColor(true);
          let amendedWhileHeld: Awaited<ReturnType<typeof h.snapshot>> | undefined;
          if (boundary === 'query') { await h.flush(); amendedWhileHeld = await h.snapshot(); }
          const pendingWhileAmended = count(), gpuWhileHeld = await gpuMasks(h.controller);
          held.release(); await cancelling; const accepted = await selecting, after = await h.snapshot();
          await h.controller.command({ command: 'undo' }); const undone = await h.snapshot(), released = await h.releaseMaps();
          return { previous, pendingWhileAmended, amendedWhileHeld, gpuWhileHeld, accepted, after, undone, released,
            pendingAfter: count(), busy: useApp.getState().busy, error: useApp.getState().error };
        } finally { held.release(); }
      } finally { h.dispose(); }
    },
  };
}
export type QueueHarness = ReturnType<typeof createHarness>;
declare global { interface Window { queueHarness: QueueHarness; queueHarnessError?: string } }
try { window.queueHarness = createHarness(); } catch (error) { window.queueHarnessError = String(error); }
