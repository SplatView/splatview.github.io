/** Owned external Chromium + its existing default context, preserving genuine tab visibility.
 * Mechanism reference: .build/orbit-observation-tests/probe-visibility-05.mjs and
 * visibility-mechanism-05.json; retained-session download proof is probe-host-04.ts
 * and host-mechanism-04.json. This factory itself makes no performance claim.
 */
import { spawn } from 'node:child_process';
import { mkdir, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { chromium, type Browser, type BrowserContext, type CDPSession, type ConnectOverCDPOptions, type Page } from '@playwright/test';
import { Workspace, digest, relativePath } from '../release/files.ts';
import type { FileRef } from '../release/types.ts';
import type { ProbeDownload, ProductionProbeBrowserOwner } from './run.ts';

export const HOST_LOG_LIMIT = 65_536;
export const HOST_DOWNLOAD_LIMIT = 128 * 1024 * 1024;
const DOWNLOAD_EVENT_LIMIT = 256, DOWNLOAD_ATTEMPT_LIMIT = 16;
export interface VisibilityChild {
  readonly pid?: number;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  once(event: 'exit' | 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: 'error', listener: (error: Error) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}
export interface BrowserHostDependencies {
  root?: string;
  executablePath(): string;
  spawn(executable: string, arguments_: string[]): VisibilityChild;
  connect(url: string, options: ConnectOverCDPOptions): Promise<Browser>;
  readPort?(path: string): Promise<Uint8Array>;
  now?(): number;
  sleep?(milliseconds: number): Promise<void>;
  portTimeoutMs?: number;
  closeTimeoutMs?: number;
  downloadTimeoutMs?: number;
}
export interface VisibilityBrowserOptions { directory: string; metadata: Record<string, unknown> }
export interface ChildTerminal {
  code: number | null; signal: NodeJS.Signals | null; spawnError: string | null;
  exitObserved: boolean; closeObserved: boolean; forcedTermination: boolean;
  disposition: 'clean' | 'nonzero' | 'signal' | 'spawn-failed' | 'forced';
}

const errorText = (error: unknown): string => (error instanceof Error ? error.stack ?? error.message : String(error)).slice(0, 16_384);
export function validateBrowserHostDirectory(value: string): string {
  relativePath(value);
  if (!/^\.build\/bench-hosts\/[a-z0-9][a-z0-9._-]{0,79}\/[a-z0-9][a-z0-9._-]{0,79}$/u.test(value))
    throw new Error('Browser owner directory must be .build/bench-hosts/SAFE_RUN/SAFE_OWNER.');
  return value;
}
export function parseDevToolsActivePort(bytes: Uint8Array): { port: number; browserPath: string } {
  if (bytes.byteLength < 1 || bytes.byteLength > 4096) throw new Error('Invalid DevToolsActivePort byte bound.');
  const lines = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trimEnd().split(/\r?\n/u);
  if (lines.length !== 2 || !/^[1-9][0-9]{0,4}$/u.test(lines[0]!) ||
      !/^\/devtools\/browser\/[A-Za-z0-9-]{1,128}$/u.test(lines[1]!)) throw new Error('Invalid owned DevToolsActivePort content.');
  const port = Number(lines[0]);
  if (!Number.isSafeInteger(port) || port > 65535) throw new Error('Invalid owned local CDP port.');
  return { port, browserPath: lines[1]! };
}
export function childTerminalDisposition(value: Omit<ChildTerminal, 'disposition'>): ChildTerminal['disposition'] {
  return value.forcedTermination ? 'forced' : value.spawnError ? 'spawn-failed' : value.signal ? 'signal' : value.code === 0 && value.exitObserved ? 'clean' : 'nonzero';
}
export class BoundedHostLog {
  private chunks: Uint8Array[] = [];
  observedBytes = 0;
  capturedBytes = 0;
  readonly maximumBytes: number;
  constructor(maximumBytes = HOST_LOG_LIMIT) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > HOST_LOG_LIMIT) throw new Error('Invalid host log bound.');
    this.maximumBytes = maximumBytes;
  }
  append(input: Uint8Array | string): void {
    const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
    this.observedBytes += bytes.byteLength;
    const retained = bytes.subarray(0, Math.max(0, this.maximumBytes - this.capturedBytes));
    if (retained.byteLength) { this.chunks.push(retained.slice()); this.capturedBytes += retained.byteLength; }
  }
  get droppedBytes(): number { return this.observedBytes - this.capturedBytes; }
  bytes(): Uint8Array {
    const result = new Uint8Array(this.capturedBytes); let offset = 0;
    for (const chunk of this.chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  }
}

async function bounded<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' timed out.')), milliseconds); })]);
  } finally { clearTimeout(timer); }
}
async function readPortFile(workspace: Workspace, logical: string): Promise<Uint8Array> {
  const absolute = await workspace.safe(logical), handle = await open(absolute, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > 4096) throw new Error('Owned port file is not regular or exceeds 4096 bytes.');
    const bytes = new Uint8Array(before.size + 1); let used = 0;
    while (used < bytes.byteLength) { const part = await handle.read(bytes, used, bytes.byteLength - used, null); if (!part.bytesRead) break; used += part.bytesRead; }
    const after = await handle.stat();
    if (used !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('Owned port file changed during read.');
    await workspace.safe(logical); return bytes.subarray(0, used);
  } finally { await handle.close(); }
}
async function writeBytes(workspace: Workspace, name: string, bytes: Uint8Array): Promise<FileRef> {
  const absolute = await workspace.safe(name, true), handle = await open(absolute, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await workspace.safe(name); return { path: name, bytes: bytes.byteLength, sha256: digest(bytes) };
}

interface DownloadBegin { frameId: string; guid: string; url: string; suggestedFilename: string }
interface DownloadProgress { guid: string; totalBytes: number; receivedBytes: number; state: 'inProgress' | 'completed' | 'canceled'; filePath?: string }
type DownloadEvent = { event: 'Browser.downloadWillBegin'; value: DownloadBegin } | { event: 'Browser.downloadProgress'; value: DownloadProgress };
interface PendingDownload {
  frames: Set<string> | null; buffered: DownloadEvent[]; begin: DownloadBegin | null; finishing: boolean;
  observation: Record<string, unknown>; timer: ReturnType<typeof setTimeout>;
  resolve(value: ProbeDownload): void; reject(error: Error): void;
}

/** Page.getFrameTree identities, not page URLs, correlate actual browser download events. */
function downloadFrameIds(tree: unknown): Set<string> {
  const result = new Set<string>(); let count = 0;
  const visit = (value: unknown, depth: number): void => {
    if (!value || typeof value !== 'object' || ++count > 64 || depth > 32) throw new Error('Invalid or excessive download frame tree.');
    const node = value as { frame?: { id?: unknown }; childFrames?: unknown };
    if (typeof node.frame?.id !== 'string' || !node.frame.id || node.frame.id.length > 256) throw new Error('Missing actual download frame identity.');
    result.add(node.frame.id);
    if (node.childFrames !== undefined) {
      if (!Array.isArray(node.childFrames)) throw new Error('Invalid download child frame tree.');
      for (const child of node.childFrames) visit(child, depth + 1);
    }
  };
  visit(tree, 0); return result;
}

const defaults: BrowserHostDependencies = {
  executablePath: () => chromium.executablePath(),
  spawn: (executable, arguments_) => spawn(executable, arguments_, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }),
  connect: (url, options) => chromium.connectOverCDP(url, options),
};

