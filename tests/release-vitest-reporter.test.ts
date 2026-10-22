import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'vitest';
import type { TestCase, TestDiagnostic, TestModule, TestResult, TestSuite, Vitest } from 'vitest/node';
import ReleaseVitestReporter, { buildRuntimeReport, mapRuntimeTest } from '../tools/release-vitest-reporter.ts';
import type { ReleaseVitestReport } from '../tools/release-vitest-reporter.ts';
import { inspectTestReport } from '../tools/release/reports.ts';
import type { ReportExpectation } from '../tools/release/types.ts';
import { collectionFromModules, parseCollectionArguments } from '../tools/release/collect-vitest.ts';
import type { VitestCaseCollection } from '../tools/release/collect-vitest.ts';

const ROOT = process.cwd();
const snapshot = { failure: false, filesRemoved: 0, filesUnmatched: 0, unmatched: 0, unchecked: 0, updated: 0, added: 0, didUpdate: false };
const diagnostic: TestDiagnostic = { retryCount: 0, repeatCount: 0, flaky: false, startTime: 100, duration: 2, slow: false, heap: undefined };

// These hand-built public entities are synthetic mapping/policy fixtures only.
// The subprocess fixtures below independently exercise real installed Vitest.
function synthetic(options: { diagnostic?: TestDiagnostic | null; result?: TestResult; mode?: 'run' | 'skip' | 'todo'; moduleErrors?: unknown[]; suiteErrors?: unknown[] } = {}) {
  const moduleErrors = options.moduleErrors ?? [], suiteErrors = options.suiteErrors ?? [];
  const module = { type: 'module', moduleId: path.join(ROOT, 'tests/synthetic-runtime.test.ts'),
    state: () => moduleErrors.length ? 'failed' : 'passed', errors: () => moduleErrors } as unknown as TestModule;
  const outer = { type: 'suite', name: 'outer', fullName: 'outer', parent: module, state: () => 'passed', errors: () => [] } as unknown as TestSuite;
  const inner = { type: 'suite', name: 'inner', fullName: 'outer > inner', parent: outer, state: () => suiteErrors.length ? 'failed' : 'passed', errors: () => suiteErrors } as unknown as TestSuite;
  const leaf = { type: 'test', name: 'leaf', parent: inner, options: { mode: options.mode ?? 'run' }, location: undefined,
    result: () => options.result ?? { state: 'passed', errors: undefined },
    diagnostic: () => options.diagnostic === null ? undefined : options.diagnostic ?? diagnostic,
    meta: () => ({ retryCount: 912, repeatCount: 813, flaky: true }) } as unknown as TestCase;
  Object.assign(module, { children: { *allTests() { yield leaf; }, *allSuites() { yield outer; yield inner; } } });
  return { module, leaf };
}
const mapped = (module: TestModule, overrides: Partial<Parameters<typeof buildRuntimeReport>[0]> = {}) => buildRuntimeReport({
  modules: [module], unhandledErrors: [], reason: 'passed', startTime: 100, vitestVersion: '5.0.3', snapshot, ...overrides,
});
function fakeContext(outputFile: string | Record<string, string>): Vitest {
  return { config: { root: ROOT, outputFile }, version: '5.0.3', snapshot: { summary: snapshot }, logger: { log() {} } } as unknown as Vitest;
}
async function fixtureDirectory(): Promise<{ absolute: string; relative: string }> {
  await mkdir(path.join(ROOT, '.build'), { recursive: true });
  const absolute = await mkdtemp(path.join(ROOT, '.build/release-vitest-reporter-'));
  return { absolute, relative: path.relative(ROOT, absolute).split(path.sep).join('/') };
}

