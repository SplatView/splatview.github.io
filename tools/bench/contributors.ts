/** Raw ordinary-UI Single contributor observations; no performance/capacity acceptance. */
import assert from 'node:assert/strict';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { Workspace, relativePath } from '../release/files.ts';
import type { FileRef } from '../release/types.ts';
import { benchmarkExpectedIdentities } from './oracles.ts';
import { assertSelectionMask, selectionBaselineMask, type SelectionMaskIdentity } from './selection-oracles.ts';
import { contributorAnchorCase, expectedContributorAnchorMask, contributorSingleCase, contributorBaselineMask,
  expectedContributorSingleMask, contributorDeletedAnchorCase, contributorDeletedAnchorMask, assertContributorPick } from './contributor-oracles.ts';
import { assertOrbitCamera, assertOrbitFrame, type CameraBoundary, type OrbitFrameObservation } from './orbit.ts';
import { KEY, parseProbeOptions, runProductionProbe, snapshot, assertProbeSnapshot, assertProbeClock,
  type ProbeOptions, type Snapshot, type ProductionProbeObservation } from './run.ts';

type Json = Record<string, unknown>;
type Revision = NonNullable<Snapshot['controller']['state']['documentRevision']>;
const COUNT = 256_000;
const CAMERA = [0, 0, 0, 0, 0, 24, 1, 45, 1, 0, 1.6];
const FRAMEBUFFER = { width: 1280, height: 800, devicePixelRatio: 1 };
const NEUTRAL = [1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const COMBINE_LABELS = ['Replace', 'Add', 'Subtract', 'Intersect'];
export interface ContributorOptions extends ProbeOptions { selectionManifest: string }
export interface ContributorOwner {
  clientOwnerId: number | null; rendererOwnerId: number | null; sceneOwnerId: number | null; cameraOwnerId: number | null;
  documentRevision: Revision | null; camera: { revision: number; state: number[]; view: number[]; projection: number[]; eye: number[] } | null;
  scene: { revision: number; sourceRevision: number; selectedRevision: number; count: number } | null;
  deviceEpoch: number | null; rendererSubmissionSequence: number | null;
  framebuffer: typeof FRAMEBUFFER | null; visibility: string;
}
export interface ContributorQuery {
  sequence: number; status: 'pending' | 'completed' | 'stale' | 'failed' | 'disabled'; clock: 'performance.now';
  startedAtMs: number; settledAtMs: number | null; path: 'ordinary-single' | 'ordinary-color';
  request: { x: number; y: number; centerRadius: 0; sample: { x: number; y: number } };
  renderState: { grade: number[]; highlight: true; geometry: number[]; selectedOnly: boolean; geometrySelectedOnly: boolean; opacityScale: 1; opacitySelectedOnly: false };
  before: ContributorOwner; after: ContributorOwner | null;
  result: { index: number | null; depth: number | null; opacity: number | null; contribution: number | null; deviceEpoch: number } | null;
  error: string | null; staleReason: string | null; representation: 'decoded-production-GpuPick-not-raw-readback';
}
export interface ContributorMaskSnapshot {
  schemaVersion: 1; kind: 'splatview-production-benchmark-mask'; clock: Snapshot['clock'];
  runtime: Pick<Snapshot['runtime'], 'mode' | 'appInputId' | 'deploymentId'>;
  observation: { schemaVersion: 1; kind: 'splatview-controller-benchmark-mask'; status: 'completed' | 'stale' | 'failed';
    clock: 'performance.now'; startedAtMs: number; settledAtMs: number; before: ContributorOwner; after: ContributorOwner;
    sourceCount: number; byteLength: number; encoding: 'base64'; bytesBase64: string | null; callbacks: number;
    summary: Json | null; error: string | null; staleReason: string | null };
}
interface ContributorRing { queries: ContributorQuery[]; lastQuerySequence: number; droppedQueries: number; maxQueries: number }
export type ContributorSnapshot = Snapshot & { controller: Snapshot['controller'] & { observation: Snapshot['controller']['observation'] & ContributorRing } };
export interface ContributorPoint {
  rect: { x: number; y: number; width: number; height: number; left: number; top: number; right: number; bottom: number };
  framebuffer: typeof FRAMEBUFFER; requestedPoint: number[]; clientPoint: number[]; elementFromPointCanvas: boolean;
}
export interface ContributorCheckpoint {
  artifact: FileRef | null; maskObservation: Json | null; independentIdentity: SelectionMaskIdentity | null;
  oracleStatus: 'pending' | 'passed' | 'failed'; oracleError: string | null;
}
type Candidate = ReturnType<typeof contributorAnchorCase> | ReturnType<typeof contributorSingleCase> | ReturnType<typeof contributorDeletedAnchorCase>;
interface ContributorBridge {
  snapshot(): Promise<ContributorSnapshot>; applyCamera(state: number[]): Promise<CameraBoundary>;
  waitForFrame(after: number, timeoutMs?: number): Promise<OrbitFrameObservation>; readMasks(): Promise<ContributorMaskSnapshot>;
}
function object(value: unknown, label = 'contributor record'): Json {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), 'Invalid ' + label); return value as Json;
}
function errorText(error: unknown): string { try { return (error instanceof Error ? error.stack ?? error.message : String(error)).slice(0, 16_384); } catch { return 'Unserializable contributor failure'; } }
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const integer = (value: unknown, minimum = 0): value is number => Number.isSafeInteger(value) && (value as number) >= minimum;
function vector(value: unknown, length: number): void { assert(Array.isArray(value) && value.length === length && value.every(finite), 'Malformed finite vector'); }

