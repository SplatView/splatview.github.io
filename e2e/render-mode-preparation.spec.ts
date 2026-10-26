import { expect, test } from '@playwright/test';
import type {} from './geometry-viewer-harness';

for (const backend of ['webgpu', 'webgl2'] as const) test(`${backend} General settings prepares only shaders and retains exact mode transitions`, async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`/e2e/backend-bench-harness.html?graphics=${backend}`);
  await page.waitForFunction(() => window.geometryViewer?.ready());
  await page.getByRole('button', { name: 'Open example', exact: true }).click();
  await expect(page).toHaveTitle('Bench example.sog — SplatView');
  await page.evaluate(() => {
    const app = window.geometryViewer.controllerForRendererNavigation(), renderer = app.renderer!;
    const prepare = renderer.prepareRenderMode.bind(renderer);
    const probe = { calls: 0, done: false, before: { ...renderer.steadySnapshot }, after: renderer.steadySnapshot,
      document: { ...app.client!.revision }, camera: app.camera!.state };
    (window as unknown as { modePreparation: typeof probe }).modePreparation = probe;
    renderer.prepareRenderMode = async mode => {
      probe.calls++; await prepare(mode); probe.after = { ...renderer.steadySnapshot }; probe.done = true;
    };
  });
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await page.waitForFunction(() => (window as unknown as { modePreparation: { done: boolean } }).modePreparation.done);
  const before = await page.evaluate(() => {
    const app = window.geometryViewer.controllerForRendererNavigation();
    return { ...(window as unknown as { modePreparation: object }).modePreparation,
      currentDocument: { ...app.client!.revision }, currentCamera: app.camera!.state };
  });
  expect(before).toMatchObject({ calls: 1, before: { status: 'sorted', allocationBytes: 0 }, after: { status: 'sorted', allocationBytes: 0, frame: 0 } });
  expect((before as typeof before & { document: object }).document).toEqual(before.currentDocument);
  expect((before as typeof before & { camera: number[] }).camera).toEqual(before.currentCamera);
  const mode = settings.getByRole('combobox', { name: 'Gaussian renderer', exact: true });
  await expect(mode).toHaveValue('sorted'); await mode.selectOption('steady');
  await page.waitForFunction(() => window.geometryViewer.controllerForRendererNavigation().renderer!.steadySnapshot.restFrames === 16);
  await mode.selectOption('sorted');
  await page.waitForFunction(() => {
    const snapshot = window.geometryViewer.controllerForRendererNavigation().renderer!.steadySnapshot;
    return snapshot.status === 'sorted' && snapshot.allocationBytes === 0;
  });
  const after = await page.evaluate(() => {
    const app = window.geometryViewer.controllerForRendererNavigation();
    return { document: { ...app.client!.revision }, camera: app.camera!.state, snapshot: app.renderer!.steadySnapshot,
      environment: { browser: navigator.userAgent, secure: isSecureContext, crossOriginIsolated } };
  });
  expect(after.document).toEqual(before.currentDocument); expect(after.camera).toEqual(before.currentCamera);
  expect(errors).toEqual([]);
  await info.attach('mode-preparation.json', { body: JSON.stringify({ backend, before, after, errors }), contentType: 'application/json' });
});
