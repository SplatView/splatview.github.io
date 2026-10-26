import type { Page } from '@playwright/test';
import { gaussianPly } from '../tests/fixtures/gaussians';
import type { WasmModule } from '../src/workers/wasm';
import type { CameraModule } from '../src/input/camera';
import type { NativeSummary } from '../src/document/types';

// Separate shipping native modules compute centers in development and production;
// the oracle never imports a development application module or the App controller.
export async function fixtureCenters(page: Page, bytes = gaussianPly(), points = [[-.4, 0, 0], [.4, 0, 0], [0, .4, .1]]) {
  if (bytes.byteLength > 4 * 1024 * 1024 || points.length > 1000) throw new Error('The coordinate oracle requires a bounded literal fixture.');
  return page.evaluate(async ({ bytes, points }) => {
    const coreUrl = '/wasm/splatview-core.mjs', cameraUrl = '/wasm/splatview-camera.mjs';
    const [{ default: coreFactory }, { default: cameraFactory }] = await Promise.all([
      import(/* @vite-ignore */ coreUrl), import(/* @vite-ignore */ cameraUrl),
    ]);
    const core: WasmModule = await coreFactory(), camera: CameraModule = await cameraFactory();
    const input = core._malloc(bytes.length), pointer = camera._malloc(46 * 4);
    if (!input || !pointer) { if (input) core._free(input); if (pointer) camera._free(pointer); throw new Error('The native coordinate oracle could not allocate its bounded inputs.'); }
    try {
      core.HEAPU8.set(bytes, input);
      const summary = JSON.parse(core.UTF8ToString(core._sv_open(input, bytes.length, 0, 1000, 128 * 1024 * 1024))) as NativeSummary;
      if (!summary.ok || !summary.camera) throw new Error(summary.error ?? 'The actual native coordinate fixture was refused.');
      const bounds = document.querySelector('canvas')!.getBoundingClientRect();
      const state = [...summary.camera]; state[10] = bounds.width / bounds.height;
      camera.HEAPF32.set(state, pointer / 4); camera._sv_camera(pointer, 0, 0, 0, 0);
      const view = camera.HEAPF32.slice(pointer / 4 + 11, pointer / 4 + 27), projection = camera.HEAPF32.slice(pointer / 4 + 27, pointer / 4 + 43);
      const multiply = (point: number[], matrix: Float32Array) => Array.from({ length: 4 }, (_, column) =>
        point.reduce((sum, coordinate, row) => sum + coordinate * matrix[row * 4 + column], 0));
      return points.map(point => {
        const clip = multiply(multiply([...point, 1], view), projection);
        return [bounds.x + (clip[0] / clip[3] + 1) * bounds.width / 2, bounds.y + (1 - clip[1] / clip[3]) * bounds.height / 2];
      });
    } finally { core._free(input); camera._free(pointer); }
  }, { bytes: Array.from(bytes), points });
}
