import type { Page } from '@playwright/test';
import { gaussianPly } from '../tests/fixtures/gaussians';

// A separate native document computes fixture centers without reaching into the
// application's controller or relying on approximate screenshot coordinates.
export async function fixtureCenters(page: Page, bytes = gaussianPly(), points = [[-.4, 0, 0], [.4, 0, 0], [0, .4, .1]]) {
  return page.evaluate(async ({ bytes, points }) => {
    const coreUrl = '/src/document/coreClient.ts', cameraUrl = '/src/input/camera.ts', resourcesUrl = '/src/document/resources.ts';
    const [{ CoreClient }, { CameraController }, { ResourceLedger }] = await Promise.all([
      import(/* @vite-ignore */ coreUrl), import(/* @vite-ignore */ cameraUrl), import(/* @vite-ignore */ resourcesUrl),
    ]);
    const client = new CoreClient(), camera = await CameraController.create(), ledger = new ResourceLedger(128 * 1024 * 1024);
    let closed = false;
    try {
      const { summary } = await client.load(new File([new Uint8Array(bytes)], 'reference.ply'), 1000, 128 * 1024 * 1024, {
        admit: (size: number) => ledger.reserve('work', size),
        current() { if (closed) throw new Error('The coordinate fixture source was closed.'); },
      });
      const bounds = document.querySelector('canvas')!.getBoundingClientRect();
      camera.set(summary.camera); camera.aspect(bounds.width / bounds.height);
      const multiply = (point: number[], matrix: Float32Array) => Array.from({ length: 4 }, (_, column) =>
        point.reduce((sum, coordinate, row) => sum + coordinate * matrix[row * 4 + column], 0));
      return points.map(point => {
        const clip = multiply(multiply([...point, 1], camera.view), camera.projection);
        return [bounds.x + (clip[0] / clip[3] + 1) * bounds.width / 2, bounds.y + (1 - clip[1] / clip[3]) * bounds.height / 2];
      });
    } finally { closed = true; camera.dispose(); client.dispose(); }
  }, { bytes: Array.from(bytes), points });
}
