import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppController } from '../src/app/controller';
import { setApp, useApp } from '../src/app/store';
import { NEUTRAL_COLOR, type NativeSummary, type SceneCommand } from '../src/document/types';
import type { ColorSessionSummary } from '../src/document/colorProtocol';
import { colorValues, estimateColorWorkBytes, isAutoColorMethod, sameColorValues } from '../src/document/colorSession';
import { AdmissionError, estimateSceneBytes, MiB, type ResourceLease, type ResourceLedger } from '../src/document/resources';
import type { OperationOwner } from '../src/document/operationProtocol';
import type { Revision } from '../src/document/types';

const initial = useApp.getState();
const warm = [...NEUTRAL_COLOR]; warm[0] = Math.fround(1.2);
const warmer = [...NEUTRAL_COLOR]; warmer[0] = Math.fround(1.4);
const baseSummary: NativeSummary = {
  ok: true, duplicateRange: null, loaded: true, count: 3, sourceCount: 3, shDegree: 0, format: 'ply', kind: 0,
  selected: 1, visible: 3, canUndo: true, canRedo: true, revision: 1, contentRevision: 0,
  transaction: false, selectionDraft: false, sceneChanged: false, pending: false, progress: 1,
  center: [0, 0, 0], radius: 1, yUp: false, camera: [], memoryBytes: 500,
  selectionMapId: null, pendingSelectionMapId: null, selectionMapBytes: 0, selectionMapRetainedIds: [],
  floor: null, filter: null, transformSession: null, opacitySession: null,
};
function session(values = warm): ColorSessionSummary {
  return { version: 1, active: true, sessionId: 1, baseId: 2, epochId: 3,
    selectedOnly: true, values: [...values], applied: [...values], pending: false };
}
beforeEach(() => {
  setApp({ ...initial, ready: true, busy: false, rendererState: 'ready', summary: { ...baseSummary },
    grade: [...NEUTRAL_COLOR], appliedGrade: [...NEUTRAL_COLOR], colorSession: null,
    colorSelectedOnly: false, gradeRevision: 0, settingsOpen: false, exportOpen: false,
    outputPending: false, navigationPrompt: false, pendingSelectionCount: 0, selectionDragging: false }, true);
  vi.stubGlobal('document', { title: '', hidden: true });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); setApp(initial, true); });

// Preserve this fixture's existing command/history model at the typed client
// boundary. Lost acknowledgements and durable receipts have separate fixtures.
function ownedTransactions<T extends { revision: Revision; command(command: SceneCommand): Promise<NativeSummary> }>(client: T) {
  let sequence = 0, active: OperationOwner | undefined;
  const check = (owner: OperationOwner) => { expect(owner).toBe(active); };
  const result = Object.assign(client, {
    createOperation: vi.fn(() => {
      expect(active).toBeUndefined();
      active = Object.freeze({ version: 1 as const, documentId: client.revision.documentId,
        sourceGeneration: client.revision.sourceGeneration, clientGeneration: 'cc000001-0000-4000-8000-000000000001', operationId: ++sequence });
      return active;
    }),
    beginOperation: vi.fn((owner: OperationOwner) => { check(owner); return client.command({ command: 'beginTransaction' }); }),
    commitOperation: vi.fn((owner: OperationOwner) => { check(owner); return client.command({ command: 'commitTransaction' }); }),
    rollbackOperation: vi.fn((owner: OperationOwner) => { check(owner); return client.command({ command: 'rollbackTransaction' }); }),
    finishOperation: vi.fn(async (owner: OperationOwner) => { check(owner); active = undefined; }),
  });
  Object.defineProperty(result, 'operationOwner', { get: () => active }); return result;
}

