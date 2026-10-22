import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { assertContributorOwner, assertSameContributorOwner, assertContributorPoint, assertContributorQuery, configureContributorSingleUi,
  contributorCases, parseContributorOptions, preserveContributorCheckpoint, validateContributorManifest, validateContributorRing,
  type ContributorCheckpoint, type ContributorMaskSnapshot, type ContributorOwner, type ContributorPoint, type ContributorQuery } from '../tools/bench/contributors.ts';
import type { Snapshot } from '../tools/bench/run.ts';

const camera = [0, 0, 0, 0, 0, 24, 1, 45, 1, 0, 1.6].map(Math.fround);
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const documentRevision = { documentId: 'actual-owned-document', sourceGeneration: 1, contentRevision: 0, selectionRevision: 0, draftRevision: 0 };
const runtime = { mode: 'production-verified', appInputId: 'a'.repeat(64), deploymentId: 'b'.repeat(64) };
const clock = { id: 'performance.now:100', timeOrigin: 100, now: 13 };
function owner(): ContributorOwner { return { clientOwnerId: 1, rendererOwnerId: 2, sceneOwnerId: 3, cameraOwnerId: 4,
  documentRevision: { ...documentRevision }, camera: { revision: 7, state: [...camera], view: [...identity], projection: [...identity], eye: [0, 0, 24] },
  scene: { revision: 0, sourceRevision: 0, selectedRevision: 0, count: 256000 }, deviceEpoch: 1, rendererSubmissionSequence: 2,
  framebuffer: { width: 1280, height: 800, devicePixelRatio: 1 }, visibility: 'visible' }; }
function loaded(): Snapshot { return { clock: { ...clock, now: 1 }, runtime: { ...runtime, artifacts: [] },
  controller: { state: { documentRevision: { ...documentRevision } } } } as unknown as Snapshot; }
function mask(bytes = new Uint8Array(256000)): ContributorMaskSnapshot { return { schemaVersion: 1, kind: 'splatview-production-benchmark-mask', clock: { ...clock }, runtime: { ...runtime },
  observation: { schemaVersion: 1, kind: 'splatview-controller-benchmark-mask', status: 'completed', clock: 'performance.now', startedAtMs: 11, settledAtMs: 12,
    before: owner(), after: owner(), sourceCount: 256000, byteLength: 256000, encoding: 'base64', bytesBase64: Buffer.from(bytes).toString('base64'), callbacks: 1,
    summary: { ok: true, duplicateRange: null, loaded: true, count: 256000, sourceCount: 256000, selected: 0, visible: 256000, pending: false, transaction: false,
      selectionDraft: false, canUndo: false, canRedo: false, revision: 0, contentRevision: 0 }, error: null, staleReason: null } }; }
function point(): ContributorPoint { return { rect: { x: 10, y: 20, left: 10, top: 20, width: 640, height: 400, right: 650, bottom: 420 },
  framebuffer: { width: 1280, height: 800, devicePixelRatio: 1 }, requestedPoint: [318.5, 400.5], clientPoint: [169.25, 220.25], elementFromPointCanvas: true }; }
function query(): ContributorQuery { return { sequence: 1, status: 'completed', clock: 'performance.now', startedAtMs: 20, settledAtMs: 21, path: 'ordinary-single',
  request: { x: 318.5, y: 400.5, centerRadius: 0, sample: { x: 318.5, y: 400.5 } },
  renderState: { grade: [1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], highlight: true, geometry: [...identity], selectedOnly: false,
    geometrySelectedOnly: false, opacityScale: 1, opacitySelectedOnly: false }, before: owner(), after: { ...owner(), rendererSubmissionSequence: 3 },
  result: { index: 0, depth: 24, opacity: 1, contribution: .8, deviceEpoch: 1 }, error: null, staleReason: null, representation: 'decoded-production-GpuPick-not-raw-readback' }; }