export function contributorCases(): Candidate[] {
  return [contributorAnchorCase(0), contributorAnchorCase(1), contributorAnchorCase(2),
    ...([0, 1, 2, 3] as const).map(operation => contributorSingleCase(operation)),
    ...([0, 1, 2, 3] as const).map(operation => contributorSingleCase(operation, [1])), contributorDeletedAnchorCase()];
}
/** The original candidate declaration is bound before any contributor action. */
export function validateContributorManifest(value: unknown, fixtureValue: unknown, fixtureReference: FileRef): void {
  const manifest = object(value), fixture = object(fixtureValue), expected = benchmarkExpectedIdentities();
  assert.equal(fixture.status, 'pinned'); assert.equal(fixture.id, expected.fixtureId);
  const identity = object(fixture.identity);
  for (const key of ['inputSha256', 'expectedSceneSha256', 'sourceOrderSha256', 'distributionSha256'] as const) assert.equal(identity[key], expected[key]);
  assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.kind, 'splatview-fixed-selection-oracle-manifest'); assert.equal(manifest.id, 'dyadic-grid-selection-v1');
  assert.equal(manifest.status, 'native-correctness-qualified-browser-gpu-cache-performance-pending');
  const boundFixture = object(manifest.fixture); assert.deepEqual(boundFixture.manifest, fixtureReference);
  const selectedIdentity = object(boundFixture.identity);
  assert.equal(selectedIdentity.fixtureId, expected.fixtureId); assert.equal(selectedIdentity.count, COUNT);
  for (const key of ['inputSha256', 'expectedSceneSha256', 'sourceOrderSha256', 'distributionSha256'] as const) assert.equal(selectedIdentity[key], expected[key]);
  assert(Array.isArray(manifest.gpuPickCandidates) && manifest.gpuPickCandidates.length === 3);
  for (const id of [0, 1, 2] as const) {
    const candidate = object(manifest.gpuPickCandidates[id]); assert.equal(candidate.expectedSourceId, id);
    assert.equal(candidate.parametersSha256, contributorAnchorCase(id).parameters.ui.anchorProposalParametersSha256);
  }
}

