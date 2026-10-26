import { requireWebGpuRenderer } from './gaussian-harness-scene';
// Test-only orchestration of the mounted App, its actual worker/native module,
// Blob reads and GPU owners. No shipping worker command or memory.grow hook.
import './geometry-viewer-harness';
import { useApp } from '../src/app/store';
import { GpuGeometryScene } from '../src/renderer/webgpu/renderer';
import type { CoreClient } from '../src/document/coreClient';
import { resourceCreditBytes, resourceLeaseCredit, type ResourceCredit, type ResourceLedger, type ResourceLease } from '../src/document/resources';
import { assertOwnedSceneCollection, type OwnedSceneCollection, type SceneCollectionOptions } from '../src/io/sceneCollection';
import { NEUTRAL_COLOR } from '../src/renderer/defaults';
import { gaussianPly } from '../tests/fixtures/gaussians';

const MiB = 1024 * 1024, pageBytes = 65536, stagedBytes = 40 * MiB;
const points = `ply
format ascii 1.0
element vertex 3
property float x
property float y
property float z
property uchar red
property uchar green
property uchar blue
end_header
-.4 0 0 255 0 0
.4 0 0 0 255 0
0 .4 .1 0 0 255
`;
type Source = 'gaussian' | 'points';
type ObservedClient = { worker?: Worker; disposed?: boolean };
function app() { return window.geometryViewer.controllerForSourceNavigation(); }
function internals() {
  return app() as unknown as { ledger: ResourceLedger; candidate?: CoreClient; files: readonly File[]; currentFile: number;
    collection?: OwnedSceneCollection; intake?: { collection?: OwnedSceneCollection };
    collectionOptions(owner: object): SceneCollectionOptions;
    intakeCollection(owner: object, factory: () => Promise<OwnedSceneCollection>): Promise<void> };
}
const catalogLeases = new WeakMap<OwnedSceneCollection, ResourceLease>();
const intakeLeases = new WeakMap<object, ResourceLease[]>();
const observedCredits = new Map<symbol, { id: number; credit: ResourceCredit }>();
let observing: ReturnType<typeof app> | undefined;
function creditObservation(lease: ResourceLease) {
  const value = internals().ledger, credit = resourceLeaseCredit(lease);
  const identity = (value as unknown as { identities: WeakMap<ResourceLease, symbol> }).identities.get(lease);
  if (!identity) throw new Error('An observed credit is not a genuine reservation in the actual App ledger.');
  let binding = observedCredits.get(identity);
  if (binding && binding.credit !== credit) throw new Error('The actual ledger reservation changed credit identity.');
  if (!binding) { binding = { id: observedCredits.size + 1, credit }; observedCredits.set(identity, binding); }
  const bytes = resourceCreditBytes(credit);
  return { id: binding.id, bytes: bytes ?? null, live: bytes !== undefined,
    owned: value.owns(lease), source: value.owns(lease, 'source') };
}
function catalogLease(collection: OwnedSceneCollection) {
  const lease = catalogLeases.get(collection);
  if (!lease) throw new Error('The actual factory-owned catalog has no observed admission binding.');
  return lease;
}
function observeCollectionAdmission() {
  const controller = app(); if (observing === controller) return;
  const value = internals(), options = value.collectionOptions, intake = value.intakeCollection;
  value.collectionOptions = function (owner) {
    const actual = options.call(this, owner), leases = intakeLeases.get(owner) ?? [];
    intakeLeases.set(owner, leases);
    return { ...actual, admit(bytes) {
      const lease = actual.admit(bytes); creditObservation(lease); leases.push(lease); return lease;
    } };
  };
  value.intakeCollection = function (owner, factory) {
    return intake.call(this, owner, async () => {
      const collection = await factory(); assertOwnedSceneCollection(collection);
      // The real factory has joined/released transient discovery/drop owners.
      // Bind its actual result to the unique remaining authenticated credit;
      // category labels and reservation sizes never select this owner.
      const leases = intakeLeases.get(owner)?.filter(lease => resourceCreditBytes(resourceLeaseCredit(lease)) !== undefined) ?? [];
      if (leases.length !== 1) throw new Error('The completed actual collection factory must retain exactly one catalog credit.');
      catalogLeases.set(collection, leases[0]); return collection;
    });
  };
  observing = controller;
}
function ledger() {
  const controller = app(), selected = internals(), value = selected.ledger;
  const nativeRemainder = controller.client?.nativeMemory ? creditObservation(controller.client.nativeMemory.remainder) : undefined;
  if (selected.candidate?.nativeMemory) creditObservation(selected.candidate.nativeMemory.remainder);
  const catalog = selected.collection ? creditObservation(catalogLease(selected.collection)) : undefined;
  const entries = [...(value as unknown as { entries: Map<symbol, { category: string; bytes: number }> }).entries]
    .map(([identity, entry]) => ({ ...entry, creditId: observedCredits.get(identity)?.id ?? null }))
    .sort((a, b) => a.category.localeCompare(b.category) || a.bytes - b.bytes);
  return { bytes: value.usage.bytes, allocations: value.usage.allocations, entries, overageBytes: value.overageBytes,
    ...(nativeRemainder ? { nativeRemainder } : {}), ...(catalog ? { catalog } : {}) };
}
function budget() { return internals().ledger as unknown as { limit: number }; }
function base(source: Source) { return source === 'gaussian' ? gaussianPly(0) : new TextEncoder().encode(points); }
function input(source: Source, name: string, padded = false) {
  const bytes = base(source);
  // Extra ASCII whitespace is outside the declared three records. It preserves
  // the decoded source while exercising complete original-input staging/hash.
  return padded ? new File([bytes, new Uint8Array(stagedBytes - bytes.byteLength).fill(32)], name) : new File([bytes], name);
}
function gate() {
  let enter!: () => void, release!: () => void;
  return { entered: new Promise<void>(resolve => { enter = resolve; }), held: new Promise<void>(resolve => { release = resolve; }),
    enter: () => enter(), release: () => release() };
}
function memory(client: CoreClient) {
  if (!client.nativeMemory) throw new Error('The actual App client has no retained native heap owner.');
  return client.nativeMemory.state;
}
function nativeCredit(client: CoreClient) {
  if (!client.nativeMemory) throw new Error('The actual candidate has no native remainder credit.');
  return creditObservation(client.nativeMemory.remainder);
}
async function snapshot() {
  const controller = app(), client = controller.client;
  if (!client) throw new Error('An actual published source is required.');
  return { ...(await window.geometryViewer.snapshot()), memory: memory(client), census: client.nativeAllocationCensus, accounting: ledger() };
}
// Selection and content changes briefly own the automatic pivot query.
async function colorReady() {
  for (const start = performance.now(); !app().colorControlsEnabled && performance.now() - start < 10_000;)
    await new Promise(resolve => setTimeout(resolve, 5));
}
async function edited(padded = false) {
  const controller = app();
  await controller.openFiles([input('gaussian', 'a-kept.ply', padded), input('gaussian', 'z-next.ply')]);
  await controller.command({ command: 'selectAll' }); await colorReady();
  const values = [...NEUTRAL_COLOR]; values[0] = 1.2;
  if (!await controller.command({ command: 'grade', values })) throw new Error('The first native edit was refused.');
  values[0] = 1.5; await colorReady();
  if (!await controller.command({ command: 'grade', values }) || (await colorReady(), !await controller.command({ command: 'undo' })))
    throw new Error('The real native Redo fixture was not established.');
  await colorReady();
  controller.camera!.orbit(11, -7); controller.cycleBackground(); controller.invalidate();
}
async function replace(file: File) {
  await app().openFiles([file]);
  if (useApp.getState().navigationPrompt) await app().discardAndContinue();
}
async function redoRestoration() {
  const controller = app(), redone = await controller.command({ command: 'redo' }), afterRedo = await snapshot();
  const undone = await controller.command({ command: 'undo' }), afterUndo = await snapshot();
  return { redone, afterRedo, undone, afterUndo };
}