function fixture() {
  const controller = new AppController();
  let native: NativeSummary = { ...baseSummary }, checkpoint: NativeSummary | undefined;
  let failStream = false, onGrade: (() => void) | undefined, onStream: (() => void) | undefined, manualNoop = false;
  const base = { kind: 'gaussian', setDuplicateRange: vi.fn(), count: 3, degree: 0, sourceRevision: 1, allocationBytes: 800,
    upload: vi.fn(async () => {}), masks: vi.fn(), stageMasks: vi.fn(async () => ({ allocationBytes: 27, retirementBytes: 15,
      retirementBuffers: [], publish: vi.fn(), dispose: vi.fn() })), dispose: vi.fn(async () => {}) };
  const staged = { ...base, upload: vi.fn(async () => {}), masks: vi.fn(), dispose: vi.fn(async () => {}) };
  const renderer = { lost: false, device: { queue: { onSubmittedWorkDone: vi.fn(async () => {}) } },
    allocateScene: vi.fn(async () => staged) };
  const command = vi.fn(async (request: SceneCommand) => {
    if (request.command === 'beginTransaction') { checkpoint = { ...native }; native = { ...native, transaction: true }; }
    else if (request.command === 'commitTransaction') { checkpoint = undefined; native = { ...native, transaction: false, sceneChanged: false }; }
    else if (request.command === 'rollbackTransaction') {
      native = checkpoint!; checkpoint = undefined;
      if (native.colorSession) native = { ...native, colorSession: { ...native.colorSession, epochId: native.colorSession.epochId + 1 } };
    }
    else if (request.command === 'grade' || request.command === 'autoColor') {
      if (manualNoop && request.command === 'grade') return native;
      const values = request.values as number[];
      native = { ...native, sceneChanged: true, contentRevision: native.contentRevision + 1,
        revision: native.revision + 1, canRedo: false, memoryBytes: 950, colorSession: session(values) };
      onGrade?.();
    } else if (request.command === 'endColor') native = { ...native, colorSession: null };
    return native;
  });
  const stream = vi.fn(async (chunk: (first: number, count: number, bytes: ArrayBuffer) => Promise<void>, masks: (bytes: ArrayBuffer) => void) => {
    if (failStream) throw new Error('Injected candidate upload failure');
    onStream?.();
    await chunk(0, 3, new ArrayBuffer(144)); masks(new ArrayBuffer(3)); return native;
  });
  const client = ownedTransactions({ command, stream, readMasks: vi.fn(async (masks: (bytes: ArrayBuffer) => void) => {
    masks(new Uint8Array([1,0,0]).buffer); return native;
  }), revision: { documentId: 'cc000002-0000-4000-8000-000000000002', sourceGeneration: 1, contentRevision: 0,
    selectionRevision: 0, draftRevision: 0 }, assertNativeAdmission: vi.fn(), updateNativeCoverage: vi.fn(),
    transferNativeCoverage: vi.fn(), setNativeWork: vi.fn(), releaseNativeCoverage: vi.fn((lease: () => void) => lease()) });
  controller.client = client as unknown as NonNullable<AppController['client']>;
  controller.scene = base as unknown as NonNullable<AppController['scene']>;
  controller.renderer = renderer as unknown as NonNullable<AppController['renderer']>;
  vi.spyOn(controller, 'invalidate').mockImplementation(() => {});
  const internal = controller as unknown as { settleColorSession(): Promise<boolean>; selection?: unknown;
    releasedSelections: unknown[]; releaseHistory?: ResourceLease; colorDisplay?: { epochId: number }; ledger: ResourceLedger };
  return { controller, internal, base, staged, renderer, client,
    failStream: () => { failStream = true; }, noop: () => { manualNoop = true; },
    onGrade: (callback: () => void) => { onGrade = callback; }, onStream: (callback: () => void) => { onStream = callback; }, native: () => native };
}

