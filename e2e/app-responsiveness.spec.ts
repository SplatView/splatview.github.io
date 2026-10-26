import { expect, test, type Page } from '@playwright/test';
import type {} from './geometry-viewer-harness';
import type { CameraGesture, InputResponse } from './app-input-probe';

type InputPattern = 'isolated' | 'stream';
const warmup = 8;

async function driveInputs(page: Page, gesture: CameraGesture, pattern: InputPattern, x: number, y: number) {
  const count = pattern === 'isolated' ? 120 : 240;
  const button = gesture === 'orbit' ? 'middle' : 'right';
  const isolated: InputResponse[] = [];

  if (gesture !== 'zoom') await page.mouse.down({ button });
  try {
    for (let i = 0; i < count + warmup; i++) {
      if (gesture === 'zoom') {
        await page.mouse.wheel(0, i % 2 ? -6 : 6);
      } else {
        const step = i % 16, offset = step < 8 ? step * 6 - 24 : 72 - step * 6;
        await page.mouse.move(x + offset, y + Math.sin(i * Math.PI / 8) * 9);
      }
      if (pattern === 'isolated' || i < warmup) {
        const sample = await page.evaluate(id => window.appInputProbe.waitForInput(id), i + 1);
        if (i >= warmup) isolated.push(sample);
      } else {
        await page.waitForTimeout(8);
      }
    }
    return { count, isolated };
  } finally {
    if (gesture !== 'zoom') await page.mouse.up({ button });
  }
}

for (let repetition = 0; repetition < 3; repetition++) for (const backend of ['webgpu', 'webgl2'] as const) {
  test(`${backend} actual App orbit/pan/zoom responsiveness repetition ${repetition + 1}`, async ({ page }, info) => {
    test.setTimeout(300000);
    await page.goto(`/e2e/backend-bench-harness.html?graphics=${backend}`);
    await page.waitForFunction(() => window.geometryViewer?.ready());
    await page.getByRole('button', { name: 'Open example', exact: true }).click();
    await expect(page).toHaveTitle('Bench example.sog — SplatView');

    const initial = await page.evaluate(async () => {
      const url = '/e2e/app-input-probe.ts', { waitForAppInputIdle } = await import(/* @vite-ignore */ url);
      const app = window.geometryViewer.controllerForRendererNavigation();
      await waitForAppInputIdle(app);
      return { camera: app.camera!.state, backend: app.renderer!.backend };
    });
    expect(initial.backend).toBe(backend);
    const bounds = await page.locator('canvas').first().boundingBox();
    if (!bounds) throw new Error('The App canvas is unavailable.');
    const x = bounds.x + bounds.width * .45, y = bounds.y + bounds.height * .55;

    for (const gesture of ['orbit', 'pan', 'zoom'] as const) for (const pattern of ['isolated', 'stream'] as const) {
      console.log('Measuring App input', backend, `repetition ${repetition + 1}`, gesture, pattern);
      await page.mouse.move(x, y);
      await page.evaluate(async ({ camera, gesture }: { camera: number[]; gesture: CameraGesture }) => {
        const url = '/e2e/app-input-probe.ts';
        const { installAppInputProbe, waitForAppInputIdle } = await import(/* @vite-ignore */ url);
        const app = window.geometryViewer.controllerForRendererNavigation();
        app.camera!.set(camera); app.invalidate();
        await waitForAppInputIdle(app);
        window.appInputProbe = installAppInputProbe(app, gesture);
      }, { camera: initial.camera, gesture });

      try {
        const { count, isolated } = await driveInputs(page, gesture, pattern, x, y);
        const value = await page.evaluate(() => window.appInputProbe.finish());
        await info.attach(`app-responsiveness-${gesture}-${pattern}.json`, {
          body: JSON.stringify({ schemaVersion: 1, backend, repetition, pattern, warmup,
            intendedInputs: count, initialCamera: initial.camera, isolated, ...value }),
          contentType: 'application/json',
        });
        expect(value.errors).toEqual([]);
        expect(value.inputs).toHaveLength(count + warmup);
        expect(value.inputs.every(event => event.trusted)).toBe(true);
        expect(value.frames.every(frame => frame.completedMs! >= frame.submittedMs && frame.submittedMs >= frame.startedMs && frame.pending <= 2)).toBe(true);
        expect(new Set(value.frames.map(frame => frame.sequence)).size).toBe(value.frames.length);
        expect(value.frames.at(-1)?.precision).toBe(32);
        expect(value.scene).toMatchObject({ count: 262556, degree: 3 });
        expect(isolated).toHaveLength(pattern === 'isolated' ? 120 : 0);
      } finally {
        await page.evaluate(() => window.appInputProbe?.restore());
      }
    }
  });
}
