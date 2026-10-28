import assert from 'node:assert/strict';
import { test } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { validateBenchmark, percentile, summarize, requiredTargetMetrics, MEMORY_POINTS, REQUIRED_MEMORY_CEILINGS } from '../tools/bench/validate.ts';
import { checkShape, observedReportShape, observedTargetShape, reportShape, targetShape } from '../tools/bench/shapes.ts';
import { readJsonBounded, sha256, writeBenchmarkReportExclusive, writeJsonExclusive } from '../tools/bench/io.ts';
import type { Attempt, BenchmarkReport, BenchmarkTarget, ObservedBenchmarkReport, ObservedBenchmarkTarget, Scenario } from '../tools/bench/schema.ts';
import { BUILD, H, expectedFixture, fullTargetFixture, refresh, reportFixture, targetFixture } from './fixtures/bench-validator/fixtures.ts';

const packet = (): { report: BenchmarkReport; target: BenchmarkTarget } => { const target = targetFixture(); return { target, report: reportFixture(target) }; };
const validate = ({ report, target }: ReturnType<typeof packet>) => validateBenchmark(report, target, expectedFixture());
const scenario = (report: BenchmarkReport | ObservedBenchmarkReport, id = 'open-cold'): Scenario => report.cells[0]!.scenarios.find((entry) => entry.id === id)!;
const attempt = (report: BenchmarkReport | ObservedBenchmarkReport, id = 'open-cold'): Attempt => scenario(report, id).attempts[0]!;
const has = (result: ReturnType<typeof validateBenchmark>, code: string): boolean => result.issues.some((issue) => issue.code === code);
/** In-memory synthetic policy setup only, never a published hardware target/report. */
function approvePolicyFixture(target: BenchmarkTarget, report: BenchmarkReport): void {
  target.status = 'approved'; report.evidenceClass = 'actual-mac';
  for (const cell of report.cells) cell.environment.osFamily = 'macOS';
  target.thresholds = report.cells.flatMap((cell) => cell.scenarios.flatMap((s) => requiredTargetMetrics(s.kind).map((metric) => ({ cellId: cell.identity.id, scenarioId: s.id, metric, statistic: 'p95' as const, unit: metric.endsWith('Bytes') ? 'bytes' as const : 'ms' as const, maximum: 1000000 }))));
  target.memoryCeilings = report.cells.flatMap((cell) => MEMORY_POINTS.flatMap((point) => REQUIRED_MEMORY_CEILINGS.map((category) => ({ cellId: cell.identity.id, point, category, maximumBytes: 1000000 }))));
}

/** Synthetic unit policy only: these numbers/model names are never collected observations or release budgets. */
function observedPacket(): { target: ObservedBenchmarkTarget; report: ObservedBenchmarkReport } {
  const base = packet(); approvePolicyFixture(base.target, base.report);
  const report: ObservedBenchmarkReport = { ...base.report, schemaVersion: 2, purpose: 'observed-browser-initial-baseline', evidenceClass: 'local-chromium',
    cells: base.report.cells.map(cell => ({ ...cell, environment: { ...cell.environment, osFamily: 'Windows' as const, browserHost: 'automation' as const } })) };
  const target: ObservedBenchmarkTarget = { ...base.target, schemaVersion: 2, id: 'synthetic-observed-policy-v2', scope: 'observed-browser-initial',
    machines: base.target.machines.map(machine => ({ id: machine.id, tier: 'observed' as const })),
    observedHosts: report.cells.map(cell => {
      const host = structuredClone(cell.environment); delete (host as Partial<typeof host>).framebuffer; return host;
    }),
  };
  report.target.id = target.id;
  return { target, report };
}
const validateObserved = ({ report, target }: ReturnType<typeof observedPacket>) => validateBenchmark(report, target, expectedFixture());

