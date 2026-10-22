import { describe, expect, it, vi } from 'vitest';
import { DocumentSelectionMaps, type SelectionMapContext } from '../src/app/selectionMaps';
import { ResourceLedger, type ResourceLease } from '../src/document/resources';
import type { CoreClient } from '../src/document/coreClient';
import type { CameraController } from '../src/input/camera';
import type { GaussianRenderer, GpuScene } from '../src/renderer/webgpu/renderer';
import { StaleGpuQueryError } from '../src/renderer/webgpu/renderer';
import { NEUTRAL_COLOR } from '../src/document/types';

const stub = vi.hoisted(() => ({ created: 0, admissions: [] as ((bytes: number) => ResourceLease)[] }));
vi.mock('../src/renderer/webgpu/surface', () => ({
  compositedSurface: async (_renderer: unknown, _scene: unknown, options: { admit(bytes: number): ResourceLease }) => {
    stub.created++; stub.admissions.push(options.admit); let disposed = false;
    return { width: 1, height: 1, fullWidth: 1, fullHeight: 1, depths: new Float32Array([1]),
      opacities: new Float32Array([.5]), deviceEpoch: 1, attempts: 1, tileCapacity: 1, allocationBytes: 8,
      assertCurrent() { if (disposed) throw new Error('Disposed'); }, dispose() { disposed = true; } };
  },
}));
function fixture() {
  stub.created = 0; stub.admissions.length = 0; let nextId = 0;
  const renderer = { lost: false, deviceEpoch: 1, canvas: { width: 1, height: 1 }, render: vi.fn(),
    trimSurfaceResources: vi.fn() } as unknown as GaussianRenderer;
  const scene = { kind: 'gaussian', count: 1, sourceRevision: 1, selectedRevision: 1, retired: false, renderer } as GpuScene;
  const client = { revision: { documentId: 'scene', sourceGeneration: 1 }, nativeContentRevision: 1,
    async adoptSelectionMap(_data: unknown, options: { current(): void }) {
      options.current(); let disposed = false;
      return { mapId: ++nextId, payloadBytes: 8, nativeBytes: 12, summary: {},
        assertCurrent() { options.current(); if (disposed) throw new Error('Disposed'); }, async dispose() { disposed = true; } };
    } } as unknown as CoreClient;
  const context: SelectionMapContext = { client, renderer, scene, camera: { revision: 1 } as CameraController,
    ledger: new ResourceLedger(1024), current() {}, opacityScale: 2, opacitySelectedOnly: false, opacityPreviewRevision: 1 };
  return { context, scene, renderer, maps: new DocumentSelectionMaps(), created: () => stub.created };
}
describe('opacity dependencies of cached selection surfaces', () => {
  it('shares surface/native admission and evicts optional scratch before retrying native adoption', async () => {
    const f = fixture(), ledger = f.context.ledger;
    const idleScratch = ledger.reserve('work', 1000), reserve = vi.spyOn(ledger, 'reserve');
    const trim = vi.mocked(f.renderer.trimSurfaceResources);
    trim.mockImplementation(owner => { expect(owner).toBe(ledger); idleScratch(); });
    const adopt = f.context.client.adoptSelectionMap.bind(f.context.client);
    let nativeAdmit: ((bytes: number) => ResourceLease) | undefined;
    vi.spyOn(f.context.client, 'adoptSelectionMap').mockImplementation(async (data, options) => {
      nativeAdmit = options.admit;
      const credit = options.admit(32), map = await adopt(data, options);
      return { ...map, async dispose() { try { await map.dispose(); } finally { credit(); } } };
    });
    const map = await f.maps.request(f.context);
    map.assertCurrent();
    expect(stub.admissions).toHaveLength(1); expect(stub.admissions[0]).toBe(nativeAdmit);
    expect(reserve.mock.calls).toEqual([['work', 32], ['work', 32]]);
    expect(trim).toHaveBeenCalledOnce(); expect(trim).toHaveBeenCalledWith(ledger);
    expect(ledger.usage.bytes).toBe(32); expect(ledger.usage.allocations).toBe(1);
    await f.maps.invalidate();
    expect(ledger.usage.bytes).toBe(0); expect(ledger.usage.allocations).toBe(0);
    expect(trim).toHaveBeenCalledTimes(2);
  });
  it.each(['transformBase', 'opacityBase'] as const)('expires active selected surface when %s target ownership changes without a canonical mask revision', async channel => {
    const f=fixture(), revisions={transformBase:1,opacityBase:1,colorBase:1};
    f.scene.previewMaskRevision=value=>revisions[value];
    if(channel==='opacityBase')f.context.opacitySelectedOnly=true;
    else{f.context.geometry=[1,0,0,0,0,1,0,0,0,0,1,0,1,0,0,1];f.context.geometrySelectedOnly=true;}
    const selected=f.scene.selectedRevision,first=await f.maps.request(f.context);revisions[channel]++;
    expect(f.scene.selectedRevision).toBe(selected);expect(()=>first.assertCurrent()).toThrow(StaleGpuQueryError);
    expect(await f.maps.request(f.context)).not.toBe(first);await f.maps.invalidate();
  });
  it('inactive target ownership changes do not invalidate an unrestricted raw surface',async()=>{
    const f=fixture(),revisions={transformBase:1,opacityBase:1,colorBase:1};f.scene.previewMaskRevision=value=>revisions[value];
    const first=await f.maps.request(f.context);revisions.transformBase++;revisions.opacityBase++;revisions.colorBase++;
    expect(first.assertCurrent).not.toThrow();expect(await f.maps.request(f.context)).toBe(first);await f.maps.invalidate();
  });
  it('observes actual surface/adoption boundaries only when production builds them',async()=>{
    const f=fixture(),events:string[]=[];f.context.observe=event=>{events.push(`${event.stage}:${event.status}`);};
    const first=await f.maps.request(f.context);expect(events).toEqual(['surface-create:started','surface-create:completed','native-adopt:started','native-adopt:completed']);
    expect(await f.maps.request(f.context)).toBe(first);expect(events).toHaveLength(4);
    f.context.opacityScale=3;expect(await f.maps.request(f.context)).not.toBe(first);expect(events).toHaveLength(8);
    f.context.opacityScale=4;f.context.observe=()=>{throw new Error('diagnostic observer failed');};
    await expect(f.maps.request(f.context)).resolves.toBeDefined();await f.maps.invalidate();
  });
  it('reuses unchanged opacity while RGB grading changes', async () => {
    const f = fixture(), first = await f.maps.request(f.context);
    f.context.grade = [...NEUTRAL_COLOR]; f.context.grade[0] = 2;
    expect(await f.maps.request(f.context)).toBe(first); expect(f.created()).toBe(1);
    await f.maps.invalidate();
  });
  it('an alpha edit expires the retained map before rendering another frame', async () => {
    const f = fixture(), first = await f.maps.request(f.context);
    f.context.opacityScale = 3;
    expect(() => first.assertCurrent()).toThrow(StaleGpuQueryError);
    const next = await f.maps.request(f.context); expect(next).not.toBe(first); expect(f.created()).toBe(2);
    expect(f.renderer.render).toHaveBeenLastCalledWith(f.scene, f.context.camera, NEUTRAL_COLOR, false,
      expect.any(Array), false, false, 3, false);
    await f.maps.invalidate();
  });
  it('an owner revision expires otherwise identical alpha', async () => {
    const f = fixture(), first = await f.maps.request(f.context);
    f.context.opacityPreviewRevision = (f.context.opacityPreviewRevision ?? 0) + 1;
    expect(() => first.assertCurrent()).toThrow(StaleGpuQueryError);
    expect(await f.maps.request(f.context)).not.toBe(first); await f.maps.invalidate();
  });
  it.each([false, true])('mask changes affect active selected opacity=%s', async selected => {
    const f = fixture(); f.context.opacitySelectedOnly = selected;
    const first = await f.maps.request(f.context); f.scene.selectedRevision++;
    if (selected) { expect(() => first.assertCurrent()).toThrow(StaleGpuQueryError); expect(await f.maps.request(f.context)).not.toBe(first); }
    else { expect(first.assertCurrent).not.toThrow(); expect(await f.maps.request(f.context)).toBe(first); }
    await f.maps.invalidate();
  });
  it('neutral scope does not consume selection revision or create another map', async () => {
    const f = fixture(); f.context.opacityScale = 1;
    const first = await f.maps.request(f.context); f.context.opacitySelectedOnly = true; f.scene.selectedRevision++;
    expect(await f.maps.request(f.context)).toBe(first); expect(f.created()).toBe(1); await f.maps.invalidate();
  });
});
