import { expect, test } from '@playwright/test';
import type {} from './geometry-viewer-harness';
import type { ResourceLedger } from '../src/document/resources';
import { gaussianPly } from '../tests/fixtures/gaussians';

test('the browser explains resource-dependent input admission before opening a scene', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.empty-state').getByText('Memory and GPU limits apply', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Choose a scene file', exact: true })).toHaveAttribute('title', 'Memory and GPU limits apply');
  await expect(page.getByRole('button', { name: 'Open scene', exact: true })).toHaveAttribute('title', 'Memory and GPU limits apply');
});

for (const entry of ['picker', 'drop', 'adjacent', 'shadowed-controller'] as const) {
  test(`${entry} refuses an oversized file before reading or changing the edited document`, async ({ page }, testInfo) => {
    await page.goto('/e2e/geometry-viewer-harness.html');
    await page.waitForFunction(() => window.geometryViewerError || window.geometryViewer?.ready());
    expect(await page.evaluate(() => window.geometryViewerError)).toBeUndefined();
    const result = await page.evaluate(async ({ entry, gaussian }) => {
      const app = window.geometryViewer.controllerForSourceNavigation();
      // Immutable Blob parts share one small backing block. No 512 MiB body is
      // read or transferred to the browser automation process.
      const block = new Blob([new Uint8Array(1024 * 1024)]);
      const oversized = new File([...Array<Blob>(512).fill(block), new Uint8Array(1)], 'z-oversized.ply');
      const intrinsicBytes = Object.getOwnPropertyDescriptor(Blob.prototype, 'size')!.get!.call(oversized) as number;
      let reads = 0;
      oversized.slice = () => { reads++; throw new Error('Oversized source was read'); };
      oversized.arrayBuffer = async () => { reads++; throw new Error('Oversized source was read'); };
      await app.openFiles([new File([new Uint8Array(gaussian)], 'a-kept.ply'), oversized]);
      await app.command({ command: 'selectAll' });
      // File publication can finish before startup's first rendered frame.
      // Join the actual color admission predicate before preparing edits.
      const colorReady = async () => {
        const readyDeadline = performance.now() + 10_000;
        while (!app.colorControlsEnabled) {
          if (performance.now() >= readyDeadline) throw new Error('Color controls did not become ready');
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        }
      };
      await colorReady();
      const values = [1.2, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
      if (!await app.command({ command: 'grade', values })) throw new Error('First edit failed');
      await colorReady();
      values[0] = 1.5;
      if (!await app.command({ command: 'grade', values })) throw new Error('Second edit failed');
      await colorReady();
      if (!await app.command({ command: 'undo' })) throw new Error('Redo fixture failed');
      app.camera!.orbit(11, -7); app.cycleBackground(); app.invalidate();
      const before = await window.geometryViewer.snapshot(), client = app.client, scene = app.scene;
      const ledger = (app as unknown as { ledger: ResourceLedger }).ledger;
      const reserve = ledger.reserve, worker = window.Worker;
      const reservations: { category: Parameters<ResourceLedger['reserve']>[0]; bytes: number }[] = [];
      const navigation = window.geometryViewer.observeSourceNavigation(); let workers = 0;
      ledger.reserve = function (...args: Parameters<ResourceLedger['reserve']>) {
        reservations.push({ category: args[0], bytes: args[1] }); return Reflect.apply(reserve, this, args);
      };
      window.Worker = new Proxy(worker, { construct(target, args, receiver) {
        workers++; return Reflect.construct(target, args, receiver);
      } });
      try {
        if (entry === 'adjacent') await app.adjacent(1);
        else if (entry === 'shadowed-controller') {
          Object.defineProperty(oversized, 'size', { value: 1 });
          await app.openFiles([oversized]);
        } else {
          const transfer = new DataTransfer(); transfer.items.add(oversized);
          if (entry === 'picker') {
            const input = document.querySelector<HTMLInputElement>('input[aria-label="Open scene files"]')!;
            input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true }));
          } else document.querySelector('main')!.dispatchEvent(new DragEvent('drop', {
            bubbles: true, cancelable: true, dataTransfer: transfer,
          }));
        }
        // Join the actual controller promise dispatched by the picker/drop,
        // including metadata preflight and all staged catalog retirement.
        await navigation.joined();
      } finally { navigation.restore(); ledger.reserve = reserve; window.Worker = worker; }
      const after = await window.geometryViewer.snapshot();
      const sameClient = app.client === client, sameScene = app.scene === scene;
      return { intrinsicBytes, reads, reservations, workers, before, after, sameClient, sameScene };
    }, { entry, gaussian: Array.from(gaussianPly(0)) });
    expect(result.intrinsicBytes).toBe(536_870_913);
    expect(result.reads).toBe(0); expect(result.workers).toBe(0);
    // Discovery admits only temporary source-name/handle bookkeeping. The
    // source-inclusive decode budget refuses before a probe, candidate or body range.
    expect(result.reservations).toEqual(entry === 'adjacent' ? [] : [
      ...(entry === 'drop' ? [{ category: 'source', bytes: 65_792 }] : []),
      { category: 'source', bytes: 65_536 }, { category: 'source', bytes: 65_792 },
    ]);
    expect(result.sameClient).toBe(true); expect(result.sameScene).toBe(true);
    expect(result.before.summary.canRedo).toBe(true); expect(result.before.dirty).toBe(true);
    expect(result.after).toEqual(result.before);
    await expect(page.getByRole('alert')).toContainText('The scene source does not fit within the available decode memory budget.');
    await expect(page.getByRole('dialog', { name: 'Unsaved changes' })).toHaveCount(0);
    const history = await page.evaluate(async () => {
      const app = window.geometryViewer.controllerForSourceNavigation();
      const redone = await app.command({ command: 'redo' }), afterRedo = await window.geometryViewer.snapshot();
      const undone = await app.command({ command: 'undo' }), afterUndo = await window.geometryViewer.snapshot();
      return { redone, undone, afterRedo, afterUndo };
    });
    expect(history.redone).toBe(true); expect(history.undone).toBe(true);
    expect(history.afterRedo.exported).not.toBe(result.before.exported);
    expect(history.afterUndo.exported).toBe(result.before.exported);
    expect(history.afterUndo.gpuMasks).toEqual(result.before.gpuMasks);
    await testInfo.attach(`limited-input-${entry}.json`, { body: JSON.stringify({ ...result, ...history }), contentType: 'application/json' });
  });
}
