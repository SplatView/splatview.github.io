import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, realpath, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'vitest';
import type { Browser, BrowserContext, ConnectOverCDPOptions, Page } from '@playwright/test';
import { BoundedHostLog, HOST_DOWNLOAD_LIMIT, childTerminalDisposition, createVisibilityBrowserFactory, parseDevToolsActivePort,
  validateBrowserHostDirectory, type BrowserHostDependencies, type VisibilityChild } from '../tools/bench/browser-host.ts';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function workspace(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'splatview-browser-host-unit-'))); roots.push(root); return root;
}
const portBytes = () => new TextEncoder().encode('54585\n/devtools/browser/test-owned-browser\n');
class FakeChild extends EventEmitter {
  readonly pid = 12345;
  readonly stdout = new PassThrough(); readonly stderr = new PassThrough();
  readonly signals: (NodeJS.Signals | undefined)[] = [];
  closed = false;
  finish(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    if (this.closed) return; this.closed = true;
    this.stdout.end(); this.stderr.end(); this.emit('exit', code, signal); this.emit('close', code, signal);
  }
  kill(signal?: NodeJS.Signals): boolean { this.signals.push(signal); this.finish(null, signal ?? 'SIGTERM'); return true; }
}
async function fixture(options: { connectError?: boolean; closeError?: boolean; invalidPort?: boolean; earlyExit?: boolean;
  downloadDetachError?: boolean; frameLookup?: () => Promise<{ frameTree: { frame: { id: string } } }> } = {}) {
  const root = await workspace(), child = new FakeChild(), metadata: Record<string, unknown> = {};
  const connections: { url: string; options: ConnectOverCDPOptions }[] = [], commands: { method: string; parameters: unknown }[] = [];
  const spawnCalls: { executable: string; arguments: string[] }[] = [];
  let connected = true, closeCalls = 0, milliseconds = 0;
  let downloadDetachCalls = 0, browserSessionCalls = 0;
  const downloadSession = Object.assign(new EventEmitter(), {
    send: async (method: string, parameters?: unknown) => { commands.push({ method, parameters }); return {}; },
    detach: async () => { downloadDetachCalls++; if (options.downloadDetachError) throw new Error('fake retained download detach failure'); },
  });
  const context = { fakeUnitContext: true, newCDPSession: async () => ({
    send: async (method: string) => { assert.equal(method, 'Page.getFrameTree'); return options.frameLookup ? options.frameLookup() : { frameTree: { frame: { id: 'owned-main-frame' } } }; },
    detach: async () => undefined,
  }) } as unknown as BrowserContext;
  const page = { context: () => context } as unknown as Page;
  const browser = {
    contexts: () => [context], version: () => 'unit-fake-not-observed-browser', isConnected: () => connected,
    newBrowserCDPSession: async () => ++browserSessionCalls === 1 ? downloadSession : ({
      send: async (method: string, parameters?: unknown) => { commands.push({ method, parameters }); if (method === 'Browser.close') child.finish(); return {}; },
      detach: async () => undefined,
    }),
    close: async () => { closeCalls++; connected = false; if (options.closeError) throw new Error('fake CDP cleanup failure'); },
  } as unknown as Browser;
  const dependencies: BrowserHostDependencies = {
    root, executablePath: () => 'unit-fake-chromium-executable',
    spawn(executable, arguments_) {
      spawnCalls.push({ executable, arguments: [...arguments_] });
      queueMicrotask(() => { child.stdout.write('fake stdout\n'); child.stderr.write('fake stderr\n'); if (options.earlyExit) child.finish(7); });
      return child as VisibilityChild;
    },
    async connect(url, actualOptions) {
      connections.push({ url, options: actualOptions }); if (options.connectError) throw new Error('fake connection refusal'); return browser;
    },
    readPort: async () => options.invalidPort ? new TextEncoder().encode('bad-port') : portBytes(),
    now: () => milliseconds, sleep: async duration => { milliseconds += duration; }, portTimeoutMs: 100, closeTimeoutMs: 20, downloadTimeoutMs: 10_000,
  };
  const launch = createVisibilityBrowserFactory(dependencies), directory = '.build/bench-hosts/unit-run/owner-01';
  return { root, child, metadata, context, page, browser, downloadSession, dependencies, connections, commands, spawnCalls, launch, directory,
    closeCalls: () => closeCalls, downloadDetachCalls: () => downloadDetachCalls };
}

