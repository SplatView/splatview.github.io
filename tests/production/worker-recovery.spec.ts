import { expect, test, type Page } from '@playwright/test';
import { artifact, deployment, digest, exportBytes, grade, openScene, sceneFile, wake } from './initialization-helpers';
import type { BuildDescriptor, NativeIdentity } from '../../src/build/contracts';
import type { NativeSummary, Revision } from '../../src/document/types';
import type { RecoveryCheckpointBinding, RecoveryCheckpointPlan } from '../../src/document/recoveryCheckpoint';
import type { SourceFingerprint } from '../../src/io/fingerprint';
import type { OperationOwner } from '../../src/document/operationProtocol';

type WorkerRecord = { id: number; url: string; terminationCalls: number; injectedFailures: number;
  initializationId?: string; readyInitializationId?: string; readyBuild?: BuildDescriptor; readyCore?: NativeIdentity; mode?: string };
type WireObservation = {
  ordinal: number; worker: number; direction: 'request' | 'response'; type: string;
  requestId?: number; initializationId?: string; mode?: string; manifestDeploymentId?: string;
  base?: Revision; operationOwner?: OperationOwner; action?: string; command?: string; recoveryId?: string;
  binding?: RecoveryCheckpointBinding; plan?: RecoveryCheckpointPlan; fingerprint?: SourceFingerprint;
  summary?: NativeSummary; maxSplats?: number; sourceBytes?: number; transferBytes?: number;
  index?: number; offset?: number; length?: number;
  heap?: { sequence: number; heapBytes: number } | null; census?: unknown; allocation?: unknown;
};
type ShippingRecoveryEvidence = { workers: WorkerRecord[]; wire: WireObservation[]; overflow: boolean };
type ShippingRecoveryMonitor = ShippingRecoveryEvidence & { fail(id: number): void };
declare global { interface Window { __shippingWorkerRecovery: ShippingRecoveryMonitor } }

/** The only fault is destruction of an actual browser Worker followed by an
 * explicit error event. No native payload, summary, receipt or restore outcome
 * is replaced. Only bounded descriptor/scalar observations are retained.
 */
async function observeShippingWorkers(page: Page) {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    const instances = new Map<number, Worker>();
    const monitor: ShippingRecoveryMonitor = { workers: [], wire: [], overflow: false,
      fail(id) {
        const worker = instances.get(id), record = monitor.workers.find(value => value.id === id);
        if (!worker || !record || record.terminationCalls) throw new Error('The actual shipping worker is no longer live.');
        record.injectedFailures++;
        worker.terminate();
        // terminate() emits no browser error event. This explicit, separate
        // seam reaches the unchanged production CoreClient.onerror handler.
        worker.dispatchEvent(new ErrorEvent('error', { cancelable: true,
          message: 'The shipping browser test terminated the authoritative scene worker.',
          error: new Error('The shipping browser test terminated the authoritative scene worker.') }));
      } };
    window.__shippingWorkerRecovery = monitor;
    function observe(worker: number, direction: 'request' | 'response', value: unknown) {
      if (monitor.wire.length >= 512) { monitor.overflow = true; return; }
      if (!value || typeof value !== 'object') return;
      const data = value as Record<string, unknown>;
      const row: WireObservation = { ordinal: monitor.wire.length, worker, direction, type: String(data.type) };
      for (const key of ['requestId', 'initializationId', 'mode', 'action', 'recoveryId', 'maxSplats', 'index', 'offset', 'length'] as const)
        if (typeof data[key] === 'string' || typeof data[key] === 'number') Object.assign(row, { [key]: data[key] });
      const command = data.command as { command?: unknown } | undefined;
      if (typeof command?.command === 'string') row.command = command.command;
      for (const key of ['base', 'operationOwner', 'binding', 'plan', 'fingerprint', 'summary', 'heap', 'census', 'allocation'] as const)
        if (Object.hasOwn(data, key)) Object.assign(row, { [key]: structuredClone(data[key]) });
      const source = data.source as { byteLength?: unknown } | undefined;
      if ((data.type === 'source-load' || data.type === 'source-group-load') && typeof source?.byteLength === 'number')
        row.sourceBytes = source.byteLength;
      if (data.bytes instanceof ArrayBuffer) row.transferBytes = data.bytes.byteLength;
      const manifest = data.manifest as { deploymentId?: unknown } | undefined;
      if (typeof manifest?.deploymentId === 'string') row.manifestDeploymentId = manifest.deploymentId;
      // In particular, never clone initialize.source native binaries, stream
      // chunks, checkpoint ranges or output buffers into this observer.
      monitor.wire.push(row);
    }
    window.Worker = class extends NativeWorker {
      private record: WorkerRecord;
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        const record: WorkerRecord = { id: monitor.workers.length + 1, url: String(url), terminationCalls: 0, injectedFailures: 0 };
        this.record = record;
        if (monitor.workers.length >= 4) { monitor.overflow = true; return; }
        monitor.workers.push(record); instances.set(record.id, this);
        this.addEventListener('message', event => {
          const data = event.data as { type?: string; initializationId?: string; build?: BuildDescriptor; core?: NativeIdentity; mode?: string };
          if (data?.type === 'ready') {
            record.readyInitializationId = data.initializationId;
            record.readyBuild = structuredClone(data.build!); record.readyCore = structuredClone(data.core!); record.mode = data.mode;
          }
          observe(record.id, 'response', event.data);
        });
      }
      override postMessage(message: unknown, options?: Transferable[] | StructuredSerializeOptions) {
        const data = message as { type?: string; initializationId?: string };
        if (data?.type === 'initialize') this.record.initializationId = data.initializationId;
        observe(this.record.id, 'request', message);
        if (Array.isArray(options)) super.postMessage(message, options); else super.postMessage(message, options);
      }
      override terminate() { this.record.terminationCalls++; super.terminate(); }
    };
  });
}
const evidence = (page: Page) => page.evaluate(() => {
  const { workers, wire, overflow } = window.__shippingWorkerRecovery;
  return { workers, wire, overflow };
});
const posts = (value: ShippingRecoveryEvidence, worker: number, type?: string) => value.wire.filter(row =>
  row.worker === worker && row.direction === 'request' && (type === undefined || row.type === type));
