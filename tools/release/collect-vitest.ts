import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createVitest } from 'vitest/node';
import type { TestModule, TestSuite } from 'vitest/node';
import { Workspace, relativePath } from './files.ts';

export interface VitestCaseCollection {
  schemaVersion: 1;
  kind: 'splatview-vitest-case-collection';
  files: { path: string; leaves: { id: string; title: string; project: '' }[] }[];
}
export interface CollectVitestOptions { root: string; tests?: readonly string[]; config?: string }

/**
 * Independently maps collected public entities, before any execution report exists.
 * Literal " > " in a title is retained; only actual parent relationships are joined.
 * No runner internals, reporter output, regexp separator replacement or task meta.
 */
export function collectionFromModules(root: string, modules: readonly TestModule[]): VitestCaseCollection {
  if (!modules.length || modules.length > 10_000) throw new Error('Empty or excessive Vitest module collection');
  const workspace = new Workspace(root), files: VitestCaseCollection['files'] = [], seenFiles = new Set<string>();
  let totalLeaves = 0, totalSuites = 0;
  for (const module of modules) {
    if (module.project.name !== '') throw new Error('Release Vitest inventory currently requires the unnamed project');
    if (module.errors().length || module.state() === 'failed') throw new Error(`Vitest module collection failed: ${module.moduleId}`);
    const file = workspace.normalize(module.moduleId), key = file.toLowerCase();
    if (seenFiles.has(key)) throw new Error(`Duplicate or case-aliased collected Vitest file: ${file}`);
    seenFiles.add(key);
    for (const suite of module.children.allSuites()) {
      if (++totalSuites > 200_000) throw new Error('Vitest suite collection exceeds bound');
      if (suite.errors().length || suite.state() === 'failed') throw new Error(`Vitest suite collection failed: ${file}`);
    }
    const leaves: VitestCaseCollection['files'][number]['leaves'] = [], seenLeaves = new Set<string>();
    for (const test of module.children.allTests()) {
      if (++totalLeaves > 200_000) throw new Error('Vitest leaf collection exceeds bound');
      const state = test.result().state;
      if (state === 'passed' || state === 'failed' || test.diagnostic() !== undefined) throw new Error(`Vitest collection unexpectedly contains executed cases: ${file}`);
      const ancestors: string[] = [];
      let parent: TestSuite | TestModule = test.parent;
      while (parent.type !== 'module') {
        if (ancestors.length >= 128) throw new Error('Vitest collection ancestor depth exceeds bound');
        ancestors.push(parent.name); parent = parent.parent;
      }
      if (parent !== module) throw new Error('Vitest collected leaf has a foreign module parent');
      ancestors.reverse();
      const title = [...ancestors, test.name].join(' ');
      if (!title || title.length > 16_384 || seenLeaves.has(title)) throw new Error(`Empty, excessive or duplicate Vitest case identity: ${file}`);
      seenLeaves.add(title);
      leaves.push({ id: title, title, project: '' });
    }
    if (!leaves.length) throw new Error(`Vitest collected module has no cases: ${file}`);
    files.push({ path: file, leaves });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { schemaVersion: 1, kind: 'splatview-vitest-case-collection', files };
}

/**
 * Collecting actual declarations evaluates modules and describe factories and any
 * configured Vitest setup. It does not execute test bodies or test lifecycle hooks.
 * Collection is CPU-only; browser/typecheck projects are refused before collection.
 * close() joins every worker/server before the caller can publish the inventory.
 */
export async function collectVitestCases(options: CollectVitestOptions): Promise<VitestCaseCollection> {
  const workspace = new Workspace(options.root), tests = [...options.tests ?? []], seen = new Set<string>();
  for (const filter of tests) {
    relativePath(filter);
    if (seen.has(filter.toLowerCase())) throw new Error('Duplicate/case-aliased Vitest collection filter');
    seen.add(filter.toLowerCase());
    await workspace.safe(filter);
  }
  if (options.config !== undefined) await workspace.safe(relativePath(options.config));
  const context = await createVitest({ root: workspace.root, watch: false, run: false, reporters: [],
    maxWorkers: 1, fileParallelism: false, cache: false, dangerouslyIgnoreUnhandledErrors: false,
    ...(options.config === undefined ? {} : { config: path.join(workspace.root, options.config) }),
  });
  let collection: VitestCaseCollection | undefined;
  try {
    if (context.projects.some(project => project.isBrowserEnabled() || project.config.typecheck.enabled)) throw new Error('Release Vitest collector only accepts CPU test projects');
    const result = await context.collect(tests, { staticParse: false });
    if (result.unhandledErrors.length) throw new Error('Unhandled errors during Vitest case collection');
    collection = collectionFromModules(workspace.root, result.testModules);
    for (const file of collection.files) await workspace.safe(file.path);
    if (tests.length && (collection.files.length !== tests.length || collection.files.some(file => !seen.has(file.path.toLowerCase())))) throw new Error('Vitest collection filters did not resolve to the exact requested source files');
  } finally { await context.close(); }
  if (process.exitCode !== undefined && Number(process.exitCode) !== 0) throw new Error('Vitest collection or joined cleanup set a failing process exit code');
  if (collection === undefined) throw new Error('Vitest did not produce a case collection');
  return collection;
}

export function parseCollectionArguments(args: readonly string[]): { output: string; tests: string[]; config?: string } {
  let output: string | undefined, config: string | undefined;
  const tests: string[] = [];
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error('Missing Vitest collection argument value');
    relativePath(value);
    if (flag === '--output' && output === undefined) output = value;
    else if (flag === '--config' && config === undefined) config = value;
    else if (flag === '--test') tests.push(value);
    else throw new Error('Unknown or duplicated Vitest collection argument');
  }
  if (output === undefined) throw new Error('Usage: node tools/release/collect-vitest.ts --output NEW_WORKSPACE_RELATIVE_JSON [--test WORKSPACE_TEST_PATH ...] [--config WORKSPACE_CONFIG_PATH]');
  return { output, tests, ...(config === undefined ? {} : { config }) };
}
async function main(): Promise<void> {
  const args = parseCollectionArguments(process.argv.slice(2));
  const workspace = new Workspace(process.cwd(), 64 * 1024 * 1024, 128 * 1024 * 1024);
  await workspace.safe(args.output, true);
  const collection = await collectVitestCases({ root: workspace.root, tests: args.tests, ...(args.config === undefined ? {} : { config: args.config }) });
  await workspace.writeExclusive(args.output, collection);
  process.stdout.write(JSON.stringify({ files: collection.files.length, cases: collection.files.reduce((sum, file) => sum + file.leaves.length, 0), output: args.output }) + '\n');
}
if (process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
