/** Loopback-only mutable host for genuine, immutable W26 build cohorts. */
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, sha256 } from './web-build.mjs';

const CONTROL = '/__offline_test__/';
const BODY_LIMIT = 64 * 1024;
const MAX_COUNTERS = 100_000;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8', '.wasm': 'application/wasm', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2' };
const pathSafe = value => typeof value === 'string' && /^[A-Za-z0-9_./-]+$/.test(value) &&
  !value.startsWith('/') && value.split('/').every(part => part && part !== '.' && part !== '..');
const plainObject = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const onlyKeys = (value, keys) => Object.keys(value).every(key => keys.includes(key));

function checkedPath(value, kind) {
  const path = resolve(value);
  // Reject junctions and aliases in every ancestor, including case aliases on
  // Windows. Only explicitly configured fixture directories can be served.
  for (let current = path;; current = dirname(current)) {
    const info = lstatSync(current);
    if (info.isSymbolicLink() || realpathSync.native(current) !== current) throw new Error(`Linked or noncanonical fixture path: ${current}`);
    if (current !== path && !info.isDirectory()) throw new Error(`Non-directory fixture ancestor: ${current}`);
    if (dirname(current) === current) break;
  }
  const info = lstatSync(path);
  if (kind === 'directory' ? !info.isDirectory() : !info.isFile()) throw new Error(`Invalid fixture ${kind}: ${path}`);
  return path;
}

function inventory(directory) {
  const rows = [];
  function visit(current) {
    checkedPath(current, 'directory');
    for (const name of readdirSync(current).sort()) {
      const path = resolve(current, name), info = lstatSync(path);
      if (info.isSymbolicLink()) throw new Error(`Linked fixture output: ${path}`);
      if (info.isDirectory()) visit(path);
      else if (info.isFile()) {
        checkedPath(path, 'file');
        const name = relative(directory, path).split(sep).join('/');
        if (!pathSafe(name)) throw new Error(`Unsafe fixture output: ${name}`);
        rows.push({ path: name, data: readFileSync(path) });
      } else throw new Error(`Unsupported fixture output: ${path}`);
    }
  }
  visit(directory);
  return rows;
}

function loadCohort(id, value) {
  const directory = checkedPath(value, 'directory'), rows = inventory(directory);
  const files = new Map(rows.map(row => [row.path, row.data]));
  const manifestBytes = files.get('build-manifest.json');
  if (!manifestBytes) throw new Error(`Missing cohort manifest: ${id}`);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (!plainObject(manifest) || manifest.schemaVersion !== 1 || !plainObject(manifest.build) ||
      !Array.isArray(manifest.artifacts) || !/^[a-f0-9]{64}$/.test(manifest.deploymentId ?? '')) throw new Error(`Invalid cohort manifest: ${id}`);
  const { deploymentId, ...payload } = manifest;
  if (sha256(canonicalJson(payload)) !== deploymentId) throw new Error(`Cohort manifest identity differs: ${id}`);
  const expected = new Set(['build-manifest.json']), aliases = new Set(['build-manifest.json']);
  for (const artifact of manifest.artifacts) {
    if (!plainObject(artifact) || !pathSafe(artifact.path) || aliases.has(artifact.path.toLowerCase()) ||
        !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0 || !/^[a-f0-9]{64}$/.test(artifact.sha256 ?? '')) throw new Error(`Invalid cohort artifact: ${id}`);
    expected.add(artifact.path);aliases.add(artifact.path.toLowerCase());
    const data = files.get(artifact.path);
    if (!data || data.length !== artifact.bytes || sha256(data) !== artifact.sha256) throw new Error(`Cohort artifact differs: ${id}/${artifact.path}`);
  }
  const scripts = ['application-entry', 'document-worker'].map(role => {
    const matches = manifest.artifacts.filter(artifact => artifact.role === role);
    if (matches.length !== 1) throw new Error(`Ambiguous ${role} in cohort ${id}`);
    return matches[0].path;
  });
  const renderWorkers = manifest.artifacts.filter(artifact => artifact.role === 'runtime-asset' && /^assets\/compute\.worker-[A-Za-z0-9_-]+\.js$/.test(artifact.path));
  if (renderWorkers.length > 1) throw new Error(`Ambiguous render executor in cohort ${id}`);
  scripts.push(...renderWorkers.map(artifact => artifact.path));
  const serviceWorker = manifest.artifacts.find(artifact => artifact.path === 'service-worker.js' && artifact.role === 'runtime-asset');
  if (!serviceWorker) throw new Error(`Offline cohort requires a genuine root service-worker.js: ${id}`);
  for (const path of [...scripts, 'service-worker.js']) {
    const mapPath = `${path}.map`, data = files.get(mapPath);
    if (!data) throw new Error(`Missing current cohort source map: ${id}/${mapPath}`);
    const map = JSON.parse(data.toString('utf8'));
    if (map.version !== 3 || map.file !== basename(path) || !files.get(path).toString('utf8').includes(`sourceMappingURL=${basename(mapPath)}`)) throw new Error(`Unowned cohort source map: ${id}/${mapPath}`);
    expected.add(mapPath);
  }
  for (const path of files.keys()) if (!expected.has(path)) throw new Error(`Unowned cohort output: ${id}/${path}`);
  for (const path of expected) if (!files.has(path)) throw new Error(`Missing cohort output: ${id}/${path}`);
  return { id, directory, files, metadata: { id, directory, deploymentId, appInputId: manifest.build.appInputId,
    coreNativeInputId: manifest.build.native?.core?.nativeInputId, serviceWorkerSha256: serviceWorker.sha256,
    manifestSha256: sha256(manifestBytes), runtimeArtifacts: manifest.artifacts.length, files: files.size } };
}

