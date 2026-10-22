/** Version one tooling contract. These types describe observations, never supported budgets. */
export type Hash = string;
export type ScenarioKind = 'open-cold' | 'open-warm' | 'orbit' | 'selection-cold' | 'selection-warm' | 'export' | 'retention';
export type EvidenceClass = 'synthetic-tooling' | 'local-chromium' | 'actual-mac';
export type Status = 'completed' | 'failed' | 'refused' | 'cancelled';
export type Method = 'monotonic-cpu' | 'raf-interval' | 'queue-wall' | 'gpu-timestamp' | 'application-counter';
export type Unit = 'ms' | 'bytes' | 'count';

export interface BuildIdentity {
  appSha256: Hash;
  coreSha256: Hash;
  cameraSha256: Hash;
  deploymentSha256: Hash;
  protocol: number;
  uiWorker: number;
}
export interface FixtureIdentity {
  id: string;
  inputSha256: Hash;
  manifestSha256: Hash;
  sourceOrderSha256: Hash;
  distributionSha256: Hash;
  expectedSceneSha256: Hash;
  sourceCount: number;
  loadedCount: number;
  shDegree: 0 | 3;
  overdraw: 'low' | 'high';
}
export interface TraceIdentity {
  id: string;
  sha256: Hash;
  projectionSha256: Hash;
  warmupMs: number;
  durationMs: number;
  idleHiddenMs: number;
}
export interface Framebuffer {
  id: string;
  kind: 'standard' | 'retina';
  cssWidth: number;
  cssHeight: number;
  width: number;
  height: number;
  dpr: number;
}
export interface CellIdentity {
  id: string;
  machineId: string;
  browserId: string;
  fixtureId: string;
  traceId: string;
  framebufferId: string;
}
export interface SelectionCase {
  id: string;
  fixtureId: string;
  kind: 'pick' | 'query' | 'amendment';
  parametersSha256: Hash;
  expectedMaskSha256: Hash;
  expectedSelectedCount: number;
}
export interface ExportCase {
  id: string;
  fixtureId: string;
  format: string;
  scope: 'all' | 'selected' | 'remainder';
  parametersSha256: Hash;
  capturedRevision: number;
  expectedOutputSha256: Hash | null;
  expectedRecordCount: number;
  membership: { loadedCount: number; selectedCount: number; deletedCount: number; selectedDeletedCount: number; expectedMembershipSha256: Hash };
  precision: { mode: 'exact' | 'bounded'; absoluteTolerance: number; oracleSha256: Hash; components: { id: string; unit: string; expected: number }[] };
}
export interface Threshold {
  cellId: string;
  scenarioId: string;
  metric: string;
  statistic: 'p50' | 'p95';
  unit: Unit;
  maximum: number;
}
export interface MemoryCeiling {
  cellId: string;
  point: MemorySnapshot['point'];
  category: MemoryCategory;
  maximumBytes: number;
}
export interface BenchmarkTarget {
  schemaVersion: 1;
  id: string;
  scope: 'tooling-only' | 'w09-initial';
  status: 'pending' | 'approved';
  machines: { id: string; tier: 'minimum' | 'newer' }[];
  browsers: { id: string; family: 'Safari' | 'Chrome' }[];
  fixtures: FixtureIdentity[];
  traces: TraceIdentity[];
  framebuffers: Framebuffer[];
  cells: CellIdentity[];
  selectionCases: SelectionCase[];
  exportCases: ExportCase[];
  thresholds: Threshold[] | null;
  memoryCeilings: MemoryCeiling[] | null;
}
export interface Environment {
  machineId: string;
  browserId: string;
  osFamily: 'macOS' | 'Windows' | 'Linux';
  osVersion: string;
  machineModel: string;
  ramBytes: number;
  browserFamily: 'Safari' | 'Chrome';
  browserVersion: string;
  adapterName: string;
  adapterFeatures: string[];
  enabledFeatures: string[];
  deviceLimits: Record<string, number>;
  powerMode: string;
  cachePolicy: string;
  resolutionPolicy: 'fixed';
  crossOriginIsolated: boolean;
  sharedArrayBufferAvailable: boolean;
  framebuffer: Framebuffer;
}
export interface Measurement {
  unit: Unit;
  method: Method;
  clockId: string | null;
  samples: number[] | null;
  sampleCount: number;
  unavailableReason: string | null;
}
export interface MetricSummary {
  sampleCount: number;
  unavailableAttempts: number;
  percentileMethod: 'linear-r7';
  p50: number | null;
  p95: number | null;
}
export interface MemoryObservation {
  bytes: number | null;
  unavailableReason: string | null;
  method: 'logical-ledger' | 'native-summary' | 'wasm-memory-buffer' | 'js-heap-estimate' | 'os-process-sample' | 'driver-observation';
  processIds: number[];
  samplingIntervalMs: number | null;
  attachmentSha256: Hash | null;
}
export const MEMORY_CATEGORIES = [
  'ledgerLive', 'ledgerPeak', 'nativeLivePayload', 'wasmLinearCapacity', 'wasmLinearHighWater',
  'jsHeapEstimate', 'browserProcess', 'workerProcess', 'gpuDriver',
] as const;
export type MemoryCategory = typeof MEMORY_CATEGORIES[number];
export interface MemorySnapshot {
  point: 'baseline' | 'load-peak' | 'edit-peak' | 'export-peak' | 'capture-peak' | 'post-close' | 'final-cycle';
  observations: Record<MemoryCategory, MemoryObservation>;
  pendingRetirement: { gpuOwners: number; blobOwners: number; readOwners: number };
}
export interface Attempt {
  id: string;
  status: Status;
  reason: string | null;
  retryOf: string | null;
  clock: { id: string; method: 'performance.now'; unit: 'ms' };
  startedAtMs: number;
  operationSettledAtMs: number;
  resourcesRetiredAtMs: number | null;
  retirementUnavailableReason: string | null;
  retirementMeaning: 'application-owner-joined';
  warmupMs: number;
  idleHiddenMs: number;
  measurements: Record<string, Measurement>;
  correctness: {
    oracle: 'scene' | 'source-mask' | 'export' | 'cycle';
    expectedSha256: Hash | null;
    actualSha256: Hash;
    expectedCount: number;
    actualCount: number;
    capturedRevision: number | null;
    membershipSha256: Hash | null;
    numericOracle: { oracleSha256: Hash; values: { id: string; actual: number }[] } | null;
    absoluteError: number;
  } | null;
  memory: MemorySnapshot[];
}
export interface Scenario {
  id: string;
  kind: ScenarioKind;
  caseId: string | null;
  parametersSha256: Hash;
  attempts: Attempt[];
  counts: { total: number; completed: number; failed: number; refused: number; cancelled: number };
  summaries: Record<string, MetricSummary>;
}
export interface CellReport {
  identity: CellIdentity;
  fixture: FixtureIdentity;
  trace: TraceIdentity;
  environment: Environment;
  overdrawCheckpoints: { traceTimeMs: number; visibleProjectedSplats: number; footprintAreaRatio: number; coveredPixelFraction: number; overlapP50: number; overlapP95: number }[];
  scenarios: Scenario[];
}
export interface BenchmarkReport {
  schemaVersion: 1;
  runId: string;
  startedAtUtc: string;
  endedAtUtc: string;
  evidenceClass: EvidenceClass;
  purpose: 'w09-initial-baseline';
  target: { id: string; sha256: Hash };
  build: BuildIdentity;
  cells: CellReport[];
}
/** V2 qualifies only these declared observations; v1 retains its historical Mac matrix. */
export interface ObservedEnvironment extends Environment {
  browserHost: 'automation' | 'normal-launch';
}
export type ObservedHost = Omit<ObservedEnvironment, 'framebuffer'>;
export interface ObservedBenchmarkTarget extends Omit<BenchmarkTarget, 'schemaVersion' | 'scope' | 'machines'> {
  schemaVersion: 2;
  scope: 'observed-browser-initial';
  machines: { id: string; tier: 'observed' }[];
  observedHosts: ObservedHost[];
}
export interface ObservedCellReport extends Omit<CellReport, 'environment'> { environment: ObservedEnvironment }
export interface ObservedBenchmarkReport extends Omit<BenchmarkReport, 'schemaVersion' | 'purpose' | 'evidenceClass' | 'cells'> {
  schemaVersion: 2;
  purpose: 'observed-browser-initial-baseline';
  evidenceClass: EvidenceClass | 'observed-browser';
  cells: ObservedCellReport[];
}
export type BenchmarkTargetPacket = BenchmarkTarget | ObservedBenchmarkTarget;
export type BenchmarkReportPacket = BenchmarkReport | ObservedBenchmarkReport;
/** Caller pins target bytes and current build externally; report self-assertions are insufficient. */
export interface ExpectedPacket { targetSha256: Hash; build: BuildIdentity }
export interface ValidationIssue { level: 'invalid' | 'gate'; code: string; path: string; message: string }
export interface ValidationResult {
  valid: boolean;
  accepted: boolean;
  scope: 'w09-initial-only' | 'observed-browser-initial-only';
  sustainedQualified: false;
  /** Present only for accepted v2 observations. This is not hardware attestation. */
  observedScope?: { cellIds: string[]; hosts: ObservedHost[]; capacityQualified: false };
  issues: ValidationIssue[];
  cellCount: number;
  completedAttempts: number;
}
