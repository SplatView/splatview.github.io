/** Bounded same-page lifecycle observations. No latency, capacity or physical-memory acceptance. */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { cpus, release, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type JSHandle, type Page } from '@playwright/test';
import { Workspace, digest } from '../release/files.ts';
import type { FileRef } from '../release/types.ts';
import { benchmarkExpectedIdentities, validateBenchmarkRaw } from './oracles.ts';
import { contributorAnchorCase } from './contributor-oracles.ts';
import { validateSelectionExport } from './selection-oracles.ts';
import { configureContributorSingleUi, preserveContributorCheckpoint, assertContributorPoint, assertContributorQuery, validateContributorRing,
  type ContributorCheckpoint, type ContributorMaskSnapshot, type ContributorPoint, type ContributorSnapshot } from './contributors.ts';
import { assertOrbitCamera, assertOrbitFrame, type CameraBoundary, type OrbitFrameObservation } from './orbit.ts';
import { KEY, QUERY, parseProbeOptions, snapshot, waitProbeReady, waitForLoadedOpen, assertProbeSnapshot, assertProbeClock, assertProbeClosed,
  triggerProbeEvent, downloadBytes, writeBytes, preserveProbeExport, acknowledgeProbeExport, joinProbeCleanup, readResponseBounded,
  type Snapshot, type ProbeDownload } from './run.ts';
import { retentionDeclaration, retentionExpectedMask, assertRetentionContinuity, assertRetentionCycle, assertRetentionCompletion, retentionMemorySummary,
  type RetentionCycle, type RetentionStep, type RetentionBarrier } from './retention-oracles.ts';

type Json = Record<string, unknown>;
type Expected = Parameters<typeof assertProbeSnapshot>[1];
interface RetentionBridge {
  snapshot(): Promise<ContributorSnapshot>; applyCamera(camera: number[]): Promise<CameraBoundary>;
  waitForFrame(sequence: number, timeout?: number): Promise<OrbitFrameObservation>; readMasks(): Promise<ContributorMaskSnapshot>; stop(): Promise<Snapshot>;
}
export interface RetentionOptions { baseUrl: string; manifest: string; fixture: string; build: string; output: string; cycles: number }
const CAMERA = [0, 0, 0, 0, 0, 24, 1, 45, 1, 0, 1.6];
const errorText = (error: unknown): string => { try { return (error instanceof Error ? error.stack ?? error.message : String(error)).slice(0, 16_384); } catch { return 'Unserializable retention failure'; } };
const object = (value: unknown): Json => { assert(value !== null && typeof value === 'object' && !Array.isArray(value)); return value as Json; };

/** A rejected summary must not prevent the caller from preserving its raw snapshots. */
export function retentionMemoryDiagnostic(snapshots: readonly Snapshot[]):
  ({ status: 'observed'; error: null } & ReturnType<typeof retentionMemorySummary>) | { status: 'failed'; error: string; summary: null } {
  try { return { status: 'observed', error: null, ...retentionMemorySummary(snapshots) }; }
  catch (error) { return { status: 'failed', error: errorText(error), summary: null }; }
}