describe('absolute color display ownership', () => {
  it('bakes native content while keeping the original GPU base and absolute slider values', async () => {
    const value = fixture(); value.controller.setGrade(warm);
    expect(await value.controller.commitGrade()).toBe(true);
    expect(value.controller.scene).toBe(value.base);
    expect(value.renderer.allocateScene).not.toHaveBeenCalled(); expect(value.client.stream).not.toHaveBeenCalled();
    expect(value.base.stageMasks).toHaveBeenCalledOnce(); expect(value.base.dispose).not.toHaveBeenCalled();
    expect(value.client.readMasks.mock.calls).toHaveLength(2);
    expect(useApp.getState().grade).toEqual(warm); expect(useApp.getState().appliedGrade).toEqual(warm);
    expect(value.controller.colorPending).toBe(false); expect(useApp.getState().colorSession?.baseId).toBe(2);
  });
  it('acknowledges an older manual bake without discarding a newer preview', async () => {
    const value = fixture(); value.controller.setGrade(warm);
    value.onGrade(() => value.controller.setGrade(warmer));
    expect(await value.controller.commitGrade()).toBe(true);
    expect(useApp.getState().grade).toEqual(warmer); expect(useApp.getState().appliedGrade).toEqual(warm);
    expect(value.controller.colorPending).toBe(true); expect(value.renderer.allocateScene).not.toHaveBeenCalled();
  });
  it('acknowledges float32 decimal values without creating a second pending bake', async () => {
    const value = fixture(), decimal = [...NEUTRAL_COLOR]; decimal[0] = 1.2; decimal[5] = .7333333333333333;
    value.controller.setGrade(decimal);
    expect(useApp.getState().grade[0]).toBe(Math.fround(decimal[0]));
    expect(useApp.getState().grade[5]).toBe(Math.fround(decimal[5]));
    expect(await value.controller.commitGrade()).toBe(true); expect(value.controller.colorPending).toBe(false);
    expect(await value.controller.commitGrade()).toBe(false);
    expect(value.client.command.mock.calls.filter(([request]) => request.command === 'grade')).toHaveLength(1);
    expect(value.native().contentRevision).toBe(1);
    expect(sameColorValues(decimal, useApp.getState().appliedGrade)).toBe(true);
  });
  it('stages baked content only at session end and retires the base after the fence', async () => {
    const value = fixture(); value.controller.setGrade(warm); await value.controller.commitGrade();
    expect(await value.internal.settleColorSession()).toBe(true);
    expect(value.renderer.allocateScene).toHaveBeenCalledTimes(1); expect(value.client.stream).toHaveBeenCalledTimes(1);
    expect(value.controller.scene).toBe(value.staged); expect(value.base.dispose).toHaveBeenCalledTimes(1);
    expect(useApp.getState().grade).toEqual(NEUTRAL_COLOR); expect(useApp.getState().appliedGrade).toEqual(NEUTRAL_COLOR);
    expect(useApp.getState().colorSession).toBeNull();
    const calls = value.client.command.mock.calls.map(([request]) => request.command);
    expect(calls).toEqual(['beginTransaction', 'grade', 'commitTransaction', 'beginTransaction', 'endColor', 'commitTransaction']);
  });
  it('rolls back native session end and retains the base/grade when candidate upload fails', async () => {
    const value = fixture(); value.controller.setGrade(warm); await value.controller.commitGrade(); value.failStream();
    expect(await value.internal.settleColorSession()).toBe(false);
    expect(value.controller.scene).toBe(value.base); expect(value.base.dispose).not.toHaveBeenCalled();
    expect(value.staged.dispose).toHaveBeenCalledTimes(1); expect(value.native().colorSession?.baseId).toBe(2);
    expect(useApp.getState().grade).toEqual(warm); expect(useApp.getState().appliedGrade).toEqual(warm);
    expect(value.client.command.mock.calls.at(-1)?.[0].command).toBe('rollbackTransaction');
    expect(value.internal.colorDisplay?.epochId).toBe(4);
    expect(useApp.getState().colorSession?.epochId).toBe(4);
  });
  it('uses one transaction for a pending preview and boundary publication', async () => {
    const value = fixture(); value.controller.setGrade(warm);
    expect(await value.internal.settleColorSession()).toBe(true);
    expect(value.client.command.mock.calls.map(([request]) => request.command))
      .toEqual(['beginTransaction', 'grade', 'endColor', 'commitTransaction']);
    expect(value.controller.scene).toBe(value.staged); expect(value.base.dispose).toHaveBeenCalledTimes(1);
    expect(useApp.getState().grade).toEqual(NEUTRAL_COLOR); expect(useApp.getState().colorSession).toBeNull();
  });
  it('restores pre-boundary native content and Redo when an unbaked preview cannot be staged', async () => {
    const value = fixture(); value.controller.setGrade(warm); value.failStream();
    expect(await value.internal.settleColorSession()).toBe(false);
    expect(value.client.command.mock.calls.map(([request]) => request.command))
      .toEqual(['beginTransaction', 'grade', 'endColor', 'rollbackTransaction']);
    expect(value.native().contentRevision).toBe(0); expect(value.native().canRedo).toBe(true);
    expect(value.native().colorSession).toBeUndefined(); expect(value.controller.scene).toBe(value.base);
    expect(useApp.getState().grade).toEqual(warm); expect(useApp.getState().appliedGrade).toEqual(NEUTRAL_COLOR);
    expect(value.controller.colorPending).toBe(true); expect(value.staged.dispose).toHaveBeenCalledTimes(1);
  });
  it('refuses an externally changed boundary preview and retains that newer preview after rollback', async () => {
    const value = fixture(); value.controller.setGrade(warm);
    value.onStream(() => setApp({ grade: [...warmer], gradeRevision: useApp.getState().gradeRevision + 1 }));
    expect(await value.internal.settleColorSession()).toBe(false);
    expect(value.native().contentRevision).toBe(0); expect(value.native().canRedo).toBe(true);
    expect(value.controller.scene).toBe(value.base); expect(value.base.dispose).not.toHaveBeenCalled();
    expect(useApp.getState().grade).toEqual(warmer); expect(useApp.getState().appliedGrade).toEqual(NEUTRAL_COLOR);
    expect(value.client.command.mock.calls.at(-1)?.[0].command).toBe('rollbackTransaction');
  });
  it('keeps an empty manual no-op allocation-free and preserves Redo eligibility', async () => {
    const value = fixture(); value.noop();
    expect(await value.controller.command({ command: 'grade', values: [...NEUTRAL_COLOR], selectedOnly: true })).toBe(true);
    expect(value.native().canRedo).toBe(true); expect(value.native().contentRevision).toBe(0);
    expect(value.renderer.allocateScene).not.toHaveBeenCalled(); expect(value.client.stream).not.toHaveBeenCalled();
    expect(value.client.readMasks).not.toHaveBeenCalled(); expect(value.base.stageMasks).not.toHaveBeenCalled();
  });
  it('admits both color history copies before Auto and pending-boundary work', async () => {
    for (const automatic of [false, true]) {
      const value = fixture(), historyBytes = 128;
      value.internal.releaseHistory = value.internal.ledger.reserve('history', historyBytes);
      const reserve = vi.spyOn(value.internal.ledger, 'reserve');
      if (automatic) expect(await value.controller.autoColor('enhance')).toBe(true);
      else { value.controller.setGrade(warm); expect(await value.internal.settleColorSession()).toBe(true); }
      expect(reserve.mock.calls.find(([category]) => category === 'work')?.[1])
        .toBe(2 * historyBytes + estimateColorWorkBytes(3, 0, automatic) + (automatic ? 3 * 16 : 0));
      value.internal.releaseHistory?.(); reserve.mockRestore();
    }
  });
  it('refuses Auto before touching an admitted gesture or released click', async () => {
    const value = fixture();
    value.internal.selection = { session: { closed: false } };
    expect(await value.controller.autoColor('enhance')).toBe(false); expect(value.client.command).not.toHaveBeenCalled();
    value.internal.selection = undefined; value.internal.releasedSelections = [{}];
    expect(await value.controller.autoColor('exposure')).toBe(false); expect(value.client.command).not.toHaveBeenCalled();
  });
  it('allows a neutral restoration after a bake and refuses an equal applied manual grade', async () => {
    const value = fixture(); value.controller.setGrade(warm); await value.controller.commitGrade();
    expect(await value.controller.commitGrade()).toBe(false);
    value.controller.setGrade([...NEUTRAL_COLOR]); expect(value.controller.colorPending).toBe(true);
    expect(await value.controller.commitGrade()).toBe(true); expect(useApp.getState().appliedGrade).toEqual(NEUTRAL_COLOR);
    expect(value.renderer.allocateScene).not.toHaveBeenCalled();
  });
});