let restoreOverageBudget: (() => void) | undefined;
const harness = {
  ready() { const ready = window.geometryViewer?.ready(); if (ready) observeCollectionAdmission(); return ready; },
  async retainedSource(source: Source) {
    const file = input(source, `large-${source}.ply`, true);
    await app().openFiles([file]);
    if (useApp.getState().summary?.count !== 3) throw new Error(useApp.getState().error ?? 'The real padded PLY failed.');
    const client = app().client!, first = await snapshot();
    // A further native response proves that free/staging retirement has not
    // silently restored the old fixed 32MiB estimate.
    const settled = await snapshot();
    return { source, inputBytes: file.size, first, settled, sameClient: app().client === client };
  },
  async refusedCandidate() {
    await edited();
    const controller = app(), keptClient = controller.client!, keptScene = controller.scene!, before = await snapshot();
    const value = budget(), limit = value.limit, file = input('gaussian', 'large-refused.ply', true), slice = file.slice.bind(file);
    let candidate: CoreClient | undefined, narrowed = false, atNarrowing: ReturnType<typeof ledger> | undefined;
    file.slice = (...args) => {
      const part = slice(...args), read = part.arrayBuffer.bind(part);
      part.arrayBuffer = async () => {
        const bytes = await read();
        // The last genuine range has an allocated, measured native input. This
        // controlled test budget refuses its inactive candidate on real next
        // telemetry, while the accepted old document still fits.
        if (Number(args[0]) > 0 && Number(args[1]) === file.size) {
          candidate = internals().candidate; atNarrowing = ledger();
          value.limit = before.accounting.bytes + 32 * MiB; narrowed = true;
        }
        return bytes;
      };
      return part;
    };
    try { await replace(file); }
    finally { value.limit = limit; file.slice = slice; }
    if (!candidate || !narrowed) throw new Error('The real final source-range refusal boundary was not reached.');
    const after = await snapshot(), candidateMemory = memory(candidate), error = useApp.getState().error;
    return { before, after, atNarrowing, narrowed: Boolean(narrowed), candidateMemory, error,
      sameClient: controller.client === keptClient, sameScene: controller.scene === keptScene,
      ...(await redoRestoration()) };
  },
  async heldRead() {
    const controller = app(); await controller.openFiles([input('gaussian', 'kept.ply')]);
    const keptClient = controller.client!, keptScene = controller.scene!, before = await snapshot();
    const file = input('gaussian', 'held-read.ply', true), slice = file.slice.bind(file), held = gate();
    let reads = 0, candidate: CoreClient | undefined, settled = false;
    file.slice = (...args) => {
      const part = slice(...args), read = part.arrayBuffer.bind(part);
      part.arrayBuffer = async () => {
        const bytes = await read();
        // The first slice is the allocation probe. The second is the first
        // admitted native source range, whose actual read is now completed but
        // whose original promise is deliberately not yet consumable.
        if (++reads === 2) { candidate = internals().candidate; held.enter(); await held.held; }
        return bytes;
      };
      return part;
    };
    const opening = controller.openFiles([file]).finally(() => { settled = true; });
    try {
      await Promise.race([held.entered, opening.then(() => { throw new Error('The source ended before its held native read.'); })]);
      if (!candidate) throw new Error('The admitted actual candidate is missing.');
      const collection = internals().intake?.collection;
      if (!collection) throw new Error('The held source has no actual staged catalog owner.');
      const catalog = catalogLease(collection);
      const admitted = { nativeCredit: nativeCredit(candidate), catalog: creditObservation(catalog), accounting: ledger(), memory: memory(candidate) };
      controller.cancelLoad();
      const cancelled = { nativeCredit: nativeCredit(candidate), catalog: creditObservation(catalog), accounting: ledger(), memory: memory(candidate), settled,
        disposed: (candidate as unknown as ObservedClient).disposed === true,
        sameClient: controller.client === keptClient, sameScene: controller.scene === keptScene };
      await controller.openFiles([input('gaussian', 'successor.ply')]);
      const successor = controller.client!, successorState = await snapshot();
      const beforeRelease = { nativeCredit: nativeCredit(candidate), catalog: creditObservation(catalog), accounting: ledger(), memory: memory(candidate), settled };
      held.release(); await opening;
      const after = await snapshot();
      return { inputBytes: file.size, before, admitted, cancelled, successorState, beforeRelease, after,
        retiredNativeCredit: nativeCredit(candidate), retiredCatalog: creditObservation(catalog),
        candidateRetired: memory(candidate).retired, sameSuccessor: controller.client === successor };
    } finally { held.release(); file.slice = slice; await opening; }
  },
  async heldUpload() {
    await edited();
    const controller = app(), keptClient = controller.client!, keptScene = controller.scene!, before = await snapshot();
    const upload = GpuGeometryScene.prototype.uploadVertices, uploaded = gate(), retirement = gate();
    let candidate: CoreClient | undefined, staged: GpuGeometryScene | undefined, settled = false;
    GpuGeometryScene.prototype.uploadVertices = async function (...args) {
      await upload.apply(this, args); candidate = internals().candidate; staged = this;
      const dispose = this.dispose.bind(this), queue = requireWebGpuRenderer(controller.renderer).device.queue;
      this.dispose = () => {
        const fence = queue.onSubmittedWorkDone.bind(queue);
        queue.onSubmittedWorkDone = async () => { await fence(); retirement.enter(); await retirement.held; };
        try { return dispose(); } finally { queue.onSubmittedWorkDone = fence; }
      };
      uploaded.enter(); await uploaded.held;
    };
    const opening = replace(input('points', 'held-upload.ply', true)).finally(() => { settled = true; });
    try {
      await Promise.race([uploaded.entered, opening.then(() => { throw new Error('The candidate ended before its actual held upload.'); })]);
      if (!candidate || !staged) throw new Error('The actual candidate upload is missing.');
      const collection = internals().intake?.collection;
      if (!collection) throw new Error('The held upload has no actual staged catalog owner.');
      const catalog = catalogLease(collection);
      const admitted = { nativeCredit: nativeCredit(candidate), catalog: creditObservation(catalog), accounting: ledger(), memory: memory(candidate) };
      controller.cancelLoad();
      const cancelled = { nativeCredit: nativeCredit(candidate), catalog: creditObservation(catalog), accounting: ledger(), memory: memory(candidate), settled, stagedRetired: staged.retired,
        sameClient: controller.client === keptClient, sameScene: controller.scene === keptScene };
      uploaded.release(); await retirement.entered;
      const retiring = { nativeCredit: nativeCredit(candidate), catalog: creditObservation(catalog), accounting: ledger(), memory: memory(candidate), settled, stagedRetired: staged.retired };
      retirement.release(); await opening;
      const after = await snapshot();
      return { before, admitted, cancelled, retiring, after, candidateRetired: memory(candidate).retired,
        retiredNativeCredit: nativeCredit(candidate), retiredCatalog: creditObservation(catalog),
        ...(await redoRestoration()) };
    } finally { uploaded.release(); retirement.release(); GpuGeometryScene.prototype.uploadVertices = upload; await opening; }
  },
  async beginOverage() {
    await edited(true);
    const controller = app(), client = controller.client!, scene = controller.scene!, before = await snapshot();
    const value = budget(), limit = value.limit;
    restoreOverageBudget = () => { value.limit = limit; restoreOverageBudget = undefined; };
    // The heap growth is genuine source staging; only the available operating
    // budget is tightened at this controlled seam. No fabricated response,
    // allocator result or direct WebAssembly.Memory.grow is involved.
    value.limit = before.accounting.bytes - pageBytes;
    const summary = await client.command({ command: 'summary' });
    const worker = (client as unknown as ObservedClient).worker;
    if (!worker) throw new Error('The authoritative real worker was unexpectedly terminated.');
    const post = worker.postMessage.bind(worker), posted: string[] = [];
    worker.postMessage = (message: unknown, transfer?: Transferable[] | StructuredSerializeOptions) => {
      const request = message as { type?: string; command?: { command?: string } };
      posted.push(request.command?.command ?? request.type ?? 'unknown');
      if (Array.isArray(transfer)) post(message, transfer); else post(message, transfer);
    };
    let directError = '', captureError = '', cleanup;
    try {
      try { await client.command({ command: 'grade', values: [...NEUTRAL_COLOR] }); } catch (error) { directError = String(error); }
      const edited = await controller.command({ command: 'grade', values: [...NEUTRAL_COLOR] });
      try { await controller.capture('image/png'); } catch (error) { captureError = String(error); }
      await replace(input('gaussian', 'blocked.ply'));
      cleanup = await client.command({ command: 'cancelSelection' });
      const after = await client.command({ command: 'summary' });
      return { before, summary, after, cleanup, directError, captureError, edited, posted,
        accounting: ledger(), memory: memory(client), storeOverageBytes: useApp.getState().memoryOverageBytes,
        editingAvailable: controller.editingAvailable, sameClient: controller.client === client, sameScene: controller.scene === scene,
        sameWorker: (client as unknown as ObservedClient).worker === worker, fingerprint: controller.sourceFingerprint,
        names: internals().files.map(file => file.name), index: internals().currentFile };
    } finally { worker.postMessage = post; }
  },
  overageState() {
    const controller = app();
    return { scene: !!controller.scene, client: !!controller.client, fingerprint: controller.sourceFingerprint ?? null,
      names: internals().files.map(file => file.name), index: internals().currentFile,
      overageBytes: useApp.getState().memoryOverageBytes, accounting: ledger(), navigationPrompt: useApp.getState().navigationPrompt };
  },
  resetBudget() { restoreOverageBudget?.(); },
};
declare global { interface Window { nativeMemory: typeof harness } }
window.nativeMemory = harness;
