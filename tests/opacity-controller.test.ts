import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppController } from '../src/app/controller';
import { setApp, switchToolsMode, useApp } from '../src/app/store';
import { NEUTRAL_COLOR, type NativeSummary, type SceneCommand } from '../src/document/types';
import type { CoreClient } from '../src/document/coreClient';
import type { OpacitySessionSummary } from '../src/document/opacityProtocol';
import { transformDefaults, type TransformDefinition } from '../src/document/transformProtocol';
import { GaussianRenderer } from '../src/renderer/webgpu/renderer';
import { ResourceLedger, type ResourceLease } from '../src/document/resources';
import * as imageEncoding from '../src/io/image';
import type { OperationOwner } from '../src/document/operationProtocol';
import type { Revision } from '../src/document/types';

// Scheduling, actual host transaction and ownership fixtures only. Native/GPU
// numerical reference tests independently own the opacity formula/raster math.
const initial = useApp.getState();
const flush = async () => { for (let index = 0; index < 70; index++) await Promise.resolve(); };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function summary(opacitySession: OpacitySessionSummary | null = null): NativeSummary {
  return { ok: true, duplicateRange: null, loaded: true, kind: 0, count: 3, sourceCount: 3, selected: 1, visible: 2, shDegree: 0,
    format: 'PLY', canUndo: true, canRedo: true, revision: 2, contentRevision: 1, transaction: false, selectionDraft: false,
    sceneChanged: false, pending: false, progress: 1, floor: null, filter: null, transformSession: null, opacitySession,
    center: [3, 4, 5], radius: 1, yUp: false, camera: [0, 0, 0, 0, 0, 3, 1, 45, 0, 0, 1], memoryBytes: 528,
    selectionMapId: null, pendingSelectionMapId: null, selectionMapBytes: 0, selectionMapRetainedIds: [],
    alignment: { version: 2, branchId: 0, frame: transformDefaults().matrix, canReset: false, retainedBranchIds: [0] } };
}
type Internal = { [key: string]: unknown; executeEditCommand(command: SceneCommand, current?: () => boolean): Promise<boolean>;
  executeCommand(command: SceneCommand): Promise<boolean>; closeToleranceSelection(): Promise<void>; settleColorSession(): Promise<boolean>;
  ensureStartupCore(): Promise<void>; synchronizeViewport(): boolean; observeCanvas(): void; shrinkNativeHistory(client: CoreClient, summary: NativeSummary): void };
beforeEach(() => {
  vi.stubGlobal('document', { hidden: true, title: '' }); vi.stubGlobal('cancelAnimationFrame', vi.fn());
  setApp({ ...initial, ready: true, busy: false, rendererState: 'ready', toolsOpen: true, mode: 'pro', summary: summary(), operation: 0,
    opacity: null, opacityScale: 1, opacityPreview: null, opacityPreviewRevision: 0, transform: null, transformPreview: null,
    transformParameters: transformDefaults(), filter: null, navigationPrompt: false, settingsOpen: false, exportOpen: false,
    outputPending: false, viewTransferPending: false, thumbnailPending: false, savedViewChoices: [], selectionRecovery: 'idle' }, true);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); setApp(initial, true); });