test('browser host directory is one exact private run/owner with no traversal, aliases or device names', () => {
  assert.equal(validateBrowserHostDirectory('.build/bench-hosts/run-01/attempt-01'), '.build/bench-hosts/run-01/attempt-01');
  for (const name of ['public/owner', 'dist/owner', '.build/bench-hosts/run', '.build/bench-hosts/run/owner/extra',
    '.build/bench-hosts/../owner', '.build/bench-hosts/run/..', '.build/bench-hosts/run/con',
    '.build/bench-hosts/run/owner.', '.build\\bench-hosts\\run\\owner', 'C:/host/owner'])
    assert.throws(() => validateBrowserHostDirectory(name));
});

test('owned debugging port parser binds a bounded local port and browser path', () => {
  assert.deepEqual(parseDevToolsActivePort(portBytes()), { port: 54585, browserPath: '/devtools/browser/test-owned-browser' });
  for (const text of ['0\n/devtools/browser/a', '65536\n/devtools/browser/a', '01\n/devtools/browser/a',
    '1234\nws://remote.test/browser', '1234\n/devtools/browser/../../other', '1234\n/devtools/browser/a\nextra', 'not-a-port'])
    assert.throws(() => parseDevToolsActivePort(new TextEncoder().encode(text)));
  assert.throws(() => parseDevToolsActivePort(new Uint8Array(4097)));
  assert.throws(() => parseDevToolsActivePort(new Uint8Array([255])));
});

test('bounded host logs retain exact prefix bytes and count every discarded byte independently', () => {
  const log = new BoundedHostLog(4), input = new Uint8Array([1, 2, 3]); log.append(input); input[0] = 9;
  log.append(new Uint8Array([4, 5, 6])); log.append('é');
  assert.deepEqual([...log.bytes()], [1, 2, 3, 4]); assert.equal(log.observedBytes, 8); assert.equal(log.capturedBytes, 4); assert.equal(log.droppedBytes, 4);
  assert.throws(() => new BoundedHostLog(0)); assert.throws(() => new BoundedHostLog(65537));
});

test('forced termination, signal and spawn failure can never be reported as a clean zero exit', () => {
  const base = { code: 0, signal: null, spawnError: null, exitObserved: true, closeObserved: true, forcedTermination: false } as const;
  assert.equal(childTerminalDisposition(base), 'clean');
  assert.equal(childTerminalDisposition({ ...base, forcedTermination: true }), 'forced');
  assert.equal(childTerminalDisposition({ ...base, signal: 'SIGTERM' }), 'signal');
  assert.equal(childTerminalDisposition({ ...base, spawnError: 'failed' }), 'spawn-failed');
  assert.equal(childTerminalDisposition({ ...base, exitObserved: false }), 'nonzero');
  assert.equal(childTerminalDisposition({ ...base, code: 7 }), 'nonzero');
});

