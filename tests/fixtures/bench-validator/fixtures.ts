import type { Attempt, BenchmarkReport, BenchmarkTarget, CellIdentity, CellReport, ExpectedPacket, FixtureIdentity, MemoryCategory, MemoryObservation, MemorySnapshot, MetricSummary, Scenario, ScenarioKind } from '../../../tools/bench/schema.ts';
import { REQUIRED_METRICS, scenarioDefinitions } from '../../../tools/bench/validate.ts';

/** Clearly synthetic hashes; these are not fixture/build/source observations. */
export const H = (digit: string): string => digit.repeat(64);
export const BUILD = { appSha256: H('1'), coreSha256: H('2'), cameraSha256: H('3'), deploymentSha256: H('4'), protocol: 10, uiWorker: 5 };
export function targetFixture(): BenchmarkTarget {
  return {
    schemaVersion: 1, id: 'synthetic-pending-v1', scope: 'tooling-only', status: 'pending', thresholds: null, memoryCeilings: null,
    machines: [{ id: 'synthetic-minimum', tier: 'minimum' }], browsers: [{ id: 'synthetic-chrome', family: 'Chrome' }],
    fixtures: [{ id: 'synthetic-fixture', inputSha256: H('a'), manifestSha256: H('b'), sourceOrderSha256: H('c'), distributionSha256: H('d'), expectedSceneSha256: H('e'), sourceCount: 256000, loadedCount: 256000, shDegree: 0, overdraw: 'low' }],
    traces: [{ id: 'synthetic-orbit', sha256: H('5'), projectionSha256: H('6'), warmupMs: 5000, durationMs: 30000, idleHiddenMs: 1000 }],
    framebuffers: [{ id: 'standard', kind: 'standard', cssWidth: 1280, cssHeight: 800, width: 1280, height: 800, dpr: 1 }],
    cells: [{ id: 'synthetic-cell', machineId: 'synthetic-minimum', browserId: 'synthetic-chrome', fixtureId: 'synthetic-fixture', traceId: 'synthetic-orbit', framebufferId: 'standard' }],
    selectionCases: ['pick', 'query', 'amendment'].map((kind) => ({ id: kind, fixtureId: 'synthetic-fixture', kind: kind as 'pick' | 'query' | 'amendment', parametersSha256: H('7'), expectedMaskSha256: H('8'), expectedSelectedCount: 3 })),
    exportCases: (['all', 'selected', 'remainder'] as const).map((scope) => ({ id: `ply-${scope}`, fixtureId: 'synthetic-fixture', format: 'ply', scope, parametersSha256: H('9'), capturedRevision: 4, expectedOutputSha256: H('f'), expectedRecordCount: scope === 'all' ? 255998 : scope === 'selected' ? 2 : 255996,
      membership: { loadedCount: 256000, selectedCount: 3, deletedCount: 2, selectedDeletedCount: 1, expectedMembershipSha256: H(scope === 'all' ? 'a' : scope === 'selected' ? 'b' : 'c') },
      precision: { mode: 'exact', absoluteTolerance: 0, oracleSha256: H('0'), components: [] },
    })),
  };
}
export function memory(point: MemorySnapshot['point']): MemorySnapshot {
  const closed = point === 'post-close' || point === 'final-cycle';
  const values: Record<MemoryCategory, number | null> = { ledgerLive: closed ? 0 : 100000, ledgerPeak: 200000, nativeLivePayload: closed ? 0 : 64, wasmLinearCapacity: closed ? 0 : 65536, wasmLinearHighWater: 131072, jsHeapEstimate: null, browserProcess: null, workerProcess: null, gpuDriver: null };
  const observation = (category: MemoryCategory): MemoryObservation => ({
    bytes: values[category], unavailableReason: values[category] === null ? 'Synthetic fixture intentionally has no OS/driver measurement' : null,
    method: category.startsWith('ledger') ? 'logical-ledger' : category === 'nativeLivePayload' ? 'native-summary' : category.startsWith('wasm') ? 'wasm-memory-buffer' : category === 'jsHeapEstimate' ? 'js-heap-estimate' : category === 'gpuDriver' ? 'driver-observation' : 'os-process-sample',
    processIds: [], samplingIntervalMs: null, attachmentSha256: null,
  });
  return {
    point, pendingRetirement: { gpuOwners: 0, blobOwners: 0, readOwners: 0 },
    observations: { ledgerLive: observation('ledgerLive'), ledgerPeak: observation('ledgerPeak'), nativeLivePayload: observation('nativeLivePayload'), wasmLinearCapacity: observation('wasmLinearCapacity'), wasmLinearHighWater: observation('wasmLinearHighWater'), jsHeapEstimate: observation('jsHeapEstimate'), browserProcess: observation('browserProcess'), workerProcess: observation('workerProcess'), gpuDriver: observation('gpuDriver') },
  };
}
/** Fixture construction does not call production percentiles; literal test anchors check the R7 convention. */
export function fixtureSummary(attempts: Attempt[], metric: string): MetricSummary {
  const passed = attempts.filter((attempt) => attempt.status === 'completed');
  const values = passed.flatMap((attempt) => attempt.measurements[metric]?.samples ?? []).sort((a, b) => a - b);
  const quantile = (p: number): number | null => {
    if (!values.length) return null;
    // Use the contract's zero-based evaluation order, avoiding different IEEE rounding from a weighted sum.
    const rank = (values.length - 1) * p;
    const index = Math.trunc(rank);
    const value = values[index]!;
    return value + (values[Math.min(index + 1, values.length - 1)]! - value) * (rank - index);
  };
  return { sampleCount: values.length, unavailableAttempts: passed.filter((attempt) => attempt.measurements[metric]?.samples === null).length, percentileMethod: 'linear-r7', p50: quantile(0.5), p95: quantile(0.95) };
}
export function refresh(scenario: Scenario): void {
  scenario.counts = { total: scenario.attempts.length, completed: 0, failed: 0, refused: 0, cancelled: 0 };
  for (const attempt of scenario.attempts) scenario.counts[attempt.status]++;
  scenario.summaries = Object.fromEntries(REQUIRED_METRICS[scenario.kind].map((metric) => [metric, fixtureSummary(scenario.attempts, metric)]));
}
export function reportFixture(target = targetFixture()): BenchmarkReport {
  return {
    schemaVersion: 1, runId: 'synthetic-run', startedAtUtc: '2026-10-11T12:00:00.000Z', endedAtUtc: '2026-10-11T14:00:00.000Z',
    evidenceClass: 'synthetic-tooling', purpose: 'w09-initial-baseline', target: { id: target.id, sha256: H('0') }, build: structuredClone(BUILD),
    cells: target.cells.map((cell) => cellFixture(target, cell)),
  };
}
function cellFixture(target: BenchmarkTarget, identity: CellIdentity): CellReport {
  const fixture = target.fixtures.find((entry) => entry.id === identity.fixtureId)!;
  const trace = target.traces.find((entry) => entry.id === identity.traceId)!;
  const framebuffer = target.framebuffers.find((entry) => entry.id === identity.framebufferId)!;
  return {
    identity: structuredClone(identity), fixture: structuredClone(fixture), trace: structuredClone(trace),
    environment: { machineId: identity.machineId, browserId: identity.browserId, osFamily: 'Windows', osVersion: 'synthetic-os', machineModel: 'synthetic-not-hardware', ramBytes: 16 * 1024 ** 3, browserFamily: target.browsers.find((entry) => entry.id === identity.browserId)!.family, browserVersion: 'synthetic-browser', adapterName: 'synthetic-adapter', adapterFeatures: [], enabledFeatures: [], deviceLimits: { maxBufferSize: 1024 ** 3 }, powerMode: 'synthetic-unspecified', cachePolicy: 'synthetic-app-cold-scene-cold/scene-warm', resolutionPolicy: 'fixed', crossOriginIsolated: false, sharedArrayBufferAvailable: false, framebuffer: structuredClone(framebuffer) },
    overdrawCheckpoints: [{ traceTimeMs: 0, visibleProjectedSplats: fixture.loadedCount, footprintAreaRatio: 1, coveredPixelFraction: 0.5, overlapP50: 1, overlapP95: 2 }],
    scenarios: scenarioDefinitions(target, fixture.id).map((definition) => {
      const count: Record<ScenarioKind, number> = { 'open-cold': 3, 'open-warm': 5, orbit: 3, 'selection-cold': 30, 'selection-warm': 30, export: 3, retention: 20 };
      const scenario: Scenario = { ...definition, attempts: [], counts: { total: 0, completed: 0, failed: 0, refused: 0, cancelled: 0 }, summaries: {} };
      scenario.attempts = Array.from({ length: count[definition.kind] }, (_, index) => attemptFixture(target, fixture, scenario, index));
      refresh(scenario);
      return scenario;
    }),
  };
}
function attemptFixture(target: BenchmarkTarget, fixture: FixtureIdentity, scenario: Scenario, index: number): Attempt {
  const selection = scenario.kind.startsWith('selection-') ? target.selectionCases.find((entry) => entry.id === scenario.caseId) : undefined;
  const exporting = scenario.kind === 'export' ? target.exportCases.find((entry) => entry.id === scenario.caseId) : undefined;
  const clockId = 'main-clock';
  const startedAtMs = index * 40000;
  const elapsed = scenario.kind === 'orbit' ? 30000 : 10 + index;
  const attempt: Attempt = {
    id: `${scenario.id}/${index + 1}`, status: 'completed', reason: null, retryOf: null, clock: { id: clockId, method: 'performance.now', unit: 'ms' },
    startedAtMs, operationSettledAtMs: startedAtMs + elapsed, resourcesRetiredAtMs: startedAtMs + elapsed + 2, retirementUnavailableReason: null, retirementMeaning: 'application-owner-joined',
    warmupMs: scenario.kind === 'orbit' ? 5000 : 0, idleHiddenMs: scenario.kind === 'orbit' ? 1000 : 0,
    measurements: {}, correctness: {
      oracle: selection ? 'source-mask' : exporting ? 'export' : scenario.kind === 'retention' ? 'cycle' : 'scene',
      expectedSha256: selection ? selection.expectedMaskSha256 : exporting ? exporting.expectedOutputSha256 : fixture.expectedSceneSha256,
      actualSha256: selection ? selection.expectedMaskSha256 : exporting ? exporting.expectedOutputSha256 ?? H('a') : fixture.expectedSceneSha256,
      expectedCount: selection?.expectedSelectedCount ?? exporting?.expectedRecordCount ?? fixture.loadedCount, actualCount: selection?.expectedSelectedCount ?? exporting?.expectedRecordCount ?? fixture.loadedCount, capturedRevision: exporting?.capturedRevision ?? null,
      membershipSha256: exporting?.membership.expectedMembershipSha256 ?? null,
      numericOracle: exporting?.precision.mode === 'bounded' ? { oracleSha256: exporting.precision.oracleSha256, values: exporting.precision.components.map((component) => ({ id: component.id, actual: component.expected })) } : null,
      absoluteError: 0,
    },
    memory: scenario.kind === 'retention' ? [memory('post-close'), ...(index === 0 ? [memory('capture-peak')] : []), ...(index === 19 ? [memory('final-cycle')] : [])] : scenario.kind === 'open-cold' && index === 0 ? [memory('baseline'), memory('load-peak')] : scenario.id.startsWith('selection-cold/') && selection?.kind === 'pick' && index === 0 ? [memory('edit-peak')] : scenario.kind === 'export' && index === 0 ? [memory('export-peak')] : [],
  };
  const counters = ['longTasks', 'droppedFrames', 'idleWorkCount', 'pendingGpuOwners', 'pendingBlobOwners', 'pendingReadOwners'];
  for (const metric of REQUIRED_METRICS[scenario.kind]) {
    const isCounter = metric.endsWith('Bytes') || counters.includes(metric);
    const values = metric === 'operationSettledMs' ? [elapsed] : metric === 'resourceRetiredMs' ? [elapsed + 2] : metric === 'frameMs' ? Array<number>(30).fill(1000) : metric === 'sortMs' || metric === 'rasterMs' ? Array<number>(30).fill(1) : metric === 'postCloseLedgerBytes' || counters.includes(metric) ? [0] : [1];
    attempt.measurements[metric] = { unit: metric.endsWith('Bytes') ? 'bytes' : isCounter ? 'count' : 'ms', method: isCounter ? 'application-counter' : metric === 'frameMs' ? 'raf-interval' : 'monotonic-cpu', clockId: isCounter ? null : clockId, samples: values, sampleCount: values.length, unavailableReason: null };
  }
  return attempt;
}
export const expectedFixture = (): ExpectedPacket => ({ targetSha256: H('0'), build: structuredClone(BUILD) });