test('complete synthetic packet is valid diagnostic data, never accepted; scope excludes sustained qualification', () => {
  const p = packet(), result = validate(p);
  assert.equal(result.valid, true, JSON.stringify(result.issues)); assert.equal(result.accepted, false);
  assert.equal(result.sustainedQualified, false); assert.equal(result.scope, 'w09-initial-only');
  assert.equal(result.completedAttempts, 220); assert(has(result, 'pending-target')); assert(has(result, 'evidence-class'));
});
test('R7 has literal independent percentile anchors and does not mutate input', () => {
  const values = [10, 1, 9, 2]; assert.equal(percentile(values, 0.5), 5.5); assert.equal(percentile(values, 0.95), 9.85);
  assert.equal(percentile([], 0.95), null); assert.equal(percentile([7], 0.95), 7); assert.deepEqual(values, [10, 1, 9, 2]);
  assert.throws(() => percentile([Infinity], 0.95)); assert.throws(() => percentile([1], NaN)); assert.throws(() => percentile([-1], 0.5));
});
test('frozen report/profile/expected input remain unchanged across repeated validation', () => {
  const p = packet(), expected = expectedFixture();
  const freeze = (value: unknown): void => { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } };
  freeze(p); freeze(expected); const before = JSON.stringify(p);
  assert.equal(validateBenchmark(p.report, p.target, expected).valid, true); assert.equal(validateBenchmark(p.report, p.target, expected).valid, true); assert.equal(JSON.stringify(p), before);
});
for (const field of ['appSha256', 'coreSha256', 'cameraSha256', 'deploymentSha256', 'protocol', 'uiWorker'] as const) test(`externally pinned build rejects changed ${field}`, () => {
  const p = packet(); if (typeof p.report.build[field] === 'number') (p.report.build as unknown as Record<string, unknown>)[field] = 11; else (p.report.build as unknown as Record<string, unknown>)[field] = H('a');
  assert(has(validate(p), 'identity'));
});
for (const field of ['inputSha256', 'manifestSha256', 'sourceOrderSha256', 'distributionSha256', 'expectedSceneSha256'] as const) test(`fixture ${field} is exact, not a display-name match`, () => {
  const p = packet(); p.report.cells[0]!.fixture[field] = H('0'); assert(has(validate(p), 'identity'));
});
test('profile hash and profile id must both match the separately pinned target', () => {
  const p = packet(); p.report.target.sha256 = H('f'); assert(has(validate(p), 'identity'));
  p.report.target.sha256 = H('0'); p.report.target.id = 'another-profile'; assert(has(validate(p), 'identity'));
});
test('exact trace/projection/framebuffer/loaded count and operation parameter identities are bound', () => {
  for (const mutate of [
    (r: BenchmarkReport) => { r.cells[0]!.trace.sha256 = H('0'); },
    (r: BenchmarkReport) => { r.cells[0]!.trace.projectionSha256 = H('0'); },
    (r: BenchmarkReport) => { r.cells[0]!.environment.framebuffer.width = 640; },
    (r: BenchmarkReport) => { r.cells[0]!.fixture.loadedCount--; },
    (r: BenchmarkReport) => { scenario(r, 'selection-cold/pick').parametersSha256 = H('0'); },
  ]) { const p = packet(); mutate(p.report); assert(has(validate(p), 'identity')); }
});
test('missing/duplicate/unexpected cells cannot pass an inventory check', () => {
  const p = packet(); p.target.cells.push({ ...p.target.cells[0]!, id: 'missing-cell' }); assert(has(validate(p), 'identity'));
  const q = packet(); q.report.cells.push(structuredClone(q.report.cells[0]!)); assert(has(validate(q), 'duplicate'));
  const s = packet(); s.report.cells[0]!.identity.id = 'unknown-cell'; assert(has(validate(s), 'identity'));
});
test('required scenarios and every phase metric must remain present', () => {
  const p = packet(); p.report.cells[0]!.scenarios = p.report.cells[0]!.scenarios.filter((entry) => entry.id !== 'open-warm'); assert(has(validate(p), 'identity'));
  const q = packet(); delete attempt(q.report).measurements.resourceHashMs; assert(has(validate(q), 'identity'));
});
test('duplicate attempts do not satisfy repeat minima', () => { const p = packet(); scenario(p.report).attempts[1]!.id = attempt(p.report).id; assert(has(validate(p), 'duplicate')); });
test('repeat counts are recomputed from raw attempts; summary counts cannot conceal refusal', () => {
  const p = packet(), a = attempt(p.report); a.status = 'refused'; a.reason = 'synthetic admission refusal'; a.correctness = null;
  const result = validate(p); assert(has(result, 'identity')); assert(has(result, 'unsuccessful-attempts')); assert(has(result, 'insufficient-completions'));
});
test('honest unsuccessful attempts are valid diagnostic data and retries never erase them', () => {
  const p = packet(), s = scenario(p.report), failure = structuredClone(s.attempts[0]!); failure.id = 'failed-original'; failure.status = 'failed'; failure.reason = 'synthetic decoder failure'; failure.correctness = null;
  s.attempts.unshift(failure); s.attempts[1]!.retryOf = failure.id; refresh(s);
  const result = validate(p); assert.equal(result.valid, true, JSON.stringify(result.issues)); assert.equal(result.accepted, false); assert(has(result, 'unsuccessful-attempts')); assert.equal(s.counts.failed, 1);
});
test('30 fast refusals do not fulfill 30 completed selection requests', () => {
  const p = packet(), s = scenario(p.report, 'selection-cold/pick'); for (const a of s.attempts) { a.status = 'refused'; a.reason = 'synthetic refusal'; a.correctness = null; } refresh(s);
  const result = validate(p); assert.equal(result.valid, true, JSON.stringify(result.issues)); assert(has(result, 'insufficient-completions')); assert(has(result, 'unsuccessful-attempts'));
});
test('retention requires 20 complete cycles and a distinct post-close snapshot on each', () => {
  const p = packet(), s = scenario(p.report, 'retention'); s.attempts.pop(); refresh(s); assert(has(validate(p), 'insufficient-completions'));
  const q = packet(); attempt(q.report, 'retention').memory = []; assert(has(validate(q), 'retention-snapshot'));
});
test('cold/warm, pick/query/amendment and chosen export case identities cannot be relabeled', () => {
  const p = packet(); scenario(p.report, 'selection-cold/pick').kind = 'selection-warm'; assert(has(validate(p), 'identity'));
  const q = packet(); scenario(q.report, 'export/ply-all').caseId = 'query'; assert(has(validate(q), 'identity'));
});
test('retry must reference a retained earlier failure, not a missing/future/successful attempt', () => {
  const p = packet(); attempt(p.report).retryOf = 'missing'; assert(has(validate(p), 'retry-reference'));
  const q = packet(); scenario(q.report).attempts[1]!.retryOf = attempt(q.report).id; assert(has(validate(q), 'retry-reference'));
});
test('raw samples need finite numbers, declared counts, units and nonnegative values', () => {
  for (const value of [NaN, Infinity, -1]) { const p = packet(); attempt(p.report).measurements.decodeMs!.samples = [value]; assert(has(validate(p), 'shape')); }
  const p = packet(); attempt(p.report).measurements.decodeMs!.sampleCount = 2; assert(has(validate(p), 'raw-count'));
  const q = packet(); attempt(q.report).measurements.decodeMs!.unit = 'bytes'; assert(has(validate(q), 'metric-unit'));
});
test('p50/p95/sample counts are recomputed per cell from raw completed-attempt samples', () => {
  const p = packet(); scenario(p.report).summaries.operationSettledMs!.p95 = 0; assert(has(validate(p), 'identity'));
  const q = packet(); scenario(q.report).summaries.operationSettledMs!.sampleCount++; assert(has(validate(q), 'identity'));
});
test('per-request scalar sample padding cannot dilute p95; orbit pass samples align with frames', () => {
  const p = packet(), s = scenario(p.report, 'selection-cold/pick');
  for (const a of s.attempts) { a.measurements.pointerPreviewMs!.samples = [1000, ...Array<number>(100).fill(0)]; a.measurements.pointerPreviewMs!.sampleCount = 101; } refresh(s);
  assert(has(validate(p), 'sample-cardinality'));
  const q = packet(), orbit = scenario(q.report, 'orbit'); orbit.attempts[0]!.measurements.rasterMs!.samples = [1]; orbit.attempts[0]!.measurements.rasterMs!.sampleCount = 1; refresh(orbit); assert(has(validate(q), 'sample-cardinality'));
});
test('mandatory phase observations cannot be unavailable; metadata-only and untargeted GPU stages can', () => {
  const p = packet(), s = scenario(p.report), a = s.attempts[0]!;
  for (const name of ['decodeMs', 'packMs', 'workerTransferMs', 'gpuUploadMs', 'firstPresentMs', 'transferredBytes']) { const m = a.measurements[name]!; m.samples = null; m.sampleCount = 0; m.unavailableReason = 'Synthetic absent instrumentation'; }
  refresh(s); const result = validate(p); assert.equal(result.valid, true, JSON.stringify(result.issues)); assert(has(result, 'missing-required-observation'));
  const q = packet(), o = scenario(q.report, 'orbit'), m = o.attempts[0]!.measurements.rasterMs!; m.samples = null; m.sampleCount = 0; m.unavailableReason = 'No isolated GPU execution observation'; refresh(o); assert.equal(validate(q).valid, true); assert.equal(has(validate(q), 'missing-required-observation'), false);
});
test('R7 summary cannot be replaced with nearest-rank p95', () => {
  const p = packet(), s = scenario(p.report); assert.equal(s.summaries.operationSettledMs!.p95, 11.9); s.summaries.operationSettledMs!.p95 = 12; assert(has(validate(p), 'identity'));
});
test('unavailable measurement is null plus reason, never fabricated zero', () => {
  const p = packet(), m = attempt(p.report).measurements.metadataParseMs!; m.samples = null; m.sampleCount = 0; m.unavailableReason = 'Not applicable: standalone input'; refresh(scenario(p.report)); assert.equal(validate(p).valid, true);
  m.samples = [0]; m.sampleCount = 1; refresh(scenario(p.report)); assert(has(validate(p), 'raw-count'));
});
test('missing primary metric keeps a valid report unaccepted', () => {
  const p = packet(), a = attempt(p.report, 'orbit'); a.measurements.frameMs!.samples = null; a.measurements.frameMs!.sampleCount = 0; a.measurements.frameMs!.unavailableReason = 'Synthetic missing frame trace'; refresh(scenario(p.report, 'orbit'));
  assert(has(validate(p), 'missing-primary-metric')); assert(has(validate(p), 'frame-coverage'));
});
test('settlement and resource retirement have separate boundaries and exact samples', () => {
  const p = packet(); attempt(p.report).measurements.resourceRetiredMs!.samples = [10]; refresh(scenario(p.report)); assert(has(validate(p), 'identity'));
  const q = packet(); attempt(q.report).resourcesRetiredAtMs = 9; assert(has(validate(q), 'timeline'));
});
test('unjoined retirement cannot become zero or be described as physical reclamation', () => {
  const p = packet(), a = attempt(p.report); a.resourcesRetiredAtMs = null; a.retirementUnavailableReason = 'GPU owner still pending'; a.measurements.resourceRetiredMs!.samples = null; a.measurements.resourceRetiredMs!.sampleCount = 0; a.measurements.resourceRetiredMs!.unavailableReason = 'GPU owner still pending'; refresh(scenario(p.report));
  assert.equal(validate(p).valid, true); assert(has(validate(p), 'unjoined-retirement'));
  const q = packet(); (attempt(q.report) as unknown as Record<string, unknown>).retirementMeaning = 'physical-gpu-reclamation'; assert(has(validate(q), 'shape'));
});
test('mixed clock contexts and unsupported timing-method claims are rejected', () => {
  const p = packet(); attempt(p.report).measurements.operationSettledMs!.clockId = 'worker-clock'; assert(has(validate(p), 'identity'));
  const q = packet(); attempt(q.report, 'orbit').measurements.frameMs!.method = 'gpu-timestamp'; assert(has(validate(q), 'frame-method'));
});
test('GPU timestamps require advertised AND enabled capability; queue wall is labeled separately', () => {
  const p = packet(), a = attempt(p.report, 'orbit'); a.measurements.rasterMs!.method = 'gpu-timestamp'; a.measurements.rasterMs!.clockId = 'gpu:adapter'; assert(has(validate(p), 'timestamp-feature'));
  p.report.cells[0]!.environment.adapterFeatures.push('timestamp-query'); assert(has(validate(p), 'timestamp-feature'));
  p.report.cells[0]!.environment.enabledFeatures.push('timestamp-query'); assert.equal(validate(p).valid, true);
  a.measurements.rasterMs!.method = 'queue-wall'; a.measurements.rasterMs!.clockId = 'main-clock'; assert.equal(validate(p).valid, true);
});
test('five-second warm-up, three 30-second traces and idle interval cannot be shortened', () => {
  const p = packet(); attempt(p.report, 'orbit').warmupMs = 4999; assert(has(validate(p), 'orbit-procedure'));
  const q = packet(); attempt(q.report, 'orbit').idleHiddenMs = 0; assert(has(validate(q), 'orbit-procedure'));
  const r = packet(); r.target.traces[0]!.durationMs = 1000; r.report.cells[0]!.trace.durationMs = 1000; assert(has(validate(r), 'trace-procedure'));
});
test('per-frame intervals cannot under-cover or exceed the actual trace interval', () => {
  for (const duration of [999, 1001]) { const p = packet(); attempt(p.report, 'orbit').measurements.frameMs!.samples = Array<number>(30).fill(duration); refresh(scenario(p.report, 'orbit')); assert(has(validate(p), 'frame-coverage')); }
});
test('correctness checks independent expected/actual hashes and exact membership counts', () => {
  const p = packet(); attempt(p.report, 'selection-cold/pick').correctness!.actualSha256 = H('0'); assert(has(validate(p), 'correctness-failed'));
  const q = packet(); attempt(q.report, 'selection-warm/query').correctness!.actualCount = 2; assert(has(validate(q), 'correctness-failed'));
  const r = packet(); attempt(r.report, 'selection-cold/pick').correctness!.expectedSha256 = H('0'); assert(has(validate(r), 'identity'));
});
test('export revision, scope/parameters, hash and precision oracle remain distinct', () => {
  const p = packet(); attempt(p.report, 'export/ply-all').correctness!.capturedRevision = 3; assert(has(validate(p), 'identity'));
  const q = packet(); attempt(q.report, 'export/ply-all').correctness!.absoluteError = 0.01; assert(has(validate(q), 'correctness-failed'));
  const r = packet(); r.target.exportCases[0]!.precision.absoluteTolerance = 0.1; assert(has(validate(r), 'precision'));
});
test('All/Selected/Remainder independently exclude deleted records, including selected/deleted overlap', () => {
  const p = packet();
  // 256000 records, selected3, deleted2, overlap1: All255998, Selected2, Remainder255996.
  assert.deepEqual(p.target.exportCases.map((entry) => [entry.scope, entry.expectedRecordCount]), [['all', 255998], ['selected', 2], ['remainder', 255996]]);
  assert.equal(validate(p).valid, true);
  p.target.exportCases[2]!.expectedRecordCount++; assert(has(validate(p), 'export-membership'));
  const q = packet(); q.target.exportCases[2]!.membership.selectedDeletedCount = 3; assert(has(validate(q), 'export-membership'));
  const r = packet(); attempt(r.report, 'export/ply-remainder').correctness!.membershipSha256 = H('0'); assert(has(validate(r), 'correctness-failed'));
});
test('visible is refused as an export scope; Remainder is not a visibility alias', () => {
  const p = packet(); (p.target.exportCases[2] as unknown as Record<string, unknown>).scope = 'visible'; assert(has(validate(p), 'shape'));
});
test('bounded numeric export permits different encoded byte hashes but checks pinned raw values and error', () => {
  const target = targetFixture(), e = target.exportCases[2]!; e.expectedOutputSha256 = null;
  e.precision = { mode: 'bounded', absoluteTolerance: 0.01, oracleSha256: H('4'), components: [{ id: 'source-0-x', unit: 'scene-unit', expected: 1.25 }, { id: 'source-1-x', unit: 'scene-unit', expected: -2 }] };
  const report = reportFixture(target), a = attempt(report, 'export/ply-remainder'), numeric = a.correctness!.numericOracle!;
  a.correctness!.actualSha256 = H('0'); numeric.values[0]!.actual = 1.255; a.correctness!.absoluteError = Math.abs(1.255 - 1.25);
  const result = validateBenchmark(report, target, expectedFixture()); assert.equal(result.valid, true, JSON.stringify(result.issues)); assert.equal(has(result, 'correctness-failed'), false);
  numeric.values[0]!.actual = 1.3; a.correctness!.absoluteError = Math.abs(1.3 - 1.25); assert(has(validateBenchmark(report, target, expectedFixture()), 'correctness-failed'));
  numeric.oracleSha256 = H('0'); assert(has(validateBenchmark(report, target, expectedFixture()), 'identity'));
});
test('bounded export cannot underreport numeric error, omit components or substitute an exact byte target', () => {
  const target = targetFixture(), e = target.exportCases[0]!; e.expectedOutputSha256 = null;
  e.precision = { mode: 'bounded', absoluteTolerance: 0.01, oracleSha256: H('4'), components: [{ id: 'source-0-x', unit: 'scene-unit', expected: 1.25 }] };
  const report = reportFixture(target), a = attempt(report, 'export/ply-all'); a.correctness!.numericOracle!.values[0]!.actual = 1.255; assert(has(validateBenchmark(report, target, expectedFixture()), 'identity'));
  a.correctness!.numericOracle = null; assert(has(validateBenchmark(report, target, expectedFixture()), 'numeric-oracle'));
  e.expectedOutputSha256 = H('f'); assert(has(validateBenchmark(report, target, expectedFixture()), 'precision'));
});
test('each memory category requires its own method; WASM capacity is not live ledger', () => {
  const p = packet(); attempt(p.report).memory[0]!.observations.ledgerLive.method = 'wasm-memory-buffer'; assert(has(validate(p), 'memory-method'));
  const q = packet(); attempt(q.report).memory[0]!.observations.wasmLinearHighWater.bytes = 1; assert(has(validate(q), 'memory-order'));
});
test('optional JS/process/GPU memory can be unavailable but cannot be zero with an unavailable reason', () => {
  const p = packet(); assert.equal(attempt(p.report).memory[0]!.observations.gpuDriver.bytes, null); assert.equal(validate(p).valid, true);
  attempt(p.report).memory[0]!.observations.gpuDriver.bytes = 0; assert(has(validate(p), 'memory-unavailable'));
});
test('measured process memory requires actual PID, interval and attachment provenance', () => {
  const p = packet(), o = attempt(p.report).memory[0]!.observations.browserProcess; o.bytes = 1000; o.unavailableReason = null; assert(has(validate(p), 'process-provenance'));
  o.processIds = [123]; o.samplingIntervalMs = 100; o.attachmentSha256 = H('0'); assert.equal(validate(p).valid, true);
});
test('logical/memory-method categories cannot carry process IDs to imply OS measurement', () => {
  const p = packet(); attempt(p.report).memory[0]!.observations.nativeLivePayload.processIds = [123]; assert(has(validate(p), 'process-provenance'));
});
test('load/edit/export/capture peaks and final cycle require separate observations', () => {
  const p = packet(); attempt(p.report, 'retention').memory = attempt(p.report, 'retention').memory.filter((entry) => entry.point !== 'capture-peak'); assert(has(validate(p), 'missing-memory-point'));
});
test('memory peak labels cannot be transplanted onto unrelated operation phases', () => {
  const p = packet(); attempt(p.report).memory.push(...attempt(p.report, 'export/ply-all').memory); assert(has(validate(p), 'memory-phase'));
  const q = packet(); attempt(q.report, 'retention').memory.push(...scenario(q.report, 'retention').attempts.at(-1)!.memory.filter((entry) => entry.point === 'final-cycle')); assert(has(validate(q), 'memory-phase'));
});
test('checked-in JSON Schemas exactly match runtime structural shapes', async () => {
  for (const [name, shape] of [['benchmark-target-v1', targetShape], ['benchmark-report-v1', reportShape], ['benchmark-target-v2', observedTargetShape], ['benchmark-report-v2', observedReportShape]] as const) {
    const json = JSON.parse(await readFile(new URL(`../tools/bench/schemas/${name}.schema.json`, import.meta.url), 'utf8')) as Record<string, unknown>;
    delete json.$schema; delete json.title; delete json.description; assert.deepEqual(json, shape);
  }
});
test('retention counters must match actual post-close owners; live bytes and pending owners disqualify', () => {
  const p = packet(), a = attempt(p.report, 'retention'); a.memory[0]!.pendingRetirement.blobOwners = 1; assert(has(validate(p), 'pending-retirement')); assert(has(validate(p), 'identity'));
  const q = packet(), b = attempt(q.report, 'retention'); b.memory[0]!.observations.ledgerLive.bytes = 4; b.measurements.postCloseLedgerBytes!.samples = [4]; refresh(scenario(q.report, 'retention')); assert(has(validate(q), 'post-close-live'));
});
test('local Windows/Chromium cannot be relabeled actual Mac or Safari', () => {
  const p = packet(); p.report.evidenceClass = 'actual-mac'; assert(has(validate(p), 'host-label'));
  const q = packet(); q.report.evidenceClass = 'local-chromium'; q.report.cells[0]!.environment.browserFamily = 'Safari'; assert(has(validate(q), 'host-label'));
});
test('canonical UTC interval and unknown JSON fields are checked', () => {
  const p = packet(); p.report.startedAtUtc = '2026-02-30T00:00:00.000Z'; assert(has(validate(p), 'utc'));
  const q = packet(); (q.report as unknown as Record<string, unknown>).fps = 999; assert(has(validate(q), 'shape'));
});
test('accessors, class instances, sparse arrays, prototypes and nonfinite values are refused before use', () => {
  const p = packet(); let reads = 0; Object.defineProperty(p.report, 'runId', { enumerable: true, get: () => { reads++; return 'unsafe'; } }); assert(has(validate(p), 'shape')); assert.equal(reads, 0);
  assert(checkShape(new Date(), reportShape, 'report').length > 0);
  const q = packet(); delete scenario(q.report).attempts[1]; assert(has(validate(q), 'shape'));
  const r = packet(); Object.defineProperty(r.report, '__proto__', { value: {}, enumerable: true }); assert(has(validate(r), 'shape'));
});
test('pending target cannot smuggle in numeric thresholds; approval without targets cannot accept', () => {
  const p = packet(); p.target.thresholds = [{ cellId: 'synthetic-cell', scenarioId: 'open-cold', metric: 'operationSettledMs', statistic: 'p95', unit: 'ms', maximum: 10 }]; assert(has(validate(p), 'pending-thresholds'));
  const q = packet(); q.target.status = 'approved'; assert(has(validate(q), 'tooling-approval')); assert(has(validate(q), 'missing-thresholds'));
});
test('bounded issue list cannot hide a later invalid record behind many diagnostic gates', () => {
  const target = fullTargetFixture(), report = reportFixture(target);
  for (const cell of report.cells) for (const s of cell.scenarios) {
    const a = s.attempts[0]!; a.status = 'failed'; a.reason = 'Synthetic retained failure'; a.correctness = null; refresh(s);
  }
  const last = report.cells.at(-1)!.scenarios.at(-1)!;
  last.summaries.operationSettledMs!.p95 = 999;
  const result = validateBenchmark(report, target, expectedFixture());
  assert.equal(result.issues.length, 200); assert.equal(result.valid, false); assert.equal(result.accepted, false);
});
test('planned minimum/newer × Safari/Chrome × count/SH/overdraw/framebuffer matrix has exactly 64 required cells', () => {
  const target = fullTargetFixture(); assert.equal(target.cells.length, 64); assert.equal(checkShape(target, targetShape, 'target').length, 0);
  const report = reportFixture(target); const result = validateBenchmark(report, target, expectedFixture()); assert.equal(result.valid, true, JSON.stringify(result.issues)); assert.equal(result.accepted, false);
  target.cells.pop(); assert(has(validateBenchmark(report, target, expectedFixture()), 'identity'));
});
test('a full-source count cannot qualify a tiny admitted/rendered W09 workload', () => {
  const target = fullTargetFixture(), report = reportFixture(target); target.fixtures[0]!.loadedCount = 1;
  assert(has(validateBenchmark(report, target, expectedFixture()), 'fixture-workload'));
});
test('synthetic in-memory policy test exercises explicit approved thresholds without publishing Mac evidence', () => {
  const target = fullTargetFixture(), report = reportFixture(target); approvePolicyFixture(target, report);
  const accepted = validateBenchmark(report, target, expectedFixture()); assert.equal(accepted.valid, true, JSON.stringify(accepted.issues)); assert.equal(accepted.accepted, true); assert.equal(accepted.sustainedQualified, false);
  assert.equal(accepted.scope, 'w09-initial-only'); assert.equal(accepted.observedScope, undefined);
});
// Each case still validates the complete 64-cell matrix. Give each independent
// policy scenario its own timeout and failure identity instead of bundling five
// CPU-heavy validations into one five-second test on shared CI runners.
test.each(['evidence-class', 'threshold-exceeded', 'incomplete-thresholds', 'synthetic-tooling'] as const)(
  'synthetic in-memory approved policy refuses %s without publishing Mac evidence', issue => {
    const target = fullTargetFixture(), report = reportFixture(target); approvePolicyFixture(target, report);
    if (issue === 'evidence-class') report.evidenceClass = 'local-chromium';
    if (issue === 'threshold-exceeded') target.thresholds![0]!.maximum = 0;
    if (issue === 'incomplete-thresholds' || issue === 'synthetic-tooling') target.thresholds!.shift();
    if (issue === 'synthetic-tooling') report.evidenceClass = 'synthetic-tooling';
    const result = validateBenchmark(report, target, expectedFixture());
    if (issue === 'synthetic-tooling') assert.equal(result.accepted, false);
    else assert(has(result, issue));
  });
