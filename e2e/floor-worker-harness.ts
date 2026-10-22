// Actual registered CoreClient/worker/WASM only; no renderer or GPU initialization.
import { CoreClient } from '../src/document/coreClient';
import { ResourceLedger } from '../src/document/resources';
import { BUILD_DESCRIPTOR } from '../src/generated/buildIdentity';
import type { NativeSummary, Revision, WorkerRequest } from '../src/document/types';

const core = new CoreClient(), ledger = new ResourceLedger(64 * 1024 * 1024);
let ready = false;
function source(count: number) {
  const properties = ['x', 'y', 'z', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3', 'opacity', 'f_dc_0', 'f_dc_1', 'f_dc_2'];
  const header = ['ply', 'format ascii 1.0', `element vertex ${count}`, ...properties.map(name => `property float ${name}`), 'end_header'];
  const rows = Array.from({ length: count }, (_, index) => {
    const x = Math.fround((index % 300) * .02), z = Math.fround(Math.floor(index / 300) * .02);
    // Independent RDF PLY input; the real decoder owns native Gaussian records.
    const y = Math.fround(2 + .25 * x + .5 * z);
    return [x, -y, -z, -2, -2.5, -3, 1, 0, 0, 0, 32, .1, .2, -.3].join(' ');
  });
  return new TextEncoder().encode([...header, ...rows, ''].join('\n'));
}
async function digest(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('');
}
async function snapshot() {
  const summary = await core.command({ command: 'summary' });
  const chunks: { first: number; count: number; bytes: number; sha256: string }[] = [];
  let masks: Promise<string> | undefined;
  await core.stream(async (first, count, bytes) => { chunks.push({ first, count, bytes: bytes.byteLength, sha256: await digest(bytes) }); },
    bytes => { masks = digest(bytes); });
  if (!masks) throw new Error('The real worker did not publish native masks.');
  return { summary, chunks, masks: await masks, revision: { ...core.revision }, census: core.nativeAllocationCensus };
}
type Posted = { type: string; command?: string; requestId: number; base: Revision };
async function ownedCancellation() {
  if (!ready) throw new Error('The real scene worker has not initialized.');
  const worker = (core as unknown as { worker?: Worker }).worker;
  if (!worker) throw new Error('The registered client has no live worker.');
  const count = 60_000, bytes = source(count);
  await core.load(new File([bytes], 'floor-worker-planar.ply'), count, 64 * 1024 * 1024,
    { current() {}, admit: size => ledger.reserve('source', size) });
  const before = await snapshot(), posts: Posted[] = [], progress: { stage: string; fraction: number }[] = [];
  const abort = new AbortController(), previousProgress = core.onProgress;
  const originalPost = worker.postMessage.bind(worker), originalTerminate = worker.terminate.bind(worker);
  let terminations = 0, lateAbort: AbortController | undefined;
  worker.postMessage = ((message: WorkerRequest, transfer: Transferable[] = []) => {
    if (message.type === 'command' || message.type === 'cancel') posts.push({ type: message.type,
      command: message.type === 'command' ? message.command.command : undefined, requestId: message.requestId, base: { ...message.base } });
    originalPost(message, transfer);
    if (message.type === 'command' && message.command.command === 'detectFloor' && lateAbort) {
      const completedSignal = lateAbort; lateAbort = undefined; completedSignal.abort();
    }
  }) as Worker['postMessage'];
  worker.terminate = () => { terminations++; originalTerminate(); };
  const camera = [0, 4, 3, 0, 0, 3, 1, 45, 1, 0, 1];
  let completed: NativeSummary | undefined, failure: { name: string; message: string } | undefined;
  try {
    core.onProgress = (stage, fraction) => {
      progress.push({ stage, fraction });
      if (stage === 'Detecting floor' && fraction < 1 && !abort.signal.aborted) abort.abort();
    };
    try { completed = await core.command({ command: 'detectFloor', camera }, abort.signal); }
    catch (error) {
      failure = { name: error && typeof error === 'object' && 'name' in error ? String(error.name) : 'unknown',
        message: error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error) };
    }
    core.onProgress = previousProgress;
    const after = await snapshot();
    const completedQuery = new AbortController();
    await core.command({ command: 'summary' }, completedQuery.signal);
    // Deliver the old, completed query's abort while the next real request is
    // being posted. It must not target that successor's cooperative analysis.
    lateAbort = completedQuery;
    const successor = await core.command({ command: 'detectFloor', camera });
    const sameWorker = (core as unknown as { worker?: Worker }).worker === worker;
    if (!successor.floor) throw new Error('The real successor did not return native Floor metadata.');
    const retired = await core.command({ command: 'cancelFloor', id: successor.floor.id });
    const final = await snapshot();
    return { scope: 'Actual registered browser worker/WASM cancellation and successor ownership; no App/GPU, wall-clock, full-domain or host-memory acceptance.',
      build: BUILD_DESCRIPTOR, count, inputBytes: bytes.byteLength, before, after, final, progress, posts,
      aborted: abort.signal.aborted, completed, failure, successor, retired, sameWorker, terminations, sourceLedger: ledger.usage };
  } finally { worker.postMessage = originalPost; worker.terminate = originalTerminate; core.onProgress = previousProgress; }
}
const harness = { ready: () => ready, ownedCancellation, dispose: () => core.retireNativeMemory() };
declare global { interface Window { floorWorker: typeof harness; floorWorkerError?: string } }
window.floorWorker = harness;
void core.ready().then(() => { ready = true; document.getElementById('status')!.textContent = 'Worker ready'; })
  .catch(error => { window.floorWorkerError = error instanceof Error ? error.message : String(error); });
