import type { Attempt, BenchmarkReportPacket, BenchmarkTargetPacket, CellReport, ExpectedPacket, Measurement, MetricSummary, ObservedBenchmarkTarget, ObservedEnvironment, Scenario, ScenarioKind, Unit, ValidationIssue, ValidationResult } from './schema.ts';
import { MEMORY_CATEGORIES } from './schema.ts';
import { anyReportShape, anyTargetShape, checkShape, expectedShape } from './shapes.ts';

const COMMON = ['operationSettledMs', 'resourceRetiredMs'];
export const REQUIRED_METRICS: Readonly<Record<ScenarioKind, readonly string[]>> = Object.freeze({
  'open-cold': [...COMMON, 'fileReadMs', 'resourceHashMs', 'canonicalHashMs', 'metadataParseMs', 'metadataRewriteMs', 'resourceStageMs', 'decodeMs', 'packMs', 'workerTransferMs', 'gpuUploadMs', 'firstPresentMs', 'creditWaitMs', 'consumptionAckWaitMs', 'transferredBytes', 'originalMetadataBytes', 'stagedMetadataBytes', 'cancelledReadRetentionMs'],
  'open-warm': [...COMMON, 'fileReadMs', 'resourceHashMs', 'canonicalHashMs', 'metadataParseMs', 'metadataRewriteMs', 'resourceStageMs', 'decodeMs', 'packMs', 'workerTransferMs', 'gpuUploadMs', 'firstPresentMs', 'creditWaitMs', 'consumptionAckWaitMs', 'transferredBytes', 'originalMetadataBytes', 'stagedMetadataBytes', 'cancelledReadRetentionMs'],
  orbit: [...COMMON, 'frameMs', 'sortMs', 'rasterMs', 'longTasks', 'droppedFrames', 'idleWorkCount'],
  'selection-cold': [...COMMON, 'pointerPreviewMs', 'queryMs', 'readbackMs', 'adoptionMs', 'nativeMs', 'publicationMs'],
  'selection-warm': [...COMMON, 'pointerPreviewMs', 'queryMs', 'readbackMs', 'adoptionMs', 'nativeMs', 'publicationMs'],
  export: [...COMMON, 'encodeMs', 'outputCopyBlobMs', 'downloadHandoffMs', 'outputBytes'],
  retention: [...COMMON, 'postCloseLedgerBytes', 'pendingGpuOwners', 'pendingBlobOwners', 'pendingReadOwners'],
});
const MINIMUM_COMPLETED: Readonly<Record<ScenarioKind, number>> = Object.freeze({ 'open-cold': 3, 'open-warm': 5, orbit: 3, 'selection-cold': 30, 'selection-warm': 30, export: 3, retention: 20 });
const OPEN_AVAILABLE = [...COMMON, 'fileReadMs', 'resourceHashMs', 'canonicalHashMs', 'resourceStageMs', 'decodeMs', 'packMs', 'workerTransferMs', 'gpuUploadMs', 'firstPresentMs', 'creditWaitMs', 'consumptionAckWaitMs', 'transferredBytes'];
/** Metadata-only/cancelled-read stages and optional GPU execution observations may be inapplicable. */
export const REQUIRED_AVAILABLE_METRICS: Readonly<Record<ScenarioKind, readonly string[]>> = Object.freeze({
  'open-cold': OPEN_AVAILABLE, 'open-warm': OPEN_AVAILABLE,
  orbit: [...COMMON, 'frameMs', 'longTasks', 'droppedFrames', 'idleWorkCount'],
  'selection-cold': REQUIRED_METRICS['selection-cold'], 'selection-warm': REQUIRED_METRICS['selection-warm'],
  export: REQUIRED_METRICS.export, retention: REQUIRED_METRICS.retention,
});
const COUNTS = new Set(['longTasks', 'droppedFrames', 'idleWorkCount', 'pendingGpuOwners', 'pendingBlobOwners', 'pendingReadOwners']);
const metricUnit = (metric: string): Unit => metric.endsWith('Bytes') ? 'bytes' : COUNTS.has(metric) ? 'count' : 'ms';
const primaryMetric = (kind: ScenarioKind): string => kind === 'orbit' ? 'frameMs' : kind === 'retention' ? 'postCloseLedgerBytes' : 'operationSettledMs';
export const MEMORY_POINTS = ['baseline', 'load-peak', 'edit-peak', 'export-peak', 'capture-peak', 'post-close', 'final-cycle'] as const;
export const REQUIRED_MEMORY_CEILINGS = ['ledgerLive', 'ledgerPeak', 'wasmLinearHighWater'] as const;
export const requiredTargetMetrics = (kind: ScenarioKind): string[] => [...new Set([primaryMetric(kind), 'resourceRetiredMs', ...(kind.startsWith('selection-') ? ['pointerPreviewMs'] : [])])];
export function percentile(values: readonly number[], fraction: number): number | null {
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1 || values.some((value) => !Number.isFinite(value) || value < 0)) throw new RangeError('Invalid percentile input');
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const at = (sorted.length - 1) * fraction;
  const lower = Math.floor(at);
  return sorted[lower]! + (sorted[Math.ceil(at)]! - sorted[lower]!) * (at - lower);
}
/** Summaries contain completed-attempt samples only; unsuccessful raw attempts stay in the report. */
export function summarize(attempts: readonly Attempt[], metric: string): MetricSummary {
  const completed = attempts.filter((attempt) => attempt.status === 'completed');
  const samples = completed.flatMap((attempt) => attempt.measurements[metric]?.samples ?? []);
  return { sampleCount: samples.length, unavailableAttempts: completed.filter((attempt) => attempt.measurements[metric]?.samples === null).length, percentileMethod: 'linear-r7', p50: percentile(samples, 0.5), p95: percentile(samples, 0.95) };
}
export function scenarioDefinitions(target: BenchmarkTargetPacket, fixtureId: string): { id: string; kind: ScenarioKind; caseId: string | null; parametersSha256: string }[] {
  const fixture = target.fixtures.find((entry) => entry.id === fixtureId)!;
  return [
    ...(['open-cold', 'open-warm', 'orbit', 'retention'] as const).map((kind) => ({ id: kind, kind, caseId: null, parametersSha256: fixture.manifestSha256 })),
    ...target.selectionCases.filter((entry) => entry.fixtureId === fixtureId).flatMap((entry) => (['selection-cold', 'selection-warm'] as const).map((kind) => ({ id: `${kind}/${entry.id}`, kind, caseId: entry.id, parametersSha256: entry.parametersSha256 }))),
    ...target.exportCases.filter((entry) => entry.fixtureId === fixtureId).map((entry) => ({ id: `export/${entry.id}`, kind: 'export' as const, caseId: entry.id, parametersSha256: entry.parametersSha256 })),
  ];
}
const same = (left: unknown, right: unknown): boolean => {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => same(item, right[index]));
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && same(a[key], b[key]));
};
const utc = (value: string): boolean => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

