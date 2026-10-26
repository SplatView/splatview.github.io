import { describe, expect, it } from 'vitest';
import { GaussianRenderer, type GpuScene, StaleGpuQueryError } from '../src/renderer/webgpu/renderer';
import { IDENTITY_MATRIX, NEUTRAL_COLOR } from '../src/renderer/defaults';
import type { CameraController } from '../src/input/camera';

type UniformOwner = {
  uniform(scene: GpuScene, camera: CameraController, grade: number[], highlight: boolean, matrix: number[],
    colorSelectedOnly: boolean, width?: number, height?: number, geometrySelectedOnly?: boolean): void;
  surfaceSnapshot(scene: GpuScene): () => void;
  querySnapshot(scene: GpuScene): () => void;
};
function fixture() {
  let bytes = new Float32Array(80);
  // Exercise the real frame writer/query dependency code without allocating a GPU.
  const renderer = Object.assign(Object.create(GaussianRenderer.prototype), {
    canvas: { width: 800, height: 600 }, frame: {}, frameRevision: 0,
    requireScene() {}, device: { queue: { writeBuffer(_target: unknown, _offset: number, data: Float32Array) { bytes = new Float32Array(data); } } },
  }) as UniformOwner;
  const targets = { colorBase: 0, transformBase: 0, opacityBase: 0 };
  const scene = { kind: 'gaussian', count: 2, stride: 64, degree: 0, revision: 1, sourceRevision: 1, selectedRevision: 1,
    previewMaskRevision: (channel: keyof typeof targets) => targets[channel],
    sortDirty: false, lastGeometry: undefined } as unknown as GpuScene;
  const camera = { view: new Float32Array(IDENTITY_MATRIX), projection: new Float32Array(IDENTITY_MATRIX),
    eye: new Float32Array([0, 0, 4]), revision: 1, background: 'black' } as unknown as CameraController;
  const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 0, 0, 1];
  const draw = (color: boolean, geometry: boolean) => renderer.uniform(scene, camera, [...NEUTRAL_COLOR], true, matrix, color, 800, 600, geometry);
  return { renderer, scene, camera, matrix, draw, targets, words: () => new Uint32Array(bytes.buffer), floats: () => bytes };
}
describe('independent display-color and geometry selection scope', () => {
  it.each([[true, false], [false, true], [true, true], [false, false]] as const)
    ('encodes color=%s and transform=%s independently in the existing shader ABI', (color, geometry) => {
      const value = fixture();value.draw(color, geometry);
      expect(value.words()[43]).toBe(Number(color));expect(value.words()[77]).toBe(Number(geometry));
      expect(value.words()[76]).toBe(1);expect(Array.from(value.floats().slice(60, 76))).toEqual(value.matrix);
    });
  it('color scope changes preserve depth order and an outstanding raw-surface query', () => {
    const value = fixture();value.draw(true, false);value.scene.sortDirty = false;
    const check = value.renderer.surfaceSnapshot(value.scene);
    value.draw(false, false);
    expect(value.scene.sortDirty).toBe(false);expect(check).not.toThrow();
  });
  it('transform scope changes invalidate depth order and an outstanding raw-surface query', () => {
    const value = fixture();value.draw(false, false);value.scene.sortDirty = false;
    const check = value.renderer.surfaceSnapshot(value.scene);
    value.draw(false, true);
    expect(value.scene.sortDirty).toBe(true);expect(check).toThrow(StaleGpuQueryError);
  });
  it.each([true, false])('selection-mask revisions matter to surface geometry only when transform scope is selected=%s', selected => {
    const value = fixture();value.draw(false, selected);const check = value.renderer.surfaceSnapshot(value.scene);
    value.scene.selectedRevision++;
    if (selected) expect(check).toThrow(StaleGpuQueryError);else expect(check).not.toThrow();
  });
  it('existing single-scope callers retain their shader behavior', () => {
    const value = fixture();value.renderer.uniform(value.scene, value.camera, [...NEUTRAL_COLOR], true, value.matrix, true);
    expect(value.words()[43]).toBe(1);expect(value.words()[77]).toBe(1);
  });
  it('retires a selected transform surface when its frozen target owner changes before another frame', () => {
    const value = fixture(); value.draw(false, true); const check = value.renderer.surfaceSnapshot(value.scene);
    value.targets.transformBase++; expect(check).toThrow(StaleGpuQueryError);
  });
  it('preserves a raw surface across a color target replacement', () => {
    const value = fixture(); value.draw(true, true); const check = value.renderer.surfaceSnapshot(value.scene);
    value.targets.colorBase++; expect(check).not.toThrow();
  });
  it('an inactive geometry scope preserves a pending contributor query between legacy preparation and display', () => {
    const value = fixture();
    value.renderer.uniform(value.scene, value.camera, [...NEUTRAL_COLOR], true, [...IDENTITY_MATRIX], true);
    const check = value.renderer.querySnapshot(value.scene);value.scene.sortDirty = false;
    value.renderer.uniform(value.scene, value.camera, [...NEUTRAL_COLOR], true, [...IDENTITY_MATRIX], true, 800, 600, false);
    expect(value.words()[43]).toBe(1);expect(value.words()[76]).toBe(0);expect(value.words()[77]).toBe(0);
    expect(value.scene.sortDirty).toBe(false);expect(check).not.toThrow();
  });
  it('an active geometry scope still retires a pending contributor query when display scope changes', () => {
    const value = fixture();value.draw(true, true);
    const check = value.renderer.querySnapshot(value.scene);
    value.draw(true, false);expect(check).toThrow(StaleGpuQueryError);
  });
});