function checkpoint(): ContributorCheckpoint { return { artifact: null, maskObservation: null, independentIdentity: null, oracleStatus: 'pending', oracleError: null }; }
const artifact = { path: '.build/bench-runs/unit/actual.state', bytes: 256000, sha256: 'c'.repeat(64) };
const args = ['--base-url', 'http://127.0.0.1:4173/project/', '--fixture', '.build/bench-fixtures/pinned/fixture.splat', '--out', '.build/bench-runs/contributors-unit'];

/** Accessible UI state: both modes put Tool choices only in a body portal. */
function selectionUi(mode: 'basic' | 'pro') {
  const state = { mode, open: false, menu: false, single: false, live: true, combine: -1, actions: [] as string[] };
  const labels = ['Replace', 'Add', 'Subtract', 'Intersect'];
  interface UiLocator {
    isVisible(): Promise<boolean>; count(): Promise<number>; waitFor(options: { state: 'visible' | 'hidden' }): Promise<void>;
    click(options?: unknown): Promise<void>; getAttribute(name: string): Promise<string>;
    getByText(text: string, options: { exact: boolean }): UiLocator;
    getByRole(role: string, options: { name: string; exact: boolean }): UiLocator;
  }
  const visible = (id: string): boolean => id === 'tools-toggle' || id === 'panel' ? id === 'tools-toggle' || state.open :
    id === 'portal' || id === 'portal-single' ? state.open && state.menu :
    id === 'selected-value' ? state.open && state.single : state.open;
  const locator = (id: string): UiLocator => ({
    async isVisible() { return visible(id); },
    async count() { return Number(visible(id)); },
    async waitFor(options: { state: 'visible' | 'hidden' }) { assert.equal(visible(id), options.state === 'visible', 'Expected actual accessible state for ' + id); },
    async click(options?: unknown) {
      assert.equal(options, undefined, 'The collector must use ordinary unforced clicks'); assert(visible(id), 'Cannot click an unmounted/hidden control: ' + id);
      state.actions.push(id);
      if (id === 'tools-toggle') state.open = !state.open;
      else if (id === 'selector') state.menu = !state.menu;
      else if (id === 'portal-single') { state.single = true; state.menu = false; }
      else if (id === 'live') state.live = !state.live;
      else if (id.startsWith('combine-')) state.combine = Number(id.slice('combine-'.length));
      else assert.fail('Control has no user action: ' + id);
    },
    async getAttribute(name: string) {
      if (id === 'selector' && name === 'aria-expanded') return String(state.menu);
      assert.equal(name, 'aria-pressed');
      return String(id === 'live' ? state.live : state.combine === Number(id.slice('combine-'.length)));
    },
    getByText(text: string, options: { exact: boolean }) { assert.equal(id, 'selector'); assert.equal(text, 'Single splat'); assert.equal(options.exact, true); return locator('selected-value'); },
    getByRole(role: string, options: { name: string; exact: boolean }) {
      assert.equal(options.exact, true);
      if (id === 'page' && role === 'complementary' && options.name === 'Tools') return locator('panel');
      if (id === 'page' && role === 'button' && options.name === 'Tools') return locator('tools-toggle');
      if (id === 'page' && role === 'menu' && options.name === 'Selection tools') return locator('portal');
      if (id === 'panel' && role === 'button' && options.name === 'Selection tool') return locator('selector');
      if (id === 'panel' && role === 'group' && options.name === 'Options') return locator('options');
      if (id === 'options' && role === 'button' && options.name === 'Live selection') return locator('live');
      if (id === 'portal' && role === 'menuitemradio' && options.name === 'Single splat') return locator('portal-single');
      if (id === 'panel' && role === 'button' && labels.includes(options.name)) return locator('combine-' + labels.indexOf(options.name));
      return assert.fail('Control is not in this accessible scope: ' + id + '/' + role + '/' + options.name);
    },
  });
  return { state, page: locator('page') as unknown as Parameters<typeof configureContributorSingleUi>[0] };
}

