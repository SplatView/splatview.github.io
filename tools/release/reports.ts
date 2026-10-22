import { createHash } from 'node:crypto';
import type { FileRef, ReportExpectation } from './types.ts';

export interface InspectedAttachment {
  name: string;
  contentType: string;
  bytes: number;
  sha256: string;
  /** Null means bytes are embedded in the already-bound report, never a workspace path. */
  path: string | null;
}
export interface InspectedLeaf {
  id: string;
  file: string;
  title: string;
  project: string;
  passed: boolean;
  attachments: InspectedAttachment[];
}
export interface ReportInspection {
  valid: boolean;
  issues: string[];
  /** Missing execution observations cannot qualify evidence even when JSON is consistent. */
  pending: string[];
  leaves: InspectedLeaf[];
  outputDirectories: string[];
}
export interface ReportInspectionContext {
  normalizePath(input: string, base?: string): string;
  readAttachment(path: string): Promise<{ reference: FileRef; bytes: Uint8Array }>;
  fixtureSet?: { reference: FileRef; value: unknown };
}

type Row = Record<string, unknown>;
const object = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const identity = (kind: string, file: string, id: string, project: string): string => JSON.stringify(kind === 'vitest' ? [file, id] : [id, project]);
const same = (left: unknown, right: unknown): boolean => {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => same(value, right[index]));
  if (!object(left) || !object(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && same(left[key], right[key]));
};

/**
 * Inspect already-read report data against an independently pinned case inventory.
 * This verifies report consistency and attachment bytes, not execution authenticity.
 * Terminal/source/build bindings and the complete output tree belong to the caller.
 */