export function parseRetentionOptions(args: string[]): RetentionOptions {
  const filtered: string[] = []; let cycles = 20, supplied = false;
  for (let index = 0; index < args.length; index += 2) {
    assert(args[index] !== '--attempts', 'Retention has one page; use --cycles, not fresh-context --attempts');
    if (args[index] === '--cycles') {
      const value = args[index + 1]; assert(!supplied && value && /^[1-9][0-9]?$/u.test(value) && Number(value) <= 20, 'Expected one bounded --cycles value from 1 to 20');
      supplied = true; cycles = Number(value);
    } else filtered.push(args[index]!, args[index + 1]!);
  }
  const { attempts: ignored, ...options } = parseProbeOptions(filtered); void ignored;
  return { ...options, cycles };
}
async function settled(page: Page, previous: Snapshot, expected: Expected, loaded = true): Promise<ContributorSnapshot> {
  let last: Snapshot | null = null;
  await waitProbeReady(async () => {
    const current = await snapshot(page) as ContributorSnapshot; last = current; assertProbeClock(current, previous);
    assert.equal(current.controller.state.error, null);
    const pending = current.controller.knownPending;
    if (['editOperation', 'selectionCleanupOwner', 'releasedSelectionDrain', 'drawing', 'scheduledAnimationFrame', 'exportOperation'].some(key => pending[key] !== false) ||
      ['selectionBarriers', 'releasedSelectionOwners', 'tolerancePickTasks', 'benchmarkMaskReads', 'benchmarkPickTasks', 'imageTasks'].some(key => pending[key] !== 0)) return null;
    if (!loaded) {
      const close = current.controller.observation.operations.findLast(value => value.kind === 'close-scene' && value.sequence > previous.controller.observation.lastOperationSequence);
      if (!close || close.status === 'pending') return null;
      assertProbeClosed(current, previous.controller.observation.lastOperationSequence);
    }
    return current;
  }, loaded);
  assert(last); assertProbeSnapshot(last, expected); validateContributorRing((last as ContributorSnapshot).controller.observation);
  return last as ContributorSnapshot;
}
async function fixedCamera(page: Page, loaded: Snapshot): Promise<Json> {
  // This existing opt-in setup API changes only camera input. All document edits
  // and navigation below use the ordinary visible UI and the original worker.
  const receipt = await page.evaluate(async ({ key, camera }) => {
    const bridge = (window as unknown as Record<string, RetentionBridge>)[key]!, boundary = await bridge.applyCamera(camera);
    const deadline = performance.now() + 15_000; let cursor = boundary.controller.observation.lastFrameSequence;
    for (;;) {
      try { await bridge.waitForFrame(cursor, 1000); } catch { /* Retain actual completion; a prior frame can settle stale. */ }
      const current = await bridge.snapshot(), frame = (current.controller.observation.frames as unknown as OrbitFrameObservation[]).find(value =>
        value.sequence > boundary.controller.observation.lastFrameSequence && value.status === 'completed' &&
        value.camera.revision === boundary.controller.camera!.revision && JSON.stringify(value.camera.state) === JSON.stringify(boundary.controller.camera!.state));
      if (frame && current.controller.knownPending.drawing === false) return { boundary, frame };
      if (performance.now() >= deadline) throw new Error('Fixed retention camera did not join an actual completed frame');
      cursor = current.controller.observation.lastFrameSequence;
    }
  }, { key: KEY, camera: CAMERA });
  assertOrbitCamera(receipt.boundary, CAMERA, loaded); assertOrbitFrame(receipt.frame, receipt.boundary, CAMERA, loaded); return receipt;
}
async function contributorPoint(page: Page): Promise<ContributorPoint> {
  const requested = [...contributorAnchorCase(1).parameters.ui.pointer.requestedPoint];
  const point = await page.getByLabel('SplatView scene', { exact: true }).evaluate((element, input) => {
    if (!(element instanceof HTMLCanvasElement)) throw new Error('Scene is not the real canvas');
    const bounds = element.getBoundingClientRect(), clientPoint = [bounds.left + input[0]! * bounds.width / element.width, bounds.top + input[1]! * bounds.height / element.height];
    return { rect: { x: bounds.x, y: bounds.y, left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom, width: bounds.width, height: bounds.height },
      framebuffer: { width: element.width, height: element.height, devicePixelRatio }, requestedPoint: input, clientPoint,
      elementFromPointCanvas: document.elementFromPoint(clientPoint[0]!, clientPoint[1]!) === element };
  }, requested);
  assertContributorPoint(point, requested); return point;
}
async function decodeCapture(page: Page, bytes: Uint8Array) {
  assert(bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9, 'Actual capture is not a complete JPEG');
  return page.evaluate(async encoded => {
    const raw = atob(encoded), data = new Uint8Array(raw.length); for (let index = 0; index < raw.length; index++) data[index] = raw.charCodeAt(index);
    const bitmap = await createImageBitmap(new Blob([data], { type: 'image/jpeg' })); const width = bitmap.width, height = bitmap.height; bitmap.close();
    return { mimeType: 'image/jpeg', width, height, bitmapClosed: true, scope: 'Independent decode of actual downloaded bytes; no pixel-fidelity or physical-presentation claim.' };
  }, Buffer.from(bytes).toString('base64'));
}