// Keep the original command model responsible for numerical/session behavior;
// this adapter only supplies the controller's typed operation boundary.
function ownedTransactions<T extends { revision: Revision; command(command: SceneCommand): Promise<NativeSummary> }>(client: T) {
  let sequence = 0, active: OperationOwner | undefined;
  const check = (owner: OperationOwner) => { expect(owner).toBe(active); };
  const result = Object.assign(client, {
    createOperation: vi.fn(() => {
      expect(active).toBeUndefined();
      active = Object.freeze({ version: 1 as const, documentId: client.revision.documentId,
        sourceGeneration: client.revision.sourceGeneration, clientGeneration: 'cc000005-0000-4000-8000-000000000005', operationId: ++sequence });
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
  const controller = new AppController(), internal = controller as unknown as Internal;
  const client = ownedTransactions({ revision: { documentId: 'cc000006-0000-4000-8000-000000000006', sourceGeneration: 1, contentRevision: 1, selectionRevision: 2, draftRevision: 0 },
    assertNativeAdmission: vi.fn(), cancel: vi.fn(), command: vi.fn(), stream: vi.fn(), dispose: vi.fn(), retireNativeMemory: vi.fn(async () => {}) });
  const scene = { kind: 'gaussian', setDuplicateRange: vi.fn(), count: 3, sourceRevision: 1, allocationBytes: 100, dispose: vi.fn(async () => {}) };
  const renderer = { lost: false, deviceEpoch: 1, canvas: { width: 400, height: 300 }, setOpacityPreview: vi.fn(),
    captureRgba: vi.fn(async () => ({ width: 1, height: 1, pixels: new Uint8ClampedArray(4), dispose: vi.fn() })),
    device: { queue: { onSubmittedWorkDone: vi.fn(async () => {}) } },
    setHistogramEnabled: vi.fn(), resetHistogram: vi.fn(), dispose: vi.fn() };
  const camera = { revision: 2, clearInput: vi.fn(), dispose: vi.fn(), state: [0, 0, 0, 0, 0, 3, 1, 45, 0, 0, 1], composeTransform: vi.fn((definition: TransformDefinition) => {
    const matrix = transformDefaults().matrix; if (definition.mode !== 'matrix') matrix[12] = definition.translation[0];
    return { matrix, pivot: [...definition.pivot] as [number, number, number] };
  }) };
  controller.client = client as unknown as CoreClient; controller.scene = scene as unknown as NonNullable<AppController['scene']>;
  controller.renderer = renderer as unknown as GaussianRenderer; controller.camera = camera as unknown as NonNullable<AppController['camera']>;
  vi.spyOn(controller, 'invalidate').mockImplementation(() => {}); vi.spyOn(controller, 'cancelSelectionGesture').mockResolvedValue(true);
  vi.spyOn(internal, 'closeToleranceSelection').mockResolvedValue(); vi.spyOn(internal, 'settleColorSession').mockResolvedValue(true);
  const ordinary = vi.spyOn(internal, 'executeCommand').mockResolvedValue(true), commands: SceneCommand[] = [];
  let id = 0, held: { command: string; gate: ReturnType<typeof deferred<boolean>> } | undefined;
  const execute = vi.spyOn(internal, 'executeEditCommand').mockImplementation(async (command, current) => {
    commands.push(structuredClone(command));
    const wait = held?.command === command.command ? held.gate : undefined; if (wait) held = undefined;
    if (wait) { setApp({ busy: true }); if (!await wait.promise || current && !current()) { setApp({ busy: false }); return false; } }
    if (command.command === 'beginOpacity') setApp({ summary: { ...useApp.getState().summary!, opacitySession: {
      id: ++id, baseId: id + 100, epoch: 0, appliedEpoch: null, appliedScale: 1, selectedOnly: command.selectedOnly as boolean } }, busy: false });
    else if (command.command === 'applyOpacity' || command.command === 'resetOpacity') {
      const before = useApp.getState().summary!; setApp({ summary: { ...before, contentRevision: before.contentRevision + 1, revision: before.revision + 1,
        opacitySession: { ...before.opacitySession!, epoch: command.epoch as number, appliedEpoch: command.epoch as number,
          appliedScale: command.command === 'resetOpacity' ? 1 : command.scale as number } }, busy: false });
    } else if (command.command === 'endOpacity') setApp({ summary: { ...useApp.getState().summary!, opacitySession: null }, busy: false });
    else if (command.command === 'beginTransform') setApp({ summary: { ...useApp.getState().summary!, transformSession: {
      id: ++id, baseId: id + 100, epoch: 0, appliedEpoch: null, kind: command.kind as 'numeric' | 'gizmo', gizmo: command.kind === 'gizmo' ? { cancelBaseId: null, cancelContentRevision: null, canUndo: false, canRedo: false } : null, selectedOnly: command.selectedOnly as boolean,
      appliedMatrix: transformDefaults().matrix, pivot: [3, 4, 5] } }, busy: false });
    else if (command.command === 'endTransform') setApp({ summary: { ...useApp.getState().summary!, transformSession: null }, busy: false });
    return true;
  });
  return { controller, internal, client, renderer, camera, scene, commands, execute, ordinary,
    hold(command = 'applyOpacity') { const gate = deferred<boolean>(); held = { command, gate }; return gate; } };
}
async function opacity(scale = 2) { const f = fixture(); f.controller.setOpacityScale(scale); await flush(); return f; }

describe('absolute opacity host owner', () => {
  it('empty opacity cancellation preserves clean or dirty document state without native commands even when saved content differs', async () => {
    for (const dirty of [false, true]) {
      const f = fixture(); f.internal.savedContent = 0;
      setApp({ dirty }); const before = useApp.getState(), native = structuredClone(f.client.revision);
      expect(before.summary!.contentRevision).not.toBe(f.internal.savedContent);
      expect(f.controller.opacityActive).toBe(false); expect(f.controller.opacityPending).toBe(false);
      const notifications = vi.fn(), unsubscribe = useApp.subscribe(notifications);
      try {
        expect(await f.controller.cancelOpacityPreview()).toBe(true);
        expect(useApp.getState()).toBe(before); expect(useApp.getState().dirty).toBe(dirty);
        expect(useApp.getState().summary).toBe(before.summary); expect(f.client.revision).toEqual(native);
        expect(f.controller.client).toBe(f.client); expect(f.controller.scene).toBe(f.scene);
        expect(f.commands).toEqual([]); expect(f.execute).not.toHaveBeenCalled(); expect(f.ordinary).not.toHaveBeenCalled();
        expect(f.client.command).not.toHaveBeenCalled(); expect(f.client.stream).not.toHaveBeenCalled();
        expect(f.renderer.setOpacityPreview).not.toHaveBeenCalled(); expect(notifications).not.toHaveBeenCalled();
      } finally { unsubscribe(); }
    }
  });
  it('stages scale changes without CPU Apply and invalidates the displayed definition immediately', async () => {
    const f = await opacity(); const revision = useApp.getState().opacityPreviewRevision;
    f.controller.setOpacityScale(.3); expect(f.commands.map(value => value.command)).toEqual(['beginOpacity']);
    expect(f.renderer.setOpacityPreview).toHaveBeenLastCalledWith(Math.fround(.3), true); expect(useApp.getState().opacityPreviewRevision).toBeGreaterThan(revision);
    expect(useApp.getState()).toMatchObject({ opacityScale: .3, opacity: { dirty: true, selectedOnly: true } });
    expect(await f.controller.applyOpacity()).toBe(true); expect(f.commands.at(-1)).toMatchObject({ command: 'applyOpacity', id: 1, epoch: 1, scale: Math.fround(.3) });
    expect(f.controller.scene).toBe(f.scene); expect(useApp.getState().opacity?.dirty).toBe(false);
  });
  it('keeps continued120 typing/slider changes cheap through a held native Begin and publishes only after acknowledgment', async () => {
    const f = fixture(), held = f.hold('beginOpacity'); f.controller.setOpacityScale(.01); await flush();
    expect(useApp.getState().opacity?.phase).toBe('preparing'); expect(f.controller.opacityControlsEnabled).toBe(true); expect(f.controller.opacityApplyEnabled).toBe(false);
    f.controller.setOpacityScale(.12); f.controller.setOpacityScale(1.2); f.controller.setOpacityScale(1.25); f.controller.setOpacityScale(1.2);
    expect(useApp.getState().opacityScale).toBe(1.2); expect(f.commands.map(value => value.command)).toEqual(['beginOpacity']);
    expect(f.renderer.setOpacityPreview).not.toHaveBeenCalled(); expect(await f.controller.applyOpacity()).toBe(false);
    held.resolve(true); await flush(); expect(useApp.getState().opacity).toMatchObject({ phase: 'ready', dirty: true, desiredRevision: 5 });
    expect(f.renderer.setOpacityPreview).toHaveBeenLastCalledWith(Math.fround(1.2), true); expect(f.commands).toHaveLength(1);
  });
  it('captures scope after manual settlement and does not retarget a later desired scale', async () => {
    const f = fixture(); vi.mocked(f.controller.cancelSelectionGesture).mockImplementation(async () => { setApp({ summary: { ...useApp.getState().summary!, selected: 0 } }); return true; });
    f.controller.setOpacityScale(2); await flush(); expect(f.commands[0]).toMatchObject({ selectedOnly: false });
    setApp({ summary: { ...useApp.getState().summary!, selected: 2 } }); f.controller.setOpacityScale(3); await f.controller.applyOpacity();
    expect(useApp.getState().opacityPreview?.selectedOnly).toBe(false);
  });
  it('retains one baseline across repeated absolute Apply and explicit latest-request joining', async () => {
    const f = await opacity(), held = f.hold(), first = f.controller.applyOpacity(); await flush();
    f.controller.setOpacityScale(3); const latest = f.controller.applyOpacity(); held.resolve(true);
    expect(await first).toBe(true); expect(await latest).toBe(true);
    expect(f.commands.filter(value => value.command === 'applyOpacity')).toMatchObject([{ id: 1, epoch: 1, scale: 2 }, { id: 1, epoch: 2, scale: 3 }]);
    expect(useApp.getState().opacity).toMatchObject({ dirty: false, baseId: 101 });
  });
  it('invalid new desired input cannot apply an older candidate or cross ordinary boundaries', async () => {
    const f = await opacity(); await f.controller.applyOpacity(); f.controller.setOpacityScale(6);
    expect(useApp.getState().opacityScale).toBe(6); expect(await f.controller.applyOpacity()).toBe(false); expect(await f.controller.endOpacitySession()).toBe(false);
    expect(await f.controller.command({ command: 'delete' })).toBe(false); expect(await f.controller.selectFilter('sphere')).toBe(false);
    expect(await f.controller.startCenterAlignment()).toBe(false); f.controller.setGrade(NEUTRAL_COLOR.map(value => value + .1));
    expect(useApp.getState().grade).toEqual(NEUTRAL_COLOR); expect(f.commands).toHaveLength(2); expect(f.ordinary).not.toHaveBeenCalled();
  });
  it('Cancel restores accepted scale, preserving native accepted scene/history and monotonically advancing desired revision', async () => {
    const f = await opacity(.3); await f.controller.applyOpacity(); const before = useApp.getState().summary!, revision = useApp.getState().opacity!.desiredRevision;
    f.controller.setOpacityScale(4); expect(await f.controller.cancelOpacityPreview()).toBe(true);
    expect(useApp.getState().opacityScale).toBe(.3); expect(useApp.getState().summary).toBe(before); expect(useApp.getState().opacity!.desiredRevision).toBeGreaterThan(revision);
    expect(f.commands).toHaveLength(2); expect(f.renderer.setOpacityPreview).toHaveBeenLastCalledWith(Math.fround(.3), true);
  });
  it('joins held cancellation, restores last accepted controls and never reuses a consumed request epoch', async () => {
    const f = await opacity(), held = f.hold(), apply = f.controller.applyOpacity(); await flush();
    const cancel = f.controller.cancelOpacityPreview(); held.resolve(true); expect(await apply).toBe(false); expect(await cancel).toBe(true);
    expect(f.client.cancel).toHaveBeenCalled(); expect(useApp.getState().opacityScale).toBe(1);
    f.controller.setOpacityScale(3); await f.controller.applyOpacity(); expect(f.commands.at(-1)).toMatchObject({ epoch: 2 });
  });
  it('Color Reset restores entry opacity before materialization then stages neutral grade without a grade bake', async () => {
    const f = await opacity(); await f.controller.applyOpacity(); f.controller.setOpacityScale(3);
    expect(f.controller.colorResetPreviewEnabled).toBe(true); expect(await f.controller.resetColorPreview()).toBe(true);
    expect(f.commands.map(value => value.command)).toEqual(['beginOpacity', 'applyOpacity', 'resetOpacity', 'endOpacity']);
    expect(useApp.getState()).toMatchObject({ opacity: null, opacityScale: 1, opacityPreview: null, grade: NEUTRAL_COLOR });
    expect(f.ordinary).not.toHaveBeenCalled(); expect(f.controller.colorResetPreviewEnabled).toBe(false);
  });
  it('Color Reset remains meaningful when neutral desired scale overlays nonneutral accepted opacity', async () => {
    const f = await opacity(); await f.controller.applyOpacity(); f.controller.setOpacityScale(1);
    expect(f.controller.colorResetPreviewEnabled).toBe(true); await f.controller.resetColorPreview(); expect(f.commands.at(-2)?.command).toBe('resetOpacity');
  });
  it('Basic/Tools deactivation discards the unaccepted draft and ends without an implicit Apply', async () => {
    const f = await opacity(); switchToolsMode('basic'); expect(useApp.getState().mode).toBe('pro');
    expect(await f.controller.endOpacitySession(true)).toBe(true); switchToolsMode('basic');
    expect(f.commands.map(value => value.command)).toEqual(['beginOpacity', 'endOpacity']); expect(useApp.getState().mode).toBe('basic');
  });
  it('coalesces clean-owner grade changes after materialization and fences replay against source replacement', async () => {
    const f = await opacity(); await f.controller.applyOpacity(); const held = f.hold('endOpacity'), first = [...NEUTRAL_COLOR], latest = [...first];
    first[0] = 1.2; latest[0] = 1.6; f.controller.setGrade(first); await flush(); f.controller.setGrade(latest); held.resolve(true); await flush();
    expect(useApp.getState().grade[0]).toBe(Math.fround(1.6)); expect(f.commands.at(-1)?.command).toBe('endOpacity');
    f.controller.setOpacityScale(2); await flush(); await f.controller.applyOpacity(); const stale = f.hold('endOpacity'); f.controller.setGrade(first); await flush();
    f.client.revision.sourceGeneration++; stale.resolve(true); await flush(); expect(useApp.getState().grade[0]).toBe(Math.fround(1.6));
  });
  it('allows latest numeric transform entry only after clean opacity end, without baking its staged transform', async () => {
    const f = await opacity(); await f.controller.applyOpacity(); const held = f.hold('endOpacity');
    f.controller.setTransformParameters({ translation: [1, 0, 0] }); await flush(); f.controller.setTransformParameters({ translation: [2, 0, 0] });
    held.resolve(true); await flush(); expect(f.commands.map(value => value.command)).toEqual(['beginOpacity', 'applyOpacity', 'endOpacity', 'beginTransform']);
    expect(useApp.getState().transformParameters.translation).toEqual([2, 0, 0]); expect(useApp.getState().transform?.dirty).toBe(true);
  });
  it('manual activation/Cleanup Reset cancel opacity first while dirty source/export/saved-view actions refuse', async () => {
    const f = await opacity(); await f.controller.openFiles([]); await f.controller.exportScene(); expect(await f.controller.updateThumbnail()).toBe(false);
    expect(await f.controller.importSavedView(new Blob())).toBe(false); expect(await f.controller.exportSavedView()).toBe(false);
    expect(f.commands).toHaveLength(1); expect(await f.controller.activateSelectionTool('rectangle')).toBe(true);
    expect(f.commands.at(-1)?.command).toBe('endOpacity'); expect(useApp.getState().tool).toBe('rectangle');
    f.controller.setOpacityScale(3); await flush(); expect(await f.controller.command({ command: 'resetCleanup' })).toBe(true);
    expect(f.commands.at(-1)?.command).toBe('endOpacity'); expect(f.ordinary).toHaveBeenCalledWith({ command: 'resetCleanup' });
  });
  it('capture forwards independent alpha scope while keeping the opacity owner and preview', async () => {
    vi.spyOn(imageEncoding, 'encodeRgba').mockImplementation(async (_source, type) => ({ blob: new Blob([], { type }), dispose: vi.fn() }));
    const f = await opacity(); await f.controller.capture();
    expect(f.renderer.captureRgba).toHaveBeenCalledWith(f.scene, f.camera, expect.objectContaining({ signal: expect.any(AbortSignal) }),
      NEUTRAL_COLOR, expect.any(Array), true, false, 2, true);
    expect(f.controller.opacityActive).toBe(true); expect(f.commands).toHaveLength(1);
  });
  it('coalesces slider input while a clean transform owner is still being materialized', async () => {
    const f = fixture(); await f.controller.setTransformGizmoMode('move'); const held = f.hold('endTransform');
    f.controller.setOpacityScale(.01); await flush(); expect(f.controller.opacityControlsEnabled).toBe(true);
    f.controller.setOpacityScale(.12); f.controller.setOpacityScale(1.2); expect(f.controller.opacityApplyEnabled).toBe(false);
    expect(useApp.getState().opacityScale).toBe(1.2); expect(f.controller.opacityActive).toBe(true); expect(f.controller.opacityCancelEnabled).toBe(true);
    expect(f.controller.transformGizmoControlsEnabled).toBe(false);
    held.resolve(true); await flush(); expect(useApp.getState().opacityScale).toBe(1.2);
    expect(f.commands.map(value => value.command)).toEqual(['beginTransform', 'endTransform', 'beginOpacity']);
    expect(f.renderer.setOpacityPreview).toHaveBeenLastCalledWith(Math.fround(1.2), true);
  });
  it('Tools/Basic settlement discards a queued opacity entry after joining clean transform materialization', async () => {
    const f = fixture(); await f.controller.setTransformGizmoMode('move'); const held = f.hold('endTransform');
    f.controller.setOpacityScale(2); await flush(); const ending = f.controller.endOpacitySession(true);
    held.resolve(true); expect(await ending).toBe(true); expect(f.controller.opacityActive).toBe(false);
    expect(useApp.getState().opacityScale).toBe(1); expect(f.commands.map(value => value.command)).toEqual(['beginTransform', 'endTransform']);
    expect(f.renderer.setOpacityPreview).not.toHaveBeenCalled();
  });
  it('cancels a held Begin before deactivation without silently accepting staged opacity', async () => {
    const f = fixture(), held = f.hold('beginOpacity'); f.controller.setOpacityScale(2); await flush();
    const ending = f.controller.endOpacitySession(true); held.resolve(true);
    expect(await ending).toBe(true); expect(useApp.getState()).toMatchObject({ opacity: null, opacityScale: 1, opacityPreview: null });
    expect(f.commands.map(value => value.command)).toEqual(['beginOpacity', 'endOpacity']);
    expect(f.commands.some(value => value.command === 'applyOpacity')).toBe(false);
  });
  it('disposal joins a held entry before retiring its native memory and rejects a late preview publication', async () => {
    const f = fixture(), held = f.hold('beginOpacity'); f.controller.setOpacityScale(2); await flush();
    f.controller.dispose(); await flush(); expect(f.client.dispose).toHaveBeenCalled(); expect(f.client.retireNativeMemory).not.toHaveBeenCalled();
    held.resolve(true); await flush(); expect(f.client.retireNativeMemory).toHaveBeenCalledOnce();
    expect(f.renderer.setOpacityPreview).not.toHaveBeenCalled(); expect(useApp.getState()).toMatchObject({ opacity: null, opacityScale: 1, opacityPreview: null });
  });
});

function nativeTransactions(f: Awaited<ReturnType<typeof opacity>>) {
  f.execute.mockRestore(); let authoritative = useApp.getState().summary!, checkpoint = authoritative;
  const commands: string[] = [], credit = {
    updateNativeCoverage: vi.fn(), setNativeWork: vi.fn(), releaseNativeCoverage: vi.fn((lease: ResourceLease) => lease()),
    transferNativeCoverage: vi.fn((updates: { lease: ResourceLease; nextLeaseBytes: number }[]) => {
      for (const update of updates) update.lease.resize(update.nextLeaseBytes);
    }), readMasks: vi.fn(async (masks: (bytes: ArrayBuffer) => void) => { masks(new Uint8Array([1,0,2]).buffer); return authoritative; }),
  };
  Object.assign(f.scene, { stageMasks: vi.fn(async () => ({ allocationBytes: 27, retirementBytes: 27,
    retirementBuffers: [], publish: vi.fn(), dispose: vi.fn() })) });
  Object.assign(f.client, credit);
  f.client.command.mockImplementation(async (command: SceneCommand) => {
    commands.push(command.command);
    if (command.command === 'beginTransaction') { checkpoint = authoritative; authoritative = { ...authoritative, transaction: true }; }
    if (command.command === 'applyOpacity' || command.command === 'resetOpacity') authoritative = {
      ...authoritative, revision: authoritative.revision + 1, contentRevision: authoritative.contentRevision + 1, sceneChanged: true,
      opacitySession: { ...authoritative.opacitySession!, epoch: command.epoch as number, appliedEpoch: command.epoch as number,
        appliedScale: command.command === 'resetOpacity' ? 1 : command.scale as number } };
    if (command.command === 'endOpacity') authoritative = { ...authoritative, opacitySession: null, sceneChanged: false };
    if (command.command === 'commitTransaction') authoritative = { ...authoritative, transaction: false };
    if (command.command === 'rollbackTransaction') authoritative = checkpoint;
    return authoritative;
  });
  return { commands, credit, get authoritative() { return authoritative; } };
}
function graphicsRecovery(f: Awaited<ReturnType<typeof opacity>>, authoritative: NativeSummary) {
  f.renderer.lost = true; f.internal.canvas = {};
  vi.spyOn(f.internal, 'ensureStartupCore').mockResolvedValue(); vi.spyOn(f.internal, 'synchronizeViewport').mockReturnValue(true);
  vi.spyOn(f.internal, 'observeCanvas').mockImplementation(() => {}); vi.spyOn(f.internal, 'shrinkNativeHistory').mockImplementation(() => {});
  f.client.command.mockResolvedValue(authoritative);
  const staged = { kind: 'gaussian', setDuplicateRange: vi.fn(), count: 3, sourceRevision: 1, allocationBytes: 112, upload: vi.fn(), masks: vi.fn(), dispose: vi.fn(async () => {}),
    stagePreviewMasks: vi.fn(async () => ({ allocationBytes: 12, retirementBytes: 0, retirementBuffers: [], publish: vi.fn(), dispose: vi.fn() })) };
  const replacement = { ...f.renderer, lost: false, allocateScene: vi.fn(async () => staged) };
  Object.assign(staged, { renderer: replacement });
  vi.spyOn(GaussianRenderer, 'create').mockResolvedValue(replacement as unknown as GaussianRenderer);
  Object.assign(f.client, { readMasks: vi.fn(async (masks: (bytes: ArrayBuffer) => void) => { masks(new Uint8Array([1,0,2]).buffer); return authoritative; }) });
  f.client.stream.mockImplementation(async (_chunk: unknown, masks: (bytes: ArrayBuffer) => void) => { masks(new Uint8Array([1,0,2]).buffer); return authoritative; });
  return { staged, replacement };
}
describe('admitted opacity publication and retained recovery', () => {
  it('Apply and Reset retain the exact entry GPU geometry while publishing canonical masks and frozen targets', async () => {
    const f = await opacity(), tx = nativeTransactions(f), allocateScene = vi.fn(), stageMasks = (f.scene as unknown as { stageMasks: ReturnType<typeof vi.fn> }).stageMasks;
    Object.assign(f.renderer, { allocateScene });
    expect(await f.controller.applyOpacity()).toBe(true); expect(await f.controller.resetOpacity()).toBe(true);
    expect(tx.commands).toEqual(['beginTransaction', 'applyOpacity', 'commitTransaction', 'beginTransaction', 'resetOpacity', 'commitTransaction']);
    expect(f.controller.scene).toBe(f.scene); expect(allocateScene).not.toHaveBeenCalled(); expect(stageMasks).toHaveBeenCalledTimes(2);
    expect(f.client.stream).not.toHaveBeenCalled(); expect(tx.credit.readMasks).toHaveBeenCalledTimes(4);
    expect(tx.credit.setNativeWork).toHaveBeenLastCalledWith(undefined); expect(useApp.getState().opacityScale).toBe(1);
  });
  it('failed end upload rolls back the accepted native owner and retains display and work-credit authority', async () => {
    const f = await opacity(); await f.controller.applyOpacity(); const before = useApp.getState().summary!, preview = useApp.getState().opacityPreview;
    const tx = nativeTransactions(f), staged = { setDuplicateRange: vi.fn(), upload: vi.fn(), masks: vi.fn(), allocationBytes: 100, dispose: vi.fn(async () => {}) };
    Object.assign(f.renderer, { allocateScene: vi.fn(async () => staged) }); f.client.stream.mockRejectedValue(new Error('Upload refused'));
    expect(await f.controller.endOpacitySession()).toBe(false);
    expect(tx.commands).toEqual(['beginTransaction', 'endOpacity', 'rollbackTransaction']); expect(useApp.getState().summary).toEqual(before);
    expect(useApp.getState().opacityPreview).toEqual(preview); expect(useApp.getState().opacity?.phase).toBe('required');
    expect(f.controller.scene).toBe(f.scene); expect(staged.dispose).toHaveBeenCalledOnce();
    expect((f.internal.ledger as ResourceLedger).usage.bytes).toBe(0); expect(tx.credit.setNativeWork).toHaveBeenLastCalledWith(undefined);
    expect(f.renderer.setOpacityPreview).toHaveBeenLastCalledWith(2, true);
  });
  it('installs accepted materialization and clears alpha preview before joining retirement of the old GPU base', async () => {
    const f = await opacity(); await f.controller.applyOpacity(); const tx = nativeTransactions(f);
    const retired = deferred<void>(), staged = { setDuplicateRange: vi.fn(), upload: vi.fn(), masks: vi.fn(), allocationBytes: 100, dispose: vi.fn(async () => {}) };
    Object.assign(f.renderer, { allocateScene: vi.fn(async () => staged) }); f.scene.dispose.mockImplementation(async () => retired.promise);
    f.client.stream.mockImplementation(async () => tx.authoritative);
    const ending = f.controller.endOpacitySession(); await flush();
    expect(f.controller.scene).toBe(staged); expect(useApp.getState().opacityPreview).toBeNull();
    expect(f.renderer.setOpacityPreview).toHaveBeenLastCalledWith(1, false); expect(f.scene.dispose).toHaveBeenCalledOnce();
    expect(f.controller.opacityPending).toBe(true); retired.resolve(); expect(await ending).toBe(true); expect(useApp.getState().opacity).toBeNull();
  });
  it('refuses an inconsistent committed definition without publishing or pretending a rollback occurred', async () => {
    const f = await opacity(), before = useApp.getState().summary!, tx = nativeTransactions(f), command = f.client.command.getMockImplementation()!;
    f.client.command.mockImplementation(async (value: SceneCommand) => {
      const result = await command(value); return value.command === 'commitTransaction' ?
        { ...result, opacitySession: { ...result.opacitySession!, appliedScale: 3 } } : result;
    });
    expect(await f.controller.applyOpacity()).toBe(false);
    expect(tx.commands).toEqual(['beginTransaction', 'applyOpacity', 'commitTransaction']); expect(useApp.getState().summary).toEqual(before);
    expect(useApp.getState().opacity).toMatchObject({ id: 1, baseId: 101, phase: 'required' }); expect(f.controller.editingAvailable).toBe(false);
  });
  it.each(['bounds', 'default-view'] as const)('rolls back an opacity candidate that changes %s and retains its retryable draft', async fault => {
    const f = await opacity(), before = useApp.getState().summary!, tx = nativeTransactions(f), command = f.client.command.getMockImplementation()!;
    f.client.command.mockImplementation(async (value: SceneCommand) => {
      const result = await command(value); return value.command === 'applyOpacity' ? { ...result,
        ...(fault === 'bounds' ? { center: [9, 4, 5] } : { camera: [...result.camera.slice(0, 9), 1, 0] }) } : result;
    });
    expect(await f.controller.applyOpacity()).toBe(false); expect(tx.commands.at(-1)).toBe('rollbackTransaction');
    expect(useApp.getState().summary).toEqual(before); expect(useApp.getState().opacity).toMatchObject({ phase: 'ready', dirty: true });
    expect(f.controller.scene).toBe(f.scene); expect(f.renderer.setOpacityPreview).toHaveBeenLastCalledWith(2, true);
  });
  it('recovery streams the immutable opacity base and preserves accepted metadata plus newer desired preview', async () => {
    const f = await opacity(.3); await f.controller.applyOpacity(); f.internal.savedContent = useApp.getState().summary!.contentRevision;
    f.controller.setOpacityScale(4); const authoritative = useApp.getState().summary!, recovery = graphicsRecovery(f, authoritative);
    expect(await f.controller.retryRenderer()).toBe(true);
    expect(f.client.command).toHaveBeenCalledWith({ command: 'summary' }); expect(f.client.stream.mock.calls.at(-1)?.[2]).toBe('opacityBase');
    expect(useApp.getState()).toMatchObject({ ready: true, dirty: true, opacityScale: 4,
      opacity: { phase: 'ready', dirty: true, id: 1, baseId: 101 }, opacityPreview: { scale: 4, id: 1, baseId: 101, epoch: 1 } });
    expect(recovery.replacement.setOpacityPreview).toHaveBeenLastCalledWith(4, true);
    expect(f.commands.filter(value => value.command === 'applyOpacity')).toHaveLength(1);
  });
  it('failed recovery retains its owner for a joined retry and never streams an ordinary accepted document as entry alpha', async () => {
    const f = await opacity(); await f.controller.applyOpacity(); const authoritative = useApp.getState().summary!;
    const recovery = graphicsRecovery(f, authoritative); f.client.stream.mockRejectedValueOnce(new Error('Lost base upload'));
    expect(await f.controller.retryRenderer()).toBe(false); expect(useApp.getState().opacity).toMatchObject({ phase: 'required', id: 1, baseId: 101 });
    expect(f.controller.scene).toBe(f.scene); expect(recovery.staged.dispose).toHaveBeenCalled(); expect(await f.controller.retryRenderer()).toBe(true);
    expect(f.client.stream.mock.calls.map(value => value[2])).toEqual(['opacityBase', 'opacityBase']);
    expect(useApp.getState().opacity?.phase).toBe('ready'); expect(f.controller.opacityControlsEnabled).toBe(true);
    f.controller.setOpacityScale(3); expect(useApp.getState().opacityScale).toBe(3);
  });
  it.each(['missing', 'foreign'] as const)('recovery refuses %s native ownership without releasing the retained entry', async fault => {
    const f = await opacity(); await f.controller.applyOpacity(); const authoritative = useApp.getState().summary!;
    graphicsRecovery(f, { ...authoritative, opacitySession: fault === 'missing' ? null : { ...authoritative.opacitySession!, baseId: 999 } });
    expect(await f.controller.retryRenderer()).toBe(false); expect(f.controller.scene).toBe(f.scene);
    expect(f.client.stream).not.toHaveBeenCalled(); expect(useApp.getState().opacity).toMatchObject({ phase: 'required', id: 1, baseId: 101 });
  });
  it('recovery refuses a base stream whose terminal accepted definition differs from its captured summary', async () => {
    const f = await opacity(); await f.controller.applyOpacity(); const authoritative = useApp.getState().summary!;
    const recovery = graphicsRecovery(f, authoritative);
    f.client.stream.mockResolvedValue({ ...authoritative, opacitySession: { ...authoritative.opacitySession!, appliedScale: 3 } });
    expect(await f.controller.retryRenderer()).toBe(false); expect(f.controller.scene).toBe(f.scene);
    expect(recovery.staged.dispose).toHaveBeenCalled(); expect(useApp.getState().opacity?.phase).toBe('required');
  });
});