function parseArgs(argv) {
  const options = { port: 5373, cohorts: [] }, seen = new Set();
  for (const argument of argv) {
    const match = /^--(root|project|port|cohort|certificate|key)=(.+)$/.exec(argument);
    if (!match || (match[1] !== 'cohort' && seen.has(match[1]))) throw new Error(`Invalid or duplicate host argument: ${argument}`);
    seen.add(match[1]);
    if (match[1] === 'cohort') {
      const definition = /^([A-Za-z][A-Za-z0-9_-]{0,31}):(.+)$/.exec(match[2]);
      if (!definition) throw new Error('Use --cohort=A:qualified-dist-directory');
      options.cohorts.push({ id: definition[1], directory: definition[2] });
    } else options[match[1]] = match[2];
  }
  options.port = Number(options.port);
  if (!Number.isSafeInteger(options.port) || options.port < 1 || options.port > 65535 || !options.root || !options.project ||
      Boolean(options.certificate) !== Boolean(options.key)) throw new Error('Use --root=dist --project=dist --port=5373 [--cohort=A:dist] [--certificate=pem --key=pem]');
  return options;
}

function requestPath(raw) {
  if (typeof raw !== 'string' || raw.length > 2048 || !raw.startsWith('/') || raw.startsWith('//') || /[\\%#\x00-\x20\x7f-\uffff]/.test(raw)) return null;
  const [pathname, query, extra] = raw.split('?');
  if (extra !== undefined || !/^\/[A-Za-z0-9_./-]*$/.test(pathname) || pathname.split('/').slice(1).some(part => part === '.' || part === '..') || pathname.includes('//')) return null;
  if (query !== undefined && (!['/', '/index.html', '/project/', '/project/index.html'].includes(pathname) ||
      !/^__splatview_update=[A-Za-z0-9_-]{1,256}$/.test(query))) return null;
  return pathname;
}

function response(res, status, data, contentType = 'application/json; charset=utf-8', head = false) {
  if (res.destroyed || res.writableEnded) return;
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': bytes.length, 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff' });
  res.end(head ? undefined : bytes);
}