test('runtime reporter maps public zero diagnostics and space-joined ancestors without consulting test.meta', () => {
  const { module, leaf } = synthetic(), assertion = mapRuntimeTest(leaf), report = mapped(module);
  assert.equal(assertion.fullName, 'outer inner leaf');
  assert.deepEqual(assertion.ancestorTitles, ['outer', 'inner']);
  assert.deepEqual(assertion.releaseDiagnostics, { retryCount: 0, repeatCount: 0, flaky: false });
  assert.deepEqual(assertion.meta, {});
  assert.equal(report.numTotalTestSuites, 3);
  assert.equal(report.numPassedTestSuites, 3);
  assert.equal(report.success, true);
  assert.equal(report.testResults[0]!.startTime, 100);
  assert.equal(report.testResults[0]!.endTime, 102);
});
test('runtime reporter preserves actual positive retry/repeat/flaky observations', () => {
  const { leaf } = synthetic({ diagnostic: { ...diagnostic, retryCount: 1, repeatCount: 1, flaky: true } });
  assert.deepEqual(mapRuntimeTest(leaf).releaseDiagnostics, { retryCount: 1, repeatCount: 1, flaky: true });
});
test('runtime reporter leaves unavailable diagnostics absent and counts the observation gap', () => {
  const { module, leaf } = synthetic({ diagnostic: null });
  assert.equal(Object.hasOwn(mapRuntimeTest(leaf), 'releaseDiagnostics'), false);
  assert.equal(mapped(module).releaseReporter.missingDiagnostics, 1);
});
for (const [name, result, mode, counter] of [
  ['skipped', { state: 'skipped', errors: undefined, note: undefined }, 'skip', 'numPendingTests'],
  ['todo', { state: 'skipped', errors: undefined, note: undefined }, 'todo', 'numTodoTests'],
  ['pending', { state: 'pending', errors: undefined }, 'run', 'numPendingTests'],
] as const) test(`runtime reporter preserves ${name} rather than fabricating success`, () => {
  const { module } = synthetic({ diagnostic: null, result, mode }), report = mapped(module);
  assert.equal(report.testResults[0]!.assertionResults[0]!.status, name);
  assert.equal(report[counter], 1);
  assert.equal(report.numPassedTests, 0);
});
test('runtime reporter records hook/import errors outside assertions and cannot mark success', () => {
  const { module } = synthetic({ moduleErrors: [new Error('import fault')], suiteErrors: [new Error('afterAll fault')] });
  const report = mapped(module);
  assert.equal(report.success, false);
  assert.equal(report.numFailedTestSuites, 2);
  assert.deepEqual(report.errors.map(error => error.message), ['import fault', 'afterAll fault']);
  assert.match(report.testResults[0]!.message, /import fault/);
});
test('runtime reporter never marks interrupted or unhandled-error runs successful despite passing leaves', () => {
  const { module } = synthetic();
  assert.equal(mapped(module, { reason: 'interrupted' }).success, false);
  const report = mapped(module, { unhandledErrors: [new Error('unhandled genuine shape')] });
  assert.equal(report.success, false);
  assert.equal(report.unhandledErrors[0]!.message, 'unhandled genuine shape');
});
test('runtime reporter rejects malformed public diagnostics instead of normalizing them into zeros', () => {
  for (const invalid of [{ retryCount: -1 }, { repeatCount: Number.NaN }, { flaky: undefined }, { duration: Infinity }, { startTime: -1 }]) {
    const { leaf } = synthetic({ diagnostic: { ...diagnostic, ...invalid } as TestDiagnostic });
    assert.throws(() => mapRuntimeTest(leaf), /Malformed public/);
  }
});
test('runtime reporter requires explicit canonical relative output and refuses exclusive-output replacement', async () => {
  for (const unsafe of ['../report.json', '/report.json', 'C:/report.json', '.build\\report.json', '.build/../report.json', '.build/report.json.']) {
    assert.throws(() => new ReleaseVitestReporter().onInit(fakeContext(unsafe)), /workspace-relative/);
  }
  const directory = await fixtureDirectory(), output = `${directory.relative}/exclusive.json`, reporter = new ReleaseVitestReporter();
  reporter.onInit(fakeContext({ 'splatview-release': output }));
  await reporter.onTestRunEnd([synthetic().module], [], 'passed');
  const before = await readFile(path.join(ROOT, output));
  const second = new ReleaseVitestReporter({ outputFile: output });
  second.onInit(fakeContext('ignored.json'));
  await assert.rejects(second.onTestRunEnd([synthetic().module], [], 'passed'), /EEXIST/);
  assert.deepEqual(await readFile(path.join(ROOT, output)), before);
  assert.throws(() => reporter.onTestRunStart(), /watch reruns/);
  await assert.rejects(reporter.onTestRunEnd([], [], 'passed'), /duplicate run/);
});
test('runtime reporter rejects a linked output ancestor and case-aliased output ancestor', async () => {
  const directory = await fixtureDirectory();
  await mkdir(path.join(directory.absolute, 'target'));
  await symlink(path.join(directory.absolute, 'target'), path.join(directory.absolute, 'linked'), 'junction');
  const linked = new ReleaseVitestReporter({ outputFile: `${directory.relative}/linked/report.json` });
  linked.onInit(fakeContext('ignored.json'));
  await assert.rejects(linked.onTestRunEnd([synthetic().module], [], 'passed'), /Linked|reparse|aliased/);
  const aliased = new ReleaseVitestReporter({ outputFile: `${directory.relative}/TARGET/report.json` });
  aliased.onInit(fakeContext('ignored.json'));
  await assert.rejects(aliased.onTestRunEnd([synthetic().module], [], 'passed'), /alias|ENOENT|redirected/);
});

