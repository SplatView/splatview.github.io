import { describe, expect, it, vi } from 'vitest';
import { captureSelectionMapDependencies, type SelectionMapDependencyContext } from '../src/app/selectionMapSnapshot';
import { IDENTITY_MATRIX, NEUTRAL_COLOR } from '../src/document/types';
import type { CoreClient } from '../src/document/coreClient';
import type { CameraController } from '../src/input/camera';
import { StaleGpuQueryError, type GaussianRenderer, type GpuScene } from '../src/renderer/webgpu/renderer';

const translated = () => [...IDENTITY_MATRIX.slice(0, 12), 3, 4, 5, 1];
function fixture() {
  const client = { revision: { documentId: 'scene', sourceGeneration: 2, contentRevision: 7,
    selectionRevision: 11, draftRevision: 13 }, nativeContentRevision: 17 };
  const renderer = { lost: false, deviceEpoch: 19, canvas: { width: 320, height: 200 } };
  const targets = { transformBase: 23, opacityBase: 29, colorBase: 31 };
  const scene = { sourceRevision: 37, selectedRevision: 41, revision: 43, retired: false, renderer,
    previewMaskRevision: (channel: keyof typeof targets) => targets[channel] };
  const camera = { revision: 47 };
  const context: SelectionMapDependencyContext & { grade?: number[] } = {
    client: client as unknown as CoreClient,
    renderer: renderer as unknown as GaussianRenderer,
    scene: scene as unknown as GpuScene,
    camera: camera as CameraController,
    current: vi.fn(),
  };
  return { client, renderer, scene, camera, targets, context };
}
type Fixture = ReturnType<typeof fixture>;