test('fake-process lifecycle uses the existing default context, exact CDP options and matching download artifact directory', async () => {
  const value = await fixture(), owner = await value.launch({ directory: value.directory, metadata: value.metadata });
  assert.equal(owner.metadata, value.metadata); assert.equal(owner.context, value.context); assert.equal(owner.browser, value.browser);
  assert.equal(value.metadata.browserChannel, 'chromium-external-cdp'); assert.equal(value.metadata.browserVersion, 'unit-fake-not-observed-browser');
  assert.equal(value.connections.length, 1); assert.equal(value.connections[0]!.url, 'http://127.0.0.1:54585');
  const options = value.connections[0]!.options;
  assert.equal(options.noDefaults, true); assert.equal(options.isLocal, true); assert.equal(options.artifactsDir, join(value.root, value.directory, 'downloads'));
  assert(value.spawnCalls[0]!.arguments.includes('--headless=new')); assert(value.spawnCalls[0]!.arguments.includes('--enable-unsafe-webgpu'));
  assert(value.spawnCalls[0]!.arguments.includes('--force-device-scale-factor=1')); assert(value.spawnCalls[0]!.arguments.includes('--remote-debugging-port=0'));
  assert.deepEqual(value.commands[0], { method: 'Browser.setDownloadBehavior', parameters: { behavior: 'allowAndName', downloadPath: options.artifactsDir, eventsEnabled: true } });
  assert.equal(value.downloadDetachCalls(), 0);
  await owner.close(); await owner.close();
  assert.equal(value.downloadDetachCalls(), 1); assert.equal(value.metadata.downloadSessionDetached, true);
  assert.equal(value.closeCalls(), 1); assert.equal(value.metadata.childJoined, true); assert.equal(value.metadata.cdpJoined, true);
  assert.equal((value.metadata.childExit as { disposition: string }).disposition, 'clean');
  assert.deepEqual(value.child.signals, []); assert.equal(value.metadata.status, 'joined');
  assert.equal(await readFile(join(value.root, value.directory, 'stdout.log'), 'utf8'), 'fake stdout\n');
  assert.equal(await readFile(join(value.root, value.directory, 'stderr.log'), 'utf8'), 'fake stderr\n');
  const receipt = JSON.parse(await readFile(join(value.root, value.directory, 'host-receipt.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(receipt.childJoined, true); assert.equal(receipt.hostReceipt, null); assert(value.metadata.hostReceipt);
});

test('cleanup failure is preserved and thrown after the child actually joins', async () => {
  const value = await fixture({ closeError: true }), owner = await value.launch({ directory: value.directory, metadata: value.metadata });
  await assert.rejects(owner.close(), /cleanup failed/);
  assert.equal(value.metadata.childJoined, true); assert.equal(value.metadata.cdpJoined, true);
  assert.equal(value.metadata.status, 'failed'); assert((value.metadata.cleanupErrors as string[]).some(error => error.includes('fake CDP cleanup failure')));
  assert(value.metadata.hostReceipt);
});

test('launch failure joins its actual child and preserves forced termination rather than replacing the original error', async () => {
  const value = await fixture({ connectError: true });
  await assert.rejects(value.launch({ directory: value.directory, metadata: value.metadata }), /fake connection refusal/);
  assert.equal(value.metadata.childJoined, true); assert.equal(value.metadata.forcedTermination, true);
  assert.equal((value.metadata.childExit as { disposition: string }).disposition, 'forced');
  assert((value.metadata.launchError as string).includes('fake connection refusal')); assert(value.metadata.hostReceipt);
});

test('early nonzero child termination cannot produce a connected owner or a clean terminal receipt', async () => {
  const value = await fixture({ earlyExit: true });
  await assert.rejects(value.launch({ directory: value.directory, metadata: value.metadata }), /terminated|exited|failed/);
  assert.equal(value.metadata.childJoined, true); assert.equal((value.metadata.childExit as { code: number }).code, 7);
  assert.equal((value.metadata.childExit as { disposition: string }).disposition, 'nonzero');
});

test('invalid port polling is bounded and retains caller-owned failure metadata plus process cleanup', async () => {
  const value = await fixture({ invalidPort: true });
  await assert.rejects(value.launch({ directory: value.directory, metadata: value.metadata }), /did not publish/);
  assert.equal(value.connections.length, 0); assert.equal(value.metadata.childJoined, true); assert.equal(value.metadata.status, 'failed');
  assert(value.metadata.hostReceipt);
});

test('an existing owner directory remains immutable and is never reused for another launch', async () => {
  const value = await fixture(), owner = await value.launch({ directory: value.directory, metadata: value.metadata }); await owner.close();
  const path = join(value.root, value.directory, 'host-receipt.json'), before = await readFile(path);
  const laterMetadata: Record<string, unknown> = {};
  await assert.rejects(value.launch({ directory: value.directory, metadata: laterMetadata }), /EEXIST|exist/);
  assert.deepEqual(await readFile(path), before); assert.equal(value.spawnCalls.length, 1);
});

const ownedGuid = 'e01abe37-7dfa-4dfb-99c5-ecb66e6b054a';
const beginEvent = (extra: Record<string, unknown> = {}) => ({ frameId: 'owned-main-frame', guid: ownedGuid,
  url: 'blob:http://unit.invalid/actual-event', suggestedFilename: 'actual-export.splat', ...extra });
const completedEvent = (extra: Record<string, unknown> = {}) => ({ guid: ownedGuid, totalBytes: 3, receivedBytes: 3, state: 'completed', ...extra });
type Capture = { eventsObserved: number; eventsCaptured: number; eventsDropped: number; attempts: Record<string, unknown>[] };

test('retained CDP capture arms before frame lookup, ignores another page and streams only its completed GUID bytes', async () => {
  let resolveFrames!: (value: { frameTree: { frame: { id: string } } }) => void;
  const frames = new Promise<{ frameTree: { frame: { id: string } } }>(resolveValue => { resolveFrames = resolveValue; });
  const value = await fixture({ frameLookup: () => frames }), owner = await value.launch({ directory: value.directory, metadata: value.metadata });
  const pending = owner.waitForDownload!(value.page);
  await assert.rejects(owner.waitForDownload!(value.page), /Only one/);
  value.downloadSession.emit('Browser.downloadWillBegin', beginEvent({ frameId: 'another-page-frame', guid: '11111111-1111-1111-1111-111111111111' }));
  value.downloadSession.emit('Browser.downloadWillBegin', beginEvent());
  const actualPath = join(value.root, value.directory, 'downloads', ownedGuid);
  await writeFile(actualPath, new Uint8Array([1, 3, 7]));
  value.downloadSession.emit('Browser.downloadProgress', completedEvent({ filePath: actualPath }));
  resolveFrames({ frameTree: { frame: { id: 'owned-main-frame' } } });
  const download = await pending;
  assert.equal(download.suggestedFilename(), 'actual-export.splat'); assert.equal(await download.failure(), null);
  const stream = await download.createReadStream(); assert(stream);
  const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  assert.deepEqual([...Buffer.concat(chunks)], [1, 3, 7]);
  const observation = download.observation!;
  assert.equal(observation.status, 'completed'); assert.equal(observation.ignoredOtherFrameBegins, 1); assert.equal(observation.timingClaim, 'none');
  assert.deepEqual(observation.begin, beginEvent());
  assert.deepEqual(observation.file, { path: value.directory + '/downloads/' + ownedGuid, bytes: 3,
    sha256: 'bdf18fb00de1280994a82c7cfa80d233584e296509bfb9d0e5de68950254e79e', lifecycle: 'ephemeral-owned-browser-cache' });
  assert.equal((value.metadata.downloadCapture as Capture).eventsObserved, 3); assert.equal(value.downloadDetachCalls(), 0);
  await owner.close();
  const receipt = JSON.parse(await readFile(join(value.root, value.directory, 'host-receipt.json'), 'utf8')) as { downloadCapture: Capture };
  assert.equal(receipt.downloadCapture.eventsCaptured, 3); assert.equal(receipt.downloadCapture.attempts[0]!.status, 'completed');
});

test('a different context cannot subscribe and another frame cannot satisfy an owned pending download', async () => {
  const value = await fixture(), owner = await value.launch({ directory: value.directory, metadata: value.metadata });
  await assert.rejects(owner.waitForDownload!({ context: () => ({}) } as unknown as Page), /owned default context/);
  const pending = owner.waitForDownload!(value.page), rejected = assert.rejects(pending, /closed before/);
  value.downloadSession.emit('Browser.downloadWillBegin', beginEvent({ frameId: 'unrelated-frame' }));
  value.downloadSession.emit('Browser.downloadProgress', completedEvent());
  await owner.close(); await rejected;
  assert.equal((value.metadata.downloadCapture as Capture).attempts[0]!.status, 'failed');
  await assert.rejects(owner.waitForDownload!(value.page), /closing/);
});

test('actual canceled progress rejects the capture without inventing a readable download', async () => {
  const value = await fixture(), owner = await value.launch({ directory: value.directory, metadata: value.metadata });
  const rejected = assert.rejects(owner.waitForDownload!(value.page), /canceled/);
  value.downloadSession.emit('Browser.downloadWillBegin', beginEvent());
  value.downloadSession.emit('Browser.downloadProgress', completedEvent({ receivedBytes: 0, state: 'canceled' }));
  await rejected; await owner.close();
  const attempt = (value.metadata.downloadCapture as Capture).attempts[0]!;
  assert.equal(attempt.file, null); assert.equal(attempt.status, 'failed'); assert.equal(value.metadata.childJoined, true);
});

test('protocol GUID traversal is rejected and preserved before any owned file read', async () => {
  const value = await fixture(), owner = await value.launch({ directory: value.directory, metadata: value.metadata });
  const rejected = assert.rejects(owner.waitForDownload!(value.page), /GUID/);
  value.downloadSession.emit('Browser.downloadWillBegin', beginEvent({ guid: '../host-receipt.json' }));
  await rejected; await owner.close();
  assert.equal((value.metadata.downloadCapture as Capture).eventsCaptured, 1);
  assert.equal((value.metadata.downloadCapture as Capture).attempts[0]!.file, null);
});

test('completed browser progress cannot redirect the file read outside the exact owned GUID path', async () => {
  const value = await fixture(), owner = await value.launch({ directory: value.directory, metadata: value.metadata });
  await writeFile(join(value.root, value.directory, 'downloads', ownedGuid), new Uint8Array([1, 3, 7]));
  const rejected = assert.rejects(owner.waitForDownload!(value.page), /owned GUID file/);
  value.downloadSession.emit('Browser.downloadWillBegin', beginEvent());
  value.downloadSession.emit('Browser.downloadProgress', completedEvent({ filePath: join(value.root, 'outside-download') }));
  await rejected; await owner.close();
});

test('actual oversized GUID files fail the independent file byte bound even if progress claims three bytes', async () => {
  const value = await fixture(), owner = await value.launch({ directory: value.directory, metadata: value.metadata });
  const actualPath = join(value.root, value.directory, 'downloads', ownedGuid);
  await writeFile(actualPath, new Uint8Array([1, 3, 7])); await truncate(actualPath, HOST_DOWNLOAD_LIMIT + 1);
  const rejected = assert.rejects(owner.waitForDownload!(value.page), /per-file byte bound/);
  value.downloadSession.emit('Browser.downloadWillBegin', beginEvent()); value.downloadSession.emit('Browser.downloadProgress', completedEvent());
  await rejected; await owner.close();
});

test('event evidence overflow fails the pending capture and records the observed/captured difference', async () => {
  const value = await fixture(), owner = await value.launch({ directory: value.directory, metadata: value.metadata });
  const rejected = assert.rejects(owner.waitForDownload!(value.page), /evidence bound/);
  value.downloadSession.emit('Browser.downloadWillBegin', beginEvent({ url: 'x'.repeat(16_385) }));
  await rejected;
  assert.deepEqual(Object.fromEntries(['eventsObserved', 'eventsCaptured', 'eventsDropped'].map(key => [key, (value.metadata.downloadCapture as Record<string, unknown>)[key]])),
    { eventsObserved: 1, eventsCaptured: 0, eventsDropped: 1 });
  await owner.close();
});

test('closing cancels the pending waiter and preserves retained-session cleanup errors after actual clean child join', async () => {
  const value = await fixture({ downloadDetachError: true }), owner = await value.launch({ directory: value.directory, metadata: value.metadata });
  const rejected = assert.rejects(owner.waitForDownload!(value.page), /closed before/);
  await assert.rejects(owner.close(), /retained download detach failure/); await rejected;
  assert.equal(value.metadata.childJoined, true); assert.equal(value.metadata.downloadSessionDetached, false);
  assert.equal((value.metadata.childExit as { disposition: string }).disposition, 'clean');
  assert.equal(value.metadata.status, 'failed'); assert(value.metadata.hostReceipt);
});