export function assertContributorOwner(value: unknown): asserts value is ContributorOwner {
  const owner = object(value, 'actual owner');
  for (const key of ['clientOwnerId', 'rendererOwnerId', 'sceneOwnerId', 'cameraOwnerId', 'deviceEpoch']) assert(integer(owner[key], 1), 'Missing actual owner identity: ' + key);
  assert(integer(owner.rendererSubmissionSequence)); assert.equal(owner.visibility, 'visible'); assert.deepEqual(owner.framebuffer, FRAMEBUFFER);
  const revision = object(owner.documentRevision, 'document revision'); assert.equal(typeof revision.documentId, 'string'); assert((revision.documentId as string).length > 0);
  for (const key of ['sourceGeneration', 'contentRevision', 'selectionRevision', 'draftRevision']) assert(integer(revision[key]), 'Invalid full document revision');
  const camera = object(owner.camera, 'camera owner'); assert(integer(camera.revision)); assert.deepEqual(camera.state, CAMERA.map(Math.fround));
  vector(camera.view, 16); vector(camera.projection, 16); vector(camera.eye, 3);
  const scene = object(owner.scene, 'scene owner'); assert.equal(scene.count, COUNT);
  for (const key of ['revision', 'sourceRevision', 'selectedRevision']) assert(integer(scene[key]), 'Invalid scene revision');
}
/** Display submission counters may advance; actual object/revision owners may not. */
export function assertSameContributorOwner(before: ContributorOwner, after: ContributorOwner): void {
  assertContributorOwner(before); assertContributorOwner(after);
  const { rendererSubmissionSequence: first, ...a } = before, { rendererSubmissionSequence: last, ...b } = after;
  assert.deepEqual(a, b, 'Actual contributor owner/revision changed'); assert(last! >= first!, 'Renderer submission sequence moved backwards');
}
export function validateContributorRing(value: unknown): asserts value is ContributorRing {
  const ring = object(value, 'query ring'); assert.equal(ring.droppedQueries, 0, 'Contributor query history was dropped');
  assert.equal(ring.maxQueries, 128); assert(integer(ring.lastQuerySequence)); assert(Array.isArray(ring.queries) && ring.queries.length <= 128);
  let previous = 0;
  for (const raw of ring.queries) {
    const query = object(raw, 'actual query'); assert(integer(query.sequence, 1) && query.sequence === previous + 1, 'Query ring has a sequence gap'); previous = query.sequence;
    assert(['pending', 'completed', 'stale', 'failed', 'disabled'].includes(String(query.status)), 'Invalid query terminal');
  }
  assert.equal(previous, ring.lastQuerySequence, 'Query ring latest identity differs');
}
export function assertContributorPoint(point: ContributorPoint, requested: readonly number[]): void {
  vector(point.requestedPoint, 2); vector(point.clientPoint, 2); assert.deepEqual(point.requestedPoint, requested);
  assert.deepEqual(point.framebuffer, FRAMEBUFFER); assert.equal(point.elementFromPointCanvas, true, 'Pinned pixel is covered by application chrome');
  assert(Object.values(point.rect).every(finite) && point.rect.width > 0 && point.rect.height > 0, 'Invalid actual canvas DOMRect');
  assert.equal(point.rect.x, point.rect.left); assert.equal(point.rect.y, point.rect.top);
  assert.equal(point.rect.right, point.rect.left + point.rect.width); assert.equal(point.rect.bottom, point.rect.top + point.rect.height);
  assert(requested[0]! >= 0 && requested[0]! < FRAMEBUFFER.width && requested[1]! >= 0 && requested[1]! < FRAMEBUFFER.height);
  assert.deepEqual(point.clientPoint, [point.rect.left + requested[0]! * point.rect.width / FRAMEBUFFER.width,
    point.rect.top + requested[1]! * point.rect.height / FRAMEBUFFER.height], 'Actual pointer mapping differs from pinned framebuffer sample');
}
export function assertContributorQuery(query: ContributorQuery, beforeSequence: number, baseline: ContributorMaskSnapshot,
  candidate: Candidate, point: ContributorPoint): void {
  assert.equal(query.sequence, beforeSequence + 1, 'Ordinary UI action did not own exactly the next query');
  assert.equal(query.status, 'completed'); assert.equal(query.clock, 'performance.now'); assert.equal(query.path, 'ordinary-single');
  assert(finite(query.startedAtMs) && finite(query.settledAtMs) && query.startedAtMs >= baseline.observation.settledAtMs && query.settledAtMs >= query.startedAtMs, 'Invalid actual query clock boundaries');
  assert.equal(query.error, null); assert.equal(query.staleReason, null); assert.equal(query.representation, 'decoded-production-GpuPick-not-raw-readback');
  assert(query.after); assertSameContributorOwner(baseline.observation.after, query.before); assertSameContributorOwner(query.before, query.after);
  assertContributorPoint(point, candidate.parameters.ui.pointer.requestedPoint); assert.equal(query.request.centerRadius, 0);
  assert(finite(query.request.x) && finite(query.request.y));
  assert.deepEqual(query.request.sample, { x: candidate.parameters.ui.query.sample[0], y: candidate.parameters.ui.query.sample[1] });
  assert.equal(Math.floor(query.request.x), candidate.parameters.ui.query.pixel[0]); assert.equal(Math.floor(query.request.y), candidate.parameters.ui.query.pixel[1]);
  assert.deepEqual(query.renderState.grade, NEUTRAL); assert.equal(query.renderState.highlight, true); assert.deepEqual(query.renderState.geometry, IDENTITY);
  assert.equal(query.renderState.selectedOnly, Number(baseline.observation.summary!.selected) > 0);
  assert.equal(query.renderState.geometrySelectedOnly, query.renderState.selectedOnly); assert.equal(query.renderState.opacityScale, 1); assert.equal(query.renderState.opacitySelectedOnly, false);
  assertContributorPick(query.result, candidate.parameters.expectedSourceId as 0 | 1 | 2 | null, query.before.deviceEpoch!);
}

