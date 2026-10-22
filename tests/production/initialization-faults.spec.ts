import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { artifact, controlledCore, deployment, editedRedo, exportBytes, fulfillBytes, grade, nativeFixture,
  observeWorkers, openScene, replaceScene, retainedScene, retired, sceneFile, workers, wrapGenuineFactory } from './initialization-helpers';

// These matching-hash malformed/lifecycle fixtures deliberately reach browser
// initialization gates after verification. They do not claim coherent build
// provenance, an independent deployment, or replacement numerical algorithms.
for (const kind of ['core', 'camera'] as const)
  for (const fault of ['wasm-compile', 'glue-import', 'missing-factory', 'factory-rejection'] as const)
    test(`production ${kind} ${fault} fails after matching-byte verification and retires startup ownership`, async ({ page }) => {
      await observeWorkers(page);
      const manifest = await nativeFixture(page, kind, original => {
        if (fault === 'wasm-compile') {
          const wasm = Buffer.from(original.wasm); wasm[0] ^= 0xff; return { wasm };
        }
        if (fault === 'glue-import') return { glue: Buffer.concat([original.glue, Buffer.from('\nexport const = ;\n')]) };
        if (fault === 'missing-factory') {
          const text = original.glue.toString('utf8'); expect(text.split('export default Module;')).toHaveLength(2);
          return { glue: Buffer.from(text.replace('export default Module;', 'export default {};')) };
        }
        return { glue: wrapGenuineFactory(original.glue,
          `await Module(options); throw new Error('Injected ${kind} factory rejected after genuine instantiation');`) };
      });
      await page.goto('/');
      const message = fault === 'wasm-compile' ? /WebAssembly\.compile|expected magic word|CompileError/
        : fault === 'glue-import' ? /Unexpected token|Unexpected identifier|SyntaxError/
          : fault === 'missing-factory' ? /native module has no factory/
            : `Injected ${kind} factory rejected after genuine instantiation`;
      await expect(page.getByRole('alert')).toContainText(message);
      await expect(page.getByRole('button', { name: 'Open scene', exact: true })).toBeDisabled();
      const records = await workers(page); expect(records).toHaveLength(1); await retired(page, records[0].id);
      expect(records[0].replies.some(reply => reply.summary)).toBe(false);
      if (kind === 'camera') expect(records[0].readyBuild).toEqual(manifest.build);
      else expect(records[0].readyBuild).toBeUndefined();
      // Camera import/factory creates a main-thread glue blob; every startup
      // blob is released. The core glue's worker-local blob is owned by that
      // terminated worker and is not visible in this main-thread observation.
      const blobs = await page.evaluate(() => ({ created: window.__initializationMonitor.createdBlobUrls,
        revoked: window.__initializationMonitor.revokedBlobUrls }));
      expect(blobs.created.length).toBeGreaterThanOrEqual(kind === 'camera' && fault !== 'wasm-compile' ? 2 : 1);
      for (const url of blobs.created) expect(blobs.revoked).toContain(url);
    });

