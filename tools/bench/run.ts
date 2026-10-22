/** Initial production observation collector. This is not the complete v2 performance matrix. */
import assert from 'node:assert/strict';
import { mkdir, open } from 'node:fs/promises';
import { release, totalmem, cpus } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Download, type Page } from '@playwright/test';
import { Workspace, relativePath, digest } from '../release/files.ts';
import { validateBenchmarkRaw, validateBenchmarkSplatExport } from './oracles.ts';

export const KEY = '__SPLATVIEW_BENCHMARK_V1__';
export const QUERY = '__splatview_benchmark';
type ObjectValue = Record<string, unknown>;
type Revision = { documentId: string; sourceGeneration: number; contentRevision: number; selectionRevision: number; draftRevision: number };
type Operation = { sequence: number; kind: string; status: string; startedAtMs: number; settledAtMs: number | null; closed: boolean | null;
  after: { hasScene: boolean; hasClient: boolean; documentRevision: Revision | null } | null };
export type Frame = { sequence: number; status: string; drawStartedAtMs: number; submissionObservedAtMs: number; queueCompletedAtMs: number | null;
  documentRevision: Revision | null; presentation: { available: boolean } };
export type Snapshot = {
  schemaVersion: number; kind: string; clock: { id: string; timeOrigin: number; now: number };
  runtime: { mode: string; appInputId: string; deploymentId: string | null; artifacts: unknown[] };
  controller: {
    schemaVersion: number; kind: string;
    state: { ready: boolean; busy: boolean; error: string | null; bootstrapState: string; rendererState: string; runtimeMode: string | null; hasScene: boolean; hasClient: boolean; summary: null | { count: number; sourceCount: number; shDegree: number }; documentRevision: Revision | null };
    framebuffer: { width: number; height: number; devicePixelRatio: number } | null;
    renderer: { ready: boolean; negotiation: { status: string } } | null;
    camera: { state: number[]; view: number[]; projection: number[] } | null;
    observation: { enabled: boolean; disabledReason: string | null; lastFrameSequence: number; lastOperationSequence: number;
      droppedFrames: number; droppedOperations: number; droppedNegotiations: number; operations: Operation[]; frames: Frame[] };
    memory: { logicalLedger: { bytes: number; peakBytes: number; allocations: number; overageBytes: number;
      categories: Record<string, { bytes: number; allocations: number }> }; nativeAccounts: unknown[] };
    knownPending: Record<string, unknown>;
  };
};
export type Bridge = { schemaVersion: number; snapshot(): Promise<Snapshot>; closeScene(): Promise<Snapshot>; stop(): Promise<Snapshot> };
export interface ProbeOptions { baseUrl: string; manifest: string; fixture: string; build: string; output: string; attempts: number }
export interface ProductionProbeObservation {
  page: Page;
  context: BrowserContext;
  baseline: Snapshot;
  loaded: Snapshot;
  attempt: ObjectValue;
}
export interface ProductionProbeHooks {
  /** Runs after the real loaded frame and before the independent export/close proof. */
  observeLoaded?: (observation: ProductionProbeObservation) => Promise<void>;
  /** A fresh owned browser can preserve native visibility without automation's focus override. */
  createBrowserOwner?: (request: { id: string; metadata: ObjectValue }) => Promise<ProductionProbeBrowserOwner>;
}
export interface ProductionProbeBrowserOwner {
  browser: Browser;
  context: BrowserContext;
  metadata: ObjectValue;
  /** Default-context CDP hosts retain their native download event session. */
  waitForDownload?(page: Page): Promise<ProbeDownload>;
  /** Resolves only after this context and its owned browser process have joined. */
  close(): Promise<void>;
}
export type ProbeDownload = Pick<Download,'createReadStream'|'failure'|'suggestedFilename'> & {observation?:ObjectValue};

