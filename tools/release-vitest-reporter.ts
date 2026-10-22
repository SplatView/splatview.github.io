import type { Reporter, TestCase, TestModule, TestRunEndReason, TestSuite, Vitest } from 'vitest/node';
import { Workspace, relativePath } from './release/files.ts';

/** A runtime observation, taken from TestCase.diagnostic(), never from task.meta. */
export interface ReleaseDiagnostics { retryCount: number; repeatCount: number; flaky: boolean }
export interface ReleaseError { name: string; message: string; stack?: string; context?: string }
export interface ReleaseAssertion {
  ancestorTitles: string[];
  fullName: string;
  status: 'passed' | 'failed' | 'skipped' | 'pending' | 'todo';
  title: string;
  duration?: number;
  failureMessages: string[];
  location?: { line: number; column: number };
  /** User metadata is intentionally not a source of runtime diagnostics. */
  meta: Record<string, never>;
  releaseDiagnostics?: ReleaseDiagnostics;
}
export interface ReleaseVitestReport {
  numFailedTests: number;
  numFailedTestSuites: number;
  numPassedTests: number;
  numPassedTestSuites: number;
  numPendingTests: number;
  numPendingTestSuites: number;
  numTodoTests: number;
  numTotalTests: number;
  numTotalTestSuites: number;
  startTime: number;
  success: boolean;
  snapshot?: unknown;
  errors: ReleaseError[];
  unhandledErrors: ReleaseError[];
  releaseReporter: {
    schemaVersion: 1;
    kind: 'splatview-vitest-runtime';
    vitestVersion: string;
    runReason: TestRunEndReason;
    missingDiagnostics: number;
  };
  testResults: {
    message: string;
    name: string;
    status: 'failed' | 'passed';
    startTime: number;
    endTime: number;
    assertionResults: ReleaseAssertion[];
  }[];
}

const MAX_MODULES = 10_000, MAX_TESTS = 200_000, MAX_ERROR_TEXT = 256 * 1024;
function errorRecord(error: unknown, context?: string): ReleaseError {
  const row = error !== null && typeof error === 'object' ? error as Record<string, unknown> : undefined;
  const bounded = (value: string): string => {
    if (value.length > MAX_ERROR_TEXT) throw new Error('Vitest error text exceeds report bound');
    return value;
  };
  return {
    name: bounded(typeof row?.name === 'string' ? row.name : 'Error'),
    message: bounded(typeof row?.message === 'string' ? row.message : String(error)),
    ...(typeof row?.stack === 'string' ? { stack: bounded(row.stack) } : {}),
    ...(context === undefined ? {} : { context }),
  };
}

/** Public Vitest entities are read only; no runner tasks or result objects are mutated. */
export function mapRuntimeTest(test: TestCase): ReleaseAssertion {
  const ancestorTitles: string[] = [];
  let parent: TestSuite | TestModule = test.parent;
  while (parent.type !== 'module') {
    if (ancestorTitles.length >= 128) throw new Error('Vitest ancestor depth exceeds report bound');
    ancestorTitles.push(parent.name);
    parent = parent.parent;
  }
  ancestorTitles.reverse();
  const result = test.result(), diagnostic = test.diagnostic();
  const status = test.options.mode === 'todo' && result.state === 'skipped' ? 'todo' : result.state;
  const assertion: ReleaseAssertion = {
    ancestorTitles, fullName: [...ancestorTitles, test.name].join(' '), title: test.name,
    status, failureMessages: (result.errors ?? []).map(error => {
      const row = errorRecord(error); return row.stack ?? row.message;
    }), meta: {},
    ...(test.location === undefined ? {} : { location: { line: test.location.line, column: test.location.column } }),
  };
  if (diagnostic !== undefined) {
    if (!Number.isSafeInteger(diagnostic.retryCount) || diagnostic.retryCount < 0
      || !Number.isSafeInteger(diagnostic.repeatCount) || diagnostic.repeatCount < 0
      || typeof diagnostic.flaky !== 'boolean'
      || !Number.isFinite(diagnostic.startTime) || diagnostic.startTime < 0
      || !Number.isFinite(diagnostic.duration) || diagnostic.duration < 0) throw new Error('Malformed public Vitest runtime diagnostics');
    assertion.duration = diagnostic.duration;
    assertion.releaseDiagnostics = { retryCount: diagnostic.retryCount, repeatCount: diagnostic.repeatCount, flaky: diagnostic.flaky };
  }
  return assertion;
}

