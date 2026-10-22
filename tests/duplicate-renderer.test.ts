import { describe, expect, it } from 'vitest';
import { GaussianRenderer, type GpuScene } from '../src/renderer/webgpu/renderer';
import { IDENTITY_MATRIX, NEUTRAL_COLOR } from '../src/document/types';
import type { CameraController } from '../src/input/camera';

describe('Duplicate display feedback', () => {
  it('selects green only for the guarded copy selection and keeps clean captures untinted', () => {
    let words = new Uint32Array();
    const renderer = Object.assign(Object.create(GaussianRenderer.prototype), {
      canvas: { width: 64, height: 48 }, frame: {}, frameRevision: 0, requireScene() {},
      device: { queue: { writeBuffer(_buffer: unknown, _offset: number, data: Float32Array) {
        words = new Uint32Array(data.slice().buffer);
      } } },
    }) as { uniform(...args: unknown[]): void };
    const scene = { kind: 'gaussian', count: 3, stride: 48, degree: 0, revision: 1,
      sourceRevision: 1, selectedRevision: 1, sortDirty: false, lastGeometry: '', duplicateSelectionGuarded: true,
      previewMaskRevision() { return 0; } } as unknown as GpuScene;
    const camera = { view: new Float32Array(IDENTITY_MATRIX), projection: new Float32Array(IDENTITY_MATRIX),
      eye: new Float32Array([0, 0, 3]), revision: 1, background: 'black' } as unknown as CameraController;
    const draw = (highlight: boolean) => renderer.uniform(scene, camera, [...NEUTRAL_COLOR], highlight,
      [...IDENTITY_MATRIX], false, 64, 48, false, 1, false);
    draw(true); expect(words[78]).toBe(2);
    draw(false); expect(words[78]).toBe(0);
    Object.assign(scene, { duplicateSelectionGuarded: false });
    draw(true); expect(words[78]).toBe(1);
    draw(false); expect(words[78]).toBe(0);
  });
});
