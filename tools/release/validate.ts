import path from 'node:path';
import { canonicalJson } from '../web-build.mjs';
import { validateBenchmark } from '../bench/validate.ts';
import { assertShape, shapeIssues } from './schema.ts';
import { uniquePaths, Workspace } from './files.ts';
import { inspectLedger } from './ledger.ts';
import { inspectShipping, sameRecords } from './shipping.ts';
import { inspectTestReport } from './reports.ts';
import { inspectFixtureCaseAttachments, inspectGenuineFixtures } from './fixtures.ts';
import type { Applicability, CapabilityLedger, EvidenceResult, ExpectedInventory, FileRef, ReleaseBundle, ReleaseRequest, ReportExpectation, SourceCapture, TerminalReceipt } from './types.ts';

const equal = (left: unknown, right: unknown): boolean => canonicalJson(left) === canonicalJson(right);
const demand = (value: unknown, reason: string): void => { if (!value) throw new Error(reason); };
const sameSet = (left: readonly string[], right: readonly string[]): boolean => left.length === right.length && [...left].sort().join('\0') === [...right].sort().join('\0');
export function argumentOption(arguments_: readonly string[], name: string): string | null {
  const values: string[] = [];
  for (let i = 0; i < arguments_.length; i++) { if (arguments_[i] === name) { demand(i + 1 < arguments_.length, `Missing ${name} value`); values.push(arguments_[++i]!); } else if (arguments_[i]!.startsWith(name + '=')) values.push(arguments_[i]!.slice(name.length + 1)); }
  demand(values.length <= 1, `Repeated ${name} option`); return values[0] ?? null;
}
export async function inspectTerminal(workspace: Workspace, reference: FileRef, expectation?: ReportExpectation): Promise<TerminalReceipt> {
  const raw = await workspace.json(reference);
  demand(raw && typeof raw === 'object' && !Array.isArray(raw), 'Terminal is not an object');
  const value = raw as TerminalReceipt;
  const expectedKeys = ['schemaVersion', 'kind', 'workingDirectory', 'executable', 'arguments', 'startedAtUtc', 'finishedAtUtc', 'exitCode', 'exception', 'log', 'report', 'browserOutputDirectory', 'lastRun'];
  demand(sameSet(Object.keys(value), expectedKeys), 'Terminal fields differ from observed runner contract');
  demand(value.schemaVersion === 1 && value.kind === 'observed-local-command-terminal', 'Wrong terminal receipt kind/version');
  demand(typeof value.workingDirectory === 'string' && path.resolve(value.workingDirectory) === workspace.root, 'Terminal working directory differs');
  demand(typeof value.executable === 'string' && path.isAbsolute(value.executable) && Array.isArray(value.arguments) && value.arguments.every(argument => typeof argument === 'string'), 'Invalid terminal executable/arguments');
  const start = Date.parse(value.startedAtUtc), finish = Date.parse(value.finishedAtUtc);
  demand(Number.isFinite(start) && Number.isFinite(finish) && start <= finish && /(?:Z|\+00:00)$/u.test(value.startedAtUtc) && /(?:Z|\+00:00)$/u.test(value.finishedAtUtc), 'Invalid terminal interval');
  demand((value.exitCode === null || Number.isSafeInteger(value.exitCode)) && (value.exception === null || typeof value.exception === 'string' || typeof value.exception === 'object'), 'Invalid terminal outcome');
  demand(typeof value.browserOutputDirectory === 'string', 'Invalid terminal browser output directory');
  for (const field of ['log', 'report', 'lastRun'] as const) if (value[field] !== null) {
    const record = value[field]!;
    demand(record && Object.keys(record).sort().join('|') === 'bytes|path|sha256' && typeof record.path === 'string' && Number.isSafeInteger(record.bytes) && record.bytes >= 0 && /^[0-9a-f]{64}$/u.test(record.sha256), `Invalid terminal ${field} reference`);
    await workspace.read(record.path, record);
  }
  const executable = workspace.normalize(value.executable); await workspace.read(executable, expectation?.command.executable);
  if (expectation) {
    demand(executable === expectation.command.executable.path && equal(value.arguments, expectation.command.arguments), 'Terminal executable/command differs from external expected command');
    demand(equal(value.report, expectation.report), 'Terminal report differs from external expected report');
    demand(value.log !== null, 'Test transcript log missing');
    if (expectation.adapter === 'playwright') {
      demand(expectation.outputDirectory !== null && value.browserOutputDirectory === expectation.outputDirectory, 'Terminal browser output directory differs');
      const output = argumentOption(value.arguments, '--output');
      demand(output !== null && workspace.normalize(output) === expectation.outputDirectory, 'Actual --output differs from terminal/expected output directory');
    } else {
      demand(value.browserOutputDirectory === '' && expectation.outputDirectory === null && expectation.outputFiles.length === 0, 'Vitest evidence has browser output ownership');
      const report = argumentOption(value.arguments, '--outputFile');
      demand(report !== null && workspace.normalize(report) === expectation.report.path, 'Actual Vitest --outputFile differs');
    }
  }
  return value;
}
async function applicability(workspace: Workspace, value: Applicability, current: SourceCapture, requiredInputs: readonly FileRef[]): Promise<void> {
  const observed = await workspace.json(value.observedSourceCapture); assertShape<SourceCapture>('SourceCapture', observed);
  for (const group of ['applicationInputs', 'nativeFiles', 'distribution', 'coveredInputs'] as const) uniquePaths(observed[group], 'observed ' + group);
  demand(observed.appInputId === value.observedAppInputId && observed.deploymentId === value.observedDeploymentId, 'Observed applicability identity differs from frozen capture');
  uniquePaths(value.coveredInputs, 'applicability covered input'); uniquePaths(requiredInputs, 'expected covered input');
  demand(sameRecords(value.coveredInputs, requiredInputs), 'Applicability coverage differs from external expected coverage');
  const observedRows = [...observed.applicationInputs, ...observed.nativeFiles, ...observed.coveredInputs];
  const currentRows = [...current.applicationInputs, ...current.nativeFiles, ...current.coveredInputs];
  demand(requiredInputs.length > 0, 'Empty source applicability coverage');
  for (const row of requiredInputs) {
    demand(observedRows.some(item => equal(item, row)) && currentRows.some(item => equal(item, row)), 'Covered source input changed or missing from executed/current capture: ' + row.path);
    await workspace.read(row.path, row);
  }
  if (value.kind === 'exact') demand(value.review === null && value.observedAppInputId === current.appInputId && value.observedDeploymentId === current.deploymentId && sameRecords(observed.applicationInputs, current.applicationInputs) && sameRecords(observed.nativeFiles, current.nativeFiles) && sameRecords(observed.distribution, current.distribution), 'Exact evidence source/build differs');
  else {
    demand(value.review && Number.isFinite(Date.parse(value.review.atUtc)) && value.review.identity.trim() && value.review.reason.trim(), 'Missing explicit unchanged-input review attribution');
    demand(value.observedAppInputId !== current.appInputId || value.observedDeploymentId !== current.deploymentId || !sameRecords(observed.coveredInputs, current.coveredInputs), 'Unchanged-input review used where exact applicability is available');
  }
}
export async function validateRelease(workspace: Workspace, requestRef: FileRef, unknownRequest?: unknown): Promise<ReleaseBundle> {
  const raw = unknownRequest ?? await workspace.json(requestRef); assertShape<ReleaseRequest>('ReleaseRequest', raw); const request = raw;
  const issues: string[] = [], pending: string[] = [];
  const evidence: EvidenceResult[] = [];
  const bundle: ReleaseBundle = { schemaVersion: 1, kind: 'splatview-release-evidence', request: requestRef, id: request.id, observedAtUtc: new Date().toISOString(), valid: false, boundedAccepted: false, fullEditorAccepted: false, status: 'invalid', shipping: null, ledger: request.ledger, expectedInventory: request.expectedInventory, evidence, cells: [], acceptedCells: [], pendingCells: [], issues, pending, claims: request.claims, review: request.review, limitations: ['JSON/file consistency is not cryptographic execution, human approval, hardware, or fixture-origin attestation.', 'Dedicated Mac/Safari/VoiceOver hardware is optional and never a required gate.', 'Native/format/visual/manual/HTTPS adapters remain explicit pending gates; opaque passed receipts cannot qualify them.', 'Fixture qualification is limited to hash-bound genuine local A/B/C cohorts, reviewed unchanged covered inputs and actual per-case host observations; it does not establish deployed HTTPS behavior.', 'Benchmark validation establishes JSON consistency only; no capacity or supported operating budget is inferred.'] };
  try {
    demand(Number.isFinite(Date.parse(request.review.atUtc)), 'Invalid review attribution time');
    const ledgerValue = await workspace.json(request.ledger); assertShape<CapabilityLedger>('CapabilityLedger', ledgerValue);
    const ledger = ledgerValue; const cells = await inspectLedger(workspace, ledger);
    const shipping = await inspectShipping(workspace, request.shipping);
    bundle.shipping = { appInputId: shipping.descriptor.appInputId, deploymentId: shipping.manifest.deploymentId, manifest: request.shipping.manifest, sourceCapture: request.shipping.sourceCapture, distribution: request.shipping.distribution };
    const inventoryValue = await workspace.json(request.expectedInventory); assertShape<ExpectedInventory>('ExpectedInventory', inventoryValue); const inventory = inventoryValue;
    demand(new Set(inventory.suites.map(suite => suite.id)).size === inventory.suites.length, 'Duplicate expected suite ID');
    demand(new Set(request.evidence.map(row => row.id)).size === request.evidence.length, 'Duplicate evidence ID');
    demand(new Set(request.requestedCells).size === request.requestedCells.length && request.requestedCells.every(id => cells.some(cell => cell.id === id)), 'Unknown/duplicate requested cells');
    demand(new Set(request.bindings.map(row => row.cellId)).size === request.bindings.length, 'Duplicate cell binding');
    demand(request.claims.budgets.length === 0, 'Operating budgets require a capacity-qualified collector contract; current benchmark validator explicitly cannot establish capacity');
    const usedExpectations = new Set<string>();
    for (const item of request.evidence) {
      const result: EvidenceResult = { id: item.id, kind: item.kind, valid: true, qualified: false, issues: [], pending: [], caseIds: [], configurationIds: [], references: [], leaves: [] }; evidence.push(result);
      try {
        if (item.kind === 'pending') { result.pending.push(`${item.pendingKind}: ${item.reason}`); continue; }
        if (item.kind === 'benchmark') {
          const terminal = await inspectTerminal(workspace, item.terminal);
          demand(terminal.exception === null && (terminal.exitCode === 0 || terminal.exitCode === 2) && equal(terminal.report, item.report), 'Benchmark terminal/report mismatch');
          await applicability(workspace, item.applicability, shipping.source, item.applicability.coveredInputs);
          const report = await workspace.json(item.report), target = await workspace.json(item.target), build = await workspace.json(item.expectedBuild);
          const expectedBuild = { appSha256: shipping.descriptor.appInputId, deploymentSha256: shipping.manifest.deploymentId, coreSha256: request.shipping.nativeFiles.find(row => row.path.endsWith('/splatview-core.wasm'))!.sha256, cameraSha256: request.shipping.nativeFiles.find(row => row.path.endsWith('/splatview-camera.wasm'))!.sha256, protocol: shipping.descriptor.protocolVersion, uiWorker: shipping.descriptor.uiWorkerContract };
          demand(equal(build, expectedBuild), 'Externally mapped benchmark expected build differs from shipping hashes');
          const validation = validateBenchmark(report, target, { targetSha256: item.target.sha256, build: expectedBuild });
          demand(validation.valid, 'Benchmark packet invalid: ' + validation.issues.filter(issue => issue.level === 'invalid').map(issue => issue.message).join('; '));
          result.pending.push(...validation.issues.filter(issue => issue.level === 'gate').map(issue => issue.message), 'Benchmark JSON consistency does not prove a genuine production collector/raw observation contract');
          result.references.push(item.terminal, item.report, item.target, item.expectedBuild); continue;
        }
        const expectation = inventory.suites.find(suite => suite.id === item.expectationId);
        demand(expectation && expectation.adapter === item.kind && !usedExpectations.has(item.expectationId), 'Missing/wrong/reused external suite expectation'); usedExpectations.add(item.expectationId);
        const expected = expectation!; uniquePaths(expected.files.map(file => ({ path: file.path, bytes: 0, sha256: '0'.repeat(64) })), 'expected suite source');
        demand(expected.files.length > 0 && expected.files.every(file => file.leaves.length > 0 && expected.coveredInputs.some(row => row.path === file.path)), 'Expected suites empty or missing covered source');
        await applicability(workspace, item.applicability, shipping.source, expected.coveredInputs);
        const terminal = await inspectTerminal(workspace, item.terminal, expected);
        const report = await workspace.json(expected.report);
        demand(item.fixtureSet ? item.kind === 'playwright' && item.fixtureApplicability : item.fixtureApplicability === undefined || item.fixtureApplicability === null, 'Fixture evidence requires an explicit applicability policy; non-fixture evidence cannot name one');
        const fixture = item.fixtureSet ? await inspectGenuineFixtures(workspace, item.fixtureSet, item.fixtureApplicability!, { evidence: item, expectation: expected, shipping: shipping.source, descriptor: shipping.descriptor }) : undefined;
        if (expected.requiredAttachments.some(row => row.fixtureSetId !== null)) demand(fixture, 'Required genuine fixture-set receipt absent');
        const inspection = await inspectTestReport(item.kind, report, expected, { normalizePath: (input, base) => workspace.normalize(input, base), readAttachment: input => workspace.read(input), ...(fixture ? { fixtureSet: fixture } : {}) });
        result.leaves = inspection.leaves;
        demand(inspection.valid, inspection.issues.join('; '));
        if (fixture) { await inspectFixtureCaseAttachments(workspace, report, expected, fixture); result.references.push(...fixture.references); }
        if (terminal.exitCode !== 0 || terminal.exception !== null) result.pending.push('Observed test terminal did not exit successfully');
        result.pending.push(...inspection.pending);
        if (item.kind === 'playwright') {
          demand(expected.outputDirectory !== null && inspection.outputDirectories.length > 0 && inspection.outputDirectories.every(directory => workspace.normalize(directory) === expected.outputDirectory), 'Report-configured output directory differs from terminal/--output');
          uniquePaths(expected.outputFiles, 'expected browser output');
          demand(sameRecords(await workspace.inventory(expected.outputDirectory!), expected.outputFiles), 'Browser output inventory differs from exact allowed leaves');
          if (terminal.lastRun) demand(expected.outputFiles.some(row => equal(row, terminal.lastRun)), 'Last-run receipt is outside owned output inventory');
        }
        result.caseIds = inspection.leaves.map(leaf => item.kind === 'vitest' ? `${leaf.file}::${leaf.id}` : `${leaf.project}::${leaf.id}`);
        demand(new Set(result.caseIds).size === result.caseIds.length, 'Duplicate globally qualified case keys');
        result.qualified = result.pending.length === 0;
        result.references.push(item.terminal, expected.report, expected.command.executable, ...expected.coveredInputs, ...expected.outputFiles, ...(item.fixtureSet ? [item.fixtureSet] : []));
      } catch (error) { result.valid = false; result.issues.push(error instanceof Error ? error.message : String(error)); }
    }
    demand(usedExpectations.size === inventory.suites.length, 'Unused expected suite inventory');
    issues.push(...evidence.flatMap(row => row.issues.map(issue => `${row.id}: ${issue}`)));
    for (const binding of request.bindings) {
      const cell = cells.find(row => row.id === binding.cellId), observed = evidence.find(row => row.id === binding.evidenceId);
      demand(cell && observed && request.requestedCells.includes(binding.cellId), 'Binding names unknown/unrequested cell or evidence');
      const source = request.evidence.find(row => row.id === binding.evidenceId)!;
      demand((source.kind === 'pending' ? source.pendingKind : source.kind) === cell!.kind, 'Evidence adapter differs from required cell kind');
      demand(sameSet(binding.caseIds, cell!.requiredCaseIds), 'Binding case inventory differs from external ledger required cases');
      demand(binding.caseIds.every(id => observed!.caseIds.includes(id)) || source.kind === 'pending', 'Binding claims cases outside actual evidence');
    }
    for (const cell of cells) {
      const binding = request.bindings.find(row => row.cellId === cell.id), result = binding ? evidence.find(row => row.id === binding.evidenceId) : undefined;
      const capability = ledger.capabilities.find(row => row.requiredCells.some(item => item.id === cell.id));
      const complete = capability === undefined || capability.implementation === 'implemented';
      const qualified = Boolean(binding && result?.qualified && result.valid && complete && cell.requiredCaseIds.length && cell.configurationIds.every(id => result.configurationIds.includes(id)));
      bundle.cells.push({ id: cell.id, kind: cell.kind, status: qualified ? 'qualified' : 'pending', evidenceId: binding?.evidenceId ?? null, reason: qualified ? 'All externally required cases, source bindings, terminal/report/output checks matched' : !complete ? 'Retained implementation is incomplete' : cell.requiredCaseIds.length === 0 ? 'Required concrete evidence cases have not been declared' : result?.pending.join('; ') || 'Required current evidence or configuration is missing' });
    }
    for (const id of request.claims.configurations) demand(bundle.cells.some(cell => cell.status === 'qualified' && cells.find(row => row.id === cell.id)!.configurationIds.includes(id)), 'Unsupported configuration claim: ' + id);
    bundle.acceptedCells = bundle.cells.filter(row => row.status === 'qualified').map(row => row.id);
    bundle.pendingCells = bundle.cells.filter(row => row.status === 'pending').map(row => row.id);
    pending.push(...bundle.cells.filter(row => row.status === 'pending').map(row => `${row.id}: ${row.reason}`));
    bundle.valid = issues.length === 0;
    bundle.boundedAccepted = bundle.valid && request.requestedCells.length > 0 && request.requestedCells.every(id => bundle.acceptedCells.includes(id));
    if (!ledger.gates.some(cell => cell.kind === 'playwright') || !ledger.gates.some(cell => cell.kind === 'https')) pending.push('Full-editor qualification requires explicit browser-workflow and deployed-HTTPS gates');
    bundle.fullEditorAccepted = request.mode === 'full-editor' && bundle.valid && bundle.pendingCells.length === 0 && cells.length > 0 && pending.length === 0 && sameSet(request.requestedCells, cells.map(cell => cell.id));
    bundle.status = bundle.fullEditorAccepted ? 'accepted' : bundle.valid ? 'pending' : 'invalid';
  } catch (error) { issues.push(error instanceof Error ? error.message : String(error)); bundle.valid = false; bundle.status = 'invalid'; }
  const outputIssues = shapeIssues('ReleaseBundle', bundle); if (outputIssues.length) throw new Error('Internal bundle contract: ' + outputIssues.join('; '));
  return bundle;
}