interface CommandResult { code: number | null; stdout: string; stderr: string }
async function runFixture(relativeDirectory: string, output: string, extraReporters: string[] = []): Promise<CommandResult> {
  const executable = process.execPath;
  const args = [path.join(ROOT, 'node_modules/vitest/vitest.mjs'), 'run', '--config', `${relativeDirectory}/vitest.config.mts`,
    '--reporter=./tools/release-vitest-reporter.ts', ...extraReporters.map(reporter => `--reporter=${reporter}`), `--outputFile=${output}`];
  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(executable, args, { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1' } });
    let stdout = '', stderr = '', exceeded = false;
    const timer = setTimeout(() => { exceeded = true; child.kill(); }, 45_000);
    child.stdout.on('data', value => { stdout += String(value); if (stdout.length > 2 * 1024 * 1024) { exceeded = true; child.kill(); } });
    child.stderr.on('data', value => { stderr += String(value); if (stderr.length > 2 * 1024 * 1024) { exceeded = true; child.kill(); } });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); if (exceeded) reject(new Error('Isolated reporter fixture exceeded runtime/output bound')); else resolve({ code, stdout, stderr }); });
  });
}
async function writeConfig(directory: { absolute: string; relative: string }, files: Record<string, string>): Promise<void> {
  const source = `// Synthetic reporter execution fixture, not application evidence.\nexport default ${JSON.stringify({ test: {
    include: Object.keys(files).filter(file => file.endsWith('.test.ts')).map(file => `${directory.relative}/${file}`),
    exclude: [], watch: false, cache: false, fileParallelism: false, maxWorkers: 1, pool: 'forks',
    sequence: { shuffle: false },
  } }, null, 2)};\n`;
  await writeFile(path.join(directory.absolute, 'vitest.config.mts'), source, { flag: 'wx' });
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(directory.absolute, name), content, { flag: 'wx' });
}
async function reportAt(output: string): Promise<ReleaseVitestReport> {
  return JSON.parse(await readFile(path.join(ROOT, output), 'utf8')) as ReleaseVitestReport;
}
const allAssertions = (report: ReleaseVitestReport) => report.testResults.flatMap(module => module.assertionResults);

