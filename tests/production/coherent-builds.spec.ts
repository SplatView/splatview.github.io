import { test, expect, type Page } from '@playwright/test';
import { loadFixtureSet, mixRole, observeCameraAllocation, role, serveFixtures, type LoadedSet } from './coherent-fixtures';
import { editedRedo, exportBytes, grade, observeWorkers, replaceScene, retainedScene, retired, sceneFile, wake, workers } from './initialization-helpers';

let set: LoadedSet;
test.beforeAll(async () => { set = await loadFixtureSet(); });
test.beforeEach(async ({}, info) => {
  await info.attach('genuine-compatibility-fixture-set', { contentType: 'application/json',
    body: JSON.stringify({ path: set.receiptPath, sha256: set.receiptSha256, fixtureSetId: set.fixtureSetId }) });
});

async function openAt(page: Page, base: string) {
  await page.goto(base); await expect(page.getByRole('button', { name: 'Open scene', exact: true })).toBeEnabled();
  await page.getByLabel('Open scene files').setInputFiles(sceneFile());
  await expect(page).toHaveTitle('initialization-sh3.ply — SplatView'); await wake(page);
  if (!await page.getByRole('complementary', { name: 'Tools', exact: true }).count())
    await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Tools', exact: true })).toContainText('3 splats · SH3');
}
for (const name of ['A', 'B', 'C'] as const) for (const base of ['/', '/project/'])
  test(`genuine coherent ${name} opens, edits, Undo/Redo and exports at ${base}`, async ({ page }) => {
    const host = await serveFixtures(page, set, name, name, base);
    await observeWorkers(page); await observeCameraAllocation(page, set.fixtures[name]);
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await openAt(page, base); const pristine = await exportBytes(page);
    await page.getByRole('button', { name: 'Select all', exact: true }).click();
    await expect(page.getByRole('complementary', { name: 'Tools', exact: true })).toContainText('3 selected');
    await grade(page, '1.3'); const first = await exportBytes(page); expect(first.equals(pristine)).toBe(false);
    await grade(page, '1.7'); const second = await exportBytes(page); expect(second.equals(first)).toBe(false);
    await wake(page); await page.getByRole('button', { name: 'Undo', exact: true }).click();
    expect((await exportBytes(page)).equals(first)).toBe(true);
    await wake(page); await page.getByRole('button', { name: 'Redo', exact: true }).click();
    expect((await exportBytes(page)).equals(second)).toBe(true);
    const records = await workers(page); expect(records).toHaveLength(1);
    expect(records[0].readyBuild).toEqual(set.fixtures[name].build);
    expect(records[0].replies.findLast(reply => reply.masks)!.masks).toEqual([1, 1, 1]);
    expect(records[0].posts.filter(post => post.type === 'source-load')).toHaveLength(1);
    const camera = await page.evaluate(() => window.__coherentCameraCalls);
    expect(camera.identity).toBeGreaterThan(0); expect(camera.malloc).toBeGreaterThan(0); expect(camera.inputCreate).toBe(1);
    expect(host.escaped).toEqual([]);
    await expect(page.getByRole('alert')).toHaveCount(0); expect(errors).toEqual([]);
  });