describe('selection map dependency snapshot', () => {
  it('preserves the cache key field order and stable weak object identities', () => {
    const f = fixture();
    f.context.geometry = translated(); f.context.geometrySelectedOnly = true;
    f.context.opacityScale = 2; f.context.opacitySelectedOnly = true; f.context.opacityPreviewRevision = 53;
    const first = captureSelectionMapDependencies(f.context), parts = first.key.split(':');
    for (const position of [0, 4, 6, 8]) expect(parts[position]).toMatch(/^\d+$/);
    expect(new Set([parts[0], parts[4], parts[6], parts[8]]).size).toBe(4);
    expect(first.key).toBe([parts[0], 'scene', 2, 17, parts[4], 19, parts[6], 37, parts[8], 47,
      320, 200, translated().join(','), 41, true, 2, true, 53, 23, 29].join(':'));
    expect(captureSelectionMapDependencies(f.context).key).toBe(first.key);
  });

  it.each([
    ['document identity', (f: Fixture) => { f.client.revision.documentId = 'replacement'; }],
    ['source generation', (f: Fixture) => { f.client.revision.sourceGeneration++; }],
    ['native content', (f: Fixture) => { f.client.nativeContentRevision++; }],
    ['camera view', (f: Fixture) => { f.camera.revision++; }],
    ['framebuffer width', (f: Fixture) => { f.renderer.canvas.width++; }],
    ['framebuffer height', (f: Fixture) => { f.renderer.canvas.height++; }],
    ['scene source', (f: Fixture) => { f.scene.sourceRevision++; }],
    ['opacity scale', (f: Fixture) => { f.context.opacityScale = 2; }],
    ['opacity owner revision', (f: Fixture) => { f.context.opacityPreviewRevision = 1; }],
  ] as const)('expires the captured query and changes the key for %s', (_name, mutate) => {
    const f = fixture(), first = captureSelectionMapDependencies(f.context);
    mutate(f);
    expect(first.assertCurrent).toThrow(StaleGpuQueryError);
    expect(captureSelectionMapDependencies(f.context).key).not.toBe(first.key);
  });

  it.each([
    ['renderer loss', (f: Fixture) => { f.renderer.lost = true; }],
    ['scene retirement', (f: Fixture) => { f.scene.retired = true; }],
    ['scene renderer replacement', (f: Fixture) => { f.scene.renderer = { ...f.renderer }; }],
  ] as const)('rejects %s without treating liveness as a cache identity', (_name, mutate) => {
    const f = fixture(), first = captureSelectionMapDependencies(f.context);
    mutate(f);
    expect(first.assertCurrent).toThrow(StaleGpuQueryError);
    expect(captureSelectionMapDependencies(f.context).key).toBe(first.key);
  });

  it.each(['client', 'renderer', 'scene', 'camera'] as const)('distinguishes replacement %s objects with identical scalar state', name => {
    const f = fixture(), first = captureSelectionMapDependencies(f.context);
    // The controller owns replacement invalidation. These independent captures
    // establish that a new owner cannot accidentally reuse the former key.
    const replacement = { ...f.context, [name]: { ...f.context[name] } } as SelectionMapDependencyContext;
    expect(captureSelectionMapDependencies(replacement).key).not.toBe(first.key);
    expect(captureSelectionMapDependencies(f.context).key).toBe(first.key);
  });

  it('keeps the owning controller currentness check live and propagates its error first', () => {
    const f = fixture(), snapshot = captureSelectionMapDependencies(f.context);
    expect(f.context.current).not.toHaveBeenCalled();
    snapshot.assertCurrent(); expect(f.context.current).toHaveBeenCalledOnce();
    const failure = new Error('Controller owner retired');
    f.context.current = () => { throw failure; };
    f.renderer.lost = true;
    expect(snapshot.assertCurrent).toThrow(failure);
  });

  it('copies and freezes captured geometry without freezing or retaining the caller array', () => {
    const f = fixture(), input = translated(); f.context.geometry = input; f.context.selectedOnly = true;
    const snapshot = captureSelectionMapDependencies(f.context), key = snapshot.key;
    expect(Object.isFrozen(snapshot)).toBe(true); expect(Object.isFrozen(snapshot.geometry)).toBe(true);
    expect(Object.isFrozen(input)).toBe(false); expect(snapshot.geometry).not.toBe(input);
    expect(snapshot).toMatchObject({ selectedOnly: true, geometrySelectedOnly: true, opacityScale: 1, selectedOpacity: false });
    input[12] = 99;
    expect(snapshot.geometry).toEqual(translated()); expect(snapshot.key).toBe(key);
    expect(captureSelectionMapDependencies(f.context).key).not.toBe(key);
    // Geometry's live-owner invalidation remains context.current()'s job.
    expect(snapshot.assertCurrent).not.toThrow();
  });

  it('copies identity defaults on each capture and preserves explicit geometry scope override', () => {
    const f = fixture(); f.context.selectedOnly = true; f.context.geometrySelectedOnly = false;
    const a = captureSelectionMapDependencies(f.context), b = captureSelectionMapDependencies(f.context);
    expect(a.geometry).toEqual(IDENTITY_MATRIX); expect(a.geometry).not.toBe(IDENTITY_MATRIX);
    expect(a.geometry).not.toBe(b.geometry); expect(a.selectedOnly).toBe(true); expect(a.geometrySelectedOnly).toBe(false);
  });

  it.each([
    ['ordinary source selection', (f: Fixture) => { f.scene.selectedRevision++; }],
    ['display scene revision', (f: Fixture) => { f.scene.revision++; }],
    ['worker selection envelope', (f: Fixture) => { f.client.revision.selectionRevision++; }],
    ['worker draft envelope', (f: Fixture) => { f.client.revision.draftRevision++; }],
    ['worker content envelope', (f: Fixture) => { f.client.revision.contentRevision++; }],
    ['display RGB grading', (f: Fixture) => { f.context.grade = [...NEUTRAL_COLOR]; f.context.grade[0] = 2; }],
    ['inactive transform target', (f: Fixture) => { f.targets.transformBase++; }],
    ['inactive opacity target', (f: Fixture) => { f.targets.opacityBase++; }],
    ['display color target', (f: Fixture) => { f.targets.colorBase++; }],
    ['identity transform selection scope', (f: Fixture) => { f.context.selectedOnly = true; }],
    ['neutral opacity selection scope', (f: Fixture) => { f.context.opacitySelectedOnly = true; }],
  ] as const)('preserves intentional raw-surface reuse for %s', (_name, mutate) => {
    const f = fixture(), first = captureSelectionMapDependencies(f.context);
    mutate(f);
    expect(first.assertCurrent).not.toThrow();
    expect(captureSelectionMapDependencies(f.context).key).toBe(first.key);
  });

  it.each([
    ['selected geometry', (f: Fixture) => { f.context.geometry = translated(); f.context.geometrySelectedOnly = true; }],
    ['selected opacity', (f: Fixture) => { f.context.opacityScale = 2; f.context.opacitySelectedOnly = true; }],
  ] as const)('tracks canonical selection only for active %s', (_name, configure) => {
    const f = fixture(); configure(f);
    const first = captureSelectionMapDependencies(f.context); f.scene.selectedRevision++;
    expect(first.assertCurrent).toThrow(StaleGpuQueryError);
    expect(captureSelectionMapDependencies(f.context).key).not.toBe(first.key);
  });

  it.each([
    ['transformBase', (f: Fixture) => { f.context.geometry = translated(); f.context.geometrySelectedOnly = true; }],
    ['opacityBase', (f: Fixture) => { f.context.opacityScale = 2; f.context.opacitySelectedOnly = true; }],
  ] as const)('tracks active %s target ownership without a canonical mask change', (target, configure) => {
    const f = fixture(); configure(f);
    const first = captureSelectionMapDependencies(f.context); f.targets[target]++;
    expect(first.assertCurrent).toThrow(StaleGpuQueryError);
    expect(captureSelectionMapDependencies(f.context).key).not.toBe(first.key);
  });

  it('keeps unrestricted geometry and opacity independent of canonical selection and preview targets', () => {
    const f = fixture(); f.context.geometry = translated(); f.context.opacityScale = 2;
    const first = captureSelectionMapDependencies(f.context);
    f.scene.selectedRevision++; f.targets.transformBase++; f.targets.opacityBase++;
    expect(first.assertCurrent).not.toThrow(); expect(captureSelectionMapDependencies(f.context).key).toBe(first.key);
  });

  it('tracks opacity scope changes only while opacity is active', () => {
    const f = fixture(); f.context.opacityScale = 2;
    const first = captureSelectionMapDependencies(f.context); f.context.opacitySelectedOnly = true;
    expect(first.assertCurrent).toThrow(StaleGpuQueryError);
    expect(captureSelectionMapDependencies(f.context).key).not.toBe(first.key);
  });

  it('normalizes opacity to f32 for both the key and currentness', () => {
    const f = fixture(); f.context.opacityScale = 1 + 1e-8; f.context.opacitySelectedOnly = true;
    const snapshot = captureSelectionMapDependencies(f.context);
    expect(snapshot.opacityScale).toBe(1); expect(snapshot.selectedOpacity).toBe(false);
    f.context.opacityScale = 1; f.context.opacitySelectedOnly = false;
    expect(snapshot.assertCurrent).not.toThrow(); expect(captureSelectionMapDependencies(f.context).key).toBe(snapshot.key);
  });

  it('uses absent preview-target methods as zero for isolated legacy scene doubles', () => {
    const f = fixture(); f.context.geometry = translated(); f.context.geometrySelectedOnly = true;
    f.context.opacityScale = 2; f.context.opacitySelectedOnly = true;
    const { previewMaskRevision: _unused, ...sceneWithoutTargets } = f.scene;
    f.context.scene = sceneWithoutTargets as unknown as GpuScene;
    const snapshot = captureSelectionMapDependencies(f.context);
    expect(snapshot.key.endsWith(':0:0:0')).toBe(true); expect(snapshot.assertCurrent).not.toThrow();
  });

  it.each([NaN, Infinity, -Infinity, -.001, 5.001])('refuses invalid opacity %s before query work', opacityScale => {
    const f = fixture(); f.context.opacityScale = opacityScale;
    expect(() => captureSelectionMapDependencies(f.context)).toThrow('Opacity scale must be between 0 and 5.');
    expect(f.context.current).not.toHaveBeenCalled();
  });
});