// Each subprocess has an explicit private include list, one CPU worker and no
// application config, browser, GPU, native command, production bridge or recursion.
test('real Vitest runtime reporter passes an independently named hierarchy and keeps existing output byte-exact', async () => {
  const directory = await fixtureDirectory();
  await writeConfig(directory, { 'clean.test.ts': `import { describe, expect, test } from 'vitest';\ndescribe('outer', () => describe('inner', () => test('actual case', () => expect(2 + 3).toBe(5))));\n` });
  const output = `${directory.relative}/clean.json`, result = await runFixture(directory.relative, output);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const report = await reportAt(output), file = `${directory.relative}/clean.test.ts`;
  const reference = { path: output, bytes: 0, sha256: '0'.repeat(64) };
  const expectation: ReportExpectation = { id: 'synthetic-real-reporter-fixture', adapter: 'vitest', command: { executable: reference, arguments: [], workingDirectory: '.' }, report: reference,
    coveredInputs: [], files: [{ path: file, leaves: [{ id: 'outer inner actual case', title: 'outer inner actual case', project: '' }] }], outputDirectory: null, outputFiles: [], requiredAttachments: [] };
  const inspection = await inspectTestReport('vitest', report, expectation, { normalizePath: value => path.relative(ROOT, path.resolve(ROOT, value)).split(path.sep).join('/'),
    readAttachment: async () => { throw new Error('No attachments expected'); } });
  assert.equal(inspection.valid, true, JSON.stringify(inspection.issues));
  assert.deepEqual(inspection.pending, []);
  assert.equal(report.releaseReporter.vitestVersion, '5.0.3');
  assert.equal(report.releaseReporter.runReason, 'passed');
  assert.deepEqual(allAssertions(report)[0]!.releaseDiagnostics, { retryCount: 0, repeatCount: 0, flaky: false });
  const before = await readFile(path.join(ROOT, output)), again = await runFixture(directory.relative, output);
  assert.notEqual(again.code, 0, again.stderr + again.stdout);
  assert.match(again.stderr + again.stdout, /EEXIST|already exists/);
  assert.equal(createHash('sha256').update(await readFile(path.join(ROOT, output))).digest('hex'), createHash('sha256').update(before).digest('hex'));
}, 120_000);
test('real Vitest runtime reporter observes retries, repeats, failure, skipped/todo, hook/import faults and unhandled errors', async () => {
  const directory = await fixtureDirectory();
  await writeConfig(directory, {
    'outcomes.test.ts': `import { afterAll, describe, expect, test } from 'vitest';
let attempts = 0;
test('actual retry', { retry: 1 }, () => expect(attempts++).toBe(1));
test('actual repeat', { repeats: 1 }, () => expect(true).toBe(true));
test('actual failed', () => expect(1).toBe(2));
test.skip('actual skipped', () => {});
test.todo('actual todo');
test('actual unhandled', async () => { void Promise.reject(new Error('fixture genuine unhandled')); await new Promise(resolve => setTimeout(resolve, 30)); });
describe('actual hook', () => { afterAll(() => { throw new Error('fixture genuine afterAll'); }); test('passing body', () => expect(true).toBe(true)); });
`,
    'import.test.ts': `throw new Error('fixture genuine import');\nexport {};\n`,
  });
  const output = `${directory.relative}/outcomes.json`, result = await runFixture(directory.relative, output);
  assert.notEqual(result.code, 0, result.stderr + result.stdout);
  const report = await reportAt(output), assertions = new Map(allAssertions(report).map(assertion => [assertion.fullName, assertion]));
  assert.equal(report.success, false);
  assert.deepEqual(assertions.get('actual retry')!.releaseDiagnostics, { retryCount: 1, repeatCount: 0, flaky: true });
  assert.deepEqual(assertions.get('actual repeat')!.releaseDiagnostics, { retryCount: 0, repeatCount: 1, flaky: false });
  assert.equal(assertions.get('actual failed')!.status, 'failed');
  assert.equal(assertions.get('actual skipped')!.status, 'skipped');
  assert.equal(assertions.get('actual todo')!.status, 'todo');
  assert.equal(Object.hasOwn(assertions.get('actual skipped')!, 'releaseDiagnostics'), false);
  assert.equal(Object.hasOwn(assertions.get('actual todo')!, 'releaseDiagnostics'), false);
  assert.equal(report.numPendingTests, 1);
  assert.equal(report.numTodoTests, 1);
  assert.equal(report.releaseReporter.missingDiagnostics, 2);
  assert(report.errors.some(error => error.message.includes('fixture genuine afterAll')));
  assert(report.errors.some(error => error.message.includes('fixture genuine import')));
  assert(report.unhandledErrors.some(error => error.message.includes('fixture genuine unhandled')));
}, 90_000);
test('real Vitest public cancellation produces an interrupted report with success false', async () => {
  const directory = await fixtureDirectory(), requested = path.join(directory.absolute, 'cancel-requested.txt'),
    started = path.join(directory.absolute, 'body-started.txt'), joined = path.join(directory.absolute, 'cancel-joined.txt');
  await writeConfig(directory, {
    'interrupt.test.ts': `import { test } from 'vitest';
import { writeFileSync } from 'node:fs';
test('cancel now', ({ signal }) => new Promise<void>((_resolve, reject) => {
  if (signal.aborted) { reject(signal.reason); return; }
  signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  writeFileSync(${JSON.stringify(started)}, 'active test body started', { flag: 'wx' });
}));
test('after cancel', () => {});
`,
    'cancel-reporter.ts': `// Synthetic cancellation driver uses only Vitest's public API.
import { existsSync, writeFileSync } from 'node:fs';
export default class CancelReporter {
  onInit(ctx) {
    this.ctx = ctx;
    // cancelCurrentRun joins the run, including onTestRunEnd. Close joins this
    // independent driver only after that run has settled.
    ctx.onClose(() => this.driver);
  }
  onTestRunStart() {
    // Returning this promise would prevent the worker/test body from starting.
    this.driver = this.cancelWhenStarted();
    void this.driver.catch(() => {}); // close still observes its rejection
  }
  async cancelWhenStarted() {
    const deadline = Date.now() + 10_000;
    while (!existsSync(${JSON.stringify(started)})) {
      if (Date.now() >= deadline) throw new Error('public cancellation handshake did not arrive');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const cancellation = this.ctx.cancelCurrentRun('keyboard-input');
    writeFileSync(${JSON.stringify(requested)}, 'public cancellation requested', { flag: 'wx' });
    await cancellation;
    writeFileSync(${JSON.stringify(joined)}, 'public cancellation joined', { flag: 'wx' });
  }
}
`,
  });
  const output = `${directory.relative}/interrupted.json`, result = await runFixture(directory.relative, output, [`./${directory.relative}/cancel-reporter.ts`]);
  const report = await reportAt(output);
  assert.equal(report.releaseReporter.runReason, 'interrupted', result.stderr + result.stdout);
  assert.equal(report.success, false);
  assert.equal(await readFile(started, 'utf8'), 'active test body started');
  assert.equal(await readFile(requested, 'utf8'), 'public cancellation requested');
  assert.equal(await readFile(joined, 'utf8'), 'public cancellation joined');
  // Vitest5 public cancellation aborts the active test context and maps its
  // TestRunAbortError to skipped; it also skips the following pending test.
  // Neither case has completed runtime diagnostics after that abort.
  assert.equal(allAssertions(report).find(assertion => assertion.title === 'cancel now')!.status, 'skipped');
  assert.equal(allAssertions(report).find(assertion => assertion.title === 'after cancel')!.status, 'skipped');
  assert.equal(report.numPassedTests, 0);
  assert.equal(report.numPendingTests, 2);
  assert.equal(report.releaseReporter.missingDiagnostics, 2);
  assert(allAssertions(report).every(assertion => !Object.hasOwn(assertion, 'releaseDiagnostics')));
}, 90_000);