describe('ordinary public Single controls', () => {
  it('opens initially closed Basic Tools before arming Single, then preserves the open panel on later cases', async () => {
    const ui = selectionUi('basic');
    assert.deepEqual(await configureContributorSingleUi(ui.page, 2), { tool: 'single', liveSelection: false, combine: 2 });
    assert.deepEqual(ui.state.actions, ['tools-toggle', 'selector', 'portal-single', 'live', 'combine-2']);
    assert(ui.state.open && ui.state.single); assert.equal(ui.state.menu, false); assert.equal(ui.state.live, false); assert.equal(ui.state.combine, 2);
    await configureContributorSingleUi(ui.page, 1);
    assert.equal(ui.state.actions.filter(action => action === 'tools-toggle').length, 1);
    assert.equal(ui.state.actions.filter(action => action === 'selector').length, 2);
    assert.equal(ui.state.actions.filter(action => action === 'portal-single').length, 2); assert.equal(ui.state.menu, false);
    assert.equal(ui.state.actions.filter(action => action === 'live').length, 1); assert.equal(ui.state.combine, 1);
  });
  it('chooses Pro Single through its real body-portal radio and validates the closed selector and Options state', async () => {
    const ui = selectionUi('pro');
    assert.deepEqual(await configureContributorSingleUi(ui.page, 3), { tool: 'single', liveSelection: false, combine: 3 });
    assert.deepEqual(ui.state.actions, ['tools-toggle', 'selector', 'portal-single', 'live', 'combine-3']);
    assert(ui.state.open && ui.state.single); assert.equal(ui.state.menu, false); assert.equal(ui.state.live, false);
  });
});

describe('bounded ordinary-UI contributor packet', () => {
  it('retains the existing production CLI defaults and one explicit selection manifest', () => {
    const value = parseContributorOptions(args); assert.equal(value.attempts, 3); assert.equal(value.baseUrl, 'http://127.0.0.1:4173/project/');
    assert.equal(value.selectionManifest, 'tests/fixtures/bench/selection-v1.json');
    assert.equal(parseContributorOptions([...args, '--selection-manifest', 'tests/fixtures/bench/selection-v1.json', '--attempts', '1']).attempts, 1);
    for (const tail of [['--selection-manifest'], ['--selection-manifest', '../outside'], ['--selection-manifest', 'a', '--selection-manifest', 'b'], ['--attempts', '31'], ['--unknown', 'x']])
      assert.throws(() => parseContributorOptions([...args, ...tail]));
  });
  it('predeclares all three isolated anchor points, eight changed Combine recipes and the deleted-right no-hit', () => {
    const cases = contributorCases(); assert.equal(cases.length, 12); assert.equal(new Set(cases.map(row => row.id)).size, 12);
    assert.deepEqual(cases.slice(0, 3).map(row => row.parameters.ui.pointer.requestedPoint), [[318.5, 400.5], [961.5, 400.5], [640.5, 721.5]]);
    assert.deepEqual(cases.slice(3, 7).map(row => row.parameters.operation), [0, 1, 2, 3]);
    assert.deepEqual(cases.slice(7, 11).map(row => row.parameters.originalBaseline.deletedSourceIds), [[1], [1], [1], [1]]);
    assert.equal(cases[11]!.parameters.expectedSourceId, null); assert.equal(cases[11]!.parameters.ui.tool, 'single');
    for (const row of cases) { assert.equal(row.parameters.ui.liveSelection, false); assert.match(row.parametersSha256, /^[a-f0-9]{64}$/); }
  });
  it('refuses changed fixture identity, mismatched manifest bytes and reordered anchor proposals', () => {
    const identities = { fixtureId: 'dyadic-grid-256k-sh0-v1', count: 256000,
      inputSha256: 'ff27349c204f5ddb7d5cec55775193f601fe28bdd88727362edc44a3f3145244',
      expectedSceneSha256: '22397e5ed6975483e5cc7a125df52fedf6b647862757b3744e7173b3db27543d',
      sourceOrderSha256: '3859865469dd7c3f3f10c2d30346aa45554f17a1d3f8c42f352bf73027aa5789',
      distributionSha256: 'f6e02536d97111e5c8c21db437f72989e98037f592e2c17e877b95db0aa478ce' };
    const fixtureRef = { path: 'tests/fixtures/bench/manifest-v1.json', bytes: 12297, sha256: 'd'.repeat(64) };
    const fixture = { id: identities.fixtureId, status: 'pinned', identity: { ...identities } };
    const selection = { schemaVersion: 1, kind: 'splatview-fixed-selection-oracle-manifest', id: 'dyadic-grid-selection-v1',
      status: 'native-correctness-qualified-browser-gpu-cache-performance-pending', fixture: { manifest: fixtureRef, identity: { ...identities } },
      gpuPickCandidates: contributorCases().slice(0, 3).map((row, id) => ({ expectedSourceId: id, parametersSha256: row.parameters.ui.anchorProposalParametersSha256 })) };
    validateContributorManifest(selection, fixture, fixtureRef);
    const wrong = structuredClone(selection); wrong.fixture.identity.inputSha256 = 'e'.repeat(64);
    assert.throws(() => validateContributorManifest(wrong, fixture, fixtureRef));
    assert.throws(() => validateContributorManifest(selection, fixture, { ...fixtureRef, bytes: fixtureRef.bytes + 1 }));
    const reordered = structuredClone(selection); reordered.gpuPickCandidates.reverse(); assert.throws(() => validateContributorManifest(reordered, fixture, fixtureRef));
  });
});