function assertMaskEnvelope(value: unknown, loaded: Snapshot, bytes: Uint8Array): asserts value is ContributorMaskSnapshot {
  const result = object(value), observation = object(result.observation);
  assert.equal(result.schemaVersion, 1); assert.equal(result.kind, 'splatview-production-benchmark-mask');
  const clock = object(result.clock); assert.equal(clock.id, loaded.clock.id); assert.equal(clock.timeOrigin, loaded.clock.timeOrigin); assert(finite(clock.now));
  const runtime = object(result.runtime); assert.equal(runtime.mode, 'production-verified'); assert.equal(runtime.appInputId, loaded.runtime.appInputId); assert.equal(runtime.deploymentId, loaded.runtime.deploymentId);
  assert.equal(observation.schemaVersion, 1); assert.equal(observation.kind, 'splatview-controller-benchmark-mask'); assert.equal(observation.status, 'completed'); assert.equal(observation.clock, 'performance.now');
  assert(finite(observation.startedAtMs) && finite(observation.settledAtMs) && observation.startedAtMs >= loaded.clock.now && observation.settledAtMs >= observation.startedAtMs && clock.now >= observation.settledAtMs);
  assert.equal(observation.sourceCount, COUNT); assert.equal(observation.byteLength, COUNT); assert.equal(bytes.byteLength, COUNT); assert.equal(observation.encoding, 'base64');
  assert(integer(observation.callbacks, 1) && observation.callbacks <= COUNT); assert.equal(observation.error, null); assert.equal(observation.staleReason, null);
  assertContributorOwner(observation.before); assertContributorOwner(observation.after); assertSameContributorOwner(observation.before, observation.after);
  assert.equal(observation.after.documentRevision!.documentId, loaded.controller.state.documentRevision!.documentId);
  assert.equal(observation.after.documentRevision!.sourceGeneration, loaded.controller.state.documentRevision!.sourceGeneration);
  const summary = object(observation.summary, 'actual native summary'); assert.equal(summary.ok, true); assert.equal(summary.loaded, true); assert.equal(summary.count, COUNT); assert.equal(summary.sourceCount, COUNT);
  assert.equal(summary.pending, false); assert.equal(summary.transaction, false); assert.equal(summary.selectionDraft, false);
  for (const key of ['selected', 'visible', 'revision', 'contentRevision']) assert(integer(summary[key]));
  assert.equal(typeof summary.canUndo, 'boolean'); assert.equal(typeof summary.canRedo, 'boolean');
}

/** Raw native bytes are exclusive artifacts before ownership or independent oracle assertions. */
export async function preserveContributorCheckpoint(target: ContributorCheckpoint, value: unknown, expected: Uint8Array,
  loaded: Snapshot, persist: (bytes: Uint8Array) => Promise<FileRef>): Promise<void> {
  target.oracleStatus = 'pending'; target.independentIdentity = null; target.oracleError = null; target.artifact = null;
  try {
    const envelope = object(value), observation = object(envelope.observation);
    target.maskObservation = { ...envelope, observation: { ...observation, bytesBase64: null, rawBytesArtifact: null } };
    assert(typeof observation.bytesBase64 === 'string' && observation.bytesBase64.length <= 700_000, 'Missing/bounded actual mask bytes');
    const bytes = Buffer.from(observation.bytesBase64, 'base64');
    assert(bytes.length <= 512 * 1024 && bytes.toString('base64') === observation.bytesBase64, 'Noncanonical or excessive actual mask encoding');
    target.artifact = await persist(bytes);
    (target.maskObservation.observation as Json).rawBytesArtifact = target.artifact;
    assertMaskEnvelope(value, loaded, bytes);
    target.independentIdentity = assertSelectionMask(bytes, expected);
    assert.equal(value.observation.summary!.selected, target.independentIdentity.selectedCount);
    assert.equal(value.observation.summary!.visible, target.independentIdentity.visibleCount);
    target.oracleStatus = 'passed';
  } catch (error) { target.oracleStatus = 'failed'; target.oracleError = errorText(error); throw error; }
}