test('required targets include selection pointer latency and every scenario retirement metric', () => {
  assert.deepEqual(requiredTargetMetrics('selection-cold'), ['operationSettledMs', 'resourceRetiredMs', 'pointerPreviewMs']);
  assert.deepEqual(requiredTargetMetrics('orbit'), ['frameMs', 'resourceRetiredMs']);
  const p = packet(); p.target.status = 'approved'; p.target.scope = 'w09-initial';
  // Full-matrix requirement remains independent; a tiny tooling target cannot be upgraded into qualification.
  assert.equal(validate(p).accepted, false);
});
test('approved profiles cannot omit pointer or retirement targets, or hide unavailable targeted latency', () => {
  const target = fullTargetFixture(), report = reportFixture(target); approvePolicyFixture(target, report);
  const all = target.thresholds!;
  target.thresholds = all.filter((entry) => !(entry.cellId === target.cells[0]!.id && entry.scenarioId.startsWith('selection-cold/') && entry.metric === 'pointerPreviewMs'));
  assert(has(validateBenchmark(report, target, expectedFixture()), 'incomplete-thresholds'));
  target.thresholds = all.filter((entry) => !(entry.cellId === target.cells[0]!.id && entry.scenarioId === 'open-cold' && entry.metric === 'resourceRetiredMs'));
  assert(has(validateBenchmark(report, target, expectedFixture()), 'incomplete-thresholds'));
  target.thresholds = all; const s = report.cells[0]!.scenarios.find((entry) => entry.kind === 'selection-cold')!, m = s.attempts[0]!.measurements.pointerPreviewMs!;
  m.samples = null; m.sampleCount = 0; m.unavailableReason = 'Synthetic missing pointer timestamp'; refresh(s);
  assert(has(validateBenchmark(report, target, expectedFixture()), 'unmeasured-target'));
});
test('memory ceilings cannot be proposed under pending status, duplicated, unmeasured or exceeded', () => {
  const p = packet(); p.target.memoryCeilings = [{ cellId: 'synthetic-cell', point: 'load-peak', category: 'ledgerPeak', maximumBytes: 1000 }]; assert(has(validate(p), 'pending-thresholds'));
  const target = fullTargetFixture(), report = reportFixture(target); approvePolicyFixture(target, report);
  target.memoryCeilings!.find((entry) => entry.cellId === target.cells[0]!.id && entry.point === 'load-peak' && entry.category === 'ledgerPeak')!.maximumBytes = 1000;
  assert(has(validateBenchmark(report, target, expectedFixture()), 'memory-ceiling-exceeded'));
  target.memoryCeilings!.shift(); assert(has(validateBenchmark(report, target, expectedFixture()), 'incomplete-memory-ceilings'));
  target.memoryCeilings!.push({ ...target.memoryCeilings![0]! }); assert(has(validateBenchmark(report, target, expectedFixture()), 'duplicate-memory-ceiling'));
  target.memoryCeilings!.pop(); target.memoryCeilings!.push({ cellId: target.cells[0]!.id, point: 'baseline', category: 'jsHeapEstimate', maximumBytes: 1000000 }); assert(has(validateBenchmark(report, target, expectedFixture()), 'unmeasured-memory-target'));
  const observation = report.cells[1]!.scenarios.find((entry) => entry.kind === 'open-cold')!.attempts[0]!.memory[0]!.observations.wasmLinearHighWater;
  observation.bytes = null; observation.unavailableReason = 'Synthetic missing high-water measurement'; assert(has(validateBenchmark(report, target, expectedFixture()), 'unmeasured-memory-target'));
});
test('write-once report preserves existing bytes and diagnostic validity never implies acceptance', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'splatview-bench-validator-exclusive-')); const path = dir + '/report.json';
  const p = packet(); const validation = await writeBenchmarkReportExclusive(path, p.report, p.target, expectedFixture()); assert.equal(validation.accepted, false); const before = await readFile(path);
  await assert.rejects(writeBenchmarkReportExclusive(path, p.report, p.target, expectedFixture()), { code: 'EEXIST' }); assert.deepEqual(await readFile(path), before);
});
test('invalid reports cannot be published through the write-once report adapter', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'splatview-bench-validator-invalid-')); const p = packet(); p.report.build.coreSha256 = H('f');
  await assert.rejects(writeBenchmarkReportExclusive(dir + '/report.json', p.report, p.target, expectedFixture()), /inconsistent/);
});
test('bounded JSON reader refuses oversized/invalid UTF8 input and exclusive generic receipts never overwrite', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'splatview-bench-validator-bounded-')); const path = dir + '/input.json';
  await writeJsonExclusive(path, BUILD); assert.deepEqual((await readJsonBounded(path)).value, BUILD); await assert.rejects(readJsonBounded(path, 5), /bound/); await assert.rejects(writeJsonExclusive(path, {}), { code: 'EEXIST' });
  const invalid = dir + '/invalid-utf8.json'; await writeFile(invalid, new Uint8Array([0xff]), { flag: 'wx' }); await assert.rejects(readJsonBounded(invalid));
});
test('CLI retains hashed pending diagnostics with exit 2 and refuses receipt overwrite', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'splatview-bench-validator-cli-'));
  const p = packet(); await writeJsonExclusive(dir + '/target.json', p.target); await writeJsonExclusive(dir + '/build.json', BUILD);
  p.report.target.sha256 = sha256(await readFile(dir + '/target.json')); await writeJsonExclusive(dir + '/report.json', p.report);
  const arguments_ = [fileURLToPath(new URL('../tools/bench/cli.ts', import.meta.url)), '--report', dir + '/report.json', '--target', dir + '/target.json', '--build', dir + '/build.json', '--output', dir + '/validation.json'];
  const first = spawnSync(process.execPath, arguments_, { encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 }); assert.equal(first.status, 2, first.stderr);
  const bytes = await readFile(dir + '/validation.json'); const receipt = JSON.parse(bytes.toString()) as { validation: { valid: boolean; accepted: boolean }; inputs: { target: { sha256: string } } };
  assert.equal(receipt.validation.valid, true); assert.equal(receipt.validation.accepted, false); assert.equal(receipt.inputs.target.sha256, p.report.target.sha256);
  const second = spawnSync(process.execPath, arguments_, { encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 }); assert.notEqual(second.status, 0); assert.match(second.stderr, /EEXIST/); assert.deepEqual(await readFile(dir + '/validation.json'), bytes);
});
test('summary helper preserves failure/raw samples while excluding them from successful percentiles', () => {
  const p = packet(), s = scenario(p.report), failed = structuredClone(s.attempts[0]!); failed.status = 'failed'; failed.measurements.operationSettledMs!.samples = [9999]; s.attempts.push(failed);
  const summary = summarize(s.attempts, 'operationSettledMs'); assert.equal(summary.sampleCount, 3); assert.equal(summary.p95, 11.9); assert.equal(failed.measurements.operationSettledMs!.samples[0], 9999);
});

