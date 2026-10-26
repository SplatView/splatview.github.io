import { requireWebGpuRenderer } from './gaussian-harness-scene';
// Additive observations of the mounted App. No codec, summary, pick or GPU result is substituted.
import './alignment-harness';
import { useApp } from '../src/app/store';
import { CoreClient } from '../src/document/coreClient';
import { resourceCreditBytes, resourceLeaseCredit, type ResourceLedger, type ResourceLease } from '../src/document/resources';
import type { GroupSourceDescriptor } from '../src/document/sourceGroup';
import type { SourceReadBroker } from '../src/io/readBroker';
import type { GpuScene } from '../src/renderer/webgpu/renderer';

const controller = () => window.geometryViewer.controllerForSourceNavigation();
const internals = () => controller() as unknown as { ledger: ResourceLedger; files: readonly File[]; currentFile: number;
  candidate?: CoreClient; sourceLoads: Set<Promise<void>> };
type SourceOwner = { descriptor: { kind: string }; stage?: ResourceLease; range?: { lease?: ResourceLease };
  brokers: ReadonlyMap<string, SourceReadBroker> };
const sourceOwners = (client: CoreClient | undefined) => client ? [...(client as unknown as { sourceOwners: Set<SourceOwner> }).sourceOwners] : [];
const credit = (lease: ResourceLease | undefined) => lease ? resourceCreditBytes(resourceLeaseCredit(lease)) ?? null : null;
function ledger() {
  const value = internals().ledger;
  const entries = [...(value as unknown as { entries: Map<symbol, { category: string; bytes: number }> }).entries.values()]
    .map(entry => ({ ...entry })).sort((a, b) => a.category.localeCompare(b.category) || a.bytes - b.bytes);
  return { ...value.usage, entries };
}
function ownership() {
  const app = controller(), value = useApp.getState(), selected = internals();
  return { busy: value.busy, error: value.error, sourceName: value.sourceName, pendingLoads: selected.sourceLoads.size,
    currentFile: selected.currentFile, catalog: selected.files.map(file => file.name), catalogFrozen: Object.isFrozen(selected.files),
    activeDocumentId: app.client?.revision.documentId ?? null, candidateDocumentId: selected.candidate?.revision.documentId ?? null,
    fingerprint: app.sourceFingerprint, summary: value.summary ? { revision: value.summary.revision,
      contentRevision: value.summary.contentRevision, canUndo: value.summary.canUndo, canRedo: value.summary.canRedo } : null,
    ledger: ledger() };
}
function gate() {
  let release!: () => void;
  return { wait: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}
type Read = { name: string; offset: number; length: number; actualBytes: number | null; delivered: boolean; error: string | null };
type AcquiredGroup = { descriptor: GroupSourceDescriptor; sourceCount: number; metadataCredits: ResourceLease[]; client: CoreClient;
  completed: boolean; error: string | null };
type ReadObservation = {
  activeClient: CoreClient | undefined; activeScene: ReturnType<typeof controller>['scene']; heldName: string | null;
  held: boolean; released: boolean; heldCandidate?: CoreClient; reads: Read[]; groups: AcquiredGroup[];
  leases: { category: string; lease: ResourceLease; initialBytes: number }[];
  restore: (() => void)[]; release(): void;
};
let observed: ReadObservation | undefined;
function observeReads(heldName: string | null = null) {
  if (observed) throw new Error('A grouped read observation is already installed.');
  const app = controller(), memory = internals().ledger, held = gate();
  const owner: ReadObservation = { activeClient: app.client, activeScene: app.scene, heldName, held: false, released: false,
    reads: [], groups: [], leases: [], restore: [], release() { owner.released = true; held.release(); } };
  observed = owner;
  const reserve = memory.reserve;
  memory.reserve = function (...args) {
    const lease = reserve.apply(this, args); owner.leases.push({ category: args[0], lease, initialBytes: args[1] }); return lease;
  };
  owner.restore.push(() => { memory.reserve = reserve; });
  const wrapped = new WeakSet<Blob>();
  function wrap(blob: Blob, name: string) {
    if (wrapped.has(blob)) return;
    wrapped.add(blob);
    const previousSlice = Object.getOwnPropertyDescriptor(blob, 'slice'), slice = blob.slice;
    const previousRead = Object.getOwnPropertyDescriptor(blob, 'arrayBuffer'), read = blob.arrayBuffer;
    async function deliver(actual: () => Promise<ArrayBuffer>, offset: number, length: number) {
      const entry: Read = { name, offset, length, actualBytes: null, delivered: false, error: null }; owner.reads.push(entry);
      try {
        const bytes = await actual(); entry.actualBytes = bytes.byteLength;
        if (name === owner.heldName && !owner.held) {
          owner.held = true; owner.heldCandidate = internals().candidate; await held.wait;
        }
        entry.delivered = true; return bytes;
      } catch (error) { entry.error = String(error); throw error; }
    }
    Object.defineProperty(blob, 'slice', { configurable: true, value(...args: Parameters<Blob['slice']>) {
      const part = slice.apply(blob, args), actual = part.arrayBuffer.bind(part);
      const offset = args[0] ?? 0, length = part.size;
      Object.defineProperty(part, 'arrayBuffer', { configurable: true, value: () => deliver(actual, offset, length) }); return part;
    } });
    Object.defineProperty(blob, 'arrayBuffer', { configurable: true, value: () => deliver(() => read.call(blob), 0, blob.size) });
    owner.restore.push(() => {
      if (previousSlice) Object.defineProperty(blob, 'slice', previousSlice); else delete (blob as unknown as { slice?: unknown }).slice;
      if (previousRead) Object.defineProperty(blob, 'arrayBuffer', previousRead); else delete (blob as unknown as { arrayBuffer?: unknown }).arrayBuffer;
    });
  }
  const acquire = (event: Event) => {
    const files = event instanceof DragEvent ? event.dataTransfer?.files :
      event.target instanceof HTMLInputElement && event.target.getAttribute('aria-label') === 'Open scene files' ? event.target.files : null;
    if (files) for (const file of Array.from(files)) wrap(file, file.name);
  };
  document.addEventListener('change', acquire, true); document.addEventListener('drop', acquire, true);
  owner.restore.push(() => { document.removeEventListener('change', acquire, true); document.removeEventListener('drop', acquire, true); });
  const loadGroup = CoreClient.prototype.loadGroup;
  CoreClient.prototype.loadGroup = async function (...args) {
    const group = args[0], descriptor = structuredClone(group.descriptor), M = descriptor.resources[0].byteLength, R = descriptor.decoder.byteLength;
    const entry: AcquiredGroup = { descriptor, sourceCount: group.sourceCount, client: this, completed: false, error: null,
      metadataCredits: owner.leases.filter(record => record.category === 'source' && record.initialBytes === M + R && credit(record.lease) === M + R).map(record => record.lease) };
    owner.groups.push(entry);
    for (const resource of group.sources) {
      const path = descriptor.resources.find(item => item.resourceId === resource.resourceId)?.path;
      wrap(resource.blob, path === 'meta.json' ? '@original/meta.json' : path ?? '@decoder/meta.json');
    }
    try { return await loadGroup.apply(this, args); }
    catch (error) { entry.error = String(error); throw error; }
    finally { entry.completed = true; }
  };
  owner.restore.push(() => { CoreClient.prototype.loadGroup = loadGroup; });
}
function readObservation() {
  const owner = observed;
  if (!owner) throw new Error('No grouped read observation is installed.');
  const candidate = owner.heldCandidate, transfers = sourceOwners(candidate);
  const current = ownership();
  return { ...current, held: owner.held, released: owner.released,
    sameActiveClient: controller().client === owner.activeClient, sameActiveScene: controller().scene === owner.activeScene,
    reads: owner.reads.map(entry => ({ ...entry })),
    groups: owner.groups.map(entry => ({ descriptor: entry.descriptor, sourceCount: entry.sourceCount,
      completed: entry.completed, error: entry.error, metadataCredits: entry.metadataCredits.map(credit) })),
    heldCandidate: candidate ? { documentId: candidate.revision.documentId, sourceOwners: transfers.length,
      transfers: transfers.map(source => ({ kind: source.descriptor.kind, stageBytes: credit(source.stage), receiveBytes: credit(source.range?.lease),
        brokers: [...source.brokers].map(([resourceId, broker]) => ({ resourceId, byteLength: broker.descriptor.byteLength,
          consumedBytes: broker.consumedBytes, pending: broker.pending, complete: broker.complete,
          producerBytes: credit((broker as unknown as { active?: { lease?: ResourceLease } }).active?.lease) })) })) } : null,
    qualification: 'Actual Blob bytes are read first; only their arrayBuffer delivery is held. No source/native/GPU result is substituted.' };
}
function releaseRead() { if (!observed) throw new Error('No grouped read observation is installed.'); observed.release(); }
function finishReads() {
  if (!observed) throw new Error('No grouped read observation is installed.');
  if (internals().sourceLoads.size || observed.held && !observed.released) throw new Error('Join actual loads before restoring read observations.');
  const result = readObservation(), owner = observed; observed = undefined;
  for (const restore of owner.restore.reverse()) restore();
  return result;
}
let allocation: { scene?: GpuScene; entered: boolean; released: boolean; release(): void; restore(): void;
  buffers: { label: string; bytes: number; destroyCalls: number }[];
  activeClient: CoreClient | undefined; activeScene: ReturnType<typeof controller>['scene'] } | undefined;
function holdAllocation() {
  if (allocation) throw new Error('A GPU allocation is already held.');
  const app = controller(), renderer = requireWebGpuRenderer(app.renderer), original = renderer.allocateScene, held = gate();
  const owner = { scene: undefined as GpuScene | undefined, entered: false, released: false,
    buffers: [] as { label: string; bytes: number; destroyCalls: number }[],
    activeClient: app.client, activeScene: app.scene,
    release() { owner.released = true; held.release(); }, restore() { renderer.allocateScene = original; } };
  allocation = owner;
  renderer.allocateScene = async function (...args) {
    const scene = await original.apply(this, args); owner.scene = scene;
    for (const buffer of [...Object.values(scene.buffers), ...scene.params]) {
      const destroy = buffer.destroy, entry = { label: buffer.label, bytes: buffer.size, destroyCalls: 0 };
      owner.buffers.push(entry);
      buffer.destroy = function () { entry.destroyCalls++; return destroy.call(this); };
    }
    owner.entered = true; await held.wait; return scene;
  };
}
function allocationObservation() {
  if (!allocation) throw new Error('No actual GPU allocation hold is installed.');
  return { ...ownership(), entered: allocation.entered, released: allocation.released,
    sameActiveClient: controller().client === allocation.activeClient, sameActiveScene: controller().scene === allocation.activeScene,
    actualScene: allocation.scene ? { count: allocation.scene.count, stride: allocation.scene.stride,
      allocationBytes: allocation.scene.allocationBytes, retired: allocation.scene.retired } : null,
    buffers: allocation.buffers.map(buffer => ({ ...buffer })),
    qualification: 'Actual allocateScene completes before its result is held; the fixture creates no buffers or replacement scene.' };
}
function releaseAllocation() { if (!allocation) throw new Error('No actual allocation hold is installed.'); allocation.release(); }
function finishAllocation() {
  if (!allocation?.released || internals().sourceLoads.size) throw new Error('Join actual allocation retirement first.');
  const result = allocationObservation(); allocation.restore(); allocation = undefined; return result;
}
const harness = { ready: () => window.alignmentHarness.ready(), ownership, observeReads, readObservation, releaseRead, finishReads,
  holdAllocation, allocationObservation, releaseAllocation, finishAllocation,
  async joinLoads() { await Promise.all([...internals().sourceLoads]); return ownership(); },
};
declare global { interface Window { sogGroupHarness: typeof harness } }
window.sogGroupHarness = harness;
