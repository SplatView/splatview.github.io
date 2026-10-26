import { expect, test } from '@playwright/test';
import type {} from './geometry-viewer-harness';
import { gaussianPly } from '../tests/fixtures/gaussians';

for (const backend of ['webgpu', 'webgl2'] as const) for (const outcome of ['publish', 'cancel', 'reject'] as const) {
  const cancel = outcome === 'cancel';
  test(`${backend} candidate recovery overlaps held upload completion with outcome=${outcome}`, async ({ page }, info) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`/e2e/backend-bench-harness.html?graphics=${backend}`);
    await page.waitForFunction(() => window.geometryViewer?.ready());
    await page.getByLabel('Open scene files').setInputFiles({ name: 'old.ply', mimeType: 'application/octet-stream', buffer: Buffer.from(gaussianPly(0)) });
    await expect(page).toHaveTitle('old.ply — SplatView');
    await page.evaluate(async ({ source, cancel, outcome }) => {
      const app = window.geometryViewer.controllerForRendererNavigation();
      const CoreClient = app.client!.constructor as typeof import('../src/document/coreClient').CoreClient;
      const finish = app.renderer!.finish.bind(app.renderer!);
      await finish();
      let release!: () => void, held = false;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const oldClient = app.client;
      const probe = { checkpointPrepared: false, oldDocumentRetained: false, finished: false, closed: false,
        cancel, release, oldClient, complete: undefined as Promise<void> | undefined, close: undefined as Promise<void> | undefined };
      (window as unknown as { loadOverlap: typeof probe }).loadOverlap = probe;
      app.renderer!.finish = async () => {
        await finish();
        if (!held) { held = true; await gate; if (outcome === 'reject') throw new Error('held upload failed'); }
      };
      const capture = CoreClient.prototype.captureRecoveryCheckpoint;
      CoreClient.prototype.captureRecoveryCheckpoint = async function (...args) {
        const result = await capture.apply(this, args);
        probe.checkpointPrepared = true; probe.oldDocumentRetained = app.client === oldClient;
        return result;
      };
      probe.complete = app.openFiles([new File([source], 'candidate.ply')]).then(() => { probe.finished = true; });
    }, { source: gaussianPly(0), cancel, outcome });
    await page.waitForFunction(() => (window as unknown as { loadOverlap: { checkpointPrepared: boolean } }).loadOverlap.checkpointPrepared);
    const held = await page.evaluate(() => {
      const probe = (window as unknown as { loadOverlap: { finished: boolean; oldDocumentRetained: boolean } }).loadOverlap;
      return { finished: probe.finished, oldDocumentRetained: probe.oldDocumentRetained,
        sourceLoads: window.geometryViewer.controllerForRendererNavigation().benchmarkSnapshot().knownPending.sourceLoadTasks };
    });
    expect(held).toEqual({ finished: false, oldDocumentRetained: true, sourceLoads: 1 });
    await expect(page).toHaveTitle('old.ply — SplatView');
    if (cancel) {
      await page.evaluate(() => {
        const probe = (window as unknown as { loadOverlap: { close?: Promise<void>; closed: boolean } }).loadOverlap;
        probe.close = window.geometryViewer.controllerForRendererNavigation().closeScene().then(() => { probe.closed = true; });
      });
      expect(await page.evaluate(() => (window as unknown as { loadOverlap: { closed: boolean } }).loadOverlap.closed)).toBe(false);
    }
    const after = await page.evaluate(async () => {
      const probe = (window as unknown as { loadOverlap: { release(): void; complete: Promise<void>; close?: Promise<void>; oldClient: object } }).loadOverlap;
      probe.release(); await probe.complete; await probe.close;
      const app = window.geometryViewer.controllerForRendererNavigation();
      return { scene: app.scene?.kind ?? null, sourceLoads: app.benchmarkSnapshot().knownPending.sourceLoadTasks,
        candidate: app.benchmarkSnapshot().knownPending.candidateClient, oldClientRetained: app.client === probe.oldClient,
        error: app.benchmarkSnapshot().state.error,
        environment: { userAgent: navigator.userAgent, secure: isSecureContext, crossOriginIsolated } };
    });
    expect(after).toMatchObject({ scene: cancel ? null : 'gaussian', sourceLoads: 0, candidate: false });
    if (outcome === 'publish') await expect(page).toHaveTitle('candidate.ply — SplatView');
    if (outcome === 'reject') {
      await expect(page).toHaveTitle('old.ply — SplatView');
      expect(after.oldClientRetained).toBe(true); expect(after.error).toBe('held upload failed');
    }
    expect(errors).toEqual([]);
    await info.attach('load-overlap.json', { body: JSON.stringify({ backend, outcome, held, after, errors }), contentType: 'application/json' });
  });
}