for (const [entry, deployment] of [['A', 'B'], ['B', 'A'], ['A', 'C'], ['C', 'A']] as const)
  test(`actual cached ${entry} entry refuses genuine ${deployment} deployment before worker/camera creation`, async ({ page }) => {
    const host = await serveFixtures(page, set, entry, deployment);
    await observeWorkers(page); await observeCameraAllocation(page, set.fixtures[entry]);
    await page.goto('/');
    await expect(page.getByRole('alert')).toContainText('the page, worker and native requirements belong to different builds');
    await expect(page.getByRole('button', { name: 'Reload', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open scene', exact: true })).toHaveCount(0);
    expect(await workers(page)).toEqual([]);
    expect(await page.evaluate(() => window.__coherentCameraCalls)).toEqual({ identity: 0, malloc: 0, inputCreate: 0 });
    expect(host.requests.some(request => request.path === role(set.fixtures[entry], 'application-entry').path)).toBe(true);
    expect(host.requests.filter(request => request.path === 'build-manifest.json')).toHaveLength(1);
    expect(host.requests.some(request => request.path.startsWith('wasm/'))).toBe(false);
  });

for (const [base, other] of [['A', 'B'], ['B', 'A']] as const)
  for (const kind of ['document-worker', 'core', 'camera'] as const)
    test(`mixed actual ${other} ${kind} in ${base} reaches compiled identity refusal after matching digests`, async ({ page }, info) => {
      const host = await serveFixtures(page, set, base);
      const manifest = mixRole(host, set.fixtures[base], set.fixtures[other], kind);
      await info.attach('resealed-mixed-role-fault-manifest', { body: JSON.stringify(manifest), contentType: 'application/json' });
      await observeWorkers(page);
      await observeCameraAllocation(page, set.fixtures[kind === 'camera' ? other : base]);
      await page.goto('/');
      await expect(page.getByRole('alert')).toContainText(kind === 'document-worker'
        ? 'the page, worker and native requirements belong to different builds' : `the ${kind} identity or required capabilities differ`);
      await expect(page.getByRole('alert')).not.toContainText(/bytes differ|byte limit/);
      await expect(page.getByRole('button', { name: 'Open scene', exact: true })).toBeDisabled();
      const records = await workers(page); expect(records).toHaveLength(1); await retired(page, records[0].id);
      const actual = (await workers(page))[0];
      expect(actual.replies.some(reply => reply.summary)).toBe(false);
      if (kind === 'camera') {
        expect(actual.readyBuild).toEqual(set.fixtures[base].build);
        expect(await page.evaluate(() => window.__coherentCameraCalls)).toEqual({ identity: 1, malloc: 0, inputCreate: 0 });
      } else {
        expect(actual.readyBuild).toBeUndefined();
        expect(await page.evaluate(() => window.__coherentCameraCalls)).toEqual({ identity: 0, malloc: 0, inputCreate: 0 });
      }
    });

test('edited A tab remains on genuine pinned A after the host offers B, including canceled candidate and late actual ready', async ({ page }) => {
  const host = await serveFixtures(page, set, 'A'); await observeWorkers(page);
  await observeCameraAllocation(page, set.fixtures.A);
  const before = await editedRedo(page);
  host.deployment = 'B';
  // Explicit host probe: this is not the app accepting an update or fetching executables.
  const offered = await page.evaluate(async () => (await fetch('/build-manifest.json', { cache: 'no-store' })).json());
  expect(offered).toEqual(set.fixtures.B.manifestValue);
  await page.evaluate(() => { window.__initializationMonitor.holdNextReady = true; });
  await replaceScene(page, 'pinned-replacement.ply');
  await expect.poll(async () => (await workers(page)).some(record => record.heldReady)).toBe(true);
  const candidate = (await workers(page)).find(record => record.heldReady)!;
  expect(candidate.readyBuild).toEqual(set.fixtures.A.build); expect(candidate.readyBuild).not.toEqual(set.fixtures.B.build);
  await page.locator('.status.panel').getByRole('button', { name: 'Cancel', exact: true }).click();
  await retired(page, candidate.id);
  await page.evaluate(id => window.__initializationMonitor.releaseHeld(id), candidate.id);
  await retainedScene(page, before);
  for (const name of ['document-worker', 'core-glue', 'core-wasm', 'camera-glue', 'camera-wasm'] as const) {
    const path = role(set.fixtures.A, name).path;
    expect(host.requests.filter(request => request.path === path)).toHaveLength(1);
  }
  expect(host.requests.filter(request => request.deployment === 'B').map(request => request.path)).toEqual(['build-manifest.json']);
  expect((await workers(page)).map(record => record.terminated)).toEqual([false, true]);
  await expect(page.getByRole('alert')).toHaveCount(0);
});