describe('color validation and bounded analyzer policy', () => {
  it('copies finite desktop values and rejects malformed fields without changing the preview', () => {
    const value = fixture(); const input = [...warm]; value.controller.setGrade(input); input[0] = 4;
    expect(useApp.getState().grade).toEqual(warm);
    for (const invalid of [[1], Array(15), [...warm.slice(0, 14)], warm.map((v, i) => i === 0 ? NaN : v),
      warm.map((v, i) => i === 5 ? Infinity : v), warm.map((v, i) => i === 0 ? 6 : v)]) {
      expect(colorValues(invalid)).toBeNull(); value.controller.setGrade(invalid); expect(useApp.getState().grade).toEqual(warm);
    }
    expect(isAutoColorMethod({ toString: () => { throw new Error('Unexpected coercion'); } })).toBe(false);
    expect(sameColorValues(warm, [...warm])).toBe(true);
  });
  it('covers the physical 65,536-sample arrays and rejects inputs outside the web cap', () => {
    const count = 1_000_000, arrays = 2 * 65_536 * 4 + 768 * 4;
    const extra = estimateColorWorkBytes(count, 3, true) - estimateSceneBytes(count, 3);
    expect(arrays).toBe(527360); expect(extra).toBe(arrays + 1912 + 4 * MiB);
    expect(estimateColorWorkBytes(count, 3, false)).toBe(estimateSceneBytes(count, 3));
    for (const invalid of [-1, .5, NaN, Infinity, 1_000_001]) expect(() => estimateColorWorkBytes(invalid, 3, true)).toThrow(AdmissionError);
  });
});
