import { createHash } from 'node:crypto';
import { benchmarkExpectedIdentities } from './oracles.ts';
import { anchorPickProposal, selectionBaselineMask, selectionCombinedState, selectionMaskIdentity,
  selectionParameterBytes, type SelectionCombine } from './selection-oracles.ts';

// Independent predeclared expectations for the ordinary Single UI path. No
// application selector, renderer, native code, fixture generator or camera math
// is imported. Actual UI query/readback and native mask observations bind later.
const COUNT = 256_000;
export const CONTRIBUTOR_ORACLE_ID = 'dyadic-grid-single-contributor-v1';
const fail = (message: string): never => { throw new Error(`Contributor oracle: ${message}`); };
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
function frozen<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}
function operation(value: number): asserts value is SelectionCombine {
  if (!Number.isInteger(value) || Object.is(value, -0) || value < 0 || value > 3) fail('Combine must be Replace0, Add1, Subtract2 or Intersect3');
}
function deleted(value: readonly number[]): void {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      Reflect.ownKeys(value).length !== value.length + 1 || value.length > 1) fail('deleted IDs must be [] or [1]');
  if (value.length) {
    const entry = Object.getOwnPropertyDescriptor(value, '0');
    if (!entry?.enumerable || !('value' in entry) || entry.value !== 1) fail('only source ID 1 may be deleted');
  }
}
function mask(value: Uint8Array): void {
  if (!(value instanceof Uint8Array) || value.byteLength !== COUNT) fail('a complete source-ordered 256000-byte uint8 mask is required');
}
function anchor(value: number): asserts value is 0 | 1 | 2 {
  if ((value !== 0 && value !== 1 && value !== 2) || Object.is(value, -0)) fail('the isolated source ID must be 0, 1 or 2');
}

export function expectedContributorAnchorMask(sourceId: 0 | 1 | 2): Uint8Array {
  anchor(sourceId); const result = selectionBaselineMask('none'); result[sourceId] = 1; return result;
}

/** All four recipes change at least one byte, so one Undo has an unambiguous owner. */
export function contributorBaselineMask(combine: SelectionCombine, deletedIds: readonly number[] = []): Uint8Array {
  operation(combine); deleted(deletedIds);
  const result = selectionBaselineMask(combine === 1 ? 'none' : 'all');
  if (deletedIds.length) result[1] = 2;
  return result;
}

/** Validate every baseline byte before applying the independent Combine truth table. */
export function expectedContributorSingleMask(baseline: Uint8Array, combine: SelectionCombine,
  deletedIds: readonly number[] = [], sourceId: number = 0): Uint8Array {
  operation(combine); deleted(deletedIds); mask(baseline);
  if (sourceId !== 0 || Object.is(sourceId, -0)) fail('the four Combine cases target source ID 0 only');
  const baselineState = combine === 1 ? 0 : 1, hasDeleted = deletedIds.length === 1;
  const result = new Uint8Array(COUNT);
  for (let id = 0; id < COUNT; id++) {
    const before = hasDeleted && id === 1 ? 2 : baselineState;
    if (baseline[id] !== before) fail(`source ${id} differs from the predeclared baseline`);
    result[id] = selectionCombinedState(before, id === sourceId, combine);
  }
  return result;
}

/** Actual UI setup: Single/Replace source 1, Delete selected, then Clear/Select all. */
export function contributorDeletedAnchorMask(): Uint8Array {
  const result = selectionBaselineMask('none'); result[1] = 2; return result;
}