export function parseProbeOptions(args: string[]): ProbeOptions {
  const values = new Map<string, string>();
  const allowed = new Set(['--base-url','--manifest','--fixture','--build','--out','--attempts']);
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]!, value = args[index + 1];
    if (!allowed.has(key) || values.has(key) || !value || value.startsWith('--')) throw new Error('Expected unique --base-url, --manifest, --fixture, --out and optional --build/--attempts pairs.');
    values.set(key, value);
  }
  const base = new URL(values.get('--base-url') ?? '');
  if (!['http:','https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash ||
      base.protocol === 'http:' && !['127.0.0.1','localhost','[::1]'].includes(base.hostname)) throw new Error('Use an unambiguous HTTPS or local HTTP application base URL.');
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  const manifest = relativePath(values.get('--manifest') ?? 'tests/fixtures/bench/manifest-v1.json');
  const fixture = relativePath(values.get('--fixture') ?? '');
  const build = relativePath(values.get('--build') ?? 'dist/build-manifest.json');
  const output = relativePath(values.get('--out') ?? '');
  if (!/^\.build\/bench-runs\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u.test(output)) throw new Error('Output must be a fresh .build/bench-runs/RUN_ID directory.');
  const count = values.get('--attempts') ?? '3';
  if (!/^[1-9][0-9]?$/u.test(count) || Number(count) > 30) throw new Error('Probe attempts must be between 1 and 30.');
  return { baseUrl: base.href, manifest, fixture, build, output, attempts: Number(count) };
}
function record(value: unknown, name: string): ObjectValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${name}.`);
  return value as ObjectValue;
}
export function assertProbeSnapshot(value: unknown, expected: { appInputId: string; deploymentId: string; artifacts?: unknown[] }): asserts value is Snapshot {
  const snapshot = record(value, 'bridge snapshot'), runtime = record(snapshot.runtime, 'runtime'), controller = record(snapshot.controller, 'controller');
  const state = record(controller.state, 'application state'), clock = record(snapshot.clock, 'clock');
  assert.equal(snapshot.schemaVersion, 1); assert.equal(snapshot.kind, 'splatview-production-benchmark-snapshot');
  assert.equal(runtime.mode, 'production-verified'); assert.equal(state.runtimeMode, 'production-verified');
  assert.equal(runtime.appInputId, expected.appInputId); assert.equal(runtime.deploymentId, expected.deploymentId);
  assert.equal(controller.schemaVersion, 1); assert.equal(controller.kind, 'splatview-controller-benchmark-observation');
  const renderer = record(controller.renderer, 'renderer');
  assert.equal(renderer.ready, true); assert.equal(state.ready, true); assert.equal(state.busy, false);
  assert.equal(state.bootstrapState, 'ready'); assert.equal(state.rendererState, 'ready');
  assert.equal(record(renderer.negotiation, 'actual negotiation').status, 'ready');
  if (expected.artifacts) {
    assert(Array.isArray(runtime.artifacts));
    assert.deepEqual(runtime.artifacts.map(value => {
      const artifact = record(value, 'verified artifact');
      return { role: artifact.role, path: artifact.path, bytes: artifact.bytes, sha256: artifact.sha256 };
    }), expected.artifacts);
  }
  assert(Number.isFinite(clock.timeOrigin) && Number.isFinite(clock.now) && (clock.now as number) >= 0);
  assert.equal(clock.id, `performance.now:${clock.timeOrigin}`);
  const observation = record(controller.observation, 'observation');
  assert.equal(observation.enabled, true); assert.equal(observation.disabledReason, null);
  assert.equal(observation.droppedFrames, 0); assert.equal(observation.droppedOperations, 0); assert.equal(observation.droppedNegotiations, 0);
  assert.equal(state.error, null);
}
function sameRevision(a: Revision | null, b: Revision | null): boolean {
  return a !== null && b !== null && a.documentId === b.documentId && a.sourceGeneration === b.sourceGeneration &&
    a.contentRevision === b.contentRevision && a.selectionRevision === b.selectionRevision && a.draftRevision === b.draftRevision;
}
export function assertProbeClock(snapshot: Snapshot, baseline: Snapshot): void {
  assert.equal(snapshot.clock.id, baseline.clock.id, 'Probe navigation changed its browser clock domain.');
  assert.equal(snapshot.clock.timeOrigin, baseline.clock.timeOrigin);
  assert(snapshot.clock.now >= baseline.clock.now, 'Probe browser clock moved backwards.');
}
/** busy:false may publish before the actual public openFiles promise settles. */
export function settledProbeOpen(snapshot: Snapshot, afterSequence: number): Operation | null {
  const operation = snapshot.controller.observation.operations.findLast(value => value.kind === 'open-files' && value.sequence > afterSequence);
  if (!operation || operation.status === 'pending') return null;
  assert.equal(operation.status, 'settled', 'Actual open operation failed or observation was disabled.');
  assert(Number.isFinite(operation.startedAtMs) && operation.settledAtMs !== null && Number.isFinite(operation.settledAtMs) &&
    operation.settledAtMs >= operation.startedAtMs, 'Actual open operation has no valid settlement.');
  assert(operation.after?.hasScene && operation.after.hasClient && sameRevision(operation.after.documentRevision, snapshot.controller.state.documentRevision),
    'Settled open operation does not belong to the current complete document revision.');
  return operation;
}
export function completedProbeFrame(snapshot: Snapshot, afterSequence: number, opened: Operation): Frame | null {
  const revision = snapshot.controller.state.documentRevision;
  const matching = snapshot.controller.observation.frames.filter(frame => frame.sequence > afterSequence && sameRevision(frame.documentRevision, revision));
  assert(!matching.some(frame => frame.status === 'failed'), 'An actual loaded-document frame failed.');
  const frame = matching.find(value => value.status === 'completed');
  if (!frame) return null;
  assert(Number.isFinite(frame.drawStartedAtMs) && Number.isFinite(frame.submissionObservedAtMs) && frame.queueCompletedAtMs !== null &&
    Number.isFinite(frame.queueCompletedAtMs) && frame.drawStartedAtMs <= frame.submissionObservedAtMs &&
    frame.submissionObservedAtMs <= frame.queueCompletedAtMs && frame.queueCompletedAtMs >= opened.startedAtMs,
  'Loaded scene frame has no ordered actual queue-completion observation.');
  assert.equal(frame.presentation.available, false);
  return frame;
}
const LEDGER_CATEGORIES = ['source','decoded','work','history','render','image','recovery'];
const PENDING_COUNTS = ['sourceLoadTasks','collectionCleanupTasks','thumbnailTasks','savedViewTransferTasks','imageTasks','filterTasks',
  'transformTasks','opacityTasks','floorTasks','tolerancePickTasks','releasedSelectionOwners','selectionBarriers','viewDownloadCallbacks',
  'imageDownloadCallbacks','exportDownloadCallbacks'];
const PENDING_FLAGS = ['candidateClient','bootstrapClient','collectionIntakeOwner','recoveryTask','closeRequest','closeDocumentTask','editOperation',
  'exportOperation','filterOwner','transformOwner','opacityOwner','floorOwner','selectionCleanupOwner','opacityEntryTask','transformGradeTask',
  'transformNumericTask','releasedSelectionDrain'];
export function assertProbeClosed(snapshot: Snapshot, afterSequence: number): Operation {
  const { state, memory, knownPending, observation } = snapshot.controller;
  assert.equal(state.hasScene, false); assert.equal(state.hasClient, false); assert.equal(state.summary, null); assert.equal(state.documentRevision, null);
  const close = observation.operations.findLast(operation => operation.kind === 'close-scene' && operation.sequence > afterSequence);
  assert(close && close.status === 'settled' && close.closed && close.settledAtMs !== null && Number.isFinite(close.startedAtMs) &&
    Number.isFinite(close.settledAtMs) && close.settledAtMs >= close.startedAtMs, 'Actual scene close did not join.');
  assert(close.after && !close.after.hasScene && !close.after.hasClient && close.after.documentRevision === null);
  assert.equal(memory.nativeAccounts.length, 0);
  assert.equal(memory.logicalLedger.bytes, 0); assert.equal(memory.logicalLedger.allocations, 0); assert.equal(memory.logicalLedger.overageBytes, 0);
  assert.deepEqual(Object.keys(memory.logicalLedger.categories).sort(), [...LEDGER_CATEGORIES].sort());
  for (const name of LEDGER_CATEGORIES) {
    assert.equal(memory.logicalLedger.categories[name]!.bytes, 0, `Closed scene retains ${name} bytes.`);
    assert.equal(memory.logicalLedger.categories[name]!.allocations, 0, `Closed scene retains ${name} allocations.`);
  }
  for (const name of PENDING_COUNTS) assert.equal(knownPending[name], 0, `Closed scene retains ${name}.`);
  for (const name of PENDING_FLAGS) assert.equal(knownPending[name], false, `Closed scene retains ${name}.`);
  // Empty-canvas drawing may legitimately continue after document owners join.
  assert.equal(typeof knownPending.drawing, 'boolean'); assert.equal(typeof knownPending.scheduledAnimationFrame, 'boolean');
  return close;
}
function errorText(error: unknown): string {
  try { return (error instanceof Error ? error.stack ?? error.message : String(error)).slice(0, 16_384); }
  catch { return 'Error details could not be serialized.'; }
}
/** Both promises receive rejection observers before either callback can run. */
export async function triggerProbeEvent<T>(wait: () => Promise<T>, action: () => Promise<unknown>): Promise<T> {
  const event = Promise.resolve().then(wait), actionResult = Promise.resolve().then(action);
  const [result] = await Promise.all([event, actionResult]); return result;
}
/** Preserve actual bounded bytes before an oracle can refuse them. */
export async function preserveProbeExport<T>(target: ObjectValue, bytes: Uint8Array, persist: (bytes: Uint8Array) => Promise<unknown>, validate: (bytes: Uint8Array) => T): Promise<void> {
  target.oracleStatus = 'pending'; target.independentOracle = null; target.oracleError = null;
  target.artifact = await persist(bytes);
  try { target.independentOracle = validate(bytes); target.oracleStatus = 'passed'; }
  catch (error) { target.oracleStatus = 'failed'; target.oracleError = errorText(error); throw error; }
}
/** Acknowledge the real output receipt only after the private saved bytes passed their oracle. */
export async function acknowledgeProbeExport(target: ObjectValue, acknowledge: () => Promise<void>,
  expected?: { path: string; bytes: number }): Promise<void> {
  const receipt: ObjectValue = { status: 'pending', control: 'I have kept the file', artifact: null, error: null };
  target.outputAcknowledgement = receipt;
  try {
    assert.equal(target.oracleStatus, 'passed', 'Actual export must pass its independent oracle before acknowledgement.');
    assert.equal(target.oracleError, null);
    const artifact = record(target.artifact, 'saved export artifact');
    assert.equal(typeof artifact.path, 'string'); relativePath(artifact.path as string);
    if (expected) {
      relativePath(expected.path);
      assert(/^\.build\/bench-runs\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/(?:attempt|cycle)-[0-9]{2}\.splat$/u.test(expected.path), 'Expected export is not an owned private artifact.');
      assert(Number.isSafeInteger(expected.bytes) && expected.bytes > 0 && expected.bytes <= 8_192_000 && expected.bytes % 32 === 0, 'Invalid expected fixed-workload SPLAT bytes.');
      assert.equal(artifact.path, expected.path); assert.equal(artifact.bytes, expected.bytes);
    } else {
      assert(/^\.build\/bench-runs\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/attempt-[0-9]{2}\.splat$/u.test(artifact.path as string), 'Saved export is not the owned private artifact.');
      assert.equal(artifact.bytes, 8_192_000);
    }
    assert(typeof artifact.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(artifact.sha256), 'Saved export has no valid SHA256.');
    const oracle = record(target.independentOracle, 'independent export oracle');
    assert.equal(oracle.encodedSha256, artifact.sha256, 'Independent export oracle does not bind the actual saved bytes.');
    receipt.artifact = { path: artifact.path, bytes: artifact.bytes, sha256: artifact.sha256 };
    await acknowledge();
    receipt.status = 'acknowledged';
  } catch (error) { receipt.status = 'failed'; receipt.error = errorText(error); throw error; }
}
/** Failed cleanup is diagnostic evidence and must not bypass report writing. */
export async function joinProbeCleanup(close: () => Promise<void>): Promise<{ joined: boolean; error: string | null }> {
  try { await close(); return { joined: true, error: null }; }
  catch (error) { return { joined: false, error: errorText(error) }; }
}
export async function readResponseBounded(response: Response, limit: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1024*1024) throw new Error('Invalid manifest response bound.');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Production manifest response has no body.');
  const chunks: Uint8Array[] = []; let count = 0;
  try {
    for (;;) {
      const {done,value} = await reader.read(); if (done) break;
      count += value.byteLength;
      if (count > limit) { await reader.cancel(); throw new Error('Production manifest response exceeds its byte bound.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(count); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.byteLength; }
  return bytes;
}
export async function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(async key => {
    const bridge = (window as unknown as Record<string, Bridge | undefined>)[key];
    if (!bridge || bridge.schemaVersion !== 1) throw new Error('The actual production app did not install the observation bridge.');
    return bridge.snapshot();
  }, KEY);
}
export async function writeBytes(workspace: Workspace, name: string, bytes: Uint8Array) {
  const path = await workspace.safe(name, true), handle = await open(path, 'wx');
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  return (await workspace.read(name)).reference;
}
export async function downloadBytes(download: ProbeDownload, limit: number): Promise<Uint8Array> {
  const stream = await download.createReadStream();
  if (!stream) throw new Error('Actual browser download stream is unavailable.');
  const chunks: Buffer[] = []; let count = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk as Uint8Array); count += bytes.length;
    if (count > limit) { stream.destroy(); throw new Error('Actual export exceeds the declared fixed workload.'); }
    chunks.push(bytes);
  }
  if (await download.failure()) throw new Error('Actual browser download failed.');
  return Buffer.concat(chunks, count);
}
export async function waitProbeReady(read: () => Promise<Snapshot | null>, loaded: boolean, timeoutMs = 60_000): Promise<void> {
  // Playwright's predicate polling tests a returned Promise for truthiness.
  // Await the actual snapshot here before deciding that startup has completed.
  const deadline = performance.now() + timeoutMs;
  do {
    const value = await read();
    const controller = value?.controller, state = controller?.state;
    if (!controller || !state) { await new Promise(resolve => setTimeout(resolve, 100)); continue; }
    if (state.error) throw new Error(state.error);
    if (state.ready && !state.busy && state.bootstrapState === 'ready' && state.rendererState === 'ready' && controller.renderer?.ready === true &&
      controller.renderer.negotiation.status === 'ready' && controller.observation.enabled &&
      (loaded ? state.hasScene && state.hasClient : !state.hasScene && !state.hasClient)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (performance.now() < deadline);
  throw new Error('Timed out waiting for the actual production bridge and renderer readiness.');
}
async function waitReady(page: Page, loaded: boolean, observe: (value: Snapshot | null) => void) {
  await waitProbeReady(() => page.evaluate(async key => {
    const bridge = (window as unknown as Record<string, Bridge | undefined>)[key];
    return bridge ? await bridge.snapshot() : null;
  }, KEY).then(value => { observe(value); return value; }), loaded);
}
export async function waitForLoadedOpen(page: Page, baseline: Snapshot, expected: Parameters<typeof assertProbeSnapshot>[1]): Promise<{ loaded: Snapshot; opened: Operation; completed: Frame }> {
  // Node's clock bounds polling only. Reported durations exclusively subtract
  // actual observations within the unchanged browser performance.now domain.
  const deadline = performance.now() + 60_000;
  do {
    const loaded = await snapshot(page); assertProbeSnapshot(loaded, expected); assertProbeClock(loaded, baseline);
    assert.equal(loaded.controller.state.summary?.count, 256_000); assert.equal(loaded.controller.state.summary?.sourceCount, 256_000);
    assert.equal(loaded.controller.state.summary?.shDegree, 0);
    const opened = settledProbeOpen(loaded, baseline.controller.observation.lastOperationSequence);
    if (opened) {
      const completed = completedProbeFrame(loaded, baseline.controller.observation.lastFrameSequence, opened);
      if (completed) return { loaded, opened, completed };
    }
    await page.waitForTimeout(100);
  } while (performance.now() < deadline);
  throw new Error('Timed out waiting for the actual settled open operation and matching queue-completed document frame.');
}

export async function runProductionProbe(options: ProbeOptions, hooks: ProductionProbeHooks = {}): Promise<{ status: string; report: string; attempts: number }> {
  const workspace = new Workspace(process.cwd(), 128*1024*1024, 1024*1024*1024);
  const manifestInput = await workspace.read(options.manifest), manifest = record(JSON.parse(new TextDecoder().decode(manifestInput.bytes)), 'fixture manifest');
  assert.equal(manifest.status, 'pinned'); assert.equal(manifest.id, 'dyadic-grid-256k-sh0-v1');
  const identity = record(manifest.identity, 'fixture identities'), workload = record(manifest.workload, 'workload');
  const input = await workspace.read(options.fixture);
  const independentlyChecked = validateBenchmarkRaw(input.bytes);
  assert.equal(input.reference.sha256, identity.inputSha256); assert.equal(workload.sourceCount, independentlyChecked.count);
  for (const key of ['inputSha256','expectedSceneSha256','sourceOrderSha256','distributionSha256'] as const) assert.equal(identity[key], independentlyChecked[key]);
  const buildInput = await workspace.read(options.build), build = record(JSON.parse(new TextDecoder().decode(buildInput.bytes)), 'shipping manifest');
  const descriptor = record(build.build, 'shipping descriptor');
  assert.equal(typeof descriptor.appInputId, 'string'); assert.equal(typeof build.deploymentId, 'string');
  assert(Array.isArray(build.artifacts));
  const expected = { appInputId: descriptor.appInputId as string, deploymentId: build.deploymentId as string, artifacts: build.artifacts };
  const response = await fetch(new URL('build-manifest.json', options.baseUrl), { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(30_000) });
  assert(response.ok, 'Production manifest fetch failed.');
  const served = await readResponseBounded(response,1024*1024);
  assert(served.length <= 1024*1024 && digest(served) === buildInput.reference.sha256, 'Served deployment differs from the supplied local shipping manifest.');
  // Create exactly one new private output directory, after checking every ancestor.
  for (const name of ['.build','.build/bench-runs']) {
    const path = await workspace.safe(name, true);
    try { await mkdir(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    await workspace.safe(name);
  }
  await mkdir(await workspace.safe(options.output, true)); await workspace.safe(options.output);
  const attempts: ObjectValue[] = [], runtimeErrors: string[] = []; let droppedRuntimeErrors = 0;
  const recordRuntimeError = (error: unknown) => { if (runtimeErrors.length < 128) runtimeErrors.push(errorText(error)); else droppedRuntimeErrors++; };
  const startedAtUtc = new Date().toISOString();
  const launchArguments = ['--enable-unsafe-webgpu'];
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined, joined = false, normalUi: ObjectValue | null = null;
  let browserVersion: string | null = null;
  try {
    if (!hooks.createBrowserOwner) browser = await chromium.launch({ channel: 'chromium', headless: true, args: launchArguments });
    const ordinaryMetadata: ObjectValue = {browserChannel:'chromium',headless:true,launchArguments};
    const ordinaryObservation: ObjectValue = {bridgePresent:null,host:ordinaryMetadata,browserContextJoined:false};
    normalUi = ordinaryObservation;
    let ordinaryOwner: ProductionProbeBrowserOwner | undefined;
    try {
      if (hooks.createBrowserOwner) ordinaryOwner = await hooks.createBrowserOwner({id:'ordinary-ui',metadata:ordinaryMetadata});
      else {
        const ordinary = await browser!.newContext({ viewport: {width:1280,height:800}, deviceScaleFactor:1, locale:'en-US' });
        ordinaryOwner = {browser:browser!,context:ordinary,metadata:ordinaryMetadata,close:()=>ordinary.close()};
      }
      assert.equal(ordinaryOwner.metadata,ordinaryMetadata,'Browser owner replaced the retained launch metadata.');
      browserVersion=ordinaryOwner.browser.version();
      const ordinary=ordinaryOwner.context;
      await ordinary.addInitScript(() => localStorage.setItem('splatview.tutorial.v1', '{"tutorial_prompt_handled":"handled"}'));
      const page = await ordinary.newPage(); page.on('pageerror', recordRuntimeError);
      await page.setViewportSize({width:1280,height:800}); await page.bringToFront();
      await page.goto(options.baseUrl); await page.getByRole('button',{name:'Open scene',exact:true}).waitFor({state:'visible'});
      assert.equal(await page.evaluate(key => key in window, KEY), false, 'Observation bridge leaked into ordinary UI.');
      ordinaryObservation.bridgePresent=false; ordinaryObservation.url=page.url();
    } finally {
      if (ordinaryOwner) {
        const owner=ordinaryOwner,cleanup=await joinProbeCleanup(()=>owner.close());
        ordinaryObservation.browserContextJoined=cleanup.joined; ordinaryObservation.cleanupError=cleanup.error;
        if (cleanup.error) recordRuntimeError(cleanup.error);
      }
    }
    for (let index=0;index<options.attempts;index++) {
      const id = `attempt-${String(index+1).padStart(2,'0')}`;
      const attempt: ObjectValue = {id,status:'failed',cachePolicy:'Fresh browser context and document owner; GPU-driver/pipeline disk-cache state is unobserved.',snapshots:[],error:null,browserContextJoined:false,cleanupErrors:[]};
      attempts.push(attempt);
      let context: BrowserContext | undefined;
      let browserOwner: ProductionProbeBrowserOwner | undefined;
      const metadata: ObjectValue = {browserChannel:'chromium',headless:true,launchArguments};
      attempt.host = metadata;
      try {
        if (hooks.createBrowserOwner) browserOwner=await hooks.createBrowserOwner({id,metadata});
        else {
          const ownedContext=await browser!.newContext({viewport:{width:1280,height:800},deviceScaleFactor:1,locale:'en-US',acceptDownloads:true});
          browserOwner={browser:browser!,context:ownedContext,metadata,close:()=>ownedContext.close()};
        }
        assert.equal(browserOwner.metadata,metadata,'Browser owner replaced the retained launch metadata.');
        assert.equal(browserOwner.browser.version(),browserVersion,'Browser version changed between fresh probe owners.');
        context=browserOwner.context;
        await context.addInitScript(() => localStorage.setItem('splatview.tutorial.v1','{"tutorial_prompt_handled":"handled"}'));
        const page: Page = await context.newPage(); page.on('pageerror',recordRuntimeError); page.setDefaultTimeout(60_000);
        await page.setViewportSize({width:1280,height:800}); await page.bringToFront();
        const url = new URL(options.baseUrl); url.searchParams.set(QUERY,'1'); await page.goto(url.href);
        await waitReady(page,false,value=>{attempt.lastReadinessSnapshot=value;});
        const baseline = await snapshot(page); assertProbeSnapshot(baseline,expected);
        attempt.snapshots = [baseline];
        await page.getByLabel('Open scene files',{exact:true}).setInputFiles({name:'benchmark.splat',mimeType:'application/octet-stream',buffer:Buffer.from(input.bytes)});
        await waitReady(page,true,value=>{attempt.lastReadinessSnapshot=value;});
        const { loaded, opened, completed } = await waitForLoadedOpen(page, baseline, expected);
        (attempt.snapshots as Snapshot[]).push(loaded);
        attempt.openObservation = {clockId:loaded.clock.id,operation:opened,firstLoadedQueueCompletedFrame:completed,operationSettledMs:opened.settledAtMs!-opened.startedAtMs,firstLoadedQueueCompletionMs:completed.queueCompletedAtMs!-opened.startedAtMs,presentationUnavailableReason:'GPU queue completion is not physical/browser presentation.'};
        await hooks.observeLoaded?.({page,context,baseline,loaded,attempt});
        // Independent production codec proof, outside the open/close operation boundaries.
        await page.mouse.move(640,400); await page.getByRole('button',{name:'Save scene',exact:true}).click();
        const dialog = page.getByRole('dialog',{name:'Save scene',exact:true});
        await dialog.getByLabel('Export format',{exact:true}).selectOption('2');
        await dialog.getByLabel('Export scope',{exact:true}).selectOption('0');
        const download = await triggerProbeEvent<ProbeDownload>(() => browserOwner!.waitForDownload?browserOwner!.waitForDownload(page):page.waitForEvent('download'), () => dialog.getByRole('button',{name:'Download',exact:true}).click());
        const bytes = await downloadBytes(download,8_192_000), exportObservation: ObjectValue = {suggestedFilename:download.suggestedFilename(),downloadObservation:download.observation??{source:'Playwright-download-event'}};
        attempt.export = exportObservation;
        await preserveProbeExport(exportObservation, bytes, value => writeBytes(workspace,`${options.output}/${id}.splat`,value), validateBenchmarkSplatExport);
        await acknowledgeProbeExport(exportObservation, async () => {
          const receipt = page.getByRole('status').filter({hasText:'Download prepared'});
          await receipt.getByRole('button',{name:'I have kept the file',exact:true}).click();
          await receipt.waitFor({state:'hidden'});
        });
        const closed: Snapshot = await page.evaluate(key=>(window as unknown as Record<string,Bridge>)[key]!.closeScene(),KEY);
        assertProbeSnapshot(closed,expected); assertProbeClock(closed,baseline);
        const close = assertProbeClosed(closed,loaded.controller.observation.lastOperationSequence);
        (attempt.snapshots as Snapshot[]).push(closed);
        attempt.closeObservation={clockId:closed.clock.id,operation:close,joinedSceneCloseMs:close.settledAtMs!-close.startedAtMs,retirementMeaning:'Actual closeScene() resolved with zero logical ledger/category allocations and named document owners joined; physical release is unobserved.'};
        await page.evaluate(key=>(window as unknown as Record<string,Bridge>)[key]!.stop(),KEY);
        assert.equal(await page.evaluate(key=>key in window,KEY),false);
        attempt.status='observed';
      } catch (error) { attempt.error=errorText(error); }
      finally {
        if (browserOwner) {
          const owner = browserOwner, cleanup = await joinProbeCleanup(() => owner.close());
          attempt.browserContextJoined = cleanup.joined;
          if (cleanup.error) { (attempt.cleanupErrors as string[]).push(cleanup.error); attempt.status='failed'; recordRuntimeError(cleanup.error); }
        }
      }
      await workspace.writeExclusive(`${options.output}/${id}.json`,attempt);
    }
  } catch (error) { recordRuntimeError(error); }
  finally {
    if (browser) { const owner = browser, cleanup = await joinProbeCleanup(() => owner.close()); joined=cleanup.joined; if (cleanup.error) recordRuntimeError(cleanup.error); }
    else if (hooks.createBrowserOwner) joined=normalUi?.browserContextJoined===true&&attempts.length===options.attempts&&attempts.every(attempt=>attempt.browserContextJoined===true);
  }
  const status = attempts.length===options.attempts&&attempts.every(attempt=>attempt.status==='observed'&&attempt.browserContextJoined===true)&&!runtimeErrors.length&&!droppedRuntimeErrors&&joined?'observed':'failed';
  const report = `${options.output}/observation.json`;
  await workspace.writeExclusive(report,{schemaVersion:1,kind:'splatview-production-open-export-close-probe',status,scope:'initial-production-observations-only',startedAtUtc,endedAtUtc:new Date().toISOString(),
    inputs:{fixture:input.reference,manifest:manifestInput.reference,build:buildInput.reference},fixtureOracle:independentlyChecked,
    host:{os:process.platform,osRelease:release(),cpuModel:cpus()[0]?.model??null,ramBytes:totalmem(),browserVersion,browserHost:'automation',
      browserChannel:(normalUi?.host as ObjectValue|undefined)?.browserChannel??'chromium',headless:(normalUi?.host as ObjectValue|undefined)?.headless??true,
      launchArguments:(normalUi?.host as ObjectValue|undefined)?.launchArguments??launchArguments,
      browserOwnership:hooks.createBrowserOwner?'fresh-external-browser-process-per-context':'one-owned-browser-with-fresh-contexts',
      systemModel:{value:null,unavailableReason:'System model is not measured by this collector.'}},
    normalUi,attempts,runtimeErrors,droppedRuntimeErrors,browserJoined:joined,performanceAccepted:false,capacityQualified:false,sustainedQualified:false,
    limitations:['This probe does not fulfill the complete 214-attempt initial benchmark protocol.','Snapshot polling and browser automation are present; these observations are not an approved latency budget.','Raw operation boundaries and queue completion use the actual page performance.now domain; queue completion is not presentation or GPU timestamps.','The declared orbit, contributor/query/amendment masks, overdraw, individual pipeline stage times, sustained history/retention and physical memory remain pending.','Fresh browser contexts do not prove cold GPU-driver caches.','No operating thresholds or memory ceilings are approved.']});
  return {status,report,attempts:attempts.length};
}
if (process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  runProductionProbe(parseProbeOptions(process.argv.slice(2))).then(result=>{process.stdout.write(JSON.stringify(result)+'\n');process.exitCode=result.status==='observed'?0:2;},error=>{process.stderr.write((error instanceof Error?error.stack??error.message:String(error))+'\n');process.exitCode=1;});
}