export function parseContributorOptions(args: string[]): ContributorOptions {
  const filtered: string[] = []; let selectionManifest: string | undefined;
  for (let index = 0; index < args.length; index += 2) {
    if (args[index] === '--selection-manifest') { assert(selectionManifest === undefined && args[index + 1], 'Expected one selection manifest'); selectionManifest = relativePath(args[index + 1]!); }
    else filtered.push(args[index]!, args[index + 1]!);
  }
  return { ...parseProbeOptions(filtered), selectionManifest: selectionManifest ?? 'tests/fixtures/bench/selection-v1.json' };
}

async function settledSnapshot(page: Page, loaded: Snapshot): Promise<ContributorSnapshot> {
  const deadline = performance.now() + 60_000;
  for (;;) {
    const value = await snapshot(page) as ContributorSnapshot;
    assert.equal(value.controller.state.error, null); assertProbeClock(value, loaded);
    validateContributorRing(value.controller.observation);
    const pending = value.controller.knownPending;
    if (!value.controller.state.busy && ['editOperation', 'selectionCleanupOwner', 'releasedSelectionDrain', 'drawing', 'scheduledAnimationFrame'].every(key => pending[key] === false) &&
        ['selectionBarriers', 'releasedSelectionOwners', 'tolerancePickTasks'].every(key => pending[key] === 0)) {
      assertProbeSnapshot(value, { appInputId: loaded.runtime.appInputId, deploymentId: loaded.runtime.deploymentId! }); return value;
    }
    assert(performance.now() < deadline, 'Timed out joining the actual public UI edit/display owners'); await page.waitForTimeout(25);
  }
}
async function fixedCamera(page: Page, loaded: Snapshot): Promise<Json> {
  const receipt = await page.evaluate(async ({ key, camera }) => {
    const api = (window as unknown as Record<string, ContributorBridge>)[key]!;
    const boundary = await api.applyCamera(camera), deadline = performance.now() + 15_000;
    let cursor = boundary.controller.observation.lastFrameSequence;
    for (;;) {
      try { await api.waitForFrame(cursor, 1000); } catch { /* An earlier camera can genuinely settle stale. */ }
      const current = await api.snapshot(), frames = current.controller.observation.frames as unknown as OrbitFrameObservation[];
      const frame = frames.find(item => item.sequence > boundary.controller.observation.lastFrameSequence && item.status === 'completed' &&
        item.camera.revision === boundary.controller.camera!.revision && JSON.stringify(item.camera.state) === JSON.stringify(boundary.controller.camera!.state));
      if (frame && current.controller.knownPending.drawing === false) return { boundary, frame };
      if (performance.now() >= deadline) throw new Error('Timed out joining the actual fixed contributor camera frame');
      cursor = current.controller.observation.lastFrameSequence;
    }
  }, { key: KEY, camera: CAMERA });
  assertOrbitCamera(receipt.boundary, CAMERA, loaded); assertOrbitFrame(receipt.frame, receipt.boundary, CAMERA, loaded);
  return receipt;
}
export async function configureContributorSingleUi(page: Pick<Page, 'getByRole'>, operation: number): Promise<Json> {
  assert(integer(operation) && operation <= 3);
  const tools = page.getByRole('complementary', { name: 'Tools', exact: true });
  if (!await tools.isVisible()) await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await tools.waitFor({ state: 'visible' });
  const selector = tools.getByRole('button', { name: 'Selection tool', exact: true });
  if (await selector.count()) {
    await selector.click();
    // Both modes use the accessible document.body portal, outside Tools.
    const menu = page.getByRole('menu', { name: 'Selection tools', exact: true });
    await menu.getByRole('menuitemradio', { name: 'Single splat', exact: true }).click();
    await menu.waitFor({ state: 'hidden' });
    await selector.getByText('Single splat', { exact: true }).waitFor({ state: 'visible' });
    assert.equal(await selector.getAttribute('aria-expanded'), 'false');
  } else {
    const single = tools.getByRole('button', { name: 'Single splat', exact: true }); await single.click();
    assert.equal(await single.getAttribute('aria-pressed'), 'true');
  }
  const live = tools.getByRole('group', { name: 'Options', exact: true }).getByRole('button', { name: 'Live selection', exact: true });
  if (await live.getAttribute('aria-pressed') === 'true') await live.click();
  assert.equal(await live.getAttribute('aria-pressed'), 'false');
  const combine = tools.getByRole('button', { name: COMBINE_LABELS[operation]!, exact: true }); await combine.click();
  assert.equal(await combine.getAttribute('aria-pressed'), 'true');
  return { tool: 'single', liveSelection: false, combine: operation };
}
async function selectionBaselineUi(page: Page, all: boolean): Promise<Json> {
  const label = all ? 'Select all' : 'Clear selection', button = page.getByRole('complementary', { name: 'Tools', exact: true }).getByRole('button', { name: label, exact: true });
  const clicked = await button.isEnabled(); if (clicked) await button.click();
  return { command: all ? 'selectAll' : 'selectNone', label, clicked };
}
async function pointFor(page: Page, candidate: Candidate): Promise<ContributorPoint> {
  const requested = [...candidate.parameters.ui.pointer.requestedPoint];
  const point = await page.getByLabel('SplatView scene', { exact: true }).evaluate((element, input) => {
    if (!(element instanceof HTMLCanvasElement)) throw new Error('Actual scene element is not a canvas');
    const bounds = element.getBoundingClientRect(), clientPoint = [bounds.left + input[0]! * bounds.width / element.width, bounds.top + input[1]! * bounds.height / element.height];
    return { rect: { x: bounds.x, y: bounds.y, left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom, width: bounds.width, height: bounds.height },
      framebuffer: { width: element.width, height: element.height, devicePixelRatio }, requestedPoint: input, clientPoint,
      elementFromPointCanvas: document.elementFromPoint(clientPoint[0]!, clientPoint[1]!) === element };
  }, requested);
  assertContributorPoint(point, requested); return point;
}
function blankCheckpoint(): ContributorCheckpoint { return { artifact: null, maskObservation: null, independentIdentity: null, oracleStatus: 'pending', oracleError: null }; }