function uiParameters(id: 0 | 1 | 2) {
  const candidate = anchorPickProposal(id), pixel = candidate.parameters.pixel;
  return {
    path: 'ordinary-Single-UI-query', tool: 'single', liveSelection: false,
    pointer: { button: 0, stationary: true, modifiers: { shift: false, control: false, meta: false, alt: false },
      coordinateSpace: 'framebuffer', requestedPoint: [pixel[0] + 0.5, pixel[1] + 0.5] },
    query: { coordinateSpace: 'framebuffer', pixel: [...pixel], sample: [...candidate.parameters.pixelSample], centerRadius: 0,
      observation: 'decoded-result-of-the-same-renderer.pick-invocation-issued-by-the-ordinary-UI-path' },
    camera: [...candidate.parameters.camera], framebuffer: { ...candidate.parameters.framebuffer },
    options: { geometryTransform: 'identity', opacityScale: 1, grade: 'neutral', autoOrbit: false },
    anchorProposalParametersSha256: candidate.parametersSha256,
  };
}

/** Same predeclared radius-zero pixel as the pinned proposal, with actual UI flags explicit. */
export function contributorAnchorCase(sourceId: 0 | 1 | 2) {
  anchor(sourceId);
  const before = selectionMaskIdentity(selectionBaselineMask('none')), after = selectionMaskIdentity(expectedContributorAnchorMask(sourceId));
  const fixture = benchmarkExpectedIdentities();
  const parameters = { schemaVersion: 1, oracleId: CONTRIBUTOR_ORACLE_ID, fixtureId: fixture.fixtureId,
    fixtureInputSha256: fixture.inputSha256, fixtureCanonicalSceneSha256: fixture.expectedSceneSha256,
    expectedSourceId: sourceId, operation: 0, ui: uiParameters(sourceId),
    originalBaseline: { recipe: 'none-visible-selected', deletedSourceIds: [] as number[], stateMaskSha256: before.stateMaskSha256 },
    history: ['before', 'after', 'undo', 'redo', 'undoAgain'] };
  return frozen({ schemaVersion: 1, kind: 'splatview-single-contributor-candidate', id: `single-isolated-source-${sourceId}`,
    status: 'predeclared-pending-actual-ui-query-and-mask-comparison', parameters, parametersSha256: sha(selectionParameterBytes(parameters)),
    expected: { before, after, undo: { ...before }, redo: { ...after }, undoAgain: { ...before } },
    qualification: { actualGpuContributor: false, actualOrdinaryUi: false, exactReadbackBytes: false, numericAcceptanceBound: null,
      overlappingContributors: false, compositedMap: false, coldWarmCache: false, performanceAccepted: false },
    limitation: 'Separated isolated contributor only. The original anchor proposal remains unchanged; this identity additionally binds the actual UI path and pointer flags.' });
}

export function contributorSingleCase(combine: SelectionCombine, deletedIds: readonly number[] = []) {
  operation(combine); deleted(deletedIds);
  const beforeMask = contributorBaselineMask(combine, deletedIds), afterMask = expectedContributorSingleMask(beforeMask, combine, deletedIds);
  const before = selectionMaskIdentity(beforeMask), after = selectionMaskIdentity(afterMask), fixture = benchmarkExpectedIdentities();
  const parameters = { schemaVersion: 1, oracleId: CONTRIBUTOR_ORACLE_ID, fixtureId: fixture.fixtureId,
    fixtureInputSha256: fixture.inputSha256, fixtureCanonicalSceneSha256: fixture.expectedSceneSha256,
    expectedSourceId: 0, operation: combine, ui: uiParameters(0),
    originalBaseline: { recipe: combine === 1 ? 'none-visible-selected' : 'all-visible-selected', deletedSourceIds: [...deletedIds],
      stateMaskSha256: before.stateMaskSha256 },
    history: ['before', 'after', 'undo', 'redo', 'undoAgain'] };
  return frozen({ schemaVersion: 1, kind: 'splatview-single-contributor-candidate',
    id: `single-source-0-combine-${combine}-${deletedIds.length ? 'right-anchor-deleted' : 'alive'}`,
    status: 'predeclared-pending-actual-ui-query-and-mask-comparison', parameters,
    parametersSha256: sha(selectionParameterBytes(parameters)), expected: { before, after, undo: { ...before }, redo: { ...after }, undoAgain: { ...before } },
    qualification: { actualGpuContributor: false, actualOrdinaryUi: false, exactReadbackBytes: false, numericAcceptanceBound: null,
      overlappingContributors: false, compositedMap: false, coldWarmCache: false, performanceAccepted: false },
    limitation: 'Exact source ID and all source-state bytes only. Finite decoded GPU values are retained without claiming numerical agreement or raw 16-byte readback identity.' });
}