export async function inspectTestReport(kind: 'vitest' | 'playwright', input: unknown, expectation: ReportExpectation, context: ReportInspectionContext): Promise<ReportInspection> {
  const issues: string[] = [], pending: string[] = [], leaves: InspectedLeaf[] = [], directories = new Set<string>();
  let invalid = false;
  const issue = (message: string): void => { invalid = true; if (issues.length < 200) issues.push(message); };
  const finish = (): ReportInspection => ({ valid: !invalid, issues, pending, leaves, outputDirectories: [...directories].sort() });
  const normalize = (value: unknown, label: string, base?: string): string | null => {
    if (!text(value)) { issue(`${label}: missing path`); return null; }
    try {
      const path = context.normalizePath(value, base);
      if (!text(path)) throw new Error('empty normalized path');
      return path;
    } catch (error) { issue(`${label}: unsafe path (${error instanceof Error ? error.message : String(error)})`); return null; }
  };
  const requireCount = (value: unknown, wanted: number, label: string): void => { if (!count(value) || value !== wanted) issue(`${label}: expected ${wanted}`); };
  const emptyErrors = (value: unknown, label: string, required = false): void => {
    if (value === undefined && !required) return;
    if (!Array.isArray(value) || value.length !== 0) issue(`${label}: errors or malformed error array`);
  };
  const checkReference = (reference: FileRef, label: string): string | null => {
    if (!object(reference) || !count(reference.bytes) || typeof reference.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(reference.sha256)) {
      issue(`${label}: malformed file reference`); return null;
    }
    return normalize(reference.path, label);
  };
  if (expectation.adapter !== kind) issue('Expectation adapter does not match report kind');
  const expected = new Map<string, { file: string; id: string; title: string; project: string }>();
  const expectedFiles = new Set<string>();
  for (const file of expectation.files) {
    const path = normalize(file.path, 'Expected source');
    if (path === null) continue;
    if (expectedFiles.has(path)) issue(`Duplicate expected source: ${path}`);
    expectedFiles.add(path);
    if (!file.leaves.length) issue(`Empty expected source: ${path}`);
    for (const leaf of file.leaves) {
      if (!text(leaf.id) || !text(leaf.title) || typeof leaf.project !== 'string') { issue(`Malformed expected leaf: ${path}`); continue; }
      if (kind === 'vitest' && (leaf.project !== '' || leaf.title !== leaf.id)) issue(`Vitest inventory must pin fullName with an empty project: ${path}`);
      const key = identity(kind, path, leaf.id, leaf.project);
      if (expected.has(key)) issue(`Duplicate expected case: ${key}`);
      expected.set(key, { file: path, ...leaf });
    }
  }
  if (!expected.size) issue('Expected case inventory is empty');
  const outputDirectory = expectation.outputDirectory === null ? null : normalize(expectation.outputDirectory, 'Expected output directory');
  const outputFiles = new Map<string, FileRef>();
  for (const reference of expectation.outputFiles) {
    const path = checkReference(reference, 'Expected output file');
    if (path === null) continue;
    if (outputFiles.has(path)) issue(`Duplicate expected output: ${path}`);
    if (outputDirectory === null || !path.startsWith(`${outputDirectory}/`)) issue(`Output file escapes its declared directory: ${path}`);
    outputFiles.set(path, reference);
  }
  if (kind === 'vitest' && (expectation.outputDirectory !== null || expectation.outputFiles.length || expectation.requiredAttachments.length)) issue('Vitest reports cannot declare Playwright outputs or attachments');
  const observed = new Set<string>(), observedFiles = new Set<string>();
  const addLeaf = (leaf: InspectedLeaf): void => {
    const key = identity(kind, leaf.file, leaf.id, leaf.project), pinned = expected.get(key);
    if (observed.has(key)) issue(`Duplicate observed case: ${key}`);
    observed.add(key); observedFiles.add(leaf.file);
    if (!pinned || pinned.file !== leaf.file || pinned.title !== leaf.title || pinned.project !== leaf.project) issue(`Case does not match pinned inventory: ${key}`);
    if (!leaf.passed) issue(`Case did not pass exactly once: ${key}`);
    leaves.push(leaf);
  };
  const fixtureAttachment = (bytes: Uint8Array, requirement: ReportExpectation['requiredAttachments'][number], label: string): void => {
    const fixture = context.fixtureSet;
    if (!fixture || !object(fixture.value) || fixture.value.fixtureSetId !== requirement.fixtureSetId) { issue(`${label}: missing matching fixture-set context`); return; }
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { issue(`${label}: fixture attachment is not UTF-8 JSON`); return; }
    if (!object(value)) { issue(`${label}: fixture attachment is not an object`); return; }
    if (value.fixtureSetId !== requirement.fixtureSetId) issue(`${label}: fixtureSetId differs`);
    for (const key of ['fixtures', 'sourceCapture', 'shippingNativePublication']) {
      if (!Object.hasOwn(value, key) || !Object.hasOwn(fixture.value, key) || !same(value[key], fixture.value[key])) issue(`${label}: ${key} differs from the genuine fixture receipt`);
    }
    if (!object(value.receipt)) { issue(`${label}: fixture receipt reference is missing`); return; }
    const actualPath = normalize(value.receipt.path, `${label} receipt`);
    const wantedPath = checkReference(fixture.reference, `${label} fixture reference`);
    if (actualPath === null || actualPath !== wantedPath || value.receipt.bytes !== fixture.reference.bytes || value.receipt.sha256 !== fixture.reference.sha256) issue(`${label}: fixture receipt path/bytes/hash differs`);
  };
  const attachmentRequirements = new Map<string, ReportExpectation['requiredAttachments']>();
  const requirementIdentities = new Set<string>();
  for (const requirement of expectation.requiredAttachments) {
    const caseKey = identity(kind, '', requirement.caseId, requirement.project);
    const key = JSON.stringify([requirement.caseId, requirement.project, requirement.name]);
    if (requirementIdentities.has(key)) issue(`Duplicate attachment requirement: ${key}`);
    requirementIdentities.add(key);
    if (!expected.has(caseKey)) issue(`Attachment requirement refers to an unpinned case: ${caseKey}`);
    if (!text(requirement.name) || (requirement.sha256 !== null && !/^[a-f0-9]{64}$/.test(requirement.sha256)) || (requirement.fixtureSetId !== null && !text(requirement.fixtureSetId))) issue(`Malformed attachment requirement: ${key}`);
    const requirements = attachmentRequirements.get(caseKey) ?? [];
    requirements.push(requirement); attachmentRequirements.set(caseKey, requirements);
  }
  const inspectAttachments = async (value: unknown, caseId: string, project: string): Promise<InspectedAttachment[]> => {
    const rows: InspectedAttachment[] = [], requirements = attachmentRequirements.get(identity(kind, '', caseId, project)) ?? [];
    const matches = new Map<string, number>();
    if (!Array.isArray(value)) { issue(`Case ${caseId}: attachments must be an array`); return rows; }
    for (let ordinal = 0; ordinal < value.length; ordinal++) {
      const attachment = value[ordinal], label = `Case ${caseId} attachment ${ordinal}`;
      if (!object(attachment) || !text(attachment.name) || !text(attachment.contentType)) { issue(`${label}: malformed attachment`); continue; }
      let bytes: Uint8Array, path: string | null = null;
      const hasPath = Object.hasOwn(attachment, 'path'), hasBody = Object.hasOwn(attachment, 'body');
      if (hasPath === hasBody) { issue(`${label}: requires exactly one path or inline body`); continue; }
      if (hasPath) {
        path = normalize(attachment.path, label);
        if (path === null) continue;
        if (outputDirectory === null || !path.startsWith(`${outputDirectory}/`)) { issue(`${label}: path escapes the declared output directory`); continue; }
        try {
          const read = await context.readAttachment(path), pinned = outputFiles.get(path);
          bytes = read.bytes;
          const observedPath = checkReference(read.reference, label);
          if (!pinned || observedPath !== path || read.reference.bytes !== bytes.byteLength || read.reference.sha256 !== hash(bytes) || pinned.bytes !== read.reference.bytes || pinned.sha256 !== read.reference.sha256) issue(`${label}: attachment bytes/reference/output inventory differ`);
        } catch (error) { issue(`${label}: unreadable attachment (${error instanceof Error ? error.message : String(error)})`); continue; }
      } else {
        if (typeof attachment.body !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(attachment.body)) { issue(`${label}: invalid strict base64 body`); continue; }
        bytes = Buffer.from(attachment.body, 'base64');
        if (Buffer.from(bytes).toString('base64') !== attachment.body) { issue(`${label}: noncanonical base64 body`); continue; }
      }
      const row = { name: attachment.name, contentType: attachment.contentType, bytes: bytes.byteLength, sha256: hash(bytes), path };
      rows.push(row);
      for (const requirement of requirements.filter(required => required.name === row.name)) {
        matches.set(row.name, (matches.get(row.name) ?? 0) + 1);
        if (requirement.sha256 !== null && requirement.sha256 !== row.sha256) issue(`${label}: required attachment hash differs`);
        if (requirement.fixtureSetId !== null) {
          if (row.contentType !== 'application/json') issue(`${label}: fixture attachment content type must be application/json`);
          fixtureAttachment(bytes, requirement, label);
        }
      }
    }
    for (const requirement of requirements) if (matches.get(requirement.name) !== 1) issue(`Case ${caseId}: required attachment ${requirement.name} must occur exactly once`);
    return rows;
  };
  if (!object(input)) { issue('Report must be an object'); return finish(); }
  if (kind === 'vitest') {
    if (input.success !== true) issue('Vitest success must be true');
    emptyErrors(input.errors, 'Vitest errors'); emptyErrors(input.unhandledErrors, 'Vitest unhandledErrors');
    if (input.testExecError !== undefined && input.testExecError !== null) issue('Vitest execution error');
    if (input.snapshot !== undefined) {
      const snapshot = input.snapshot;
      if (!object(snapshot) || snapshot.failure !== false || ['filesRemoved', 'filesUnmatched', 'unmatched', 'unchecked', 'updated', 'added'].some(key => snapshot[key] !== 0) || snapshot.didUpdate === true) issue('Vitest snapshots failed, changed, malformed or remain unchecked');
    }
    if (!Array.isArray(input.testResults)) { issue('Vitest testResults must be an array'); return finish(); }
    let suiteCount = 0, missingDiagnostics = 0;
    const runtimeMarker = input.releaseReporter;
    if (runtimeMarker !== undefined) {
      const keys = ['schemaVersion', 'kind', 'vitestVersion', 'runReason', 'missingDiagnostics'];
      if (!object(runtimeMarker) || Object.keys(runtimeMarker).length !== keys.length || keys.some(key => !Object.hasOwn(runtimeMarker, key))
        || runtimeMarker.schemaVersion !== 1 || runtimeMarker.kind !== 'splatview-vitest-runtime' || !text(runtimeMarker.vitestVersion)
        || runtimeMarker.runReason !== 'passed' || !count(runtimeMarker.missingDiagnostics)) issue('Vitest runtime reporter marker is malformed or the run did not finish passed');
    }
    const fileRows = new Set<string>();
    for (const suite of input.testResults) {
      if (!object(suite)) { issue('Malformed Vitest file suite'); continue; }
      const file = normalize(suite.name, 'Vitest source');
      if (file === null) continue;
      if (fileRows.has(file)) issue(`Duplicate Vitest file suite: ${file}`);
      fileRows.add(file);
      if (!expectedFiles.has(file)) issue(`Unpinned Vitest file suite: ${file}`);
      if (suite.status !== 'passed' || (suite.message !== undefined && suite.message !== '')) issue(`Vitest file suite did not pass cleanly: ${file}`);
      if (suite.testExecError !== undefined && suite.testExecError !== null) issue(`Vitest file execution error: ${file}`);
      if (!Array.isArray(suite.assertionResults) || !suite.assertionResults.length) { issue(`Empty or malformed Vitest file suite: ${file}`); continue; }
      const ancestors = new Set<string>();
      for (const assertion of suite.assertionResults) {
        if (!object(assertion) || !text(assertion.fullName) || !text(assertion.title) || !Array.isArray(assertion.ancestorTitles) || assertion.ancestorTitles.some(title => typeof title !== 'string')) { issue(`Malformed Vitest assertion: ${file}`); continue; }
        const titles = assertion.ancestorTitles as string[];
        for (let depth = 1; depth <= titles.length; depth++) ancestors.add(JSON.stringify(titles.slice(0, depth)));
        if ([...titles, assertion.title].join(' ') !== assertion.fullName) issue(`Vitest fullName differs from its hierarchy: ${file}`);
        const passed = assertion.status === 'passed' && Array.isArray(assertion.failureMessages) && assertion.failureMessages.length === 0;
        if (assertion.retry !== undefined && assertion.retry !== 0) issue(`Vitest assertion retried: ${assertion.fullName}`);
        if (object(assertion.meta) && ((assertion.meta.retryCount !== undefined && assertion.meta.retryCount !== 0) || (assertion.meta.repeatCount !== undefined && assertion.meta.repeatCount !== 0))) issue(`Vitest assertion retried or repeated: ${assertion.fullName}`);
        // The standard Vitest JSON reporter drops testCase.diagnostic() entirely.
        // A separately bound custom reporter may preserve these real diagnostics;
        // ordinary test.meta values are not a substitute for that observation.
        if (assertion.releaseDiagnostics === undefined) missingDiagnostics++;
        else if (!object(assertion.releaseDiagnostics) || assertion.releaseDiagnostics.retryCount !== 0 || assertion.releaseDiagnostics.repeatCount !== 0
          || (runtimeMarker !== undefined && (Object.keys(assertion.releaseDiagnostics).length !== 3 || assertion.releaseDiagnostics.flaky !== false))) issue(`Vitest release retry/repeat diagnostics are malformed, flaky or nonzero: ${assertion.fullName}`);
        addLeaf({ id: assertion.fullName, file, title: assertion.fullName, project: '', passed, attachments: [] });
      }
      suiteCount += 1 + ancestors.size;
    }
    requireCount(input.numTotalTests, leaves.length, 'Vitest total tests'); requireCount(input.numPassedTests, leaves.length, 'Vitest passed tests');
    for (const key of ['numFailedTests', 'numPendingTests', 'numTodoTests', 'numFailedTestSuites', 'numPendingTestSuites']) requireCount(input[key], 0, `Vitest ${key}`);
    requireCount(input.numTotalTestSuites, suiteCount, 'Vitest total suites'); requireCount(input.numPassedTestSuites, suiteCount, 'Vitest passed suites');
    if (object(runtimeMarker) && runtimeMarker.missingDiagnostics !== missingDiagnostics) issue('Vitest runtime missingDiagnostics counter differs from observed assertion diagnostics');
    if (missingDiagnostics) pending.push(`Vitest report omits observed retry/repeat diagnostics for ${missingDiagnostics} assertion(s); standard JSON consistency cannot qualify the no-retry execution gate`);
  } else {
    emptyErrors(input.errors, 'Playwright report errors', true);
    if (!object(input.config) || !Array.isArray(input.config.projects) || !input.config.projects.length) { issue('Playwright project configuration is missing'); return finish(); }
    const rootDirectory = typeof input.config.rootDir === 'string' ? input.config.rootDir : undefined;
    if (rootDirectory === undefined || normalize(rootDirectory, 'Playwright rootDir') === null) issue('Playwright rootDir is missing or unsafe');
    const projects = new Set<string>();
    for (const project of input.config.projects) {
      if (!object(project) || typeof project.name !== 'string') { issue('Malformed Playwright project'); continue; }
      if (projects.has(project.name)) issue(`Duplicate Playwright project: ${project.name}`);
      projects.add(project.name);
      const directory = normalize(project.outputDir, `Playwright project ${project.name} outputDir`);
      if (directory !== null) directories.add(directory);
      if (outputDirectory === null || directory !== outputDirectory) issue(`Playwright project ${project.name} outputDir differs from expectation`);
    }
    const selectedProjects = new Set([...expected.values()].map(leaf => leaf.project));
    if (Array.isArray(input.config.filteredProjects)) {
      const filtered = new Set<string>();
      for (const project of input.config.filteredProjects) {
        if (!object(project) || typeof project.name !== 'string' || filtered.has(project.name)) { issue('Malformed or duplicate filtered Playwright project'); continue; }
        filtered.add(project.name);
        const directory = normalize(project.outputDir, `Filtered Playwright project ${project.name} outputDir`);
        if (directory === null || directory !== outputDirectory) issue(`Filtered Playwright project ${project.name} outputDir differs`);
      }
      if (!same([...filtered].sort(), [...selectedProjects].sort())) issue('Filtered Playwright projects differ from expected case projects');
    }
    for (const project of selectedProjects) if (!projects.has(project)) issue(`Pinned project is absent from Playwright config: ${project}`);
    const walk = async (suites: unknown): Promise<void> => {
      if (!Array.isArray(suites)) { issue('Playwright suites must be an array'); return; }
      for (const suite of suites) {
        if (!object(suite) || typeof suite.title !== 'string') { issue('Malformed Playwright suite'); continue; }
        const leavesBeforeSuite = leaves.length;
        if ((suite.status !== undefined && suite.status !== 'passed' && suite.status !== 'expected') || suite.skipped === true) issue(`Skipped or failed Playwright suite: ${suite.title}`);
        if (suite.file !== undefined) {
          const file = normalize(suite.file, 'Playwright suite source', rootDirectory);
          if (file !== null && !expectedFiles.has(file)) issue(`Unpinned Playwright suite source: ${file}`);
        }
        if (suite.specs !== undefined && !Array.isArray(suite.specs)) issue('Playwright specs must be an array');
        for (const spec of Array.isArray(suite.specs) ? suite.specs : []) {
          if (!object(spec) || !text(spec.id) || !text(spec.title)) { issue('Malformed Playwright spec identity'); continue; }
          const file = normalize(spec.file, 'Playwright spec source', rootDirectory);
          if (file === null) continue;
          if (spec.ok !== true) issue(`Playwright spec is not okay: ${spec.id}`);
          if (!Array.isArray(spec.tests) || !spec.tests.length) { issue(`Empty or malformed Playwright test list: ${spec.id}`); continue; }
          for (const test of spec.tests) {
            if (!object(test) || typeof test.projectName !== 'string') { issue(`Malformed Playwright project identity: ${spec.id}`); continue; }
            if (!projects.has(test.projectName)) issue(`Unconfigured Playwright project: ${test.projectName}`);
            const results = Array.isArray(test.results) ? test.results : [];
            const result = results[0];
            const passed = test.expectedStatus === 'passed' && test.status === 'expected' && results.length === 1 && object(result) && result.status === 'passed' && result.retry === 0 && Array.isArray(result.errors) && !result.errors.length && (result.error === undefined || result.error === null);
            const attachments = object(result) ? await inspectAttachments(result.attachments, spec.id, test.projectName) : [];
            addLeaf({ id: spec.id, file, title: spec.title, project: test.projectName, passed, attachments });
          }
        }
        if (suite.suites !== undefined) await walk(suite.suites);
        if (leaves.length === leavesBeforeSuite) issue(`Empty Playwright suite cannot establish complete execution: ${suite.title}`);
      }
    };
    await walk(input.suites);
    if (!object(input.stats)) issue('Playwright stats are missing');
    else {
      requireCount(input.stats.expected, leaves.length, 'Playwright expected tests');
      for (const key of ['unexpected', 'flaky', 'skipped']) requireCount(input.stats[key], 0, `Playwright ${key}`);
    }
  }
  for (const [key] of expected) if (!observed.has(key)) issue(`Missing expected case: ${key}`);
  if (!same([...observedFiles].sort(), [...expectedFiles].sort())) issue('Observed source files differ from pinned inventory');
  return finish();
}