async function observeContributors(input: ProductionProbeObservation, options: ContributorOptions, workspace: Workspace, cases: Candidate[]): Promise<void> {
  const { page, loaded, attempt } = input, records: Json[] = [];
  const observed: Json = { status: 'pending', clock: loaded.clock, predeclaredCases: cases, camera: null, cases: records,
    setup: null, restored: null, cache: { available: false, reason: 'This bounded Single packet does not exercise or qualify Connected Color/map-cache reuse.' }, error: null };
  attempt.contributorObservation = observed;
  const id = String(attempt.id); assert(/^attempt-[0-9]{2}$/u.test(id));
  const checkpoint = async (name: string, target: ContributorCheckpoint, expected: Uint8Array): Promise<ContributorMaskSnapshot> => {
    assert(/^[a-z0-9][a-z0-9-]{0,120}$/u.test(name));
    try {
      await settledSnapshot(page, loaded);
      const value = await page.evaluate(key => (window as unknown as Record<string, ContributorBridge>)[key]!.readMasks(), KEY);
      await preserveContributorCheckpoint(target, value, expected, loaded, async bytes => {
        const path = `${options.output}/${id}-${name}.state`, handle = await open(await workspace.safe(path, true), 'wx');
        try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
        return (await workspace.read(path)).reference;
      });
      return value;
    } catch (error) { target.oracleStatus = 'failed'; target.oracleError = errorText(error); throw error; }
  };
  const click = async (target: Json, candidate: Candidate, before: ContributorMaskSnapshot): Promise<void> => {
    const initial = await settledSnapshot(page, loaded), sequence = initial.controller.observation.lastQuerySequence;
    const ringProof = (ring: ContributorRing) => ({ lastQuerySequence: ring.lastQuerySequence, droppedQueries: ring.droppedQueries,
      maxQueries: ring.maxQueries, retainedSequences: ring.queries.map(row => row.sequence) });
    target.queryBeforeSequence = sequence; target.query = null; target.queryRingBefore = ringProof(initial.controller.observation); target.queryRingAfter = null;
    const point = await pointFor(page, candidate); target.point = point;
    await page.mouse.click(point.clientPoint[0]!, point.clientPoint[1]!, { button: 'left' });
    const deadline = performance.now() + 60_000;
    for (;;) {
      const current = await snapshot(page) as ContributorSnapshot; assertProbeClock(current, loaded); validateContributorRing(current.controller.observation);
      const query = current.controller.observation.queries.find(row => row.sequence > sequence);
      target.queryRingAfter = ringProof(current.controller.observation); if (query) target.query = query;
      if (query && query.status !== 'pending') {
        assert.equal(current.controller.observation.lastQuerySequence, sequence + 1, 'One click produced unrelated/additional query observations');
        assertContributorQuery(query, sequence, before, candidate, point); await settledSnapshot(page, loaded); return;
      }
      assert.equal(current.controller.state.error, null); assert(performance.now() < deadline, 'Actual ordinary Single query did not settle'); await page.waitForTimeout(25);
    }
  };
  const runCase = async (candidate: Candidate, beforeMask: Uint8Array, afterMask: Uint8Array, history: boolean): Promise<void> => {
    const checkpoints: Record<string, ContributorCheckpoint> = {}, row: Json = { id: candidate.id, status: 'pending', parameters: candidate.parameters,
      parametersSha256: candidate.parametersSha256, expected: candidate.expected, baselineAction: null, settings: null, point: null, queryBeforeSequence: null, query: null, checkpoints, error: null };
    records.push(row);
    try {
      row.settings = await configureContributorSingleUi(page, candidate.parameters.operation);
      row.baselineAction = await selectionBaselineUi(page, candidate.parameters.originalBaseline.recipe === 'all-visible-selected');
      const before = await checkpoint(candidate.id + '-before', checkpoints.before = blankCheckpoint(), beforeMask);
      await click(row, candidate, before);
      const after = await checkpoint(candidate.id + '-after', checkpoints.after = blankCheckpoint(), afterMask);
      if (history) {
        for (const [phase, label, mask] of [['undo', 'Undo', beforeMask], ['redo', 'Redo', afterMask], ['undoAgain', 'Undo', beforeMask]] as const) {
          await page.getByRole('complementary', { name: 'Tools', exact: true }).getByRole('button', { name: label, exact: true }).click();
          await checkpoint(candidate.id + '-' + phase.toLowerCase(), checkpoints[phase] = blankCheckpoint(), mask);
        }
      } else {
        assert.deepEqual(after.observation.after.documentRevision, before.observation.after.documentRevision, 'No-hit action changed the full document revision');
        for (const key of ['canUndo', 'canRedo', 'revision', 'contentRevision']) assert.equal(after.observation.summary![key], before.observation.summary![key], 'No-hit action changed native history: ' + key);
      }
      row.status = 'observed';
    } catch (error) { row.status = 'failed'; row.error = errorText(error); throw error; }
  };
  try {
    observed.camera = await fixedCamera(page, loaded);
    const none = selectionBaselineMask('none');
    for (const source of [0, 1, 2] as const) await runCase(cases[source]!, none, expectedContributorAnchorMask(source), true);
    for (const operation of [0, 1, 2, 3] as const) {
      const before = contributorBaselineMask(operation); await runCase(cases[3 + operation]!, before, expectedContributorSingleMask(before, operation), true);
    }
    const setup: Json = { status: 'pending', before: null, selectedRight: null, deletedRight: null, settings: null, baselineAction: null, point: null,
      queryBeforeSequence: null, query: null, error: null }; observed.setup = setup;
    try {
      setup.settings = await configureContributorSingleUi(page, 0); setup.baselineAction = await selectionBaselineUi(page, false);
      const before = await checkpoint('setup-before', setup.before = blankCheckpoint(), none);
      await click(setup, contributorAnchorCase(1), before);
      await checkpoint('setup-selected-right', setup.selectedRight = blankCheckpoint(), expectedContributorAnchorMask(1));
      await page.getByRole('complementary', { name: 'Tools', exact: true }).getByRole('button', { name: 'Delete selected', exact: true }).click();
      await checkpoint('setup-deleted-right', setup.deletedRight = blankCheckpoint(), contributorDeletedAnchorMask()); setup.status = 'observed';
    } catch (error) { setup.status = 'failed'; setup.error = errorText(error); throw error; }
    for (const operation of [0, 1, 2, 3] as const) {
      const before = contributorBaselineMask(operation, [1]); await runCase(cases[7 + operation]!, before, expectedContributorSingleMask(before, operation, [1]), true);
    }
    await runCase(cases[11]!, contributorDeletedAnchorMask(), contributorDeletedAnchorMask(), false);
    await page.getByRole('complementary', { name: 'Tools', exact: true }).getByRole('button', { name: 'Restore deleted', exact: true }).click();
    await settledSnapshot(page, loaded); await selectionBaselineUi(page, false);
    await checkpoint('restored', observed.restored = blankCheckpoint(), none); observed.status = 'observed';
  } catch (error) { observed.status = 'failed'; observed.error = errorText(error); throw error; }
}