test('v2 synthetic policy proves a fully pinned local Chrome cell can qualify only its observed scope', () => {
  const p = observedPacket(), before = JSON.stringify(p), result = validateObserved(p);
  assert.equal(result.valid, true, JSON.stringify(result.issues)); assert.equal(result.accepted, true, JSON.stringify(result.issues));
  assert.equal(result.scope, 'observed-browser-initial-only'); assert.equal(result.sustainedQualified, false); assert.equal(result.completedAttempts, 220);
  assert.deepEqual(result.observedScope, { cellIds: ['synthetic-cell'], hosts: p.target.observedHosts, capacityQualified: false });
  assert.equal(result.observedScope!.hosts[0]!.osFamily, 'Windows'); assert.equal(result.observedScope!.hosts[0]!.browserFamily, 'Chrome');
  result.observedScope!.hosts[0]!.machineModel = 'detached receipt'; assert.equal(JSON.stringify(p), before);
});
test('v2 normal browser launch is explicit and cannot erase automation provenance', () => {
  const p = observedPacket(); p.report.evidenceClass = 'observed-browser';
  assert(has(validateObserved(p), 'host-label'));
  p.report.cells[0]!.environment.browserHost = 'normal-launch'; p.target.observedHosts[0]!.browserHost = 'normal-launch';
  assert.equal(validateObserved(p).accepted, true);
  p.report.evidenceClass = 'local-chromium'; assert(has(validateObserved(p), 'host-label'));
});
test('v2 does not promote synthetic or pending diagnostics into observations', () => {
  const p = observedPacket(); p.report.evidenceClass = 'synthetic-tooling';
  const synthetic = validateObserved(p); assert.equal(synthetic.valid, true); assert.equal(synthetic.accepted, false); assert(has(synthetic, 'evidence-class')); assert.equal(synthetic.observedScope, undefined);
  const q = observedPacket(); q.target.status = 'pending'; q.target.thresholds = null; q.target.memoryCeilings = null;
  const pending = validateObserved(q); assert.equal(pending.valid, true); assert.equal(pending.accepted, false); assert(has(pending, 'pending-target')); assert.equal(pending.observedScope, undefined);
});
test('v1 and v2 packets cannot mix or silently downgrade their acceptance contract', () => {
  const legacy = packet(), observed = observedPacket();
  for (const [report, target] of [[legacy.report, observed.target], [observed.report, legacy.target]] as const) {
    const result = validateBenchmark(report, target, expectedFixture()); assert.equal(result.valid, false); assert(has(result, 'contract-version')); assert.equal(result.observedScope, undefined);
  }
});
for (const field of ['osFamily', 'osVersion', 'machineModel', 'ramBytes', 'browserVersion', 'adapterName', 'powerMode', 'cachePolicy', 'crossOriginIsolated'] as const) test(`v2 pins observed host ${field} independently of report labels`, () => {
  const p = observedPacket(), host = p.report.cells[0]!.environment;
  if (field === 'ramBytes') host.ramBytes++;
  else if (field === 'crossOriginIsolated') host.crossOriginIsolated = !host.crossOriginIsolated;
  else if (field === 'osFamily') host.osFamily = 'Linux';
  else host[field] += '-mismatch';
  const result = validateObserved(p); assert.equal(result.valid, false); assert(has(result, 'identity')); assert.equal(result.observedScope, undefined);
});
test('v2 pins adapter capabilities, enabled features and limits rather than guessing a device tier', () => {
  for (const mutate of [
    (p: ReturnType<typeof observedPacket>) => { p.report.cells[0]!.environment.adapterFeatures.push('timestamp-query'); },
    (p: ReturnType<typeof observedPacket>) => { p.report.cells[0]!.environment.enabledFeatures.push('timestamp-query'); },
    (p: ReturnType<typeof observedPacket>) => { p.report.cells[0]!.environment.deviceLimits.maxBufferSize! /= 2; },
  ]) {
    const p = observedPacket(), pinned = JSON.stringify(p.target.observedHosts);
    const reported = p.report.cells[0]!.environment, host = p.target.observedHosts[0]!;
    assert.notEqual(reported.adapterFeatures, host.adapterFeatures); assert.notEqual(reported.enabledFeatures, host.enabledFeatures); assert.notEqual(reported.deviceLimits, host.deviceLimits);
    mutate(p); assert.equal(JSON.stringify(p.target.observedHosts), pinned); assert(has(validateObserved(p), 'identity'));
  }
});
test('v2 cannot relabel Windows or automated Chrome observations as actual Mac or Safari', () => {
  const p = observedPacket(); p.report.evidenceClass = 'actual-mac'; assert(has(validateObserved(p), 'host-label'));
  const q = observedPacket(); q.target.browsers[0]!.family = 'Safari'; q.target.observedHosts[0]!.browserFamily = 'Safari'; q.report.cells[0]!.environment.browserFamily = 'Safari';
  assert(has(validateObserved(q), 'host-label')); assert.equal(validateObserved(q).accepted, false);
});
test('v2 supports an explicitly pinned local framebuffer without inheriting the legacy Mac dimensions', () => {
  const p = observedPacket();
  Object.assign(p.target.framebuffers[0]!, { cssWidth: 1024, cssHeight: 768, width: 1024, height: 768 });
  p.report.cells[0]!.environment.framebuffer = structuredClone(p.target.framebuffers[0]!);
  assert.equal(validateObserved(p).accepted, true);
  p.report.cells[0]!.environment.framebuffer.width++; assert(has(validateObserved(p), 'identity'));
  const q = observedPacket(); Object.assign(q.target.framebuffers[0]!, { kind: 'retina', cssWidth: 400, cssHeight: 300, width: 800, height: 600, dpr: 2 });
  q.report.cells[0]!.environment.framebuffer = structuredClone(q.target.framebuffers[0]!); assert.equal(validateObserved(q).accepted, true);
});
test('v2 requires all declared cells and never fills missing framebuffer coverage from another cell', () => {
  const p = observedPacket(); p.target.framebuffers.push({ id: 'local-second-size', kind: 'standard', cssWidth: 1024, cssHeight: 768, width: 1024, height: 768, dpr: 1 });
  p.target.cells.push({ ...p.target.cells[0]!, id: 'missing-local-cell', framebufferId: 'local-second-size' });
  assert(has(validateObserved(p), 'identity')); assert.equal(validateObserved(p).accepted, false);
  const q = observedPacket(); q.report.cells.push(structuredClone(q.report.cells[0]!)); assert(has(validateObserved(q), 'duplicate'));
});
test('v2 host and workload inventories cannot imply unobserved machines, browsers or fixtures', () => {
  const p = observedPacket(); p.target.observedHosts.push({ ...p.target.observedHosts[0]!, machineId: 'unobserved-machine' }); assert(has(validateObserved(p), 'identity'));
  const q = observedPacket(); q.target.machines.push({ id: 'unobserved-machine', tier: 'observed' }); assert(has(validateObserved(q), 'identity'));
  const r = observedPacket(); r.target.observedHosts.push(structuredClone(r.target.observedHosts[0]!)); assert(has(validateObserved(r), 'duplicate'));
  const s = observedPacket(); s.target.fixtures[0]!.loadedCount--; assert(has(validateObserved(s), 'fixture-workload'));
});
test('v2 missing repeats and skipped status remain disqualifying without a partial scope receipt', () => {
  const p = observedPacket(), s = scenario(p.report); s.attempts.pop(); refresh(s);
  const result = validateObserved(p); assert(has(result, 'insufficient-completions')); assert.equal(result.observedScope, undefined);
  const q = observedPacket(); (attempt(q.report) as unknown as Record<string, unknown>).status = 'skipped'; assert(has(validateObserved(q), 'shape'));
});
for (const status of ['failed', 'refused', 'cancelled'] as const) test(`v2 retains ${status} attempts even when enough other repeats completed`, () => {
  const p = observedPacket(), s = scenario(p.report), failed = structuredClone(s.attempts[0]!);
  failed.id = `synthetic-retained-${status}`; failed.status = status; failed.reason = 'Synthetic unit failure retained'; failed.correctness = null; s.attempts.push(failed); refresh(s);
  const result = validateObserved(p); assert(has(result, 'unsuccessful-attempts')); assert.equal(result.accepted, false); assert.equal(result.completedAttempts, 220); assert.equal(s.attempts.length, 4);
});
test('v2 requires measured targeted latency and joined retirement rather than null or synthetic zero', () => {
  const p = observedPacket(), s = scenario(p.report, 'selection-cold/pick'), m = s.attempts[0]!.measurements.pointerPreviewMs!;
  m.samples = null; m.sampleCount = 0; m.unavailableReason = 'Synthetic missing pointer timestamp'; refresh(s); assert(has(validateObserved(p), 'unmeasured-target'));
  const q = observedPacket(), a = attempt(q.report); a.resourcesRetiredAtMs = null; a.retirementUnavailableReason = 'Synthetic pending owner';
  Object.assign(a.measurements.resourceRetiredMs!, { samples: null, sampleCount: 0, unavailableReason: 'Synthetic pending owner' }); refresh(scenario(q.report));
  assert(has(validateObserved(q), 'unjoined-retirement')); assert(has(validateObserved(q), 'unmeasured-target'));
});
test('v2 requires complete approved latency budgets and phase memory ceilings', () => {
  const p = observedPacket(); p.target.thresholds!.shift(); assert(has(validateObserved(p), 'incomplete-thresholds'));
  const q = observedPacket(); q.target.thresholds![0]!.maximum = 0; assert(has(validateObserved(q), 'threshold-exceeded'));
  const r = observedPacket(); r.target.memoryCeilings!.shift(); assert(has(validateObserved(r), 'incomplete-memory-ceilings'));
  const s = observedPacket(); s.target.memoryCeilings![0]!.maximumBytes = 0; assert(has(validateObserved(s), 'memory-ceiling-exceeded'));
  const t = observedPacket(), observation = attempt(t.report).memory[0]!.observations.wasmLinearHighWater;
  observation.bytes = null; observation.unavailableReason = 'Synthetic missing native high-water observation'; assert(has(validateObserved(t), 'unmeasured-memory-target'));
});
test('v2 preserves build and independent correctness hashes, raw samples and pending-owner checks', () => {
  const p = observedPacket(); p.report.build.appSha256 = H('f'); assert(has(validateObserved(p), 'identity'));
  const q = observedPacket(); attempt(q.report, 'selection-cold/pick').correctness!.actualSha256 = H('0'); assert(has(validateObserved(q), 'correctness-failed'));
  const r = observedPacket(); attempt(r.report, 'export/ply-all').correctness!.membershipSha256 = H('0'); assert(has(validateObserved(r), 'correctness-failed'));
  const s = observedPacket(); attempt(s.report).measurements.operationSettledMs!.sampleCount++; assert(has(validateObserved(s), 'raw-count'));
  const t = observedPacket(); attempt(t.report, 'retention').memory[0]!.pendingRetirement.blobOwners = 1; assert(has(validateObserved(t), 'pending-retirement'));
});