async function body(req) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new Error('Control POST requires application/json');
  const declared = req.headers['content-length'];
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > BODY_LIMIT)) throw new Error('Control body exceeds limit');
  const chunks = [];let bytes = 0;
  for await (const chunk of req) { bytes += chunk.length;if (bytes > BODY_LIMIT) throw new Error('Control body exceeds limit');chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createFixtureHost(options) {
  const rootDirectory = checkedPath(options.root, 'directory'), projectDirectory = checkedPath(options.project, 'directory');
  const definitions = options.cohorts?.length ? options.cohorts : [{ id: 'A', directory: rootDirectory },
    ...(projectDirectory === rootDirectory ? [] : [{ id: 'B', directory: projectDirectory }])];
  const cohorts = new Map();
  for (const definition of definitions) {
    if (cohorts.has(definition.id)) throw new Error(`Duplicate configured cohort: ${definition.id}`);
    const cohort = loadCohort(definition.id, definition.directory);
    if ([...cohorts.values()].some(existing => existing.directory === cohort.directory)) throw new Error('A physical cohort directory must have one ID');
    cohorts.set(definition.id, cohort);
  }
  const selected = { root: [...cohorts.values()].find(cohort => cohort.directory === rootDirectory)?.id,
    project: [...cohorts.values()].find(cohort => cohort.directory === projectDirectory)?.id };
  if (!selected.root || !selected.project) throw new Error('Both mounted directories must be preconfigured cohorts');
  let faults = [], counters = [], sequence = 0, faultSequence = 0, countersDropped = 0, counterGeneration = 0;
  const sockets = new Set();
  const state = () => ({ schemaVersion: 1, kind: 'splatview-offline-fixture-host', pid: process.pid,
    origin: `${options.certificate ? 'https' : 'http'}://127.0.0.1:${options.port}`, selected: { ...selected },
    cohorts: Object.fromEntries([...cohorts].map(([id, cohort]) => [id, cohort.metadata])),
    faults: faults.map(fault => ({ ...fault })), counters: counters.map(counter => ({ ...counter })),
    counterGeneration, countersDropped, sequence });
  function configure(value) {
    if (!plainObject(value) || !onlyKeys(value, ['resetCounters', 'clearFaults', 'select', 'faults']) ||
        ('resetCounters' in value && typeof value.resetCounters !== 'boolean') || ('clearFaults' in value && typeof value.clearFaults !== 'boolean')) throw new Error('Invalid host configuration');
    const choices = { ...selected };
    if (value.select !== undefined) {
      if (!plainObject(value.select) || !onlyKeys(value.select, ['root', 'project'])) throw new Error('Invalid mount selection');
      for (const [scope, id] of Object.entries(value.select)) {
        if (!cohorts.has(id)) throw new Error(`Unconfigured cohort: ${id}`);
        choices[scope] = id;
      }
    }
    const nextFaults = value.clearFaults ? [] : faults.filter(fault => fault.remaining > 0).map(fault => ({ ...fault }));let nextFaultSequence = faultSequence;
    if (value.faults !== undefined) {
      if (!Array.isArray(value.faults) || value.faults.length > 128) throw new Error('Invalid fault list');
      for (const fault of value.faults) {
        if (!plainObject(fault) || !onlyKeys(fault, ['scope', 'path', 'mode', 'times', 'delayMs', 'bytes']) ||
            !['root', 'project'].includes(fault.scope) || !pathSafe(fault.path) ||
            !['corrupt', 'truncate', 'disconnect', 'delay', '503'].includes(fault.mode)) throw new Error('Invalid artifact fault');
        const times = fault.times ?? 1;
        if (!Number.isSafeInteger(times) || times < 1 || times > 1000 ||
            (fault.delayMs !== undefined && (!Number.isSafeInteger(fault.delayMs) || fault.delayMs < 1 || fault.delayMs > 30_000)) ||
            (fault.bytes !== undefined && (!Number.isSafeInteger(fault.bytes) || fault.bytes < 0 || fault.bytes > 64 * 1024 * 1024)) ||
            (fault.mode !== 'delay' && fault.delayMs !== undefined) || (!['truncate', 'disconnect'].includes(fault.mode) && fault.bytes !== undefined)) throw new Error('Invalid fault parameters');
        if (![...cohorts.values()].some(cohort => cohort.files.has(fault.path))) throw new Error(`Fault is outside configured artifacts: ${fault.path}`);
        if (nextFaults.some(existing => existing.remaining > 0 && existing.scope === fault.scope && existing.path === fault.path)) throw new Error('Clear the existing path fault before replacing it');
        nextFaults.push({ id: ++nextFaultSequence, scope: fault.scope, path: fault.path, mode: fault.mode, remaining: times,
          ...(fault.mode === 'delay' ? { delayMs: fault.delayMs ?? 1000 } : {}), ...(fault.bytes !== undefined ? { bytes: fault.bytes } : {}) });
      }
    }
    if (nextFaults.length > 128) throw new Error('Too many active artifact faults');
    Object.assign(selected, choices);faults = nextFaults;faultSequence = nextFaultSequence;
    if (value.resetCounters) { counters = [];countersDropped = 0;counterGeneration += 1; }
    return state();
  }
  const listener = async (req, res) => {
    const pathname = requestPath(req.url), method = req.method ?? 'GET';
    const allowedHosts = [`127.0.0.1:${options.port}`, `localhost:${options.port}`];
    if (!allowedHosts.includes(req.headers.host ?? '') || !pathname) { response(res, 400, '{"error":"Invalid request path or host"}');return; }
    if (pathname.startsWith(CONTROL)) {
      const origin = req.headers.origin;
      if (origin && !allowedHosts.map(host => `${options.certificate ? 'https' : 'http'}://${host}`).includes(origin)) { response(res, 403, '{"error":"Foreign control origin"}');return; }
      try {
        if (pathname === `${CONTROL}state` && method === 'GET') response(res, 200, JSON.stringify(state()));
        else if (pathname === `${CONTROL}config` && method === 'POST') response(res, 200, JSON.stringify(configure(await body(req))));
        else response(res, 404, '{"error":"Unknown control endpoint"}');
      } catch (error) { response(res, 400, JSON.stringify({ error: error.message })); }
      return;
    }
    const scope = pathname.startsWith('/project/') ? 'project' : 'root';
    let path = scope === 'project' ? pathname.slice('/project/'.length) : pathname.slice(1);
    if (!path) path = 'index.html';
    const cohort = cohorts.get(selected[scope]), data = cohort.files.get(path);
    const counter = { id: ++sequence, method, path: pathname, artifactPath: path, scope, cohort: cohort.id,
      deploymentId: cohort.metadata.deploymentId, servedArtifact: false, fault: null, faultId: null, status: 0, bytes: 0, completed: false };
    if (counters.length < MAX_COUNTERS) counters.push(counter);else countersDropped += 1;
    const finish = (status, bytes) => { counter.status = status;counter.bytes = bytes;counter.completed = true; };
    if (!['GET', 'HEAD'].includes(method)) { const message = '{"error":"GET or HEAD required"}';finish(405, Buffer.byteLength(message));response(res, 405, message);return; }
    if (!pathSafe(path) || !data) { const message = '{"error":"Unknown fixture artifact"}';finish(404, method === 'HEAD' ? 0 : Buffer.byteLength(message));response(res, 404, message, undefined, method === 'HEAD');return; }
    const fault = method === 'GET' ? faults.find(item => item.scope === scope && item.path === path && item.remaining > 0) : undefined;
    if (fault) { fault.remaining -= 1;counter.fault = fault.mode;counter.faultId = fault.id; }
    const mime = MIME[/\.[^.]+$/.exec(path)?.[0].toLowerCase()] ?? 'application/octet-stream';
    if (fault?.mode === '503') { const message = Buffer.from('Configured offline fixture outage');finish(503, message.length);response(res, 503, message, 'text/plain; charset=utf-8');return; }
    if (fault?.mode === 'delay') {
      const alive = await new Promise(resolveDelay => {
        const timer = setTimeout(() => { res.off('close', closed);resolveDelay(true); }, fault.delayMs);
        const closed = () => { clearTimeout(timer);resolveDelay(false); };res.once('close', closed);
      });
      if (!alive) { finish(0, 0);return; }
    }
    if (fault?.mode === 'disconnect') {
      const count = Math.min(fault.bytes ?? 0, data.length);
      counter.servedArtifact = count > 0;
      if (count) { res.writeHead(200, { 'Content-Type': mime, 'Content-Length': data.length, 'Cache-Control': 'no-store' });res.write(data.subarray(0, count), () => res.destroy()); }
      else res.destroy();
      finish(count ? 200 : 0, count);return;
    }
    if (fault?.mode === 'truncate') {
      const count = Math.min(fault.bytes ?? Math.floor(data.length / 2), Math.max(0, data.length - 1));
      res.writeHead(200, { 'Content-Type': mime, 'Content-Length': data.length, 'Cache-Control': 'no-store', Connection: 'close' });
      counter.servedArtifact = true;
      finish(200, count);res.end(data.subarray(0, count));return;
    }
    const served = fault?.mode === 'corrupt' ? Buffer.from(data.length ? data : [0]) : data;
    if (fault?.mode === 'corrupt' && data.length) served[0] ^= 0xff;
    counter.servedArtifact = true;
    finish(200, method === 'HEAD' ? 0 : served.length);response(res, 200, served, mime, method === 'HEAD');
  };
  const server = options.certificate ? createHttpsServer({ cert: readFileSync(checkedPath(options.certificate, 'file')),
    key: readFileSync(checkedPath(options.key, 'file')) }, (req, res) => { listener(req, res).catch(error => { if (!res.headersSent) response(res, 500, JSON.stringify({ error: error.message }));else res.destroy(); }); })
    : createHttpServer((req, res) => { listener(req, res).catch(error => { if (!res.headersSent) response(res, 500, JSON.stringify({ error: error.message }));else res.destroy(); }); });
  server.requestTimeout = 35_000;server.headersTimeout = 10_000;server.keepAliveTimeout = 1000;
  server.on('connection', socket => { sockets.add(socket);socket.once('close', () => sockets.delete(socket)); });
  return { server, state, close() { server.close();for (const socket of sockets) socket.destroy(); } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2)), host = createFixtureHost(options);
    host.server.once('error', error => { process.stderr.write(`${error.stack ?? error}\n`);process.exitCode = 1; });
    host.server.listen(options.port, '127.0.0.1', () => process.stdout.write(`${JSON.stringify({ ...host.state(), listening: true })}\n`));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => host.close());
  } catch (error) { process.stderr.write(`${error.stack ?? error}\n`);process.exitCode = 1; }
}