test('candidate genuine-factory rejection retains exact edited bytes, masks, revisions, source and isolated Redo', async ({ page }) => {
  await observeWorkers(page); const control = await controlledCore(page, ['pass', 'reject']);
  const before = await editedRedo(page); expect(control.calls()).toBe(1);
  await replaceScene(page);
  await expect(page.getByRole('alert')).toContainText('Injected genuine-factory readiness failure');
  await expect(page.locator('.status.panel')).toHaveCount(0); expect(control.calls()).toBe(2);
  const candidate = (await workers(page)).find(item => item.id !== before.activeId)!;
  await retired(page, candidate.id); expect(candidate.readyBuild).toBeUndefined();
  await page.getByRole('button', { name: 'Dismiss error', exact: true }).click(); await retainedScene(page, before);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('real 45-second candidate bootstrap bound retires a hung genuine factory and preserves the edited document', async ({ page }) => {
  test.setTimeout(90_000);
  await observeWorkers(page); const control = await controlledCore(page, ['pass', 'hang']);
  const before = await editedRedo(page), started = Date.now(); await replaceScene(page);
  await expect.poll(control.calls).toBe(2);
  await expect(page.getByRole('alert')).toContainText(/could not verify this build in time|could not initialize in time/, { timeout: 55_000 });
  const elapsed = Date.now() - started; expect(elapsed).toBeGreaterThanOrEqual(43_000); expect(elapsed).toBeLessThan(60_000);
  await expect(page.locator('.status.panel')).toHaveCount(0);
  const candidate = (await workers(page)).find(item => item.id !== before.activeId)!;
  await retired(page, candidate.id); expect(candidate.readyBuild).toBeUndefined();
  await page.getByRole('button', { name: 'Dismiss error', exact: true }).click(); await retainedScene(page, before);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('Cancel disposes a candidate while its genuine factory is hung and keeps prior edits usable', async ({ page }) => {
  await observeWorkers(page); const control = await controlledCore(page, ['pass', 'hang']);
  const before = await editedRedo(page); await replaceScene(page); await expect.poll(control.calls).toBe(2);
  const candidate = (await workers(page)).find(item => item.id !== before.activeId)!;
  await page.locator('.status.panel').getByRole('button', { name: 'Cancel', exact: true }).click();
  await retired(page, candidate.id); await expect(page.locator('.status.panel')).toHaveCount(0);
  await retainedScene(page, before); await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a superseded held actual candidate cannot replace the edited scene after its successor fails initialization', async ({ page }) => {
  await observeWorkers(page); const control = await controlledCore(page, ['pass', 'pass', 'reject']);
  const before = await editedRedo(page);
  await page.evaluate(() => { window.__initializationMonitor.holdNextReady = true; });
  await replaceScene(page, 'superseded-candidate.ply');
  await expect.poll(async () => (await workers(page)).some(item => item.heldReady)).toBe(true);
  const superseded = (await workers(page)).find(item => item.heldReady)!;
  expect(superseded.readyBuild).toEqual(control.manifest.build);
  // The real file-input event reaches the same controller entry as a drop or
  // picker result. It does not invoke private controller methods.
  await replaceScene(page, 'successor-candidate.ply');
  await expect(page.getByRole('alert')).toContainText('Injected genuine-factory readiness failure');
  await expect(page.locator('.status.panel')).toHaveCount(0); expect(control.calls()).toBe(3);
  const records = await workers(page); expect(records).toHaveLength(3);
  await retired(page, superseded.id); const successor = records.find(item => item.id !== before.activeId && item.id !== superseded.id)!;
  await retired(page, successor.id);
  await page.evaluate(id => window.__initializationMonitor.releaseHeld(id), superseded.id);
  await retired(page, superseded.id);
  await page.getByRole('button', { name: 'Dismiss error', exact: true }).click(); await retainedScene(page, before);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('changing server responses cannot cause a second native or worker executable fetch during repeated open, edit and export', async ({ page }) => {
  await observeWorkers(page); const manifest = await deployment(), counts = new Map<string, number>();
  for (const role of ['document-worker', 'core-glue', 'core-wasm', 'camera-glue', 'camera-wasm'] as const) {
    const row = artifact(manifest, role), original = await readFile(resolve('dist', row.path)); counts.set(role, 0);
    await page.route(`**/${row.path}`, async route => {
      const count = counts.get(role)! + 1; counts.set(role, count);
      await fulfillBytes(route, count === 1 ? original : Buffer.from('different unchecked second response'),
        role.endsWith('wasm') ? 'application/wasm' : 'text/javascript');
    });
  }
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  for (let index = 0; index < 3; index++) {
    const name = `pinned-${index}`; await openScene(page, sceneFile(`${name}.ply`), index === 0);
    const pristine = await exportBytes(page, name);
    await grade(page, String(1.2 + .1 * index)); const bytes = await exportBytes(page, name);
    expect(bytes.length).toBeGreaterThan(100); expect(bytes.equals(pristine)).toBe(false);
  }
  expect(Object.fromEntries(counts)).toEqual({ 'document-worker': 1, 'core-glue': 1, 'core-wasm': 1, 'camera-glue': 1, 'camera-wasm': 1 });
  const records = await workers(page); expect(records).toHaveLength(3);
  expect(records.map(item => item.terminated)).toEqual([true, true, false]);
  for (const worker of records) {
    expect(worker.url).toMatch(/^blob:/); expect(worker.readyBuild).toEqual(manifest.build);
    expect(worker.posts.filter(post => post.type === 'source-load')).toHaveLength(1);
    expect(worker.posts.some(post => post.type === 'export')).toBe(true);
  }
  expect(errors).toEqual([]); await expect(page.getByRole('alert')).toHaveCount(0);
});