const replies = (value: ShippingRecoveryEvidence, worker: number, type?: string) => value.wire.filter(row =>
  row.worker === worker && row.direction === 'response' && (type === undefined || row.type === type));

test('shipped fatal worker recovery preserves edited native SH3 exports and executable Redo without source reread or mutation replay', async ({ page }, testInfo) => {
  const manifest = await deployment(), file = sceneFile('shipped-worker-recovery-sh3.ply');
  const failures: string[] = []; page.on('pageerror', error => failures.push(error.message));
  let report: Record<string, unknown> = { schemaVersion: 1, scenario: 'shipped-quiescent-authoritative-worker-termination',
    fault: 'Actual Worker.terminate followed by explicit ErrorEvent through existing CoreClient.onerror.',
    manifest: { deploymentId: manifest.deploymentId, build: manifest.build,
      artifacts: (['document-worker', 'core-glue', 'core-wasm', 'camera-glue', 'camera-wasm'] as const).map(role => artifact(manifest, role)) },
    source: { name: file.name, bytes: file.buffer.byteLength },
    limits: { maximumObservedWorkers: 4, maximumWireRows: 512, retainedTransferBuffers: 0 } };
  try {
  await observeShippingWorkers(page); await openScene(page, file, true);
  const tools = page.getByRole('complementary', { name: 'Tools', exact: true });
  await tools.getByRole('button', { name: 'Select all', exact: true }).click();
  await expect(tools.locator('.model-stats')).toHaveText(/^3\/3 splats \| SH3$/);
  await grade(page, '1.3'); const first = await exportBytes(page, 'shipped-worker-recovery-sh3');
  await grade(page, '1.7'); const second = await exportBytes(page, 'shipped-worker-recovery-sh3');
  expect(second.equals(first)).toBe(false);
  await wake(page); await tools.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(tools.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
  const beforeBytes = await exportBytes(page, 'shipped-worker-recovery-sh3'); expect(beforeBytes.equals(first)).toBe(true);
  const before = await evidence(page);
  expect(before.overflow).toBe(false); expect(before.workers).toHaveLength(1);
  const original = before.workers[0], sourceRequest = posts(before, original.id, 'source-load');
  expect(sourceRequest).toHaveLength(1); expect(sourceRequest[0].sourceBytes).toBe(file.buffer.byteLength);
  const sourceResults = replies(before, original.id, 'source-load-result'); expect(sourceResults).toHaveLength(1);
  const sourceResult = sourceResults[0], fingerprint = sourceResult.fingerprint!;
  expect(fingerprint).toMatchObject({ scheme: 'splatview-source-v1', resourceCount: 1,
    totalBytes: file.buffer.byteLength, sourceKindHint: 'PLY' }); expect(fingerprint.assetDigest).toMatch(/^[0-9a-f]{64}$/);
  const captures = posts(before, original.id, 'recovery-export'); expect(captures.length).toBeGreaterThan(1);
  const latestCapture = captures.at(-1)!, captured = latestCapture.binding!;
  expect(replies(before, original.id, 'recovery-result').filter(row => row.action === 'export' &&
    row.recoveryId === latestCapture.recoveryId)).toHaveLength(1);
  const exportedPlan = replies(before, original.id, 'recovery-plan').find(row => row.recoveryId === latestCapture.recoveryId)!.plan!;
  expect(captured.source).toEqual(fingerprint); expect(captured.core).toEqual(manifest.build.native.core);
  expect(captured.subset).toEqual({ sourceCount: sourceResult.summary!.sourceCount,
    loadedCount: sourceResult.summary!.count, maxSplats: sourceRequest[0].maxSplats });
  const summaryBefore = replies(before, original.id).findLast(row => row.summary)!.summary!;
  const baseBefore = posts(before, original.id).findLast(row => row.base)!.base!;
  expect(summaryBefore).toMatchObject({ ok: true, loaded: true, shDegree: 3, selected: 3, visible: 3, canUndo: true, canRedo: true,
    selectionDraft: false, transaction: false, pending: false });
  expect(original).toMatchObject({ terminationCalls: 0, injectedFailures: 0, readyBuild: manifest.build,
    readyCore: manifest.build.native.core, mode: 'production-verified' });
  expect(original.initializationId).toBe(original.readyInitializationId);
  expect(posts(before, original.id, 'initialize')[0].manifestDeploymentId).toBe(manifest.deploymentId);

  // This destroys the actual shipped authoritative worker and its WASM heap.
  // All following scene state must originate in the independently held bytes.
  await page.evaluate(id => window.__shippingWorkerRecovery.fail(id), original.id);
  await expect.poll(async () => (await evidence(page)).workers.filter(worker => worker.readyInitializationId).length).toBe(2);
  await expect(page.locator('.status.panel')).toHaveCount(0);
  await wake(page); await expect(tools.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  await expect(tools.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
  await expect(tools.locator('.model-stats')).toHaveText(/^3\/3 splats \| SH3$/);
  const restoredBytes = await exportBytes(page, 'shipped-worker-recovery-sh3'); expect(restoredBytes.equals(beforeBytes)).toBe(true);
  const restored = await evidence(page); expect(restored.overflow).toBe(false); expect(restored.workers).toHaveLength(2);
  const replacement = restored.workers.find(worker => worker.id !== original.id)!;
  expect(replacement).toMatchObject({ terminationCalls: 0, injectedFailures: 0, readyBuild: manifest.build,
    readyCore: manifest.build.native.core, mode: 'production-verified' });
  expect(replacement.initializationId).toBe(replacement.readyInitializationId);
  expect(replacement.initializationId).not.toBe(original.initializationId);
  expect(restored.workers.find(worker => worker.id === original.id)).toMatchObject({ injectedFailures: 1 });
  expect(restored.workers.find(worker => worker.id === original.id)!.terminationCalls).toBeGreaterThanOrEqual(1);
  expect(posts(restored, replacement.id, 'initialize')).toHaveLength(1);
  expect(posts(restored, replacement.id, 'initialize')[0].manifestDeploymentId).toBe(manifest.deploymentId);
  const restores = posts(restored, replacement.id, 'recovery-restore'); expect(restores).toHaveLength(1);
  expect(restores[0].binding).toEqual(captured); expect(restores[0].base).toEqual(captured.revision);
  expect(restores[0].plan).toEqual(exportedPlan);
  expect(restores[0].base!.documentId).toBe(sourceRequest[0].base!.documentId);
  expect(restores[0].base!.sourceGeneration).toBe(sourceRequest[0].base!.sourceGeneration);
  expect(posts(restored, replacement.id).findLast(row => row.base)!.base).toEqual(baseBefore);
  const terminal = replies(restored, replacement.id, 'recovery-result').filter(row => row.action === 'restore');
  expect(terminal).toHaveLength(1); expect(terminal[0].summary).toMatchObject({ revision: summaryBefore.revision,
    contentRevision: summaryBefore.contentRevision, count: 3, sourceCount: 3, shDegree: 3, selected: 3, visible: 3,
    canUndo: true, canRedo: true, pending: false, transaction: false, selectionDraft: false });
  const restoreRequests = replies(restored, replacement.id, 'recovery-range-request');
  const restoreConsumed = replies(restored, replacement.id, 'recovery-range-consumed');
  expect(restoreRequests.length).toBeGreaterThan(0); expect(restoreConsumed).toHaveLength(restoreRequests.length);
  expect(restoreRequests.reduce((sum, row) => sum + row.length!, 0)).toBe(exportedPlan.byteLength);
  for (const [index, request] of restoreRequests.entries()) {
    expect(request).toMatchObject({ index, offset: index * 1048576, recoveryId: restores[0].recoveryId,
      initializationId: replacement.initializationId, allocation: null });
    expect(request.length).toBeGreaterThan(0); expect(request.length).toBeLessThanOrEqual(1048576);
    expect(request.heap!.heapBytes).toBeGreaterThan(0); expect(request.census).toMatchObject({ ok: true, version: 1 });
    expect(restoreConsumed[index]).toMatchObject({ index, offset: request.offset, length: request.length,
      recoveryId: request.recoveryId, allocation: null });
  }
  expect(restored.wire.filter(row => row.ordinal >= before.wire.length && row.direction === 'request' &&
    ['source-load', 'source-group-load', 'source-range'].includes(row.type))).toHaveLength(0);
  expect(posts(restored, replacement.id).filter(row => row.command &&
    ['grade', 'autoColor', 'selectAll', 'single', 'undo', 'redo'].includes(row.command))).toHaveLength(0);

  await wake(page); await tools.getByRole('button', { name: 'Redo', exact: true }).click();
  const redoBytes = await exportBytes(page, 'shipped-worker-recovery-sh3'); expect(redoBytes.equals(second)).toBe(true);
  await wake(page); await tools.getByRole('button', { name: 'Undo', exact: true }).click();
  const undoBytes = await exportBytes(page, 'shipped-worker-recovery-sh3'); expect(undoBytes.equals(first)).toBe(true);
  await expect(tools.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0); expect(failures).toEqual([]);
  const final = await evidence(page); expect(final.overflow).toBe(false);
  expect(final.workers).toHaveLength(2);
  expect(posts(final, replacement.id, 'recovery-restore')).toHaveLength(1);
  expect(posts(final, replacement.id).filter(row => row.command === 'redo')).toHaveLength(1);
  expect(posts(final, replacement.id).filter(row => row.command === 'undo')).toHaveLength(1);
  expect(posts(final, replacement.id).filter(row => row.command === 'grade' || row.command === 'selectAll')).toHaveLength(0);
  const newOperations = posts(final, replacement.id, 'operation').filter(row => row.action === 'begin');
  expect(newOperations.length).toBeGreaterThanOrEqual(2);
  for (const row of newOperations) expect(row.operationOwner).toMatchObject({
    documentId: captured.revision.documentId, sourceGeneration: captured.revision.sourceGeneration,
    clientGeneration: replacement.initializationId });
  report = { ...report,
      source: { name: file.name, bytes: file.buffer.byteLength, fingerprint, subset: captured.subset },
      downloads: Object.fromEntries(Object.entries({ first, second, before: beforeBytes, restored: restoredBytes, redo: redoBytes, undo: undoBytes })
        .map(([name, bytes]) => [name, { bytes: bytes.length, sha256: digest(bytes) }])),
      before: { worker: original.id, clientGeneration: original.initializationId, base: baseBefore, native: summaryBefore },
      replacement: { worker: replacement.id, clientGeneration: replacement.initializationId, restore: restores[0] },
      assertionsCompleted: true };
  } finally {
    const final = await evidence(page).catch(error => ({ observationError: String(error) }));
    await testInfo.attach('shipped-worker-recovery-evidence.json', { contentType: 'application/json',
      body: Buffer.from(JSON.stringify({ ...report, evidence: final, pageErrors: failures }, null, 2)) });
  }
});