/** Full planned matrix for validator tests only. Hashes/model names remain conspicuously synthetic. */
export function fullTargetFixture(): BenchmarkTarget {
  const target = targetFixture();
  const base = target.fixtures[0]!;
  target.id = 'synthetic-full-matrix'; target.scope = 'w09-initial';
  target.machines.push({ id: 'synthetic-newer', tier: 'newer' });
  target.browsers.push({ id: 'synthetic-safari', family: 'Safari' });
  target.framebuffers.push({ id: 'retina', kind: 'retina', cssWidth: 1280, cssHeight: 800, width: 2560, height: 1600, dpr: 2 });
  target.fixtures = [256000, 1000000].flatMap((count) => ([0, 3] as const).flatMap((sh) => (['low', 'high'] as const).map((overdraw) => ({ ...base, id: `synthetic-${count}-${sh}-${overdraw}`, sourceCount: count, loadedCount: count, shDegree: sh, overdraw }))));
  const selections = target.selectionCases, exports = target.exportCases;
  target.selectionCases = target.fixtures.flatMap((fixture) => selections.map((entry) => ({ ...entry, id: `${fixture.id}-${entry.kind}`, fixtureId: fixture.id })));
  target.exportCases = target.fixtures.flatMap((fixture) => exports.map((entry) => ({ ...entry, id: `${fixture.id}-ply-${entry.scope}`, fixtureId: fixture.id, membership: { ...entry.membership, loadedCount: fixture.loadedCount }, expectedRecordCount: entry.scope === 'all' ? fixture.loadedCount - 2 : entry.scope === 'selected' ? 2 : fixture.loadedCount - 4 })));
  target.cells = target.machines.flatMap((machine) => target.browsers.flatMap((browser) => target.fixtures.flatMap((fixture) => target.framebuffers.map((framebuffer) => ({ id: `${machine.id}/${browser.id}/${fixture.id}/${framebuffer.id}`, machineId: machine.id, browserId: browser.id, fixtureId: fixture.id, traceId: target.traces[0]!.id, framebufferId: framebuffer.id })))));
  return target;
}
