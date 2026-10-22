import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AppController } from '../src/app/controller';
import { setApp, useApp } from '../src/app/store';
import type { CoreClient } from '../src/document/coreClient';
import { NativeHeapAccounting, WASM_PAGE_BYTES as P, type NativeCoverageUpdate } from '../src/document/nativeMemory';
import { AdmissionError, MiB, ResourceLedger, type ResourceLease } from '../src/document/resources';
import { NEUTRAL_COLOR, type NativeAllocationSnapshot, type NativeSummary, type SceneCommand } from '../src/document/types';
import type { ModuleFactory } from '../src/workers/wasm';
import { gaussianPly } from './fixtures/gaussians';
import { operationSnapshot, validateOperationReceipt, type OperationOwner, type OperationResolution } from '../src/document/operationProtocol';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function summary(patch: Partial<NativeSummary> = {}): NativeSummary {
  return { ok: true, duplicateRange: null, loaded: true, count: 1000, sourceCount: 1000, kind: 0, shDegree: 0, format: 'PLY',
    selected: 0, visible: 1000, canUndo: false, canRedo: false, revision: 0, contentRevision: 0,
    transaction: false, selectionDraft: false, sceneChanged: false, pending: false, progress: 1,
    center: [0, 0, 0], radius: 1, yUp: false, camera: [0, 0, 0, 0, 0, 3, 100, 45, 0, 0, 1],
    memoryBytes: 144000 + 5000, selectionMapId: null, pendingSelectionMapId: null,
    selectionMapBytes: 0, selectionMapRetainedIds: [], floor: null, filter: null, transformSession: null, opacitySession: null, ...patch };
}
function allocation(value: NativeSummary): NativeAllocationSnapshot {
  return { loaded: value.loaded, kind: value.kind, count: value.count, memoryBytes: value.memoryBytes,
    selectionMapBytes: value.selectionMapBytes, selectionMapRetainedIds: value.selectionMapRetainedIds };
}
type Coverage = { scene: ResourceLease; history?: ResourceLease; work?: ResourceLease; sceneNativeBytes?: number };
type Internals = {
  ledger: ResourceLedger; releaseScene?: ResourceLease; releaseHistory?: ResourceLease; sourceMemory?: NativeHeapAccounting;
  bootstrapClient?: CoreClient; bootstrapMemory?: NativeHeapAccounting;
  retainedGraphicsCredit?: { client: CoreClient; scene: NonNullable<AppController['scene']>; lease: ResourceLease };
  committedGraphicsRecovery?: { client: CoreClient; resolution: OperationResolution; admittedGpuBytes?: number };
  releaseRetainedGraphics(scene: NonNullable<AppController['scene']> | undefined): void;
  editOperation?: { cancel: AbortController; committing: boolean; finished: Promise<void>; tolerance: boolean };
  bindNativeCoverage(client: CoreClient, scene: ResourceLease, history?: ResourceLease, sceneNativeBytes?: number): Coverage;
  executeEditCommand(command: SceneCommand): Promise<unknown>;
  transferEditCoverage(client: CoreClient, history: ResourceLease, work: ResourceLease,
    actualHistoryBytes: number, nextHistoryBytes: number, retirementBytes: number,
    sceneChange?: { bytes: number; nativeBytes: number }): void;
};
class ObservedClient {
  revision = { documentId: 'cc000009-0000-4000-8000-000000000009', sourceGeneration: 1, contentRevision: 0, selectionRevision: 0, draftRevision: 0 };
  operationOwner?: OperationOwner;
  operationResolution?: OperationResolution;
  private operationSequence = 0;
  planner?: (value: NativeAllocationSnapshot) => readonly NativeCoverageUpdate[];
  work?: ResourceLease;
  sequence = 1;
  heapBytes: number;
  current = summary();
  commands: string[] = [];
  transfers: readonly NativeCoverageUpdate[][] = [];
  failEdit = false;
  sceneChanged = false;
  retirementJoin?: Promise<void>;
  dispose = vi.fn();
  constructor(readonly nativeMemory: NativeHeapAccounting) { this.heapBytes = nativeMemory.state.heapBytes; }
  // Delegate through this.command so per-test native/refusal/heap observers
  // continue to own every transaction transition and accounting sample.
  createOperation(): OperationOwner {
    expect(this.operationOwner).toBeUndefined();
    return this.operationOwner = Object.freeze({ version: 1, documentId: this.revision.documentId,
      sourceGeneration: this.revision.sourceGeneration, clientGeneration: 'cc000010-0000-4000-8000-000000000010', operationId: ++this.operationSequence });
  }
  beginOperation(owner: OperationOwner) { expect(owner).toBe(this.operationOwner); return this.command({ command: 'beginTransaction' }); }
  commitOperation(owner: OperationOwner) { expect(owner).toBe(this.operationOwner); return this.command({ command: 'commitTransaction' }); }
  rollbackOperation(owner: OperationOwner) { expect(owner).toBe(this.operationOwner); return this.command({ command: 'rollbackTransaction' }); }
  async finishOperation(owner: OperationOwner) { expect(owner).toBe(this.operationOwner); this.operationOwner = undefined; }
  setNativeCoveragePlanner(planner: ObservedClient['planner']) { this.planner = planner; }
  updateNativeCoverage(updates: readonly NativeCoverageUpdate[]) { this.nativeMemory.updateCoverage(updates); }
  transferNativeCoverage(updates: readonly NativeCoverageUpdate[]) {
    this.transfers = [...this.transfers, updates.map(value => ({ ...value }))];
    this.nativeMemory.transferCoverage(updates, this.current.memoryBytes);
  }
  releaseNativeCoverage(lease: ResourceLease) { this.nativeMemory.releaseCovered(lease); }
  setNativeWork(lease?: ResourceLease) { this.work = lease; }
  assertNativeAdmission() { if (this.nativeMemory.state.ledgerOverageBytes) throw new AdmissionError('Native heap exceeds the scene budget.'); }
  async command(command: SceneCommand) {
    this.commands.push(command.command);
    if (command.command === 'beginTransaction') this.current = summary({ transaction: true, memoryBytes: 144000 + 10000 });
    else if (command.command === 'commitTransaction') this.current = summary({ memoryBytes: 144000 + 15000 });
    else if (command.command === 'rollbackTransaction' || command.command === 'cancelSelection') this.current = summary();
    else {
      if (this.failEdit) throw new Error('Independent edit refusal');
      this.current = summary({ transaction: true, memoryBytes: 144000 + 20000, sceneChanged: this.sceneChanged });
    }
    this.nativeMemory.reconcile({ sequence: ++this.sequence, heapBytes: this.heapBytes }, this.planner?.(allocation(this.current)) ?? []);
    return this.current;
  }
  async stream() { return this.current; }
  async readMasks(consume: (bytes: ArrayBuffer) => void) { consume(new ArrayBuffer(5000)); return this.current; }
  retireNativeMemory = vi.fn(async () => { this.dispose(); await this.retirementJoin; this.nativeMemory.retire(); });
}
function fixture(limit = 256 * MiB, heapBytes = 32 * MiB, options: {
  initial?: NativeSummary; client?: (owner: NativeHeapAccounting) => ObservedClient;
  sceneBytes?: number; maskBytes?: number;
} = {}) {
  const controller = new AppController(), internals = controller as unknown as Internals;
  const initial = options.initial ?? summary(), baseBytes = initial.count * 144;
  const historyBytes = initial.memoryBytes - baseBytes;
  const ledger = new ResourceLedger(limit), remainder = ledger.reserve('source', 2 * P), owner = new NativeHeapAccounting(ledger, remainder);
  owner.observe({ sequence: 1, heapBytes });
  const sceneLease = ledger.reserve('decoded', 8 * MiB), history = ledger.reserve('history', historyBytes);
  owner.updateCoverage([{ lease: sceneLease, nextLeaseBytes: sceneLease.bytes, nativeBytes: baseBytes },
    { lease: history, nextLeaseBytes: history.bytes, nativeBytes: history.bytes }]); owner.activate();
  const client = options.client?.(owner) ?? new ObservedClient(owner), core = client as unknown as CoreClient;
  internals.ledger = ledger; internals.releaseScene = sceneLease; internals.releaseHistory = history; internals.sourceMemory = owner;
  controller.client = core;
  const coverage = internals.bindNativeCoverage(core, sceneLease, history, baseBytes);
  const masks = { allocationBytes: options.maskBytes ?? 2000, publish: vi.fn(() => ({ destroy: vi.fn() })), dispose: vi.fn() };
  const scene = { kind: 'gaussian', setDuplicateRange: vi.fn(), allocationBytes: options.sceneBytes ?? 100000, stageMasks: vi.fn(async () => masks), dispose: vi.fn(async () => {}) };
  const renderer = { lost: false, device: { queue: { onSubmittedWorkDone: vi.fn(async () => {}) } }, dispose: vi.fn(),
    setHistogramEnabled: vi.fn(), resetHistogram: vi.fn(),
    allocateScene: vi.fn(async () => ({ kind: 'gaussian', setDuplicateRange: vi.fn(), allocationBytes: options.sceneBytes ?? 100000, upload: vi.fn(), masks: vi.fn(), dispose: vi.fn(async () => {}) })) };
  controller.scene = scene as unknown as NonNullable<AppController['scene']>;
  controller.renderer = renderer as unknown as NonNullable<AppController['renderer']>;
  setApp({ summary: initial, busy: false, error: null, sourceName: 'fixture.ply' });
  return { controller, internals, ledger, owner, remainder, sceneLease, history, client, core, coverage, masks, scene, renderer };
}
beforeEach(() => {
  vi.stubGlobal('document', { hidden: true, title: '' });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  setApp({ busy: false, error: null, summary: null, selectionRecovery: 'idle', operationRecovery: 'idle', pendingSelectionCount: 0,
    navigationPrompt: false, navigationIntent: null, memoryOverageBytes: 0,
    grade: [...NEUTRAL_COLOR], appliedGrade: [...NEUTRAL_COLOR], colorSession: null, colorSelectedOnly: false, gradeRevision: 0 });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('controller native ownership', () => {
  it.each([
    { direction: 'growth', command: 'redo' as const, oldCount: 1000, targetCount: 2000, oldGpuBytes: 100000, targetGpuBytes: 132000 },
    { direction: 'shrink', command: 'undo' as const, oldCount: 2000, targetCount: 1000, oldGpuBytes: 132000, targetGpuBytes: 100000 },
  ])('retains the exact old GPU credit after committed $direction loses its acknowledgement', async test => {
    // This transport simulation accepts an identified native candidate before
    // losing its acknowledgement. Receipt topology comes from the same model
    // as the command/stream and actual native-coverage accounting observations.
    const historyBytes = 200000;
    const initial = summary({ count: test.oldCount, sourceCount: test.oldCount, visible: test.oldCount,
      memoryBytes: test.oldCount * 144 + historyBytes, canUndo: test.command === 'undo', canRedo: test.command === 'redo',
      duplicateRange: test.oldCount === 2000 ? { first: 1000, count: 1000 } : null });
    const candidate = summary({ count: test.targetCount, sourceCount: test.targetCount, visible: test.targetCount,
      selected: test.targetCount === 2000 ? 1000 : 0, duplicateRange: test.targetCount === 2000 ? { first: 1000, count: 1000 } : null,
      memoryBytes: test.targetCount * 144 + historyBytes, revision: 1, contentRevision: 1, transaction: true, sceneChanged: true,
      canUndo: test.command === 'redo', canRedo: test.command === 'undo' });
    const terminal = { ...candidate, transaction: false, sceneChanged: false };
    const f = fixture(256 * MiB, 32 * MiB, { initial, sceneBytes: test.oldGpuBytes }), oldSceneBytes = f.sceneLease.bytes;
    f.client.current = initial;
    const oldGpuJoin = deferred(); f.scene.dispose.mockImplementation(() => oldGpuJoin.promise);
    const staged = { kind: 'gaussian' as const, setDuplicateRange: vi.fn(), allocationBytes: test.targetGpuBytes,
      upload: vi.fn(), masks: vi.fn(), dispose: vi.fn(async () => {}) };
    f.renderer.allocateScene.mockResolvedValue(staged);
    vi.spyOn(f.client, 'command').mockImplementation(async command => {
      f.client.commands.push(command.command);
      if (command.command === 'beginTransaction') f.client.current = { ...initial, transaction: true };
      else if (command.command === test.command) {
        f.client.current = candidate; f.client.revision = { ...f.client.revision, contentRevision: 1, selectionRevision: 1 };
      } else if (command.command === 'commitTransaction') f.client.current = terminal;
      else throw new Error('A committed candidate must not be rolled back.');
      f.owner.reconcile({ sequence: ++f.client.sequence, heapBytes: f.client.heapBytes }, f.client.planner!(allocation(f.client.current)));
      return f.client.current;
    });
    const commit = f.client.commitOperation.bind(f.client);
    vi.spyOn(f.client, 'commitOperation').mockImplementation(async owner => {
      const accepted = await commit(owner);
      f.client.operationResolution = Object.freeze({ receipt: validateOperationReceipt({ version: 2, owner, outcome: 'committed',
        before: operationSnapshot(initial), terminal: operationSnapshot(accepted) }, owner), summary: accepted });
      throw new Error('Committed acknowledgement was lost.');
    });
    const rollback = vi.spyOn(f.client, 'rollbackOperation'), release = vi.spyOn(f.client, 'releaseNativeCoverage');
    await expect(f.internals.executeEditCommand({ command: test.command })).resolves.toBe(false);
    expect(f.client.commands).toEqual(['beginTransaction', test.command, 'commitTransaction']); expect(rollback).not.toHaveBeenCalled();
    expect(f.client.operationOwner).toBeUndefined(); expect(f.client.work).toBeUndefined(); expect(f.coverage.work).toBeUndefined();
    const proof = f.client.operationResolution!, recovery = f.internals.committedGraphicsRecovery!, retained = f.internals.retainedGraphicsCredit!;
    expect(proof.receipt.version).toBe(2); expect(proof.receipt.outcome).toBe('committed');
    expect(proof.receipt.before).toEqual(operationSnapshot(initial)); expect(proof.receipt.terminal).toEqual(operationSnapshot(terminal));
    expect(recovery.client).toBe(f.core); expect(recovery.resolution).toBe(proof); expect(recovery.admittedGpuBytes).toBe(test.targetGpuBytes);
    expect(retained.client).toBe(f.core); expect(retained.scene).toBe(f.scene); expect(retained.lease.bytes).toBe(test.oldGpuBytes);
    expect(f.ledger.owns(retained.lease, 'work')).toBe(true); expect(f.controller.scene).toBe(f.scene);
    const expectedSceneBytes = oldSceneBytes + (test.targetCount - test.oldCount) * 144 + test.targetGpuBytes - test.oldGpuBytes;
    expect(f.sceneLease.bytes).toBe(expectedSceneBytes); expect(f.coverage.sceneNativeBytes).toBe(test.targetCount * 144);
    expect(f.history.bytes).toBe(historyBytes); expect(f.owner.state.coveredBytes).toBe(terminal.memoryBytes);
    expect(useApp.getState()).toMatchObject({ summary: terminal, operationRecovery: 'required', operationRecoveryCommitted: true });
    expect(staged.dispose).toHaveBeenCalledOnce(); expect(f.scene.dispose).not.toHaveBeenCalled();
    f.internals.releaseRetainedGraphics(staged as unknown as NonNullable<AppController['scene']>);
    expect(release).not.toHaveBeenCalled(); expect(f.ledger.owns(retained.lease)).toBe(true);
    const retiring = f.scene.dispose(); await tick();
    expect(f.ledger.owns(retained.lease)).toBe(true); expect(f.sceneLease.bytes).toBe(expectedSceneBytes);
    oldGpuJoin.resolve(); await retiring;
    const beforeRelease = f.ledger.usage.bytes;
    f.internals.releaseRetainedGraphics(f.scene as unknown as NonNullable<AppController['scene']>);
    expect(release).toHaveBeenCalledOnce(); expect(release).toHaveBeenCalledWith(retained.lease); expect(f.ledger.owns(retained.lease)).toBe(false);
    expect(f.ledger.usage.bytes).toBe(beforeRelease - test.oldGpuBytes); expect(f.internals.retainedGraphicsCredit).toBeUndefined();
    f.internals.releaseRetainedGraphics(f.scene as unknown as NonNullable<AppController['scene']>);
    expect(release).toHaveBeenCalledTimes(1); expect(f.sceneLease.bytes).toBe(expectedSceneBytes); expect(f.scene.dispose).toHaveBeenCalledOnce();
    f.owner.retire(); f.sceneLease(); f.history(); expect(f.ledger.usage.bytes).toBe(0);
  });
  it('keeps appended records under work until native and GPU growth publish, then restores the smaller owners on rollback', () => {
    const f = fixture(), initialAdmission = f.ledger.usage.bytes, sceneBytes = f.sceneLease.bytes;
    const nativeGrowth = 1000 * 144, gpuGrowth = 32000, retirementBytes = 100000;
    const work = f.ledger.reserve('work', nativeGrowth + gpuGrowth + retirementBytes);f.coverage.work = work;
    f.owner.updateCoverage([{ lease: work, nextLeaseBytes: work.bytes, nativeBytes: 0 }]);
    f.client.current = summary({ count: 2000, sourceCount: 2000, visible: 2000, memoryBytes: 2000 * 144 + 5000 });
    const planned = f.client.planner!(allocation(f.client.current));
    expect(planned.map(row => row.nativeBytes)).toEqual([144000, 5000, 144000]);
    expect(planned[0].nextLeaseBytes).toBe(sceneBytes);expect(f.coverage.sceneNativeBytes).toBe(144000);
    f.owner.reconcile({ sequence: ++f.client.sequence, heapBytes: f.client.heapBytes }, planned);
    expect(f.sceneLease.bytes - planned[0].nativeBytes).toBe(sceneBytes - 144000);
    const beforePublish = f.ledger.usage.bytes;
    f.internals.transferEditCoverage(f.core, f.history, work, 5000, 5000, retirementBytes,
      { bytes: sceneBytes + nativeGrowth + gpuGrowth, nativeBytes: 288000 });
    expect(f.client.transfers.at(-1)!.map(row => row.nativeBytes)).toEqual([288000, 5000, 0]);
    expect(f.sceneLease.bytes - 288000).toBe(sceneBytes - 144000 + gpuGrowth);
    expect(f.coverage.sceneNativeBytes).toBe(288000);expect(work.bytes).toBe(retirementBytes);
    expect(f.owner.state.coveredBytes).toBe(293000);expect(f.ledger.usage.bytes).toBe(beforePublish);
    f.client.current = summary();
    f.owner.reconcile({ sequence: ++f.client.sequence, heapBytes: f.client.heapBytes }, f.client.planner!(allocation(f.client.current)));
    const beforeRollback = f.ledger.usage.bytes;
    f.internals.transferEditCoverage(f.core, f.history, work, 5000, 5000, 0, { bytes: sceneBytes, nativeBytes: 144000 });
    expect(f.client.transfers.at(-1)!.map(row => row.nativeBytes)).toEqual([144000, 5000, 0]);
    expect(f.coverage.sceneNativeBytes).toBe(144000);expect(f.sceneLease.bytes).toBe(sceneBytes);
    expect(f.owner.state.coveredBytes).toBe(149000);expect(f.ledger.usage.bytes).toBe(beforeRollback);
    f.owner.releaseCovered(work);f.coverage.work = undefined;
    expect(f.ledger.usage.bytes).toBe(initialAdmission);f.owner.retire();f.sceneLease();f.history();
  });
  it('updates native scene coverage even when GPU shrink offsets native growth to the same total lease size', () => {
    const f = fixture(), sceneBytes = f.sceneLease.bytes, work = f.ledger.reserve('work', 144000);f.coverage.work = work;
    f.owner.updateCoverage([{ lease: work, nextLeaseBytes: work.bytes, nativeBytes: 0 }]);
    f.client.current = summary({ count: 2000, sourceCount: 2000, visible: 2000, memoryBytes: 293000 });
    f.owner.reconcile({ sequence: ++f.client.sequence, heapBytes: f.client.heapBytes }, f.client.planner!(allocation(f.client.current)));
    const before = f.ledger.usage.bytes;
    f.internals.transferEditCoverage(f.core, f.history, work, 5000, 5000, 0, { bytes: sceneBytes, nativeBytes: 288000 });
    expect(f.client.transfers.at(-1)!.map(row => row.nativeBytes)).toEqual([288000, 5000, 0]);
    expect(f.sceneLease.bytes).toBe(sceneBytes);expect(f.coverage.sceneNativeBytes).toBe(288000);
    expect(f.client.planner!(allocation(f.client.current)).map(row => row.nativeBytes)).toEqual([288000, 5000, 0]);
    expect(f.ledger.usage.bytes).toBe(before);f.owner.retire();work();f.sceneLease();f.history();
  });
  it('covers actual scene/history/work native bytes while excluding map and mixed GPU admission', () => {
    const f = fixture(), work = f.ledger.reserve('work', MiB), map = f.ledger.reserve('work', 2000);
    f.owner.updateCoverage([{ lease: map, nextLeaseBytes: map.bytes, nativeBytes: 2000 },
      { lease: work, nextLeaseBytes: work.bytes, nativeBytes: 0 }]); f.coverage.work = work;
    const value = summary({ memoryBytes: 144000 + 12000 + 2000, selectionMapBytes: 2000 });
    f.owner.reconcile({ sequence: 2, heapBytes: f.client.heapBytes }, f.client.planner!(allocation(value)));
    expect(f.owner.state.coveredBytes).toBe(144000 + 12000 + 2000);
    expect(f.owner.state.remainderBytes).toBe(f.client.heapBytes - 158000);
    expect(f.sceneLease.bytes).toBe(8 * MiB); expect(work.bytes).toBe(MiB); expect(f.history.bytes).toBe(5000);
    f.owner.retire(); work(); map(); f.sceneLease(); f.history();
  });
  it('bounds coverage by admitted owners and covers geometry independently of its GPU capacity', () => {
    const f = fixture(), work = f.ledger.reserve('work', 1000); f.coverage.work = work;
    f.owner.updateCoverage([{ lease: work, nextLeaseBytes: work.bytes, nativeBytes: 0 }]);
    f.owner.reconcile({ sequence: 2, heapBytes: f.client.heapBytes }, f.client.planner!(allocation(summary({ memoryBytes: 144000 + 20000 }))));
    expect(f.owner.state.coveredBytes).toBe(144000 + 5000 + 1000);
    f.owner.reconcile({ sequence: 3, heapBytes: f.client.heapBytes }, f.client.planner!(allocation(summary({ kind: 2, memoryBytes: 321000 }))));
    expect(f.owner.state.coveredBytes).toBe(321000); expect(f.sceneLease.bytes).toBe(8 * MiB);
    f.owner.retire(); work(); f.sceneLease(); f.history();
  });
  it('moves transaction native work to history and retains GPU work until the old scene joins', async () => {
    const f = fixture(), gpu = deferred(); f.client.sceneChanged = true;
    f.scene.dispose.mockImplementation(() => gpu.promise);
    const editing = f.internals.executeEditCommand({ command: 'transform', matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1] });
    await tick();
    expect(f.client.commands).toEqual(['beginTransaction', 'transform', 'commitTransaction']);
    expect(f.history.bytes).toBe(15000); expect(f.owner.state.coveredBytes).toBe(144000 + 15000);
    expect(f.client.work).toBeDefined(); expect(f.ledger.usage.allocations).toBe(4);
    expect(f.client.transfers[0].map(value => value.nativeBytes)).toEqual([144000, 20000, 0]);
    gpu.resolve(); await expect(editing).resolves.toBe(true);
    expect(f.client.work).toBeUndefined(); expect(f.ledger.usage.allocations).toBe(3);
    expect(f.owner.state.remainderBytes).toBe(32 * MiB - 159000);
    f.owner.retire(); f.sceneLease(); f.history();
  });
  it('rolls a refused edit back without losing its original history owner or retaining work credit', async () => {
    const f = fixture(); f.client.failEdit = true;
    await expect(f.internals.executeEditCommand({ command: 'selectAll' })).resolves.toBe(false);
    expect(f.client.commands).toEqual(['beginTransaction', 'selectAll', 'rollbackTransaction']);
    expect(f.history.bytes).toBe(5000); expect(f.owner.state.coveredBytes).toBe(149000);
    expect(f.client.work).toBeUndefined(); expect(f.ledger.usage.allocations).toBe(3);
    expect(useApp.getState().busy).toBe(false); expect(useApp.getState().error).toBe('Independent edit refusal');
    f.owner.retire(); f.sceneLease(); f.history();
  });
  it('redistributes the admitted tiny-scene peak through actual native selection, grading, Undo and Redo', async () => {
    // Exact named artifacts only. Native history/deque/COW sizes and summary
    // changes come from the shipping module, independently of controller math.
    const url = pathToFileURL(resolve('public/wasm/splatview-core.mjs')).href;
    const factory = (await import(/* @vite-ignore */ url) as { default: ModuleFactory }).default;
    const module = await factory({ wasmBinary: new Uint8Array(await readFile(resolve('public/wasm/splatview-core.wasm'))) });
    const decode = (pointer: number) => {
      const value = JSON.parse(module.UTF8ToString(pointer)) as NativeSummary;
      if (!value.ok) throw new Error(value.error); return value;
    };
    const nativeCommand = (value: SceneCommand) => {
      const bytes = new TextEncoder().encode(JSON.stringify(value) + '\0'), pointer = module._malloc(bytes.byteLength);
      try {
        module.HEAPU8.set(bytes, pointer);
        let result = decode(module._sv_command(pointer));
        for (let steps = 0; result.pending; steps++) {
          if (steps > 10) throw new Error('Tiny native edit did not finish.');
          result = decode(module._sv_step(65536));
        }
        return result;
      } finally { module._free(pointer); }
    };
    const data = gaussianPly(0), pointer = module._malloc(data.byteLength);
    let initial!: NativeSummary;
    try { module.HEAPU8.set(data, pointer); initial = decode(module._sv_open(pointer, data.byteLength, 0, 100, 32 * MiB)); }
    finally { module._free(pointer); }
    expect(initial).toMatchObject({ count: 3, shDegree: 0, kind: 0 });
    const f = fixture(256 * MiB, module.HEAPU8.byteLength, { initial,
      // SH0: 3*(packed48+GPU72+CPUstate1), two 128-byte prefix
      // levels, 128-byte bin buffers, and eight 16-byte uniforms.
      sceneBytes: 875, maskBytes: 15,
      client(owner) { const client = new ObservedClient(owner); client.current = initial; return client; },
    });
    vi.spyOn(f.client, 'command').mockImplementation(async command => {
      f.client.commands.push(command.command); f.client.current = nativeCommand(command);
      f.client.heapBytes = module.HEAPU8.byteLength;
      f.owner.reconcile({ sequence: ++f.client.sequence, heapBytes: f.client.heapBytes },
        f.client.planner!(allocation(f.client.current)));
      return f.client.current;
    });
    vi.spyOn(f.client, 'readMasks').mockImplementation(async consume => {
      const pointer = module._sv_states_ptr();
      consume(module.HEAPU8.slice(pointer, pointer + f.client.current.count).buffer);
      return f.client.current;
    });
    const transfer = f.ledger.transferRetainedNativeCoverage.bind(f.ledger), totals: number[] = [];
    vi.spyOn(f.ledger, 'transferRetainedNativeCoverage').mockImplementation((remainder, bytes, updates) => {
      const before = f.ledger.usage.bytes; transfer(remainder, bytes, updates);
      expect(f.ledger.usage.bytes).toBe(before); totals.push(before);
    });
    const nativeBytes = () => module.HEAPU8.slice(module._sv_scene_ptr(), module._sv_scene_ptr() + 3 * 144);
    try {
      await expect(f.internals.executeEditCommand({ command: 'selectAll' })).resolves.toBe(true);
      expect(f.client.current.selected).toBe(3);
      const original = nativeBytes(), values = [...NEUTRAL_COLOR], gpu = deferred(); values[0] = Math.fround(1.2);
      f.scene.dispose.mockImplementation(() => gpu.promise);
      await expect(f.internals.executeEditCommand({ command: 'grade', values, selectedOnly: true })).resolves.toBe(true);
      expect(f.client.commands.at(-1)).toBe('commitTransaction');
      expect(f.client.work).toBeUndefined(); expect(f.ledger.usage.allocations).toBe(3);
      expect(f.renderer.allocateScene).not.toHaveBeenCalled(); expect(f.scene.dispose).not.toHaveBeenCalled();
      expect(f.controller.scene).toBe(f.scene); expect(useApp.getState().grade).toEqual(values);
      const first = nativeBytes(); expect(first).not.toEqual(original);
      values[0] = 1.5;
      await expect(f.internals.executeEditCommand({ command: 'grade', values, selectedOnly: true })).resolves.toBe(true);
      const second = nativeBytes(); expect(second).not.toEqual(first);
      expect(f.renderer.allocateScene).not.toHaveBeenCalled(); expect(f.scene.dispose).not.toHaveBeenCalled();
      const ending = f.internals.executeEditCommand({ command: 'endColor' }); await tick();
      expect(f.client.current.colorSession).toBeNull(); expect(f.scene.dispose).toHaveBeenCalledTimes(1);
      expect(f.client.work).toBeDefined(); expect(f.client.work!.bytes).toBeGreaterThanOrEqual(875);
      expect(f.ledger.usage.allocations).toBe(4); expect(f.renderer.allocateScene).toHaveBeenCalledTimes(1);
      gpu.resolve(); await expect(ending).resolves.toBe(true);
      expect(useApp.getState().grade).toEqual(NEUTRAL_COLOR); expect(f.client.work).toBeUndefined();
      await expect(f.internals.executeEditCommand({ command: 'undo' })).resolves.toBe(true);
      expect(nativeBytes()).toEqual(first); expect(f.client.current.canRedo).toBe(true);
      await expect(f.internals.executeEditCommand({ command: 'redo' })).resolves.toBe(true);
      expect(nativeBytes()).toEqual(second); expect(f.client.current.canRedo).toBe(false);
      expect(totals).toHaveLength(6); expect(f.ledger.usage.allocations).toBe(3);
      expect(f.owner.state.coveredBytes).toBe(f.client.current.memoryBytes);
      expect(f.history.bytes).toBe(f.client.current.memoryBytes - 3 * 144);
      expect(f.owner.state.remainderBytes).toBe(module.HEAPU8.byteLength - f.client.current.memoryBytes);
      expect(useApp.getState().error).toBeNull();
    } finally { f.owner.retire(); f.sceneLease(); f.history(); }
  });
  it.each([
    { actual: 9000, nextHistory: 9000, expectedWork: 0, expectedRemainderChange: -4000 },
    { actual: 5000, nextHistory: 3000, expectedWork: 0, expectedRemainderChange: 2000 },
  ])('keeps aggregate credit fixed when a handoff changes native C and R: $actual → $nextHistory', test => {
    const f = fixture(), work = f.ledger.reserve('work', 0);
    f.coverage.work = work; f.owner.updateCoverage([{ lease: work, nextLeaseBytes: 0, nativeBytes: 0 }]);
    f.client.current = summary({ memoryBytes: 144000 + test.actual });
    f.owner.reconcile({ sequence: ++f.client.sequence, heapBytes: f.client.heapBytes }, f.client.planner!(allocation(f.client.current)));
    const before = f.ledger.usage.bytes, remainder = f.remainder.bytes;
    Object.defineProperty(f.ledger, 'limit', { value: before - 1 }); expect(f.ledger.overageBytes).toBe(1);
    f.internals.transferEditCoverage(f.core, f.history, work, test.actual, test.nextHistory, 0);
    expect(f.ledger.usage.bytes).toBe(before); expect(f.history.bytes).toBe(test.nextHistory);
    expect(work.bytes).toBe(test.expectedWork); expect(f.remainder.bytes - remainder).toBe(test.expectedRemainderChange);
    expect(f.owner.state.coveredBytes).toBe(144000 + Math.min(test.actual, test.nextHistory));
    f.owner.retire(); work(); f.sceneLease(); f.history();
  });
  it('restores larger history after a post-transfer commit refusal without growing aggregate admission', async () => {
    const f = fixture();
    vi.spyOn(f.client, 'command').mockImplementation(async command => {
      f.client.commands.push(command.command);
      if (command.command === 'commitTransaction') throw new Error('Independent commit refusal');
      f.client.current = summary({ transaction: command.command !== 'rollbackTransaction',
        memoryBytes: 144000 + (command.command === 'rollbackTransaction' ? 5000 : 2000) });
      f.owner.reconcile({ sequence: ++f.client.sequence, heapBytes: f.client.heapBytes }, f.client.planner!(allocation(f.client.current)));
      return f.client.current;
    });
    const transfer = f.ledger.transferRetainedNativeCoverage.bind(f.ledger), totals: number[] = [];
    vi.spyOn(f.ledger, 'transferRetainedNativeCoverage').mockImplementation((remainder, bytes, updates) => {
      const before = f.ledger.usage.bytes; transfer(remainder, bytes, updates);
      expect(f.ledger.usage.bytes).toBe(before); totals.push(before);
    });
    await expect(f.internals.executeEditCommand({ command: 'selectAll' })).resolves.toBe(false);
    expect(f.client.commands).toEqual(['beginTransaction', 'selectAll', 'commitTransaction', 'rollbackTransaction']);
    expect(totals).toHaveLength(2); expect(f.history.bytes).toBe(5000); expect(f.client.work).toBeUndefined();
    expect(f.ledger.usage.allocations).toBe(3); expect(f.owner.state.coveredBytes).toBe(149000);
    expect(useApp.getState().error).toBe('Independent commit refusal'); expect(f.controller.editingAvailable).toBe(true);
    f.owner.retire(); f.sceneLease(); f.history();
  });
  it('refuses a transfer whose existing credit cannot cover actual GPU retirement without changing any owner', () => {
    const f = fixture(), work = f.ledger.reserve('work', 1000); f.coverage.work = work;
    f.owner.updateCoverage([{ lease: work, nextLeaseBytes: 1000, nativeBytes: 0 }]);
    f.client.current = summary({ memoryBytes: 144000 + 6000 });
    f.owner.reconcile({ sequence: ++f.client.sequence, heapBytes: f.client.heapBytes }, f.client.planner!(allocation(f.client.current)));
    const state = f.owner.state, usage = f.ledger.usage;
    expect(() => f.internals.transferEditCoverage(f.core, f.history, work, 6000, 6000, 1)).toThrow(/GPU retirement/);
    expect(f.owner.state).toEqual(state); expect(f.ledger.usage).toEqual(usage);
    expect(f.history.bytes).toBe(5000); expect(work.bytes).toBe(1000); expect(f.client.transfers).toEqual([]);
    f.owner.retire(); work(); f.sceneLease(); f.history();
  });
  it('permits native cancellation under measured overage without allocating or claiming a restored GPU selection', async () => {
    const f = fixture(48 * MiB); f.client.heapBytes = 64 * MiB;
    f.owner.reconcile({ sequence: ++f.client.sequence, heapBytes: f.client.heapBytes }, f.client.planner!(allocation(summary())));
    const reserve = vi.spyOn(f.ledger, 'reserve'); expect(f.ledger.overageBytes).toBeGreaterThan(0);
    await expect(f.internals.executeEditCommand({ command: 'cancelSelection' })).resolves.toBe(false);
    expect(f.client.commands).toEqual(['cancelSelection']); expect(reserve).not.toHaveBeenCalled();
    expect(f.scene.stageMasks).not.toHaveBeenCalled(); expect(f.masks.publish).not.toHaveBeenCalled();
    expect(f.owner.state.retired).toBe(false); expect(f.controller.editingAvailable).toBe(false);
    await expect(f.internals.executeEditCommand({ command: 'selectAll' })).resolves.toBe(false);
    expect(f.client.commands).toEqual(['cancelSelection']); expect(reserve).not.toHaveBeenCalled();
    f.owner.retire(); f.sceneLease(); f.history();
  });
  it('keeps the module remainder through scene, edit and source-read retirement joins', async () => {
    const f = fixture(), gpu = deferred(), edit = deferred(), read = deferred();
    f.scene.dispose.mockImplementation(() => gpu.promise); f.client.retirementJoin = read.promise;
    f.internals.editOperation = { cancel: new AbortController(), committing: false, finished: edit.promise, tolerance: false };
    f.controller.dispose(); f.controller.dispose(); await tick();
    expect(f.client.dispose).toHaveBeenCalled(); expect(f.client.retireNativeMemory).not.toHaveBeenCalled();
    expect(f.ledger.owns(f.remainder)).toBe(true);
    gpu.resolve(); await tick(); expect(f.client.retireNativeMemory).not.toHaveBeenCalled();
    edit.resolve(); await tick(); expect(f.client.retireNativeMemory).toHaveBeenCalledOnce();
    expect(f.ledger.owns(f.remainder)).toBe(true); expect(f.ledger.owns(f.sceneLease)).toBe(true);
    read.resolve(); await tick();
    expect(f.owner.state.retired).toBe(true); expect(f.ledger.usage.bytes).toBe(0); expect(f.ledger.usage.allocations).toBe(0);
  });
});