export async function runProductionRetention(options: RetentionOptions): Promise<{ status: string; report: string; cycles: number }> {
  assert(Number.isSafeInteger(options.cycles) && options.cycles >= 1 && options.cycles <= 20);
  const workspace = new Workspace(process.cwd(), 128 * 1024 * 1024, 2 * 1024 * 1024 * 1024);
  const fixtureManifest = await workspace.read(options.manifest), fixture = await workspace.read(options.fixture), buildInput = await workspace.read(options.build);
  const manifest = object(JSON.parse(new TextDecoder().decode(fixtureManifest.bytes))), identities = object(manifest.identity), independent = validateBenchmarkRaw(fixture.bytes);
  assert.equal(manifest.status, 'pinned'); assert.equal(manifest.id, 'dyadic-grid-256k-sh0-v1');
  for (const key of ['inputSha256', 'expectedSceneSha256', 'sourceOrderSha256', 'distributionSha256'] as const) assert.equal(identities[key], independent[key]);
  assert.equal(fixture.reference.sha256, benchmarkExpectedIdentities().inputSha256);
  const build = object(JSON.parse(new TextDecoder().decode(buildInput.bytes))), descriptor = object(build.build);
  assert(typeof descriptor.appInputId === 'string' && typeof build.deploymentId === 'string' && Array.isArray(build.artifacts));
  const expected: Expected = { appInputId: descriptor.appInputId, deploymentId: build.deploymentId, artifacts: build.artifacts };
  const response = await fetch(new URL('build-manifest.json', options.baseUrl), { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(30_000) });
  assert(response.ok); assert.equal(digest(await readResponseBounded(response, 1024 * 1024)), buildInput.reference.sha256, 'Served manifest differs from supplied shipping bytes');
  const sources = await Promise.all(['tools/bench/retention.ts', 'tools/bench/retention-oracles.ts', 'tools/bench/run.ts', 'tools/bench/contributors.ts',
    'tools/bench/contributor-oracles.ts', 'tools/bench/selection-oracles.ts', 'tools/bench/oracles.ts', 'tools/bench/orbit.ts', 'tools/release/files.ts'].map(async path => (await workspace.read(path)).reference));
  for (const name of ['.build', '.build/bench-runs']) {
    try { await mkdir(await workspace.safe(name, true)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    await workspace.safe(name);
  }
  // No evidence or previous run is overwritten, including unsuccessful runs.
  await mkdir(await workspace.safe(options.output, true)); await workspace.safe(options.output);
  const declaration = retentionDeclaration(); await workspace.writeExclusive(`${options.output}/predeclared-retention.json`, { ...declaration,
    inputs: { fixture: fixture.reference, manifest: fixtureManifest.reference, build: buildInput.reference }, sources });
  const startedAtUtc = new Date().toISOString(), runtimeErrors: string[] = [], cycles: RetentionCycle[] = [], cycleFiles: FileRef[] = [];
  let droppedRuntimeErrors = 0;
  const retainError = (error: unknown) => { if (runtimeErrors.length < 64) runtimeErrors.push(errorText(error)); else droppedRuntimeErrors++; };
  const launchArguments = ['--enable-unsafe-webgpu'];
  let browser: Browser | undefined, context: BrowserContext | undefined, retainedBridge: JSHandle<RetentionBridge> | undefined;
  let baseline: Snapshot | null = null, latest: Snapshot | null = null, browserVersion: string | null = null, bridgeStopped = false;
  const cleanup = { contextJoined: false, browserJoined: false, contextError: null as string | null, browserError: null as string | null };
  try {
    browser = await chromium.launch({ channel: 'chromium', headless: true, args: launchArguments }); browserVersion = browser.version();
    context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, locale: 'en-US', acceptDownloads: true });
    await context.addInitScript(() => localStorage.setItem('splatview.tutorial.v1', '{"tutorial_prompt_handled":"handled"}'));
    const page = await context.newPage(), ownedContext = context; page.setDefaultTimeout(60_000); page.on('pageerror', retainError);
    await page.bringToFront(); const url = new URL(options.baseUrl); url.searchParams.set(QUERY, '1'); await page.goto(url.href);
    await waitProbeReady(async () => page.evaluate(async key => { const bridge = (window as unknown as Record<string, RetentionBridge | undefined>)[key]; return bridge ? bridge.snapshot() : null; }, KEY), false);
    baseline = await snapshot(page); assertProbeSnapshot(baseline, expected); latest = baseline;
    retainedBridge = await page.evaluateHandle(key => (window as unknown as Record<string, RetentionBridge>)[key]!, KEY);
    const continuity = async () => ({ sameContext: page.context() === ownedContext, samePage: ownedContext.pages().length === 1 && ownedContext.pages()[0] === page,
      sameBridge: await page.evaluate(({ key, owner }) => (window as unknown as Record<string, unknown>)[key] === owner, { key: KEY, owner: retainedBridge! }), pageCount: ownedContext.pages().length });
    const picker = () => page.getByLabel('Open scene files', { exact: true }).setInputFiles({ name: 'benchmark.splat', mimeType: 'application/octet-stream', buffer: Buffer.from(fixture.bytes) });
    const openOriginal = async (previous: Snapshot) => {
      await picker(); await waitProbeReady(() => snapshot(page), true); return waitForLoadedOpen(page, previous, expected);
    };
    for (let index = 1; index <= options.cycles; index++) {
      const id = `cycle-${String(index).padStart(2, '0')}`, cycle: RetentionCycle = { id, index, status: 'pending', barriers: [], export: null, capture: null, query: null, camera: null,
        openObservation: null, replacementObservation: null, closeObservation: null, error: null };
      cycles.push(cycle); const cycleBaseline = latest;
      await workspace.writeExclusive(`${options.output}/${id}-started.json`, { id, index, status: 'started', clock: latest.clock, samePageSequence: true });
      const checkpoint = async (step: RetentionStep): Promise<RetentionBarrier> => {
        const before = await settled(page, latest!, expected, step !== 'closed');
        const mask: ContributorCheckpoint | null = step === 'closed' ? null : { artifact: null, maskObservation: null, independentIdentity: null, oracleStatus: 'pending', oracleError: null };
        // Install the record before any read/oracle can fail, retaining partial diagnostics.
        const barrier: RetentionBarrier = { step, snapshot: before, continuity: await continuity(), checkpoint: mask }; cycle.barriers.push(barrier);
        if (mask) {
          const observed = await page.evaluate(key => (window as unknown as Record<string, RetentionBridge>)[key]!.readMasks(), KEY);
          await preserveContributorCheckpoint(mask, observed, retentionExpectedMask(step), before, bytes => writeBytes(workspace, `${options.output}/${id}-${step}.state`, bytes));
          barrier.snapshot = await settled(page, before, expected);
        }
        assertRetentionContinuity(barrier.snapshot, latest!, barrier.continuity); latest = barrier.snapshot;
        await workspace.writeExclusive(`${options.output}/${id}-${step}.json`, barrier); return barrier;
      };
      try {
        const opened = await openOriginal(latest); cycle.openObservation = opened as unknown as Json;
        cycle.camera = await fixedCamera(page, opened.loaded); await configureContributorSingleUi(page, 0);
        const initial = await checkpoint('open'), beforeMask = initial.checkpoint!.maskObservation as unknown as ContributorMaskSnapshot;
        const point = await contributorPoint(page), beforeQuery = (initial.snapshot as ContributorSnapshot).controller.observation.lastQuerySequence;
        cycle.query = { point, beforeQuery, actual: null };
        await page.mouse.click(point.clientPoint[0]!, point.clientPoint[1]!, { button: 'left' });
        const queryDeadline = performance.now() + 60_000;
        for (;;) {
          const current = await snapshot(page) as ContributorSnapshot; assertProbeClock(current, initial.snapshot); validateContributorRing(current.controller.observation);
          const query = current.controller.observation.queries.find(value => value.sequence > beforeQuery); if (query) cycle.query.actual = query;
          if (query && query.status !== 'pending') {
            assert.equal(current.controller.observation.lastQuerySequence, beforeQuery + 1); assertContributorQuery(query, beforeQuery, beforeMask, contributorAnchorCase(1), point); break;
          }
          assert.equal(current.controller.state.error, null); assert(performance.now() < queryDeadline, 'Ordinary retention Single query did not settle'); await page.waitForTimeout(25);
        }
        await checkpoint('selected');
        const tools = page.getByRole('complementary', { name: 'Tools', exact: true });
        await tools.getByRole('button', { name: 'Delete selected', exact: true }).click(); await checkpoint('deleted');
        await tools.getByRole('button', { name: 'Undo', exact: true }).click(); await checkpoint('undo');
        await tools.getByRole('button', { name: 'Redo', exact: true }).click(); await checkpoint('redo');
        await page.mouse.move(640, 400); await page.getByRole('button', { name: 'Save scene', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'Save scene', exact: true });
        await dialog.getByLabel('Export format', { exact: true }).selectOption('2'); await dialog.getByLabel('Export scope', { exact: true }).selectOption('0');
        const download = await triggerProbeEvent<ProbeDownload>(() => page.waitForEvent('download'), () => dialog.getByRole('button', { name: 'Download', exact: true }).click());
        cycle.export = { suggestedFilename: download.suggestedFilename(), source: 'actual-Playwright-download-event' };
        await preserveProbeExport(cycle.export, await downloadBytes(download, 8_191_968), bytes => writeBytes(workspace, `${options.output}/${id}.splat`, bytes),
          bytes => validateSelectionExport(bytes, retentionExpectedMask('redo'), 'all'));
        await acknowledgeProbeExport(cycle.export, async () => {
          const receipt = page.getByRole('status').filter({ hasText: 'Download prepared' }); await receipt.getByRole('button', { name: 'I have kept the file', exact: true }).click(); await receipt.waitFor({ state: 'hidden' });
        }, { path: `${options.output}/${id}.splat`, bytes: 8_191_968 });
        await checkpoint('export-acknowledged'); await page.mouse.move(640, 400);
        const imageDownload = await triggerProbeEvent<ProbeDownload>(() => page.waitForEvent('download'), () => page.getByRole('button', { name: 'Capture image', exact: true }).click());
        cycle.capture = { status: 'pending', suggestedFilename: imageDownload.suggestedFilename(), artifact: null, decode: null, completedAtMs: null };
        const image = await downloadBytes(imageDownload, 16 * 1024 * 1024); cycle.capture.artifact = await writeBytes(workspace, `${options.output}/${id}.jpg`, image);
        cycle.capture.decode = await decodeCapture(page, image); cycle.capture.completedAtMs = await page.evaluate(() => performance.now()); cycle.capture.status = 'downloaded-and-decoded';
        await checkpoint('image-downloaded');
        const replaceBaseline = latest; const replacement = await openOriginal(replaceBaseline);
        cycle.replacementObservation = replacement as unknown as Json; await fixedCamera(page, replacement.loaded); await checkpoint('replaced');
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        await page.getByRole('dialog', { name: 'Settings', exact: true }).getByRole('button', { name: 'Close scene', exact: true }).click();
        const closed = await checkpoint('closed'), close = assertProbeClosed(closed.snapshot, replacement.loaded.controller.observation.lastOperationSequence);
        cycle.closeObservation = { operation: close, clockId: closed.snapshot.clock.id, joinedSceneCloseMs: close.settledAtMs! - close.startedAtMs };
        assertRetentionCycle(cycle, cycleBaseline, expected); cycle.status = 'observed';
      } catch (error) { cycle.error = errorText(error); cycle.status = 'failed'; }
      finally {
        const memory = retentionMemoryDiagnostic([cycleBaseline, ...cycle.barriers.map(value => value.snapshot)]);
        if (memory.status === 'failed') {
          cycle.status = 'failed'; cycle.error = [cycle.error, memory.error].filter(Boolean).join('\n');
        }
        await workspace.writeExclusive(`${options.output}/${id}.json`, { ...cycle, memory });
        cycleFiles.push((await workspace.read(`${options.output}/${id}.json`)).reference);
      }
      process.stdout.write(JSON.stringify({ kind: 'retention-cycle-progress', cycle: index, requestedCycles: options.cycles, status: cycle.status,
        artifact: `${options.output}/${id}.json` }) + '\n');
      if (cycle.status !== 'observed') break;
    }
  } catch (error) { retainError(error); }
  finally {
    if (retainedBridge) {
      const stopped = await joinProbeCleanup(async () => { await retainedBridge!.evaluate(bridge => bridge.stop()); bridgeStopped = true; await retainedBridge!.dispose(); });
      if (stopped.error) retainError(stopped.error);
    }
    if (context) { const result = await joinProbeCleanup(() => context!.close()); cleanup.contextJoined = result.joined; cleanup.contextError = result.error; if (result.error) retainError(result.error); }
    if (browser) { const result = await joinProbeCleanup(() => browser!.close()); cleanup.browserJoined = result.joined; cleanup.browserError = result.error; if (result.error) retainError(result.error); }
  }
  try {
    assertRetentionCompletion(cycles, options.cycles, cleanup); assert.equal(runtimeErrors.length, 0); assert.equal(droppedRuntimeErrors, 0); assert.equal(bridgeStopped, true);
    for (const reference of [fixtureManifest.reference, fixture.reference, buildInput.reference, ...sources]) await workspace.read(reference.path, reference);
  } catch (error) { retainError(error); }
  const memory = baseline ? retentionMemoryDiagnostic([baseline, ...cycles.flatMap(cycle => cycle.barriers.map(value => value.snapshot))]) : null;
  if (memory?.status === 'failed') retainError(memory.error);
  const status = !runtimeErrors.length && !droppedRuntimeErrors && cycles.length === options.cycles && cycles.every(value => value.status === 'observed') && cleanup.contextJoined && cleanup.browserJoined && bridgeStopped ? 'observed' : 'failed';
  const report = `${options.output}/retention-observation.json`;
  await workspace.writeExclusive(report, { schemaVersion: 1, kind: 'splatview-production-same-page-retention-observation', status, requestedCycles: options.cycles,
    completedCycles: cycles.filter(value => value.status === 'observed').length, scope: options.cycles === 20 ? 'twenty-cycle-same-page-logical-lifecycle-observations' : 'tooling-diagnostic-incomplete-w28',
    twentyCycleSequenceObserved: options.cycles === 20 && status === 'observed', startedAtUtc, endedAtUtc: new Date().toISOString(),
    inputs: { fixture: fixture.reference, manifest: fixtureManifest.reference, build: buildInput.reference }, fixtureOracle: independent, oracleSources: sources,
    predeclared: (await workspace.read(`${options.output}/predeclared-retention.json`)).reference, cycleFiles, baseline, terminal: latest,
    memory,
    host: { os: process.platform, osRelease: release(), cpuModel: cpus()[0]?.model ?? null, ramBytes: totalmem(), browserVersion, browserHost: 'automation',
      browserChannel: 'chromium', headless: true, launchArguments, ownership: 'one-browser-one-context-one-page-one-retained-controller-bridge', systemModel: null },
    cleanup, bridgeStopped, runtimeErrors, droppedRuntimeErrors, performanceAccepted: false, capacityQualified: false, sustainedQualified: false,
    fullMatrixAccepted: false, fullReleaseAccepted: false, closedExportAccounting: false, physicalMemoryMeasured: false,
    limitations: ['SPLAT export still has generic native workspace and Blob ownership not fully represented in logical reservations, unlike the explicit SPZ4 path; zero ledger at joined Close does not prove closed export accounting.',
      'Snapshots cover named pending owners and currently addressable native accounts only. Logical category bytes, observed barrier maxima and cumulative ledger peaks are not physical JS/process/GPU memory.',
      'The camera uses the existing opt-in fixed-camera setup bridge. File opening, Single/Delete, Undo/Redo, saving, acknowledgement, image capture, replacement and Close use the ordinary UI.',
      'Capture proves a complete actual downloaded JPEG decodes at the declared dimensions. Pixel fidelity and physical presentation are outside this packet.',
      'Automation, snapshot polling, native mask reads and independent JPEG decode introduce work outside application measurements. Cache state, latency budgets, operating limits, sustained acceptance and the complete v2 matrix remain unqualified.'] });
  return { status, report, cycles: cycles.length };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runProductionRetention(parseRetentionOptions(process.argv.slice(2))).then(value => { process.stdout.write(JSON.stringify(value) + '\n'); process.exitCode = value.status === 'observed' ? 0 : 2; },
    error => { process.stderr.write(errorText(error) + '\n'); process.exitCode = 1; });
}