/** Injection is for bounded fake-process unit checks; default launch uses the actual pinned Playwright browser. */
export function createVisibilityBrowserFactory(dependencies: BrowserHostDependencies) {
  return async (options: VisibilityBrowserOptions): Promise<ProductionProbeBrowserOwner> => {
    const metadata = options.metadata;
    Object.assign(metadata, { kind: 'splatview-owned-visibility-browser', status: 'launching', startedAtUtc: new Date().toISOString(),
      directory: options.directory, browserChannel: 'chromium-external-cdp', headless: true, noDefaults: true,
      processId: null, browserVersion: null, childExit: null, childJoined: false, cdpJoined: false,
      forcedTermination: false, cleanupErrors: [], launchError: null, hostReceipt: null });
    const workspace = new Workspace(resolve(dependencies.root ?? process.cwd()), 1024 * 1024, 8 * 1024 * 1024);
    const downloadWorkspace = new Workspace(workspace.root, HOST_DOWNLOAD_LIMIT, HOST_DOWNLOAD_LIMIT * 2);
    const now = dependencies.now ?? (() => performance.now()), sleep = dependencies.sleep ?? (ms => new Promise(resolveWait => setTimeout(resolveWait, ms)));
    const portTimeout = dependencies.portTimeoutMs ?? 10_000, closeTimeout = dependencies.closeTimeoutMs ?? 5_000;
    const downloadTimeout = dependencies.downloadTimeoutMs ?? 30_000;
    let child: VisibilityChild | undefined, browser: Browser | undefined, context: BrowserContext | undefined;
    let terminal: ChildTerminal | undefined, exitObserved = false, exitCode: number | null = null, exitSignal: NodeJS.Signals | null = null, spawnError: string | null = null;
    let resolveTerminal: ((value: ChildTerminal) => void) | undefined, terminalPromise: Promise<ChildTerminal> | undefined;
    let directoryReady = false, closePromise: Promise<void> | undefined;
    let downloadSession: CDPSession | undefined, pendingDownload: PendingDownload | undefined, closing = false;
    const downloadTasks = new Set<Promise<void>>();
    const downloadCapture = { kind: 'splatview-owned-cdp-download-capture', mechanism: 'retained-browser-cdp-session',
      maximumDownloadBytes: HOST_DOWNLOAD_LIMIT, maximumEventRecords: DOWNLOAD_EVENT_LIMIT, maximumAttempts: DOWNLOAD_ATTEMPT_LIMIT,
      maximumEventBytes: 256 * 1024, capturedEventBytes: 0,
      eventsObserved: 0, eventsCaptured: 0, eventsDropped: 0, events: [] as DownloadEvent[], attempts: [] as Record<string, unknown>[] };
    metadata.downloadCapture = downloadCapture;
    const stdout = new BoundedHostLog(), stderr = new BoundedHostLog(), cleanupErrors = metadata.cleanupErrors as string[];
    const streamErrors: string[] = [];
    const failDownload = (pending: PendingDownload, error: unknown): void => {
      if (pendingDownload !== pending) return;
      clearTimeout(pending.timer); pendingDownload = undefined;
      pending.observation.status = 'failed'; pending.observation.error = errorText(error);
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    };
    const trackDownloadTask = (pending: PendingDownload, task: Promise<void>): void => {
      const handled = task.catch(error => failDownload(pending, error));
      downloadTasks.add(handled); void handled.then(() => downloadTasks.delete(handled));
    };
    const consumeDownloadEvent = (pending: PendingDownload, event: DownloadEvent): void => {
      if (pendingDownload !== pending || pending.finishing) return;
      if (!pending.frames) { pending.buffered.push(event); return; }
      if (event.event === 'Browser.downloadWillBegin') {
        if (!pending.frames.has(event.value.frameId)) {
          pending.observation.ignoredOtherFrameBegins = Number(pending.observation.ignoredOtherFrameBegins) + 1; return;
        }
        if (pending.begin) { failDownload(pending, new Error('More than one actual download began for the pending page.')); return; }
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(event.value.guid)) {
          failDownload(pending, new Error('Actual download GUID is not a safe owned file name.')); return;
        }
        pending.begin = event.value; pending.observation.begin = event.value; return;
      }
      if (!pending.begin || event.value.guid !== pending.begin.guid) return;
      const progress = event.value;
      (pending.observation.progress as DownloadProgress[]).push(progress);
      if (!Number.isSafeInteger(progress.receivedBytes) || progress.receivedBytes < 0 || progress.receivedBytes > HOST_DOWNLOAD_LIMIT ||
          !Number.isSafeInteger(progress.totalBytes) || progress.totalBytes < 0 || progress.totalBytes > HOST_DOWNLOAD_LIMIT) {
        failDownload(pending, new Error('Actual download exceeds its finite byte bound.')); return;
      }
      if (progress.state === 'canceled') { failDownload(pending, new Error('Actual browser download was canceled.')); return; }
      if (progress.state !== 'completed') return;
      pending.finishing = true;
      trackDownloadTask(pending, (async () => {
        const logical = options.directory + '/downloads/' + pending.begin!.guid;
        const absolute = await downloadWorkspace.safe(logical);
        if (progress.filePath !== undefined && resolve(progress.filePath) !== absolute) throw new Error('Actual completed download path differs from its owned GUID file.');
        const actual = await downloadWorkspace.read(logical);
        if (actual.bytes.byteLength !== progress.receivedBytes) throw new Error('Actual download file length differs from completed browser progress.');
        if (pendingDownload !== pending) return;
        pending.observation.file = { ...actual.reference, lifecycle: 'ephemeral-owned-browser-cache' };
        pending.observation.status = 'completed'; pending.observation.error = null;
        const begin = pending.begin!, bytes = actual.bytes;
        const result: ProbeDownload = { observation: pending.observation, suggestedFilename: () => begin.suggestedFilename,
          failure: async () => null, createReadStream: async () => Readable.from([Buffer.from(bytes)]) };
        clearTimeout(pending.timer); pendingDownload = undefined; pending.resolve(result);
      })());
    };
    const observeDownloadEvent = (event: DownloadEvent): void => {
      downloadCapture.eventsObserved++;
      // Preserve real protocol payloads within a fixed evidence bound. Overflow fails
      // the active capture rather than silently accepting incomplete evidence.
      let copy: DownloadEvent;
      try {
        const encoded = JSON.stringify(event);
        const size = Buffer.byteLength(encoded);
        if (size > 16_384 || downloadCapture.capturedEventBytes + size > downloadCapture.maximumEventBytes ||
            downloadCapture.events.length >= DOWNLOAD_EVENT_LIMIT) throw new Error('Owned download event evidence bound exceeded.');
        copy = JSON.parse(encoded) as DownloadEvent;
        downloadCapture.events.push(copy); downloadCapture.eventsCaptured++; downloadCapture.capturedEventBytes += size;
      } catch (error) {
        downloadCapture.eventsDropped++; if (pendingDownload) failDownload(pendingDownload, error); return;
      }
      if (pendingDownload) consumeDownloadEvent(pendingDownload, copy);
    };
    const onDownloadBegin = (value: DownloadBegin): void => observeDownloadEvent({ event: 'Browser.downloadWillBegin', value });
    const onDownloadProgress = (value: DownloadProgress): void => observeDownloadEvent({ event: 'Browser.downloadProgress', value });
    const waitForDownload = (page: Page): Promise<ProbeDownload> => {
      const rejected = (error: Error): Promise<ProbeDownload> => { const promise = Promise.reject<ProbeDownload>(error); void promise.catch(() => {}); return promise; };
      if (closing || !downloadSession || !context) return rejected(new Error('Owned download session is unavailable or closing.'));
      if (pendingDownload) return rejected(new Error('Only one owned download may be pending.'));
      if (downloadCapture.attempts.length >= DOWNLOAD_ATTEMPT_LIMIT || downloadCapture.eventsDropped) return rejected(new Error('Owned download capture evidence bound exhausted.'));
      if (page.context() !== context) return rejected(new Error('Download page does not belong to the owned default context.'));
      let resolveDownload!: (value: ProbeDownload) => void, rejectDownload!: (error: Error) => void;
      const promise = new Promise<ProbeDownload>((resolveValue, rejectValue) => { resolveDownload = resolveValue; rejectDownload = rejectValue; });
      void promise.catch(() => {}); // Lifecycle cancellation may precede the action caller attaching its handler.
      const observation: Record<string, unknown> = { kind: 'splatview-owned-cdp-download', status: 'waiting', begin: null,
        progress: [], frameIds: null, ignoredOtherFrameBegins: 0, file: null, error: null, timingClaim: 'none' };
      const pending: PendingDownload = { frames: null, buffered: [], begin: null, finishing: false, observation,
        resolve: resolveDownload, reject: rejectDownload, timer: setTimeout(() => failDownload(pending, new Error('Actual owned download timed out.')), downloadTimeout) };
      // The pending subscription exists before any awaited frame-identity lookup.
      pendingDownload = pending; downloadCapture.attempts.push(observation);
      trackDownloadTask(pending, (async () => {
        let pageSession: CDPSession | undefined;
        try {
          pageSession = await bounded(context!.newCDPSession(page), portTimeout, 'Download page identity session');
          const result = await bounded(pageSession.send('Page.getFrameTree'), portTimeout, 'Download page frame identity');
          const identitySession = pageSession; pageSession = undefined;
          await bounded(identitySession.detach(), portTimeout, 'Download page identity detach');
          if (pendingDownload !== pending) return;
          pending.frames = downloadFrameIds(result.frameTree); observation.frameIds = [...pending.frames];
          const buffered = pending.buffered.splice(0);
          for (const event of buffered) consumeDownloadEvent(pending, event);
        } finally { if (pageSession) await bounded(pageSession.detach(), portTimeout, 'Download page identity detach'); }
      })());
      return promise;
    };
    const close = (): Promise<void> => {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        closing = true;
        if (pendingDownload) failDownload(pendingDownload, new Error('Owned browser closed before the download completed.'));
        await Promise.all([...downloadTasks]);
        if (downloadSession) {
          downloadSession.off('Browser.downloadWillBegin', onDownloadBegin); downloadSession.off('Browser.downloadProgress', onDownloadProgress);
          try { await bounded(downloadSession.detach(), closeTimeout, 'Retained download session detach'); metadata.downloadSessionDetached = true; }
          catch (error) { cleanupErrors.push(errorText(error)); metadata.downloadSessionDetached = false; }
        }
        if (browser) {
          try {
            if (browser.isConnected()) {
              const session = await bounded(browser.newBrowserCDPSession(), closeTimeout, 'Browser close session');
              await bounded(session.send('Browser.close'), closeTimeout, 'Browser.close command');
            }
          } catch (error) { cleanupErrors.push(errorText(error)); }
          try { await bounded(browser.close(), closeTimeout, 'CDP connection close'); metadata.cdpJoined = true; }
          catch (error) { cleanupErrors.push(errorText(error)); metadata.cdpJoined = !browser.isConnected(); }
        } else metadata.cdpJoined = true; // No CDP connection was created.
        if (child && terminalPromise) {
          try { terminal = await bounded(terminalPromise, closeTimeout, 'Owned Chromium process join'); }
          catch (error) {
            metadata.forcedTermination = true; cleanupErrors.push(errorText(error));
            metadata.terminationSignal = 'SIGTERM';
            try { metadata.terminationRequested = child.kill('SIGTERM'); } catch (failure) { cleanupErrors.push(errorText(failure)); }
            try { terminal = await bounded(terminalPromise, closeTimeout, 'Terminated Chromium process join'); }
            catch (failure) {
              cleanupErrors.push(errorText(failure)); metadata.terminationSignal = 'SIGKILL';
              try { metadata.terminationRequested = child.kill('SIGKILL'); } catch (killFailure) { cleanupErrors.push(errorText(killFailure)); }
              try { terminal = await bounded(terminalPromise, closeTimeout, 'Forced Chromium process join'); }
              catch (finalFailure) { cleanupErrors.push(errorText(finalFailure)); }
            }
          }
          if (terminal) {
            terminal.forcedTermination = metadata.forcedTermination === true;
            terminal.disposition = childTerminalDisposition(terminal);
            metadata.childExit = terminal; metadata.childJoined = true;
            if (terminal.disposition !== 'clean') cleanupErrors.push('Owned Chromium terminal disposition: ' + terminal.disposition);
          }
        } else metadata.childJoinNotRequiredReason = 'No child process handle was created.';
        cleanupErrors.push(...streamErrors);
        metadata.endedAtUtc = new Date().toISOString();
        metadata.status = cleanupErrors.length || metadata.launchError ? 'failed' : 'joined';
        if (directoryReady) {
          try {
            metadata.stdout = { observedBytes: stdout.observedBytes, capturedBytes: stdout.capturedBytes, droppedBytes: stdout.droppedBytes,
              artifact: await writeBytes(workspace, options.directory + '/stdout.log', stdout.bytes()) };
            metadata.stderr = { observedBytes: stderr.observedBytes, capturedBytes: stderr.capturedBytes, droppedBytes: stderr.droppedBytes,
              artifact: await writeBytes(workspace, options.directory + '/stderr.log', stderr.bytes()) };
            const receipt = options.directory + '/host-receipt.json';
            await workspace.writeExclusive(receipt, { ...metadata, hostReceipt: null });
            metadata.hostReceipt = (await workspace.read(receipt)).reference;
          } catch (error) { cleanupErrors.push(errorText(error)); metadata.status = 'failed'; }
        }
        if (cleanupErrors.length) throw new Error('Owned visibility browser cleanup failed: ' + cleanupErrors.join('\n'));
      })();
      return closePromise;
    };
    try {
      validateBrowserHostDirectory(options.directory);
      if (!Number.isFinite(portTimeout) || portTimeout <= 0 || !Number.isFinite(closeTimeout) || closeTimeout <= 0 ||
          !Number.isFinite(downloadTimeout) || downloadTimeout <= 0) throw new Error('Invalid browser owner timeout bound.');
      const parts = options.directory.split('/');
      for (let length = 1; length < parts.length; length++) {
        const logical = parts.slice(0, length).join('/'), absolute = await workspace.safe(logical, true);
        try { await mkdir(absolute); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        await workspace.safe(logical);
      }
      await mkdir(await workspace.safe(options.directory, true)); await workspace.safe(options.directory); directoryReady = true;
      const profile = options.directory + '/profile', downloads = options.directory + '/downloads';
      await mkdir(await workspace.safe(profile, true)); await mkdir(await workspace.safe(downloads, true));
      const executable = dependencies.executablePath(), profilePath = await workspace.safe(profile), downloadsPath = await workspace.safe(downloads);
      const arguments_ = ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profilePath}`,
        '--no-first-run', '--no-default-browser-check', '--enable-automation', '--enable-unsafe-webgpu', '--headless=new', '--force-device-scale-factor=1', '--window-size=1280,800', 'about:blank'];
      Object.assign(metadata, { executable, launchArguments: arguments_, profileDirectory: profile, downloadsDirectory: downloads });
      child = dependencies.spawn(executable, arguments_); metadata.processId = child.pid ?? null;
      terminalPromise = new Promise(resolveExit => { resolveTerminal = resolveExit; });
      child.once('error', error => { spawnError = errorText(error); metadata.spawnError = spawnError; });
      child.once('exit', (code, signal) => { exitObserved = true; exitCode = code; exitSignal = signal; metadata.childExitObservedAtUtc = new Date().toISOString(); });
      child.once('close', (code, signal) => {
        const value = { code: exitObserved ? exitCode : code, signal: exitObserved ? exitSignal : signal, spawnError,
          exitObserved, closeObserved: true, forcedTermination: metadata.forcedTermination === true };
        terminal = { ...value, disposition: childTerminalDisposition(value) }; resolveTerminal!(terminal);
      });
      child.stdout?.on('data', (bytes: Uint8Array | string) => stdout.append(bytes));
      child.stderr?.on('data', (bytes: Uint8Array | string) => stderr.append(bytes));
      child.stdout?.on('error', error => streamErrors.push(errorText(error))); child.stderr?.on('error', error => streamErrors.push(errorText(error)));
      const deadline = now() + portTimeout;
      let port: ReturnType<typeof parseDevToolsActivePort> | undefined, portBytes: Uint8Array | undefined, lastPortError: string | null = null;
      do {
        if (exitObserved || terminal || spawnError) throw new Error('Owned Chromium exited or failed before its debugging port was available.');
        try {
          portBytes = await bounded(dependencies.readPort ? dependencies.readPort(profilePath) : readPortFile(workspace, profile + '/DevToolsActivePort'), Math.min(1000, portTimeout), 'Owned debugging port read');
          port = parseDevToolsActivePort(portBytes); break;
        } catch (error) { lastPortError = errorText(error); }
        await sleep(100);
      } while (now() < deadline);
      if (!port || !portBytes) throw new Error('Owned Chromium did not publish a bounded local debugging port: ' + lastPortError);
      const endpoint = `http://127.0.0.1:${port.port}`;
      Object.assign(metadata, { debuggingPort: port.port, cdpEndpoint: endpoint, browserWebSocketUrl: `ws://127.0.0.1:${port.port}${port.browserPath}`,
        activePort: await writeBytes(workspace, options.directory + '/devtools-active-port.txt', portBytes) });
      // Playwright owns its connection timeout and cleanup. Do not race away
      // a still-connecting Browser handle that could subsequently be orphaned.
      browser = await dependencies.connect(endpoint, { noDefaults: true, isLocal: true, artifactsDir: downloadsPath, timeout: portTimeout });
      if (exitObserved || terminal || spawnError) throw new Error('Owned Chromium terminated while its CDP connection was being established.');
      context = browser.contexts()[0]; if (!context) throw new Error('External Chromium has no existing default context.');
      metadata.browserVersion = browser.version(); metadata.defaultContext = true;
      // Actual probe-host-04 proves policy + events on this retained public session.
      // noDefaults leaves Playwright's separate internal root-session policy unset.
      downloadSession = await bounded(browser.newBrowserCDPSession(), portTimeout, 'Download policy session');
      downloadSession.on('Browser.downloadWillBegin', onDownloadBegin); downloadSession.on('Browser.downloadProgress', onDownloadProgress);
      await bounded(downloadSession.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: downloadsPath, eventsEnabled: true }), portTimeout, 'Download policy command');
      metadata.downloadBehavior = 'allowAndName'; metadata.downloadEventsEnabled = true; metadata.downloadSessionDetached = false;
      metadata.status = 'connected';
      await workspace.writeExclusive(options.directory + '/launch.json', { ...metadata, stdout: null, stderr: null });
      return { browser, context, metadata, close, waitForDownload };
    } catch (error) {
      metadata.launchError = errorText(error); metadata.status = 'failed';
      try { await close(); } catch { /* Exact cleanup failures stay in caller-owned metadata and host records. */ }
      throw error;
    }
  };
}

export const launchVisibilityBrowser = createVisibilityBrowserFactory(defaults);
