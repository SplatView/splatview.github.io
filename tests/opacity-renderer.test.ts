import { describe, expect, it } from 'vitest';
import { GaussianRenderer, type GpuScene, StaleGpuQueryError } from '../src/renderer/webgpu/renderer';
import { IDENTITY_MATRIX, NEUTRAL_COLOR } from '../src/renderer/defaults';
import type { CameraController } from '../src/input/camera';

type FrameOwner = {
  setOpacityPreview(scale: number, selectedOnly: boolean): void;
  querySnapshot(scene: GpuScene): () => void;
  surfaceSnapshot(scene: GpuScene): () => void;
  uniform(scene: GpuScene, camera: CameraController, grade: number[], highlight: boolean, geometry: number[],
    gradeScope: boolean, width: number, height: number, geometryScope: boolean, alpha: number, alphaScope: boolean, admit?: boolean): void;
};
function fixture() {
  let frame = new Float32Array(80);
  const renderer = Object.assign(Object.create(GaussianRenderer.prototype), {
    canvas: { width: 65, height: 49 }, frame: {}, frameRevision: 0, requireScene() {},
    device: { queue: { writeBuffer(_buffer: unknown, _offset: number, data: Float32Array) { frame = new Float32Array(data); } } },
  }) as FrameOwner;
  const targets = { colorBase: 0, transformBase: 0, opacityBase: 0 };
  const scene = { kind: 'gaussian', count: 2, stride: 48, degree: 0, revision: 1,
    previewMaskRevision: (channel: keyof typeof targets) => targets[channel],
    sourceRevision: 1, selectedRevision: 1, sortDirty: false, lastGeometry: '' } as unknown as GpuScene;
  const camera = { view: new Float32Array(IDENTITY_MATRIX), projection: new Float32Array(IDENTITY_MATRIX),
    eye: new Float32Array([0, 0, 3]), revision: 1, background: 'black' } as unknown as CameraController;
  const draw = (alpha = 1, alphaScope = false, gradeScope = false, geometryScope = false, admit = true) =>
    renderer.uniform(scene, camera, [...NEUTRAL_COLOR], false, [...IDENTITY_MATRIX], gradeScope, 65, 49,
      geometryScope, alpha, alphaScope, admit);
  return { renderer, scene, draw, targets, floats: () => frame, words: () => new Uint32Array(frame.buffer) };
}
describe('opacity preview query identity and independent scope', () => {
  it.each([[false, false], [false, true], [true, false], [true, true]] as const)
    ('keeps RGB selected=%s separate from opacity selected=%s', (gradeScope, alphaScope) => {
      const f = fixture(); f.draw(2, alphaScope, gradeScope);
      expect(f.floats()[59]).toBe(2); expect(f.words()[43]).toBe(Number(gradeScope));
      expect(f.words()[79]).toBe(alphaScope ? 3 : 1); expect(f.words()[76]).toBe(0);
      expect(f.words()[77]).toBe(0); expect(f.floats().byteLength).toBe(320);
    });
  it('normalizes neutral scope and preserves outstanding queries', () => {
    const f = fixture(); f.draw(); f.scene.sortDirty = false;
    const surface = f.renderer.surfaceSnapshot(f.scene), pick = f.renderer.querySnapshot(f.scene);
    f.renderer.setOpacityPreview(1, true); f.draw(1, true);
    expect(f.words()[79]).toBe(0); expect(f.scene.sortDirty).toBe(false);
    expect(surface).not.toThrow(); expect(pick).not.toThrow();
  });
  it('retires pending queries immediately before a new frame is rendered', () => {
    const f = fixture(); f.draw(); const surface = f.renderer.surfaceSnapshot(f.scene), pick = f.renderer.querySnapshot(f.scene);
    f.renderer.setOpacityPreview(2, false);
    expect(surface).toThrow(StaleGpuQueryError); expect(pick).toThrow(StaleGpuQueryError);
    expect(() => f.renderer.surfaceSnapshot(f.scene)).toThrow(StaleGpuQueryError);
    expect(() => f.renderer.querySnapshot(f.scene)).toThrow(StaleGpuQueryError);
    f.draw(2); expect(f.renderer.surfaceSnapshot(f.scene)).not.toThrow();
  });
  it('does not admit an older frozen capture as the current preview', () => {
    const f = fixture(); f.draw(2); f.renderer.setOpacityPreview(3, false);
    f.draw(2, false, false, false, false);
    expect(() => f.renderer.querySnapshot(f.scene)).toThrow(StaleGpuQueryError);
    expect(() => f.renderer.surfaceSnapshot(f.scene)).toThrow(StaleGpuQueryError);
    f.draw(3); expect(f.renderer.querySnapshot(f.scene)).not.toThrow();
  });
  it.each([false, true])('mask revision matters only to active selected opacity=%s', selected => {
    const f = fixture(); f.draw(2, selected); const surface = f.renderer.surfaceSnapshot(f.scene);
    f.scene.selectedRevision++;
    if (selected) expect(surface).toThrow(StaleGpuQueryError); else expect(surface).not.toThrow();
  });
  it('alpha changes refresh surfaces without issuing another depth sort', () => {
    const f = fixture(); f.draw(); f.scene.sortDirty = false;
    for (const scale of [2, 0, 1, 5]) {
      const surface = f.renderer.surfaceSnapshot(f.scene); f.draw(scale);
      expect(surface).toThrow(StaleGpuQueryError); expect(f.scene.sortDirty).toBe(false);
    }
  });
  it('retires a selected opacity surface when its frozen target owner changes before another frame', () => {
    const f = fixture(); f.draw(2, true); const check = f.renderer.surfaceSnapshot(f.scene);
    f.targets.opacityBase++; expect(check).toThrow(StaleGpuQueryError);
  });
  it('ignores inactive opacity targets in raw surfaces', () => {
    const f = fixture(); f.draw(1); const check = f.renderer.surfaceSnapshot(f.scene);
    f.targets.opacityBase++; expect(check).not.toThrow();
  });
  it('uses float32 identity without expiring an unchanged preview', () => {
    const f = fixture(); f.draw(1.1); const surface = f.renderer.surfaceSnapshot(f.scene);
    f.renderer.setOpacityPreview(Math.fround(1.1), false);
    expect(surface).not.toThrow(); expect(f.floats()[59]).toBe(Math.fround(1.1));
  });
  it.each([-1, 5.0001, NaN, Infinity, -Infinity])('refuses invalid scale %s without replacing the prepared frame', scale => {
    const f = fixture(); f.draw(2); const surface = f.renderer.surfaceSnapshot(f.scene);
    expect(() => f.renderer.setOpacityPreview(scale, false)).toThrow(RangeError);
    expect(() => f.draw(scale)).toThrow(RangeError); expect(surface).not.toThrow();
  });
});