/** The deleted right anchor has no surviving contributor at its old isolated pixel. */
export function contributorDeletedAnchorCase() {
  const expected = selectionMaskIdentity(contributorDeletedAnchorMask()), fixture = benchmarkExpectedIdentities();
  const parameters = { schemaVersion: 1, oracleId: CONTRIBUTOR_ORACLE_ID, fixtureId: fixture.fixtureId,
    fixtureInputSha256: fixture.inputSha256, fixtureCanonicalSceneSha256: fixture.expectedSceneSha256,
    expectedSourceId: null, operation: 0, ui: uiParameters(1),
    originalBaseline: { recipe: 'none-visible-selected', deletedSourceIds: [1], stateMaskSha256: expected.stateMaskSha256 },
    history: 'No selection changes are expected; no Undo checkpoint is inferred for this no-op.' };
  return frozen({ schemaVersion: 1, kind: 'splatview-single-contributor-candidate', id: 'single-deleted-right-anchor-no-contributor',
    status: 'predeclared-pending-actual-ui-query-and-mask-comparison', parameters, parametersSha256: sha(selectionParameterBytes(parameters)),
    expected: { sourceId: null, before: expected, after: { ...expected } },
    qualification: { actualGpuContributor: false, actualOrdinaryUi: false, exactReadbackBytes: false, numericAcceptanceBound: null,
      overlappingContributors: false, compositedMap: false, coldWarmCache: false, performanceAccepted: false },
    limitation: 'The actual UI-path decoded winner must be null. A native mask-only no-op cannot establish that the deleted record was excluded by the GPU query.' });
}

export interface DecodedContributorPick {
  index: number | null; depth: number; opacity: number; contribution: number; deviceEpoch: number;
}
/** Structural/semantic check only: no invented shader floating-point tolerance. */
export function assertContributorPick(actual: unknown, expectedIndex: 0 | 1 | 2 | null, expectedDeviceEpoch: number): DecodedContributorPick {
  if (expectedIndex !== null && expectedIndex !== 0 && expectedIndex !== 1 && expectedIndex !== 2) fail('expected source ID must be 0, 1, 2 or null');
  if (Object.is(expectedIndex, -0)) fail('negative-zero expected source ID is invalid');
  if (!Number.isSafeInteger(expectedDeviceEpoch) || expectedDeviceEpoch < 1) fail('a positive actual device epoch is required');
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) fail('missing actual decoded GPU pick');
  const value = actual as Record<string, unknown>;
  if (value.index !== expectedIndex || Object.is(value.index, -0)) fail('actual decoded winner differs from the predeclared source ID');
  if (value.deviceEpoch !== expectedDeviceEpoch) fail('actual decoded pick belongs to another device epoch');
  for (const name of ['depth', 'opacity', 'contribution'] as const) {
    if (typeof value[name] !== 'number' || !Number.isFinite(value[name])) fail(`actual decoded ${name} is not finite`);
  }
  const result = { index: value.index as number | null, depth: value.depth as number, opacity: value.opacity as number,
    contribution: value.contribution as number, deviceEpoch: value.deviceEpoch as number };
  if (result.depth < 0 || result.opacity < 0 || result.opacity > 1 || result.contribution < 0 || result.contribution > result.opacity)
    fail('actual decoded pick violates depth/opacity/contribution invariants');
  if (expectedIndex !== null && (result.depth <= 0 || result.opacity <= 0 || result.contribution <= 0))
    fail('an actual winning contributor must have positive depth, opacity and contribution');
  return result;
}
