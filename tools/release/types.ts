/** Release tooling contracts. Hashes bind observations; reviewer names are attribution only. */
export interface FileRef { path: string; bytes: number; sha256: string }
export type EvidenceKind = 'vitest' | 'playwright' | 'native' | 'format' | 'visual' | 'manual' | 'https' | 'benchmark';
export interface RequiredCell { id: string; kind: EvidenceKind; scope: string; configurationIds: string[]; requiredCaseIds: string[] }
export interface Capability {
  id: string; desktopFeature: string; scope: 'retained' | 'excluded';
  implementation: 'implemented' | 'partial' | 'planned' | 'excluded';
  requiredCells: RequiredCell[]; approvedDifferenceIds: string[]; exclusionReason: string | null;
}
export interface CapabilityLedger {
  schemaVersion: 1; kind: 'splatview-capability-ledger';
  desktopContract: { revision: string; capture: FileRef };
  sourceFeatureLedger: FileRef; capabilityInventory: FileRef;
  capabilities: Capability[]; gates: RequiredCell[];
  differences: { id: string; description: string; reason: string }[];
}
export interface SourceCapture {
  schemaVersion: 1; kind: 'splatview-release-source-capture';
  appInputId: string; deploymentId: string;
  applicationInputs: FileRef[]; nativeFiles: FileRef[]; distribution: FileRef[]; coveredInputs: FileRef[];
}
export interface Shipping {
  sourceCapture: FileRef; applicationInputs: FileRef[]; nativeFiles: FileRef[];
  distribution: FileRef[]; manifest: FileRef;
}
/** The expected file/leaf inventory is a separately hash-bound input, never inferred from a report. */
export interface ReportExpectation {
  id: string; adapter: 'vitest' | 'playwright';
  command: { executable: FileRef; arguments: string[]; workingDirectory: '.' }; report: FileRef; coveredInputs: FileRef[];
  files: { path: string; leaves: { id: string; title: string; project: string }[] }[];
  outputDirectory: string | null; outputFiles: FileRef[];
  requiredAttachments: { caseId: string; project: string; name: string; sha256: string | null; fixtureSetId: string | null }[];
}
export interface ExpectedInventory {
  schemaVersion: 1; kind: 'splatview-release-expected-inventory'; suites: ReportExpectation[];
}
export interface Applicability {
  kind: 'exact' | 'unchanged-covered-inputs';
  observedAppInputId: string; observedDeploymentId: string;
  observedSourceCapture: FileRef; coveredInputs: FileRef[];
  review: { identity: string; atUtc: string; reason: string } | null;
}
export interface TestEvidence {
  id: string; kind: 'vitest' | 'playwright'; terminal: FileRef; expectationId: string;
  applicability: Applicability; fixtureSet: FileRef | null;
  /** Required for fixture-bearing packets; omitted/null preserves older non-fixture requests. */
  fixtureApplicability?: FileRef | null;
}
export interface SourceInventory { sha256: string; files: number; bytes: number; inventory: FileRef[] }
export interface FixtureApplicability {
  schemaVersion: 1; kind: 'splatview-offline-fixture-applicability'; fixtureSet: FileRef;
  observedSourceCapture: FileRef; currentSourceInventory: FileRef; coveredInputs: FileRef[];
  differences: { path: string; before: { bytes: number; sha256: string } | null; after: { bytes: number; sha256: string } | null; reason: string }[];
  tools: { node: { recordedPath: string; artifact: FileRef }; npm: { recordedPath: string; artifact: FileRef }; python: { recordedPath: string; artifact: FileRef } };
  hostOrigin: string; review: { identity: string; atUtc: string; reason: string };
}
export interface BenchmarkEvidence {
  id: string; kind: 'benchmark'; report: FileRef; target: FileRef; expectedBuild: FileRef;
  applicability: Applicability; terminal: FileRef;
}
/** Adapters without a reproducible contract stay pending; an opaque status cannot qualify a cell. */
export interface PendingEvidence {
  id: string; kind: 'pending'; pendingKind: EvidenceKind; reason: string;
}
export type Evidence = TestEvidence | BenchmarkEvidence | PendingEvidence;
export interface CellBinding { cellId: string; evidenceId: string; caseIds: string[] }
export interface ReleaseRequest {
  schemaVersion: 1; kind: 'splatview-release-request'; id: string; mode: 'bounded' | 'full-editor';
  ledger: FileRef; shipping: Shipping; expectedInventory: FileRef;
  evidence: Evidence[]; requestedCells: string[]; bindings: CellBinding[];
  claims: { configurations: string[]; budgets: { id: string; benchmarkEvidenceId: string; cellId: string; maximumSceneRecords: number }[] };
  review: { identity: string; atUtc: string; reason: string };
}
export interface TerminalReceipt {
  schemaVersion: 1; kind: 'observed-local-command-terminal'; workingDirectory: string; executable: string;
  arguments: string[]; startedAtUtc: string; finishedAtUtc: string; exitCode: number | null; exception: unknown | null;
  log: FileRef | null; report: FileRef | null; browserOutputDirectory: string; lastRun: FileRef | null;
}
export interface EvidenceResult {
  id: string; kind: Evidence['kind']; valid: boolean; qualified: boolean; issues: string[]; pending: string[];
  caseIds: string[]; configurationIds: string[]; references: FileRef[];
  leaves: { id: string; file: string; title: string; project: string; passed: boolean; attachments: { name: string; contentType: string; bytes: number; sha256: string; path: string | null }[] }[];
}
export interface ReleaseBundle {
  schemaVersion: 1; kind: 'splatview-release-evidence'; request: FileRef; id: string; observedAtUtc: string;
  valid: boolean; boundedAccepted: boolean; fullEditorAccepted: boolean; status: 'invalid' | 'pending' | 'accepted';
  shipping: { appInputId: string; deploymentId: string; manifest: FileRef; sourceCapture: FileRef; distribution: FileRef[] } | null;
  ledger: FileRef; expectedInventory: FileRef; evidence: EvidenceResult[];
  cells: { id: string; kind: EvidenceKind; status: 'qualified' | 'pending'; evidenceId: string | null; reason: string }[];
  acceptedCells: string[]; pendingCells: string[]; issues: string[]; pending: string[];
  claims: ReleaseRequest['claims']; review: ReleaseRequest['review'];
  limitations: string[];
}