describe('actual pixel, query and owner boundaries', () => {
  it('maps an actual scaled DOMRect to the pinned framebuffer center and rejects covering chrome', () => {
    assertContributorPoint(point(), [318.5, 400.5]);
    for (const change of [(p: ContributorPoint) => { p.elementFromPointCanvas = false; }, (p: ContributorPoint) => { p.clientPoint[0] = 318.5; },
      (p: ContributorPoint) => { p.framebuffer.width = 640; }, (p: ContributorPoint) => { p.rect.width = 0; }]) {
      const value = point(); change(value); assert.throws(() => assertContributorPoint(value, [318.5, 400.5]));
    }
  });
  it('accepts a real monotonic display submission while refusing owner or complete revision replacement', () => {
    assertContributorOwner(owner()); assertSameContributorOwner(owner(), { ...owner(), rendererSubmissionSequence: 9 });
    for (const change of [(v: ContributorOwner) => { v.clientOwnerId = 9; }, (v: ContributorOwner) => { v.documentRevision!.draftRevision++; },
      (v: ContributorOwner) => { v.scene!.selectedRevision++; }, (v: ContributorOwner) => { v.camera!.revision++; },
      (v: ContributorOwner) => { v.rendererSubmissionSequence = 1; }, (v: ContributorOwner) => { v.deviceEpoch = 2; }]) {
      const value = owner(); change(value); assert.throws(() => assertSameContributorOwner(owner(), value));
    }
  });
  it('requires a complete query ring and the exact next same-UI query rather than a nearby earlier winner', () => {
    const ring = { queries: [query()], lastQuerySequence: 1, droppedQueries: 0, maxQueries: 128 }; validateContributorRing(ring);
    for (const value of [{ ...ring, droppedQueries: 1 }, { ...ring, lastQuerySequence: 2 }, { ...ring, queries: [{ ...query(), sequence: 2 }] }, { ...ring, maxQueries: 256 }])
      assert.throws(() => validateContributorRing(value));
    assertContributorQuery(query(), 0, mask(), contributorCases()[0]!, point());
    assert.throws(() => assertContributorQuery(query(), 1, mask(), contributorCases()[0]!, point()));
  });
  it('rejects incorrect sampling, foreign lineage, stale/errors, wrong source and changed render inputs', () => {
    for (const change of [(v: ContributorQuery) => { v.request.sample.x = 319.5; }, (v: ContributorQuery) => { v.before.documentRevision!.selectionRevision++; },
      (v: ContributorQuery) => { v.path = 'ordinary-color'; }, (v: ContributorQuery) => { v.status = 'stale'; },
      (v: ContributorQuery) => { v.error = 'actual readback failure'; }, (v: ContributorQuery) => { v.result!.index = 1; },
      (v: ContributorQuery) => { v.renderState.grade[0] = 2; }, (v: ContributorQuery) => { v.settledAtMs = 19; }]) {
      const value = query(); change(value); assert.throws(() => assertContributorQuery(value, 0, mask(), contributorCases()[0]!, point()));
    }
  });
});