test('independent Vitest collector retains literal separators and all collected modes', () => {
  const { module, leaf } = synthetic({ diagnostic: null, result: { state: 'pending', errors: undefined } });
  Object.assign(module, { project: { name: '' } });
  Object.assign(leaf, { name: 'leaf > literal' });
  const collection = collectionFromModules(ROOT, [module]);
  assert.deepEqual(collection.files[0]!.leaves, [{ id: 'outer inner leaf > literal', title: 'outer inner leaf > literal', project: '' }]);
  assert.throws(() => collectionFromModules(ROOT, [module, module]), /Duplicate/);
  Object.assign(module, { project: { name: 'foreign' } });
  assert.throws(() => collectionFromModules(ROOT, [module]), /unnamed project/);
});
test('independent Vitest collector refuses executed cases and collection errors', () => {
  const executed = synthetic(); Object.assign(executed.module, { project: { name: '' } });
  assert.throws(() => collectionFromModules(ROOT, [executed.module]), /executed cases/);
  const failed = synthetic({ moduleErrors: [new Error('collection fault')] }); Object.assign(failed.module, { project: { name: '' } });
  assert.throws(() => collectionFromModules(ROOT, [failed.module]), /collection failed/);
  assert.throws(() => collectionFromModules(ROOT, []), /Empty/);
});
test('independent Vitest collector arguments require safe exact paths and explicit fresh output', () => {
  assert.deepEqual(parseCollectionArguments(['--output', '.build/new.json', '--test', 'tests/a.test.ts', '--test', 'tests/b.test.ts']), {
    output: '.build/new.json', tests: ['tests/a.test.ts', 'tests/b.test.ts'],
  });
  for (const args of [[], ['--output'], ['--output', '../escape.json'], ['--output', '.build/a.json', '--output', '.build/b.json'], ['--unknown', '.build/a.json']]) {
    assert.throws(() => parseCollectionArguments(args));
  }
});

