import { admittedExport } from './admitted-export';
// Test-only controller entry point; the production bundle includes index.html.
import { AppController } from '../src/app/controller';
import { requireGaussianScene } from './gaussian-harness-scene';
import { useApp } from '../src/app/store';
import { AdmissionError, type Category, type ResourceLedger } from '../src/document/resources';
import type { RecoveryCheckpointDescription } from '../src/document/recoveryCheckpoint';
import { gaussianPly } from '../tests/fixtures/gaussians';

async function waitFor(condition: () => boolean) {
  const start = performance.now();
  while (!condition()) {
    if (performance.now() - start > 10_000) throw new Error('Volume controller test timed out.');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
async function gpuMasks(controller: AppController) {
  const renderer = controller.renderer!, scene = requireGaussianScene(controller.scene);
  const bytes = Math.max(4, scene.count * 4), buffer = renderer.device.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    const encoder = renderer.device.createCommandEncoder(); encoder.copyBufferToBuffer(scene.buffers.states, 0, buffer, 0, bytes);
    renderer.device.queue.submit([encoder.finish()]); await buffer.mapAsync(GPUMapMode.READ);
    const result = Array.from(new Uint32Array(buffer.getMappedRange().slice(0))); buffer.unmap(); return result;
  } finally { buffer.destroy(); }
}

type LedgerEntry = { id: number; category: Category; bytes: number };
function accountingSnapshot(controller: AppController, ledger: ResourceLedger, identities: Map<symbol, number>) {
  const registry = (ledger as unknown as { entries: Map<symbol, { category: Category; bytes: number }> }).entries;
  const description = (controller as unknown as { documentRecovery?: { description?: RecoveryCheckpointDescription } }).documentRecovery?.description;
  if (!(registry instanceof Map) || !description) throw new Error('Actual live ledger and accepted recovery checkpoint required.');
  const entries: LedgerEntry[] = [...registry].map(([identity, entry]) => {
    if (!identities.has(identity)) identities.set(identity, identities.size + 1);
    return { id: identities.get(identity)!, category: entry.category, bytes: entry.bytes };
  });
  return { entries, description: structuredClone(description) };
}
// Independent canonical encoding of the actual accepted checkpoint envelope.
// Constant domain/version overhead cancels between these two lengths. Keeping
// all nonnumeric values/structure identical proves unchanged node/string units:
// recoveryCheckpoint.ts budgets every numeric node at a fixed32 units, so only
// its3 retained encoded copies contribute to this metadata-only credit delta.
function canonicalAccounting(value: unknown, normalizeNumbers = false): string {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Invalid checkpoint number.');
    return JSON.stringify(normalizeNumbers ? 0 : value);
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => canonicalAccounting(item, normalizeNumbers)).join(',')}]`;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalAccounting((value as Record<string, unknown>)[key], normalizeNumbers)}`).join(',')}}`;
  throw new Error('Invalid checkpoint envelope.');
}
function accountingProof(before: ReturnType<typeof accountingSnapshot>, after: ReturnType<typeof accountingSnapshot>) {
  const envelope = (snapshot: typeof before) => ({ binding: snapshot.description.binding,
    plan: snapshot.description.plan, metadata: snapshot.description.metadata });
  const bytes = (value: unknown) => new TextEncoder().encode(canonicalAccounting(value)).byteLength;
  const describe = (snapshot: typeof before) => {
    const metadata = snapshot.description.metadata as Record<string, unknown>;
    return { entries: snapshot.entries, checkpointBytes: snapshot.description.plan.byteLength,
      maximumChunkBytes: snapshot.description.plan.maximumChunkBytes, chunkCount: snapshot.description.chunks.length,
      envelopeBytes: bytes(envelope(snapshot)), activeCameraBytes: bytes(metadata.activeCamera), defaultCameraBytes: bytes(metadata.defaultCamera) };
  };
  const first = describe(before), last = describe(after);
  return { before: first, after: last,
    normalizedEnvelopeEqual: canonicalAccounting(envelope(before), true) === canonicalAccounting(envelope(after), true),
    expectedRecoveryDelta: 3 * (last.envelopeBytes - first.envelopeBytes) };
}

function createHarness() {
  return {
    async failure(boundary: 'cancel' | 'view' | 'admission') {
      const canvas = document.createElement('canvas'); canvas.style.width = '320px'; canvas.style.height = '200px'; document.body.append(canvas);
      const controller = new AppController(), originalMap = GPUBuffer.prototype.mapAsync;
      let resume: (() => void) | undefined, restoreReserve: (() => void) | undefined;
      try {
        await controller.initialize(canvas); await controller.openFiles([new File([gaussianPly(0)], 'volume-boundaries.ply')]);
        if (!controller.client || !controller.scene || !controller.renderer || !controller.camera) throw new Error(useApp.getState().error || 'No Volume scene opened.');
        const client = controller.client, ledger = (controller as unknown as { ledger: ResourceLedger }).ledger;
        await controller.command({ command: 'single', index: 1 }); await controller.command({ command: 'delete' }); await controller.command({ command: 'undo' });
        controller.camera.set([0, 0, 0, 0, 0, 3, 1, 45, 0, 0, canvas.width / canvas.height]);
        useApp.setState({ tool: 'volume', operation: 0, overlap: false, visibleOnly: false, live: true, selectionDragging: false });
        const beforeOutput = new Uint8Array(await admittedExport(client, 0, 0)), before = await client.command({ command: 'summary' });
        const beforeMasks = await gpuMasks(controller), identities = new Map<symbol, number>();
        const beforeAccounting = accountingSnapshot(controller, ledger, identities), bytesBefore = ledger.usage.bytes;
        if (!controller.beginSelectionGesture()) throw new Error('Volume draft was refused.');
        await waitFor(() => !!useApp.getState().summary?.selectionDraft && !useApp.getState().busy);
        let entered!: () => void;
        const waiting = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { resume = resolve; });
        if (boundary === 'admission') {
          const reserve = ledger.reserve.bind(ledger); restoreReserve = () => { ledger.reserve = reserve; };
          let refusals = 0;
          ledger.reserve = (kind, bytes) => {
            // Exhaust both bounded scratch-eviction retries during map
            // acquisition. Later baseline cleanup keeps its own admission.
            if (kind === 'work' && refusals++ < 4) throw new AdmissionError('Injected Volume map admission refusal.');
            return reserve(kind, bytes);
          };
        } else GPUBuffer.prototype.mapAsync = function(mode, offset, size) {
          const work = originalMap.call(this, mode, offset, size);
          return this.label === 'Surface capacity readback' ? work.then(async () => { entered(); await gate; return undefined; }) : work;
        };
        const x = canvas.width / 2 - .4 / 3 * (canvas.height / 2 / Math.tan(Math.PI / 8)), y = canvas.height / 2;
        const command = { command: 'volume', camera: controller.camera.state, width: canvas.width, height: canvas.height,
          points: [[Math.round(x), Math.round(y)]], radius: 24, operation: 0, overlap: false, visibleOnly: false };
        controller.previewSelection(command); let accepted: boolean | undefined, viewCancelled: boolean | undefined;
        if (boundary !== 'admission') {
          await Promise.race([waiting, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('The real surface readback did not start.')), 10_000))]);
          if (boundary === 'view') {
            controller.camera.orbit(.1, 0); controller.invalidate();
            viewCancelled = !controller.selectionActive;
            const finishing = controller.finishSelectionGesture(command); resume!(); accepted = await finishing;
            // View invalidation already cleared ownership. With no owner this
            // public cancellation boundary only joins its pending cleanup.
            await controller.cancelSelectionGesture();
          } else { const cancelled = controller.cancelSelectionGesture(); resume!(); await cancelled; }
        } else {
          await waitFor(() => !!useApp.getState().error && !useApp.getState().busy);
          restoreReserve!(); restoreReserve = undefined; accepted = await controller.finishSelectionGesture(command);
        }
        GPUBuffer.prototype.mapAsync = originalMap;
        const afterOutput = new Uint8Array(await admittedExport(client, 0, 0)), after = await client.command({ command: 'summary' });
        const afterMasks = await gpuMasks(controller);
        const afterAccounting = accountingSnapshot(controller, ledger, identities), bytesAfter = ledger.usage.bytes;
        return { before, after, accepted, viewCancelled, bytesBefore, bytesAfter, accounting: accountingProof(beforeAccounting, afterAccounting),
          sameOutput: beforeOutput.length === afterOutput.length && beforeOutput.every((value, i) => value === afterOutput[i]),
          sameGpuMasks: beforeMasks.every((value, i) => value === afterMasks[i]), active: controller.selectionActive,
          busy: useApp.getState().busy, error: useApp.getState().error };
      } finally { resume?.(); restoreReserve?.(); GPUBuffer.prototype.mapAsync = originalMap; controller.dispose(); canvas.remove(); }
    },
  };
}
export type VolumeHarness = ReturnType<typeof createHarness>;
declare global { interface Window { volumeHarness: VolumeHarness; volumeHarnessError?: string } }
try { window.volumeHarness = createHarness(); }
catch (error) { window.volumeHarnessError = String(error); }