describe('native mask artifact preservation', () => {
  it('persists actual bytes before full mask comparison and excludes duplicate base64 from retained JSON', async () => {
    const target = checkpoint(), value = mask(), calls: string[] = [];
    await preserveContributorCheckpoint(target, value, new Uint8Array(256000), loaded(), async bytes => {
      calls.push('persist'); assert.equal(target.oracleStatus, 'pending'); assert.equal(target.independentIdentity, null);
      assert.equal(bytes.length, 256000); assert.equal(bytes[0], 0); assert.equal(bytes[255999], 0); return artifact;
    });
    assert.deepEqual(calls, ['persist']); assert.equal(target.oracleStatus, 'passed'); assert.equal(target.independentIdentity!.selectedCount, 0);
    const observation = target.maskObservation!.observation as Record<string, unknown>;
    assert.equal(observation.bytesBase64, null); assert.deepEqual(observation.rawBytesArtifact, artifact); assert.equal(typeof value.observation.bytesBase64, 'string');
  });
  it('retains a mismatched full-mask artifact before refusing its independently unexpected byte', async () => {
    const actual = new Uint8Array(256000); actual[12345] = 1;
    const target = checkpoint(); let persisted = false;
    await assert.rejects(preserveContributorCheckpoint(target, mask(actual), new Uint8Array(256000), loaded(), async bytes => {
      persisted = true; assert.equal(bytes[12345], 1); return artifact;
    }), /12345/);
    assert(persisted); assert.equal(target.oracleStatus, 'failed'); assert.deepEqual(target.artifact, artifact); assert.match(target.oracleError!, /12345/);
  });
  it('preserves actual bytes even when runtime identity or owner/read settlement is invalid', async () => {
    for (const change of [(v: ContributorMaskSnapshot) => { v.runtime.appInputId = 'f'.repeat(64); },
      (v: ContributorMaskSnapshot) => { v.observation.after.sceneOwnerId = 99; },
      (v: ContributorMaskSnapshot) => { v.observation.status = 'stale'; },
      (v: ContributorMaskSnapshot) => { v.observation.settledAtMs = 10; }]) {
      const value = mask(), target = checkpoint(); change(value); let persisted = false;
      await assert.rejects(preserveContributorCheckpoint(target, value, new Uint8Array(256000), loaded(), async () => { persisted = true; return artifact; }));
      assert(persisted); assert.equal(target.oracleStatus, 'failed'); assert.deepEqual(target.artifact, artifact);
    }
  });
  it('retains persistence failure and malformed/missing encoding as explicit failed checkpoints', async () => {
    const target = checkpoint(); await assert.rejects(preserveContributorCheckpoint(target, mask(), new Uint8Array(256000), loaded(), async () => { throw new Error('exclusive persistence refused'); }), /exclusive persistence refused/);
    assert.equal(target.oracleStatus, 'failed'); assert.equal(target.artifact, null); assert(target.maskObservation);
    for (const encoding of [null, '!!!', 'AQ=']) {
      const value = mask(), failed = checkpoint(); value.observation.bytesBase64 = encoding;
      await assert.rejects(preserveContributorCheckpoint(failed, value, new Uint8Array(256000), loaded(), async () => { throw new Error('must not persist malformed encoding'); }));
      assert.equal(failed.oracleStatus, 'failed'); assert.equal(failed.artifact, null);
    }
  });
});