export interface RuntimeReportInput {
  modules: readonly TestModule[];
  unhandledErrors: readonly unknown[];
  reason: TestRunEndReason;
  startTime: number;
  vitestVersion: string;
  snapshot?: unknown;
}
/** The same space-joined hierarchy used by Vitest's standard JSON reporter. */
export function buildRuntimeReport(input: RuntimeReportInput): ReleaseVitestReport {
  if (input.modules.length > MAX_MODULES || input.unhandledErrors.length > MAX_TESTS) throw new Error('Vitest report collection exceeds bound');
  if (!['passed', 'failed', 'interrupted'].includes(input.reason)) throw new Error('Unknown Vitest run end reason');
  if (!Number.isFinite(input.startTime) || input.startTime < 0 || !input.vitestVersion) throw new Error('Missing Vitest run identity');
  const report: ReleaseVitestReport = {
    numFailedTests: 0, numFailedTestSuites: 0, numPassedTests: 0, numPassedTestSuites: 0,
    numPendingTests: 0, numPendingTestSuites: 0, numTodoTests: 0, numTotalTests: 0, numTotalTestSuites: 0,
    startTime: input.startTime, success: false, errors: [], unhandledErrors: input.unhandledErrors.map(error => errorRecord(error)),
    releaseReporter: { schemaVersion: 1, kind: 'splatview-vitest-runtime', vitestVersion: input.vitestVersion,
      runReason: input.reason, missingDiagnostics: 0 }, testResults: [],
    ...(input.snapshot === undefined ? {} : { snapshot: input.snapshot }),
  };
  for (const module of input.modules) {
    const tests = [...module.children.allTests()];
    if (report.numTotalTests + tests.length > MAX_TESTS) throw new Error('Vitest assertion count exceeds report bound');
    const assertions = tests.map(mapRuntimeTest), ancestors = new Set<string>();
    let failedSuites = 0, pendingSuites = 0;
    const suites = [module, ...module.children.allSuites()];
    for (const suite of suites) {
      const state = suite.state();
      if (state === 'failed') failedSuites++;
      if (state === 'pending' || state === 'queued' || state === 'skipped') pendingSuites++;
      report.errors.push(...suite.errors().map(error => errorRecord(error, suite.type === 'module' ? module.moduleId : `${module.moduleId}: ${suite.fullName}`)));
    }
    for (const assertion of assertions) {
      for (let depth = 1; depth <= assertion.ancestorTitles.length; depth++) ancestors.add(JSON.stringify(assertion.ancestorTitles.slice(0, depth)));
      report.numTotalTests++;
      if (assertion.status === 'failed') report.numFailedTests++;
      else if (assertion.status === 'passed') report.numPassedTests++;
      else if (assertion.status === 'todo') report.numTodoTests++;
      else report.numPendingTests++;
      if (assertion.releaseDiagnostics === undefined) report.releaseReporter.missingDiagnostics++;
    }
    // Include every actual suite. Empty or duplicated hierarchies remain visible
    // and cannot be concealed to make an external case inventory appear complete.
    const suiteCount = suites.length;
    report.numTotalTestSuites += suiteCount;
    report.numFailedTestSuites += failedSuites;
    report.numPendingTestSuites += pendingSuites;
    report.numPassedTestSuites += suiteCount - failedSuites - pendingSuites;
    const diagnostics = tests.map(test => test.diagnostic()).filter(value => value !== undefined);
    const startTime = diagnostics.length ? diagnostics.reduce((first, value) => Math.min(first, value.startTime), Infinity) : input.startTime;
    const endTime = diagnostics.reduce((last, value) => Math.max(last, value.startTime + value.duration), startTime);
    const moduleFailed = module.state() === 'failed' || assertions.some(assertion => assertion.status === 'failed') || suites.some(suite => suite.errors().length > 0);
    report.testResults.push({ name: module.moduleId, status: moduleFailed ? 'failed' : 'passed',
      message: module.errors().map(error => errorRecord(error).message).join('\n'), startTime, endTime, assertionResults: assertions });
    // This comparison exposes malformed public hierarchies rather than inventing
    // missing suites. The adapter independently derives this count from leaves.
    if (suiteCount < ancestors.size + 1) throw new Error('Vitest public suite hierarchy is inconsistent');
  }
  const snapshotFailed = input.snapshot !== null && typeof input.snapshot === 'object' && (input.snapshot as Record<string, unknown>).failure === true;
  report.success = input.reason === 'passed' && input.modules.length > 0
    && report.numFailedTests === 0 && report.numFailedTestSuites === 0
    && report.errors.length === 0 && report.unhandledErrors.length === 0 && !snapshotFailed;
  return report;
}

export interface ReleaseReporterOptions { outputFile?: string }
/**
 * Usage: vitest run --reporter=./tools/release-vitest-reporter.ts
 *   --outputFile=.build/existing-run/fresh.json
 *
 * The parent directory must already exist. Output is bounded, canonical,
 * workspace relative and exclusive. Watch reruns cannot replace prior evidence.
 */
export default class ReleaseVitestReporter implements Reporter {
  private context?: Vitest;
  private startedAt = 0;
  private output?: string;
  private workspace?: Workspace;
  private ended = false;
  readonly options: ReleaseReporterOptions;
  constructor(options: ReleaseReporterOptions = {}) { this.options = options; }
  onInit(context: Vitest): void {
    this.context = context;
    const configured = context.config.outputFile;
    const output = this.options.outputFile ?? (typeof configured === 'string' ? configured : configured?.['splatview-release'] ?? configured?.['./tools/release-vitest-reporter.ts']);
    if (typeof output !== 'string') throw new Error('Release Vitest reporter requires an explicit workspace-relative outputFile');
    this.output = relativePath(output);
    this.workspace = new Workspace(context.config.root, 64 * 1024 * 1024, 128 * 1024 * 1024);
    this.startedAt = Date.now();
  }
  onTestRunStart(): void {
    if (this.ended) throw new Error('Release Vitest reporter refuses watch reruns into an existing evidence path');
    this.startedAt = Date.now();
  }
  async onTestRunEnd(modules: readonly TestModule[], unhandledErrors: readonly unknown[], reason: TestRunEndReason): Promise<void> {
    if (!this.context || !this.workspace || !this.output) throw new Error('Release Vitest reporter was not initialized');
    if (this.ended) throw new Error('Release Vitest reporter refuses duplicate run output');
    this.ended = true;
    const report = buildRuntimeReport({ modules, unhandledErrors, reason, startTime: this.startedAt,
      vitestVersion: this.context.version, snapshot: this.context.snapshot.summary });
    await this.workspace.writeExclusive(this.output, report);
    this.context.logger.log(`Release Vitest report written to ${this.output}`);
  }
}