/** Pure, synchronous browser-compatible consistency check; it does not attest hardware or source bytes. */
export function validateBenchmark(reportInput: unknown, targetInput: unknown, expectedInput: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  let completedAttempts = 0;
  let invalidSeen = false;
  let observedTarget: ObservedBenchmarkTarget | undefined;
  const add = (level: ValidationIssue['level'], code: string, path: string, message: string): void => { if (level === 'invalid') invalidSeen = true; if (issues.length < 200) issues.push({ level, code, path, message }); };
  const invalid = (code: string, path: string, message: string): void => add('invalid', code, path, message);
  const gate = (code: string, path: string, message: string): void => add('gate', code, path, message);
  const result = (cellCount = 0): ValidationResult => ({ valid: !invalidSeen, accepted: issues.length === 0,
    scope: observedTarget ? 'observed-browser-initial-only' : 'w09-initial-only', sustainedQualified: false, issues, cellCount, completedAttempts,
    ...(observedTarget && !invalidSeen && !issues.length ? { observedScope: { cellIds: observedTarget.cells.map(cell => cell.id), hosts: structuredClone(observedTarget.observedHosts), capacityQualified: false as const } } : {}),
  });
  for (const [input, shape, path] of [[reportInput, anyReportShape, 'report'], [targetInput, anyTargetShape, 'target'], [expectedInput, expectedShape, 'expected']] as const) {
    for (const message of checkShape(input, shape, path)) invalid('shape', path, message);
  }
  if (issues.length) return result();
  const report = reportInput as BenchmarkReportPacket, target = targetInput as BenchmarkTargetPacket, expected = expectedInput as ExpectedPacket;
  if (target.schemaVersion === 2) observedTarget = target;
  if (report.schemaVersion !== target.schemaVersion) { invalid('contract-version', 'report.schemaVersion', 'Target and report must use the same contract version'); return result(); }
  const unique = <T>(entries: readonly T[], key: (entry: T) => string, path: string): void => {
    const found = new Set<string>();
    for (const entry of entries) { const value = key(entry); if (found.has(value)) invalid('duplicate', path, `Repeated identity ${value}`); found.add(value); }
  };
  const exact = (actual: unknown, wanted: unknown, path: string): void => { if (!same(actual, wanted)) invalid('identity', path, 'Does not match pinned identity/required set'); };
  const exactSet = (actual: readonly string[], wanted: readonly string[], path: string): void => { exact([...actual].sort(), [...wanted].sort(), path); };
  for (const key of ['machines', 'browsers', 'fixtures', 'traces', 'framebuffers', 'cells', 'selectionCases', 'exportCases'] as const) unique(target[key].map((entry) => entry.id), (id) => id, `target.${key}`);
  if (!utc(report.startedAtUtc) || !utc(report.endedAtUtc) || Date.parse(report.endedAtUtc) < Date.parse(report.startedAtUtc)) invalid('utc', 'report', 'UTC interval must be canonical and ordered');
  exact(report.target, { id: target.id, sha256: expected.targetSha256 }, 'report.target');
  exact(report.build, expected.build, 'report.build');
  if (target.status !== 'approved') gate('pending-target', 'target.status', 'Pending target profiles cannot qualify a run');
  if (target.scope === 'tooling-only') gate('tooling-target', 'target.scope', 'Tooling profiles cannot qualify hardware');
  if (target.schemaVersion === 1 && report.evidenceClass !== 'actual-mac') gate('evidence-class', 'report.evidenceClass', 'Synthetic/local Chromium reports cannot qualify legacy Mac budgets');
  if (target.schemaVersion === 2 && report.evidenceClass === 'synthetic-tooling') gate('evidence-class', 'report.evidenceClass', 'Synthetic tooling cannot qualify observed-browser measurements');
  if (target.status === 'pending' && target.thresholds !== null) invalid('pending-thresholds', 'target.thresholds', 'Pending profiles use null; proposed numeric budgets must not masquerade as approved targets');
  if (target.status === 'pending' && target.memoryCeilings !== null) invalid('pending-thresholds', 'target.memoryCeilings', 'Pending profiles use null memory ceilings');
  if (target.status === 'approved' && target.thresholds === null) gate('missing-thresholds', 'target.thresholds', 'Approved targets require complete explicit thresholds');
  if (target.status === 'approved' && target.memoryCeilings === null) gate('missing-memory-ceilings', 'target.memoryCeilings', 'Approved targets require explicit per-cell/per-phase memory ceilings');
  if (target.scope === 'tooling-only' && target.status === 'approved') invalid('tooling-approval', 'target.status', 'Tooling-only targets cannot be approved');
  for (const fixture of target.fixtures) {
    if (fixture.loadedCount > fixture.sourceCount) invalid('fixture-count', `target.fixtures.${fixture.id}`, 'Loaded count exceeds source count');
    if (target.scope === 'w09-initial' && ![256000, 1000000].includes(fixture.sourceCount)) invalid('fixture-count', `target.fixtures.${fixture.id}`, 'Initial packet covers 256k and 1M; 3M is a separate gate');
    if (target.scope === 'w09-initial' && fixture.loadedCount !== fixture.sourceCount) invalid('fixture-workload', `target.fixtures.${fixture.id}`, 'Initial matrix requires the full stated loaded workload; sampling is a separate cell/gate');
    if (target.schemaVersion === 2 && (fixture.loadedCount !== fixture.sourceCount || fixture.sourceCount === 0)) invalid('fixture-workload', `target.fixtures.${fixture.id}`, 'Observed initial cells require the complete positive declared workload');
    const cases = target.selectionCases.filter((entry) => entry.fixtureId === fixture.id);
    exactSet(cases.map((entry) => entry.kind), ['pick', 'query', 'amendment'], `target.selectionCases.${fixture.id}`);
    if (!target.exportCases.some((entry) => entry.fixtureId === fixture.id)) invalid('missing-export-case', `target.exportCases.${fixture.id}`, 'Choose at least one explicit format/scope for the first packet');
  }
  for (const entry of [...target.selectionCases, ...target.exportCases]) {
    const fixture = target.fixtures.find((item) => item.id === entry.fixtureId);
    if (!fixture) invalid('unknown-fixture', `target.cases.${entry.id}`, 'Case refers to unknown fixture');
    if ('expectedSelectedCount' in entry && fixture && entry.expectedSelectedCount > fixture.loadedCount) invalid('case-count', `target.cases.${entry.id}`, 'Selected count exceeds loaded count');
    if ('precision' in entry) {
      const at = `target.cases.${entry.id}`, membership = entry.membership;
      const { loadedCount: loaded, selectedCount: selected, deletedCount: deleted, selectedDeletedCount: overlap } = membership;
      if (loaded !== fixture?.loadedCount || selected > loaded || deleted > loaded || overlap > Math.min(selected, deleted) || overlap < Math.max(0, selected + deleted - loaded)) invalid('export-membership', at, 'Invalid loaded/selected/deleted intersection counts');
      const records = entry.scope === 'all' ? loaded - deleted : entry.scope === 'selected' ? selected - overlap : loaded - deleted - selected + overlap;
      if (entry.expectedRecordCount !== records) invalid('export-membership', at, 'All/Selected/Remainder omit deleted records and preserve selected/deleted overlap semantics');
      unique(entry.precision.components, (component) => component.id, `${at}.precision.components`);
      if (entry.precision.mode === 'exact' && (entry.precision.absoluteTolerance !== 0 || entry.expectedOutputSha256 === null || entry.precision.components.length !== 0)) invalid('precision', at, 'Exact byte comparison needs a hash, zero tolerance and no numeric substitute');
      if (entry.precision.mode === 'bounded' && (entry.expectedOutputSha256 !== null || entry.precision.components.length === 0)) invalid('precision', at, 'Bounded numeric comparison needs pinned components; encoded byte hash is not an equality target');
    }
  }
  for (const trace of target.traces) if (trace.warmupMs < 5000 || trace.durationMs !== 30000 || trace.idleHiddenMs <= 0) invalid('trace-procedure', `target.traces.${trace.id}`, 'Initial orbit requires >=5s warm-up, 30s trace and subsequent idle/hidden interval');
  for (const framebuffer of target.framebuffers) {
    if (framebuffer.width !== Math.round(framebuffer.cssWidth * framebuffer.dpr) || framebuffer.height !== Math.round(framebuffer.cssHeight * framebuffer.dpr)) invalid('framebuffer', `target.framebuffers.${framebuffer.id}`, 'Framebuffer must match recorded CSS size and DPR');
    if (target.schemaVersion === 1 && framebuffer.kind === 'standard' && (framebuffer.width !== 1280 || framebuffer.height !== 800)) invalid('framebuffer', `target.framebuffers.${framebuffer.id}`, 'Legacy standard packet framebuffer is 1280 by 800');
    if (framebuffer.kind === 'retina' && (framebuffer.dpr < 2 || (target.schemaVersion === 1 && framebuffer.width * framebuffer.height <= 1280 * 800))) invalid('framebuffer', `target.framebuffers.${framebuffer.id}`, 'Retina cell requires DPR>=2; legacy cells also require a framebuffer larger than 1280 by 800');
  }
  unique(target.cells, (entry) => [entry.machineId, entry.browserId, entry.fixtureId, entry.traceId, entry.framebufferId].join('|'), 'target.cells');
  for (const cell of target.cells) {
    for (const [key, entries] of [['machineId', target.machines], ['browserId', target.browsers], ['fixtureId', target.fixtures], ['traceId', target.traces], ['framebufferId', target.framebuffers]] as const) {
      if (!entries.some((entry) => entry.id === cell[key])) invalid('cell-reference', `target.cells.${cell.id}.${key}`, 'Unknown referenced identity');
    }
  }
  if (target.scope === 'w09-initial') {
    exactSet(target.machines.map((entry) => entry.tier), ['minimum', 'newer'], 'target.machines');
    exactSet(target.browsers.map((entry) => entry.family), ['Safari', 'Chrome'], 'target.browsers');
    exactSet(target.framebuffers.map((entry) => entry.kind), ['standard', 'retina'], 'target.framebuffers');
    if (target.traces.length !== 1) invalid('trace-matrix', 'target.traces', 'Initial comparable matrix uses one pinned camera trace');
    const fixtureTuples = target.fixtures.map((entry) => `${entry.sourceCount}/${entry.shDegree}/${entry.overdraw}`);
    const requiredTuples = [256000, 1000000].flatMap((count) => [0, 3].flatMap((sh) => ['low', 'high'].map((overdraw) => `${count}/${sh}/${overdraw}`)));
    exactSet(fixtureTuples, requiredTuples, 'target.fixtures');
    const requiredCells = target.machines.flatMap((machine) => target.browsers.flatMap((browser) => target.fixtures.flatMap((fixture) => target.framebuffers.map((framebuffer) => `${machine.id}|${browser.id}|${fixture.id}|${target.traces[0]!.id}|${framebuffer.id}`))));
    exactSet(target.cells.map((cell) => [cell.machineId, cell.browserId, cell.fixtureId, cell.traceId, cell.framebufferId].join('|')), requiredCells, 'target.cells');
  }
  if (target.schemaVersion === 2) {
    const pair = (entry: { machineId: string; browserId: string }): string => `${entry.machineId}|${entry.browserId}`;
    unique(target.observedHosts, pair, 'target.observedHosts');
    exactSet(target.observedHosts.map(pair), [...new Set(target.cells.map(pair))], 'target.observedHosts');
    for (const [key,entries] of [['machineId',target.machines],['browserId',target.browsers],['fixtureId',target.fixtures],['traceId',target.traces],['framebufferId',target.framebuffers]] as const)
      exactSet(entries.map(entry => entry.id), [...new Set(target.cells.map(cell => cell[key]))], `target.${key}`);
    for (const host of target.observedHosts) {
      exact(host.browserFamily, target.browsers.find(browser => browser.id === host.browserId)?.family, `target.observedHosts.${pair(host)}.browserFamily`);
      if (host.browserFamily === 'Safari' && host.osFamily !== 'macOS') invalid('host-label', 'target.observedHosts', 'Safari observations require their declared macOS host');
    }
  }
  unique(report.cells, (cell) => cell.identity.id, 'report.cells');
  exactSet(report.cells.map((cell) => cell.identity.id), target.cells.map((cell) => cell.id), 'report.cells');
  // Invalid target references must stop cross-field processing, rather than become undefined lookups.
  if (invalidSeen) return result(report.cells.length);
  for (const cell of report.cells) checkCell(cell);
  const thresholdKeys = new Set<string>();
  for (const threshold of target.thresholds ?? []) {
    const path = `target.thresholds.${threshold.cellId}/${threshold.scenarioId}/${threshold.metric}/${threshold.statistic}`;
    const key = `${threshold.cellId}|${threshold.scenarioId}|${threshold.metric}|${threshold.statistic}`;
    if (thresholdKeys.has(key)) invalid('duplicate-threshold', path, 'Repeated target threshold'); thresholdKeys.add(key);
    const cell = report.cells.find((entry) => entry.identity.id === threshold.cellId);
    const scenario = cell?.scenarios.find((entry) => entry.id === threshold.scenarioId);
    if (!scenario || !REQUIRED_METRICS[scenario.kind].includes(threshold.metric)) { invalid('threshold-reference', path, 'Unknown cell/scenario/metric'); continue; }
    if (threshold.unit !== metricUnit(threshold.metric)) invalid('threshold-unit', path, 'Threshold unit mismatch');
    const summary = scenario.summaries[threshold.metric];
    const measured = summary?.[threshold.statistic];
    if (measured === null || measured === undefined || summary!.unavailableAttempts) gate('unmeasured-target', path, 'Target measurement is unavailable');
    else if (measured > threshold.maximum) gate('threshold-exceeded', path, 'Measured statistic exceeds target');
  }
  if (target.status === 'approved') for (const cell of report.cells) for (const scenario of cell.scenarios) for (const metric of requiredTargetMetrics(scenario.kind)) {
    const key = `${cell.identity.id}|${scenario.id}|${metric}|p95`;
    if (!thresholdKeys.has(key)) gate('incomplete-thresholds', `target.thresholds.${key}`, 'Required latency/retirement metric needs an explicit p95 target');
  }
  const ceilingKeys = new Set<string>();
  for (const ceiling of target.memoryCeilings ?? []) {
    const key = `${ceiling.cellId}|${ceiling.point}|${ceiling.category}`, path = `target.memoryCeilings.${key}`;
    if (ceilingKeys.has(key)) invalid('duplicate-memory-ceiling', path, 'Repeated memory ceiling'); ceilingKeys.add(key);
    const cell = report.cells.find((entry) => entry.identity.id === ceiling.cellId);
    if (!cell) { invalid('memory-ceiling-reference', path, 'Unknown cell'); continue; }
    const values = cell.scenarios.flatMap((scenario) => scenario.attempts.flatMap((attempt) => attempt.memory.filter((snapshot) => snapshot.point === ceiling.point).map((snapshot) => snapshot.observations[ceiling.category].bytes)));
    if (!values.length || values.some((value) => value === null)) gate('unmeasured-memory-target', path, 'Targeted memory observation is missing/unavailable');
    else if (values.some((value) => value! > ceiling.maximumBytes)) gate('memory-ceiling-exceeded', path, 'At least one observed phase/cycle exceeds its memory ceiling');
  }
  if (target.status === 'approved') for (const cell of report.cells) for (const point of MEMORY_POINTS) for (const category of REQUIRED_MEMORY_CEILINGS) {
    const key = `${cell.identity.id}|${point}|${category}`;
    if (!ceilingKeys.has(key)) gate('incomplete-memory-ceilings', `target.memoryCeilings.${key}`, 'Required admitted live/peak and WASM high-water ceiling is missing');
  }
  return result(report.cells.length);

  function checkCell(cell: CellReport): void {
    const at = `report.cells.${cell.identity.id}`;
    const pinned = target.cells.find((entry) => entry.id === cell.identity.id)!;
    exact(cell.identity, pinned, `${at}.identity`);
    const fixture = target.fixtures.find((entry) => entry.id === pinned.fixtureId)!;
    const trace = target.traces.find((entry) => entry.id === pinned.traceId)!;
    exact(cell.fixture, fixture, `${at}.fixture`); exact(cell.trace, trace, `${at}.trace`);
    const env = cell.environment;
    exact(env.machineId, pinned.machineId, `${at}.environment.machineId`); exact(env.browserId, pinned.browserId, `${at}.environment.browserId`);
    exact(env.framebuffer, target.framebuffers.find((entry) => entry.id === pinned.framebufferId), `${at}.environment.framebuffer`);
    exact(env.browserFamily, target.browsers.find((entry) => entry.id === pinned.browserId)!.family, `${at}.environment.browserFamily`);
    if (report.evidenceClass === 'actual-mac' && env.osFamily !== 'macOS') invalid('host-label', `${at}.environment.osFamily`, 'Actual-Mac report requires recorded macOS environment');
    if (report.evidenceClass === 'local-chromium' && env.browserFamily !== 'Chrome') invalid('host-label', `${at}.environment.browserFamily`, 'Local-Chromium label cannot describe Safari');
    if (target.schemaVersion === 2) {
      const actualHost = Object.fromEntries(Object.entries(env).filter(([name]) => name !== 'framebuffer'));
      const host = target.observedHosts.find(entry => entry.machineId === pinned.machineId && entry.browserId === pinned.browserId);
      exact(actualHost, host, `${at}.environment.observedHost`);
      if (report.evidenceClass === 'local-chromium' && (env as ObservedEnvironment).browserHost !== 'automation') invalid('host-label', `${at}.environment.browserHost`, 'Local-Chromium observations must retain their automation label');
      if (report.evidenceClass === 'observed-browser' && (env as ObservedEnvironment).browserHost !== 'normal-launch') invalid('host-label', `${at}.environment.browserHost`, 'Normal browser observations must retain their normal-launch label');
    }
    unique(env.adapterFeatures, (value) => value, `${at}.adapterFeatures`); unique(env.enabledFeatures, (value) => value, `${at}.enabledFeatures`);
    if (!Object.keys(env.deviceLimits).length) invalid('missing-limits', `${at}.deviceLimits`, 'Record actual device limits');
    for (const feature of env.enabledFeatures) if (!env.adapterFeatures.includes(feature)) invalid('enabled-feature', `${at}.enabledFeatures`, 'Enabled feature was not advertised');
    unique(cell.overdrawCheckpoints, (entry) => String(entry.traceTimeMs), `${at}.overdrawCheckpoints`);
    for (const checkpoint of cell.overdrawCheckpoints) if (checkpoint.traceTimeMs > trace.durationMs || checkpoint.visibleProjectedSplats > fixture.loadedCount || checkpoint.overlapP95 < checkpoint.overlapP50) invalid('overdraw', `${at}.overdrawCheckpoints`, 'Checkpoint exceeds pinned workload/range');
    const definitions = scenarioDefinitions(target, fixture.id);
    unique(cell.scenarios, (scenario) => scenario.id, `${at}.scenarios`);
    exactSet(cell.scenarios.map((scenario) => scenario.id), definitions.map((entry) => entry.id), `${at}.scenarios`);
    const points = new Set<string>();
    for (const scenario of cell.scenarios) {
      const definition = definitions.find((entry) => entry.id === scenario.id);
      if (!definition) continue;
      exact({ id: scenario.id, kind: scenario.kind, caseId: scenario.caseId, parametersSha256: scenario.parametersSha256 }, definition, `${at}.scenarios.${scenario.id}`);
      checkScenario(cell, scenario, `${at}.scenarios.${scenario.id}`, points);
    }
    for (const point of MEMORY_POINTS) if (!points.has(point)) invalid('missing-memory-point', `${at}.memory`, `Missing ${point} memory observation`);
  }
  function checkScenario(cell: CellReport, scenario: Scenario, at: string, points: Set<string>): void {
    unique(scenario.attempts, (attempt) => attempt.id, `${at}.attempts`);
    const counts = { total: scenario.attempts.length, completed: 0, failed: 0, refused: 0, cancelled: 0 };
    for (const attempt of scenario.attempts) counts[attempt.status]++;
    exact(scenario.counts, counts, `${at}.counts`);
    completedAttempts += counts.completed;
    if (counts.completed < MINIMUM_COMPLETED[scenario.kind]) gate('insufficient-completions', at, `Need ${MINIMUM_COMPLETED[scenario.kind]} completed independent repeats`);
    if (counts.failed || counts.refused || counts.cancelled) gate('unsuccessful-attempts', at, 'Failed/refused/cancelled attempts remain disqualifying; retries do not erase them');
    exactSet(Object.keys(scenario.summaries), REQUIRED_METRICS[scenario.kind], `${at}.summaries`);
    const seen = new Map<string, Attempt>();
    for (const attempt of scenario.attempts) {
      const path = `${at}.attempts.${attempt.id}`;
      if (attempt.retryOf !== null && (!seen.has(attempt.retryOf) || seen.get(attempt.retryOf)!.status === 'completed')) invalid('retry-reference', `${path}.retryOf`, 'Retry must preserve an earlier unsuccessful attempt');
      seen.set(attempt.id, attempt);
      if ((attempt.status === 'completed') !== (attempt.reason === null)) invalid('attempt-reason', path, 'Success has null reason; unsuccessful attempt requires reason');
      if (attempt.operationSettledAtMs < attempt.startedAtMs || (attempt.resourcesRetiredAtMs !== null && attempt.resourcesRetiredAtMs < attempt.operationSettledAtMs)) invalid('timeline', path, 'Monotonic settlement/retirement boundaries are reversed');
      if ((attempt.resourcesRetiredAtMs === null) !== (attempt.retirementUnavailableReason !== null)) invalid('retirement-reason', path, 'Missing retirement boundary requires an explicit reason');
      if (attempt.resourcesRetiredAtMs === null) gate('unjoined-retirement', path, 'Operation settlement does not establish resource retirement');
      exactSet(Object.keys(attempt.measurements), REQUIRED_METRICS[scenario.kind], `${path}.measurements`);
      for (const [metric, observation] of Object.entries(attempt.measurements)) checkMeasurement(cell, attempt, metric, observation, `${path}.measurements.${metric}`);
      if (scenario.kind === 'orbit' && attempt.status === 'completed') {
        if (attempt.warmupMs < cell.trace.warmupMs || attempt.operationSettledAtMs - attempt.startedAtMs < cell.trace.durationMs || attempt.idleHiddenMs < cell.trace.idleHiddenMs) invalid('orbit-procedure', path, 'Warm-up, 30-second run and subsequent idle/hidden interval must be recorded separately');
        const frames = attempt.measurements.frameMs?.samples;
        const duration = frames?.reduce((sum, value) => sum + value, 0);
        if (duration === undefined || duration < cell.trace.durationMs || duration > attempt.operationSettledAtMs - attempt.startedAtMs) invalid('frame-coverage', path, 'Raw frame intervals must cover the trace and fit the measured operation interval');
      }
      checkCorrectness(cell, scenario, attempt, path);
      unique(attempt.memory, (snapshot) => snapshot.point, `${path}.memory`);
      for (const memory of attempt.memory) {
        points.add(memory.point);
        const allowed = memory.point === 'baseline' ? scenario.kind === 'open-cold' : memory.point === 'load-peak' ? scenario.kind.startsWith('open-') : memory.point === 'edit-peak' ? scenario.kind.startsWith('selection-') || scenario.kind === 'retention' : memory.point === 'export-peak' ? scenario.kind === 'export' || scenario.kind === 'retention' : scenario.kind === 'retention';
        if (!allowed || (memory.point === 'final-cycle' && (attempt !== scenario.attempts.at(-1) || attempt.status !== 'completed'))) invalid('memory-phase', `${path}.memory.${memory.point}`, 'Memory point must belong to its measured operation/final completed cycle');
        for (const category of MEMORY_CATEGORIES) {
          const observation = memory.observations[category];
          const expectedMethod = category.startsWith('ledger') ? 'logical-ledger' : category === 'nativeLivePayload' ? 'native-summary' : category.startsWith('wasm') ? 'wasm-memory-buffer' : category === 'jsHeapEstimate' ? 'js-heap-estimate' : category === 'gpuDriver' ? 'driver-observation' : 'os-process-sample';
          if (observation.method !== expectedMethod) invalid('memory-method', `${path}.memory.${memory.point}.${category}`, 'Memory categories/methods cannot substitute for one another');
          if ((observation.bytes === null) !== (observation.unavailableReason !== null)) invalid('memory-unavailable', path, 'Unavailable memory needs null plus reason; measured zero is a distinct observation');
          if (observation.method === 'os-process-sample' && observation.bytes !== null && (!observation.processIds.length || observation.samplingIntervalMs === null || observation.attachmentSha256 === null)) invalid('process-provenance', path, 'Process observations need PIDs, sampling interval and attachment hash');
          if (observation.method !== 'os-process-sample' && (observation.processIds.length || observation.samplingIntervalMs !== null)) invalid('process-provenance', path, 'PIDs/OS interval cannot describe logical or driver memory');
        }
        const value = (key: keyof typeof memory.observations): number | null => memory.observations[key].bytes;
        for (const key of ['ledgerLive', 'ledgerPeak', 'nativeLivePayload', 'wasmLinearCapacity', 'wasmLinearHighWater'] as const) if (value(key) === null) gate('missing-core-memory', path, `Core memory category ${key} must be observed`);
        if (value('ledgerLive') !== null && value('ledgerPeak') !== null && value('ledgerPeak')! < value('ledgerLive')!) invalid('memory-order', path, 'Ledger peak is smaller than live');
        if (value('wasmLinearCapacity') !== null && value('wasmLinearHighWater') !== null && value('wasmLinearHighWater')! < value('wasmLinearCapacity')!) invalid('memory-order', path, 'WASM high-water is smaller than capacity');
        if (value('nativeLivePayload') !== null && value('wasmLinearCapacity') !== null && value('nativeLivePayload')! > value('wasmLinearCapacity')!) invalid('memory-order', path, 'Native live payload exceeds linear memory');
        if (memory.point === 'post-close' || memory.point === 'final-cycle') {
          if (Object.values(memory.pendingRetirement).some((count) => count !== 0)) gate('pending-retirement', path, 'Settled cycle still has application GPU/Blob/read owners');
          if (value('ledgerLive') !== 0) gate('post-close-live', path, 'Post-close live ledger is nonzero');
        }
      }
      if (scenario.kind === 'retention' && attempt.status === 'completed' && !attempt.memory.some((entry) => entry.point === 'post-close')) invalid('retention-snapshot', path, 'Every completed cycle needs its own post-close observation');
    }
    for (const metric of REQUIRED_METRICS[scenario.kind]) {
      const computed = summarize(scenario.attempts, metric);
      exact(scenario.summaries[metric], computed, `${at}.summaries.${metric}`);
      if (metric === primaryMetric(scenario.kind) && computed.unavailableAttempts) gate('missing-primary-metric', at, 'Required primary timings/counters are unavailable');
      if (REQUIRED_AVAILABLE_METRICS[scenario.kind].includes(metric) && computed.unavailableAttempts) gate('missing-required-observation', `${at}.summaries.${metric}`, 'Required packet observation is unavailable');
    }
  }
  function checkMeasurement(cell: CellReport, attempt: Attempt, metric: string, observation: Measurement, at: string): void {
    if (observation.unit !== metricUnit(metric)) invalid('metric-unit', at, 'Metric has wrong explicit units');
    if ((observation.samples === null) !== (observation.unavailableReason !== null) || observation.sampleCount !== (observation.samples?.length ?? 0)) invalid('raw-count', at, 'Raw sample count/null reason does not match observations');
    if (observation.samples !== null && metric !== 'frameMs') {
      const expectedCount = metric === 'sortMs' || metric === 'rasterMs' ? attempt.measurements.frameMs?.samples?.length : 1;
      if (observation.samples.length !== expectedCount) invalid('sample-cardinality', at, 'One scalar is required per operation/request; orbit pass samples must align one-to-one with frames');
    }
    const counter = metricUnit(metric) !== 'ms';
    if (counter && (observation.method !== 'application-counter' || observation.clockId !== null || observation.samples?.some((value) => !Number.isSafeInteger(value)))) invalid('counter-method', at, 'Byte/count values are safe integers with application-counter method and no clock');
    if (!counter && observation.clockId === null) invalid('clock', at, 'Elapsed times require a declared clock context');
    if (metric === 'frameMs' && observation.method !== 'raf-interval') invalid('frame-method', at, 'Frame callbacks measure elapsed intervals, not physical presentation');
    if (!counter && metric !== 'frameMs' && !['sortMs', 'rasterMs', 'gpuUploadMs', 'queryMs', 'readbackMs', 'publicationMs'].includes(metric) && observation.method !== 'monotonic-cpu') invalid('timing-method', at, 'This metric requires monotonic CPU elapsed time');
    if (['sortMs', 'rasterMs', 'gpuUploadMs', 'queryMs', 'readbackMs', 'publicationMs'].includes(metric) && !['gpu-timestamp', 'queue-wall', 'monotonic-cpu'].includes(observation.method)) invalid('timing-method', at, 'GPU-related times need an explicit elapsed/timestamp method');
    if (observation.method === 'gpu-timestamp' && observation.samples !== null && (!cell.environment.adapterFeatures.includes('timestamp-query') || !cell.environment.enabledFeatures.includes('timestamp-query') || !observation.clockId?.startsWith('gpu:'))) invalid('timestamp-feature', at, 'GPU execution measurements need advertised/requested timestamp-query and GPU clock');
    if (metric === 'operationSettledMs' || metric === 'resourceRetiredMs') {
      exact(observation.clockId, attempt.clock.id, `${at}.clockId`);
      const elapsed = metric === 'operationSettledMs' ? attempt.operationSettledAtMs - attempt.startedAtMs : attempt.resourcesRetiredAtMs === null ? null : attempt.resourcesRetiredAtMs - attempt.startedAtMs;
      exact(observation.samples, elapsed === null ? null : [elapsed], `${at}.samples`);
    }
    if (metric === 'postCloseLedgerBytes' && attempt.status === 'completed') exact(observation.samples, attempt.memory.filter((entry) => entry.point === 'post-close').map((entry) => entry.observations.ledgerLive.bytes), `${at}.samples`);
    if (['pendingGpuOwners', 'pendingBlobOwners', 'pendingReadOwners'].includes(metric) && attempt.status === 'completed') {
      const key = metric === 'pendingGpuOwners' ? 'gpuOwners' : metric === 'pendingBlobOwners' ? 'blobOwners' : 'readOwners';
      exact(observation.samples, attempt.memory.filter((entry) => entry.point === 'post-close').map((entry) => entry.pendingRetirement[key]), `${at}.samples`);
    }
  }
  function checkCorrectness(cell: CellReport, scenario: Scenario, attempt: Attempt, at: string): void {
    if (attempt.status !== 'completed' && attempt.correctness === null) return;
    const correctness = attempt.correctness;
    if (!correctness) { invalid('missing-correctness', at, 'Completed attempt requires an independent oracle'); return; }
    const selection = scenario.kind.startsWith('selection-') ? target.selectionCases.find((entry) => entry.id === scenario.caseId) : undefined;
    const exporting = scenario.kind === 'export' ? target.exportCases.find((entry) => entry.id === scenario.caseId) : undefined;
    const expectedOracle = scenario.kind.startsWith('selection-') ? 'source-mask' : scenario.kind === 'export' ? 'export' : scenario.kind === 'retention' ? 'cycle' : 'scene';
    const hash = selection ? selection.expectedMaskSha256 : exporting ? exporting.expectedOutputSha256 : cell.fixture.expectedSceneSha256;
    const count = selection?.expectedSelectedCount ?? exporting?.expectedRecordCount ?? cell.fixture.loadedCount;
    exact(correctness.oracle, expectedOracle, `${at}.correctness.oracle`);
    exact(correctness.expectedSha256, hash, `${at}.correctness.expectedSha256`); exact(correctness.expectedCount, count, `${at}.correctness.expectedCount`);
    exact(correctness.capturedRevision, exporting?.capturedRevision ?? null, `${at}.correctness.capturedRevision`);
    if (exporting) {
      if (correctness.membershipSha256 !== exporting.membership.expectedMembershipSha256) gate('correctness-failed', `${at}.correctness.membershipSha256`, 'Independent scope membership oracle failed');
    } else exact(correctness.membershipSha256, null, `${at}.correctness.membershipSha256`);
    if (exporting?.precision.mode === 'bounded') {
      const numeric = correctness.numericOracle;
      if (!numeric) invalid('numeric-oracle', at, 'Bounded export needs independent raw numeric comparison values');
      else {
        exact(numeric.oracleSha256, exporting.precision.oracleSha256, `${at}.correctness.numericOracle.oracleSha256`);
        unique(numeric.values, (entry) => entry.id, `${at}.correctness.numericOracle.values`);
        exactSet(numeric.values.map((entry) => entry.id), exporting.precision.components.map((entry) => entry.id), `${at}.correctness.numericOracle.values`);
        let error = 0;
        for (const component of exporting.precision.components) {
          const observed = numeric.values.find((entry) => entry.id === component.id);
          if (observed) error = Math.max(error, Math.abs(observed.actual - component.expected));
        }
        exact(correctness.absoluteError, error, `${at}.correctness.absoluteError`);
        if (error > exporting.precision.absoluteTolerance) gate('correctness-failed', `${at}.correctness`, 'Independent bounded numeric error exceeds tolerance');
      }
    } else {
      exact(correctness.numericOracle, null, `${at}.correctness.numericOracle`);
      if (correctness.absoluteError !== 0) gate('correctness-failed', `${at}.correctness`, 'Exact comparison cannot substitute nonzero numeric error');
    }
    if ((hash !== null && correctness.actualSha256 !== hash) || correctness.actualCount !== count) gate('correctness-failed', `${at}.correctness`, 'Independent output/membership oracle failed');
  }
}