async function runCollector(directory: { relative: string }, output: string, testFiles: string[]): Promise<CommandResult> {
  const args = [path.join(ROOT, 'tools/release/collect-vitest.ts'), '--output', output, '--config', `${directory.relative}/vitest.config.mts`,
    ...testFiles.flatMap(file => ['--test', `${directory.relative}/${file}`])];
  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1' } });
    let stdout = '', stderr = '', exceeded = false;
    const timer = setTimeout(() => { exceeded = true; child.kill(); }, 45_000);
    child.stdout.on('data', value => { stdout += String(value); if (stdout.length > 2 * 1024 * 1024) { exceeded = true; child.kill(); } });
    child.stderr.on('data', value => { stderr += String(value); if (stderr.length > 2 * 1024 * 1024) { exceeded = true; child.kill(); } });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); if (exceeded) reject(new Error('Isolated collector fixture exceeded runtime/output bound')); else resolve({ code, stdout, stderr }); });
  });
}
test('real Vitest collection executes declarations while preserving dynamic, skipped, todo and literal titles without hooks or bodies', async () => {
  const directory = await fixtureDirectory(), marker = path.join(directory.absolute, 'unexpected-execution.txt');
  await writeConfig(directory, { 'collection.test.ts': `import { afterAll, afterEach, beforeAll, beforeEach, describe, test } from 'vitest';
import { writeFileSync } from 'node:fs';
const forbidden = () => { writeFileSync(${JSON.stringify(marker)}, 'test or hook executed'); throw new Error('collector executed a test lifecycle'); };
beforeAll(forbidden); afterAll(forbidden); beforeEach(forbidden); afterEach(forbidden);
describe('outer > literal', () => {
  for (let index = 0; index < 2; index++) test('generated > ' + index, forbidden);
  test.skip('skipped > literal', forbidden);
  test.todo('todo > literal');
});
` });
  const output = `${directory.relative}/collected.json`, result = await runCollector(directory, output, ['collection.test.ts']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const collection = JSON.parse(await readFile(path.join(ROOT, output), 'utf8')) as VitestCaseCollection;
  assert.deepEqual(collection, { schemaVersion: 1, kind: 'splatview-vitest-case-collection', files: [{ path: `${directory.relative}/collection.test.ts`, leaves: [
    { id: 'outer > literal generated > 0', title: 'outer > literal generated > 0', project: '' },
    { id: 'outer > literal generated > 1', title: 'outer > literal generated > 1', project: '' },
    { id: 'outer > literal skipped > literal', title: 'outer > literal skipped > literal', project: '' },
    { id: 'outer > literal todo > literal', title: 'outer > literal todo > literal', project: '' },
  ] }] });
  await assert.rejects(readFile(marker), /ENOENT/);
  const before = await readFile(path.join(ROOT, output)), again = await runCollector(directory, output, ['collection.test.ts']);
  assert.notEqual(again.code, 0, again.stderr + again.stdout);
  assert.match(again.stderr + again.stdout, /EEXIST|already exists/);
  assert.deepEqual(await readFile(path.join(ROOT, output)), before);
}, 120_000);
test('real Vitest collector refuses import errors and does not publish a partial case inventory', async () => {
  const directory = await fixtureDirectory();
  await writeConfig(directory, { 'broken.test.ts': `throw new Error('collector genuine declaration fault');\nexport {};\n` });
  const output = `${directory.relative}/must-not-exist.json`, result = await runCollector(directory, output, ['broken.test.ts']);
  assert.notEqual(result.code, 0, result.stderr + result.stdout);
  assert.match(result.stderr + result.stdout, /collection failed/);
  await assert.rejects(readFile(path.join(ROOT, output)), /ENOENT/);
}, 90_000);