export async function runProductionContributors(options: ContributorOptions): Promise<{ status: string; report: string; attempts: number }> {
  const workspace = new Workspace(process.cwd(), 128 * 1024 * 1024, 1024 * 1024 * 1024);
  const fixtureManifest = await workspace.read(options.manifest), selectionManifest = await workspace.read(options.selectionManifest);
  validateContributorManifest(JSON.parse(new TextDecoder().decode(selectionManifest.bytes)), JSON.parse(new TextDecoder().decode(fixtureManifest.bytes)), fixtureManifest.reference);
  const fixture = await workspace.read(options.fixture); assert.equal(fixture.reference.sha256, benchmarkExpectedIdentities().inputSha256);
  const cases = contributorCases(), sources = await Promise.all(['tools/bench/contributors.ts', 'tools/bench/contributor-oracles.ts', 'tools/bench/selection-oracles.ts', 'tools/bench/oracles.ts'].map(async path => (await workspace.read(path)).reference));
  let predeclared: FileRef | null = null;
  const probe = await runProductionProbe(options, { observeLoaded: async input => {
    if (!predeclared) {
      const path = `${options.output}/predeclared-contributors.json`;
      await workspace.writeExclusive(path, { schemaVersion: 1, kind: 'splatview-predeclared-single-contributor-cases', fixtureManifest: fixtureManifest.reference,
        selectionManifest: selectionManifest.reference, fixture: fixture.reference, oracleSources: sources, predeclaredCases: cases });
      predeclared = (await workspace.read(path)).reference;
    }
    await observeContributors(input, options, workspace, cases);
  } });
  for (const reference of [fixtureManifest.reference, selectionManifest.reference, fixture.reference, ...sources]) await workspace.read(reference.path, reference);
  const parent = await workspace.read(probe.report), packet = object(JSON.parse(new TextDecoder().decode(parent.bytes)));
  const attemptFiles: FileRef[] = [];
  for (let index = 0; index < probe.attempts; index++) attemptFiles.push((await workspace.read(`${options.output}/attempt-${String(index + 1).padStart(2, '0')}.json`)).reference);
  const report = `${options.output}/contributors-observation.json`;
  await workspace.writeExclusive(report, { schemaVersion: 1, kind: 'splatview-production-single-contributor-observation', status: probe.status,
    scope: 'isolated-ordinary-ui-single-queries-and-full-source-state-checkpoints-only',
    source: { probe: parent.reference, fixtureManifest: fixtureManifest.reference, selectionManifest: selectionManifest.reference, predeclared, oracleSources: sources },
    predeclaredCases: cases, attempts: probe.attempts, attemptFiles, host: packet.host,
    fullReleaseAccepted: false, performanceAccepted: false, capacityQualified: false, sustainedQualified: false, fullMatrixAccepted: false,
    overdrawMeasured: false, generalConnectedColorFillQualified: false,
    limitations: ['Decoded results are from the exact renderer.pick invoked by the real ordinary Single UI action; raw GPU readback bytes and numerical shader tolerances are not claimed.',
      'Only three separated anchor contributors, four Combine operations with/without one deleted anchor, native Undo/Redo and the null deleted-anchor query are exercised.',
      'Connected Color, Fill, overlapping contributors, cold/warm cache reuse, projected overdraw and the complete initial matrix remain pending.',
      'Actual full-scene export and zero-ledger public closure remain separately retained by the parent probe. Browser automation is present; no latency or physical-memory acceptance follows.'] });
  return { status: probe.status, report, attempts: probe.attempts };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runProductionContributors(parseContributorOptions(process.argv.slice(2))).then(value => { process.stdout.write(JSON.stringify(value) + '\n'); process.exitCode = value.status === 'observed' ? 0 : 2; },
    error => { process.stderr.write(errorText(error) + '\n'); process.exitCode = 1; });
}
