import { expect, test } from '@playwright/test';
import type {} from './geometry-viewer-harness';
import type { SceneRenderer } from '../src/renderer/contracts';

type Submission = { sequence: number; submittedMs: number; completedMs?: number; pending: number };
declare global { interface Window { displayThroughputProbe: {
  rows: Submission[]; inputs: { atMs: number; trusted: boolean }[]; errors: string[];
  finish(): Promise<void>; restore(): void;
} } }

for (const backend of ['webgpu', 'webgl2'] as const) for (let repetition = 0; repetition < 3; repetition++) {
  test(`${backend} bounded App display throughput repetition ${repetition + 1}`, async ({ page }, info) => {
    test.setTimeout(180000);
    await page.goto(`/e2e/backend-bench-harness.html?graphics=${backend}`);
    await page.waitForFunction(() => window.geometryViewer?.ready());
    await page.getByRole('button', { name: 'Open example', exact: true }).click();
    await expect(page).toHaveTitle('Bench example.sog — SplatView');
    const bounds = await page.locator('canvas').first().boundingBox(); if (!bounds) throw new Error('App canvas unavailable.');
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    for (const mode of ['sorted', 'steady'] as const) {
      await page.evaluate(async mode => {
        const app = window.geometryViewer.controllerForRendererNavigation();
        const r = (app as unknown as { renderer: SceneRenderer }).renderer;
        app.setRenderSettings({ mode, historyWeight: .7, convergence: true, convergenceFrames: 16, animate: true });
        await r.finish();
        let pending = 0; const joins: Promise<void>[] = [];
        const rows: Submission[] = [], inputs: { atMs: number; trusted: boolean }[] = [], errors: string[] = [];
        const original = r.render.bind(r), record = (sequence: number) => {
          const checkpoint = r.displayCompletion?.();
          if (!checkpoint || checkpoint.submissionSequence <= sequence) return;
          const row = { sequence: checkpoint.submissionSequence, submittedMs: performance.now(), pending: ++pending } as Submission;
          if (rows.length < 1024) rows.push(row);
          joins.push(checkpoint.done.then(() => { row.completedMs = performance.now(); }, error => { errors.push(String(error)); }).finally(() => { pending--; }));
        };
        r.render = (...args) => {
          const before = r.frameSubmissionSequence, task = original(...args);
          if (task) return task.then(() => record(before));
          record(before);
        };
        const input = (event: WheelEvent) => { if (inputs.length < 1024) inputs.push({ atMs: performance.now(), trusted: event.isTrusted }); };
        document.addEventListener('wheel', input, { capture: true });
        window.displayThroughputProbe = { rows, inputs, errors,
          async finish() { await r.finish(); await Promise.all(joins); },
          restore() { r.render = original; document.removeEventListener('wheel', input, { capture: true }); },
        };
      }, mode);
      for (let i = 0; i < 240; i++) { await page.mouse.wheel(0, i % 2 ? -2 : 2); await page.waitForTimeout(8); }
      const value = await page.evaluate(async () => {
        const probe = window.displayThroughputProbe; await probe.finish(); probe.restore();
        return { rows: probe.rows, inputs: probe.inputs, errors: probe.errors,
          environment: { userAgent: navigator.userAgent, secureContext: isSecureContext, crossOriginIsolated, dpr: devicePixelRatio } };
      });
      await info.attach(`display-throughput-${mode}.json`, { body: JSON.stringify({ backend, mode, repetition, ...value,
        scope: 'Trusted wheel stream through actual App; actual submission/fence wall clocks. Physical presentation unavailable.' }), contentType: 'application/json' });
      expect(value.errors).toEqual([]); expect(value.inputs).toHaveLength(240); expect(value.inputs.every(input => input.trusted)).toBe(true);
      expect(value.rows.length).toBeGreaterThan(10);
      expect(value.rows.every(row => row.completedMs! >= row.submittedMs && row.pending <= 2)).toBe(true);
      expect(new Set(value.rows.map(row => row.sequence)).size).toBe(value.rows.length);
    }
  });
}
