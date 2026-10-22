import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { FileRef } from './types.ts';

export const digest = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
const NATIVE_LEAVES = new Set(['splatview-core.mjs', 'splatview-core.wasm', 'splatview-camera.mjs', 'splatview-camera.wasm', 'build-provenance.json']);
export function relativePath(value: string): string {
  if (!value || value.length > 4096 || value.includes('\\') || value.includes('\0') || value.includes(':') || value.startsWith('/') || value.endsWith('/') || /[\x00-\x1f]/u.test(value)) throw new Error('Unsafe workspace-relative path');
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/u.test(part) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/iu.test(part))) throw new Error('Ambiguous workspace-relative path');
  if (value.toLowerCase().startsWith('public/wasm/') && (parts.length !== 3 || !NATIVE_LEAVES.has(parts[2]!))) throw new Error('Only the five explicit native publication leaves may be read');
  return value;
}
export function uniquePaths(rows: readonly FileRef[], label: string): void {
  const seen = new Set<string>();
  for (const row of rows) { const key = relativePath(row.path).toLowerCase(); if (seen.has(key)) throw new Error(`Duplicate/case-aliased ${label} path: ${row.path}`); seen.add(key); }
}
/** A bounded read checks path ancestry, open-file identity, size/timestamps and a second complete hash. */
export class Workspace {
  readonly root: string;
  readonly maximumFileBytes: number;
  readonly maximumTotalBytes: number;
  private total = 0;
  private observedReadBytes = 0;
  private identities = new Map<string, FileRef>();
  constructor(root: string, maximumFileBytes = 128 * 1024 * 1024, maximumTotalBytes = 1024 * 1024 * 1024) { this.root = path.resolve(root); this.maximumFileBytes = maximumFileBytes; this.maximumTotalBytes = maximumTotalBytes; }
  /** Bytes actually returned by file reads, including the independent second pass. */
  get readBytes(): number { return this.observedReadBytes; }
  normalize(input: string, base = this.root): string {
    const absolute = path.isAbsolute(input) ? path.resolve(input) : path.resolve(base, input);
    const rel = path.relative(this.root, absolute).split(path.sep).join('/');
    return relativePath(rel);
  }
  async safe(value: string, allowMissingLeaf = false): Promise<string> {
    relativePath(value);
    const rootStat = await lstat(this.root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || path.resolve(await realpath(this.root)) !== this.root) throw new Error('Workspace root is aliased or linked');
    const parts = value.split('/'); let current = this.root;
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]!);
      try {
        const stat = await lstat(current);
        if (stat.isSymbolicLink() || (i < parts.length - 1 && !stat.isDirectory())) throw new Error('Linked/reparse/non-directory path ancestor');
        const resolved = await realpath(current);
        if (resolved !== current) throw new Error('Case alias, reparse or redirected path');
      } catch (error) {
        if (allowMissingLeaf && i === parts.length - 1 && (error as NodeJS.ErrnoException).code === 'ENOENT') return current;
        throw error;
      }
    }
    return current;
  }
  private remember(reference: FileRef): void {
    const key = reference.path.toLowerCase(), previous = this.identities.get(key);
    if (previous && (previous.path !== reference.path || previous.bytes !== reference.bytes || previous.sha256 !== reference.sha256)) throw new Error(`Conflicting reference or path alias: ${reference.path}`);
    this.identities.set(key, reference);
  }
  async read(value: string, expected?: FileRef): Promise<{ reference: FileRef; bytes: Uint8Array }> {
    const absolute = await this.safe(value); const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.size > BigInt(this.maximumFileBytes)) throw new Error('Input is not regular or exceeds per-file byte bound');
      const size = Number(before.size), prospective = this.total + size * 2;
      if (prospective > this.maximumTotalBytes) throw new Error(`Aggregate evidence read bound exceeded: observed=${this.observedReadBytes} attempted=${prospective} maximum=${this.maximumTotalBytes}`);
      this.total = prospective;
      const bytes = new Uint8Array(size + 1); let offset = 0;
      while (offset < bytes.length) { const result = await handle.read(bytes, offset, bytes.length - offset, offset); this.observedReadBytes += result.bytesRead; if (!result.bytesRead) break; offset += result.bytesRead; }
      const first = bytes.subarray(0, offset);
      const second = new Uint8Array(size + 1); let again = 0;
      while (again < second.length) { const result = await handle.read(second, again, second.length - again, again); this.observedReadBytes += result.bytesRead; if (!result.bytesRead) break; again += result.bytesRead; }
      const after = await handle.stat({ bigint: true }); const leaf = await lstat(absolute, { bigint: true });
      if (offset !== size || again !== size || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || after.dev !== leaf.dev || after.ino !== leaf.ino || after.mtimeNs !== leaf.mtimeNs || after.ctimeNs !== leaf.ctimeNs || digest(first) !== digest(second.subarray(0, again))) throw new Error('Evidence mutated or was replaced during read');
      await this.safe(value);
      const reference: FileRef = { path: value, bytes: size, sha256: digest(first) };
      if (expected && (expected.path !== value || expected.bytes !== size || expected.sha256 !== reference.sha256)) throw new Error(`Reference byte/hash mismatch: ${value}`);
      this.remember(reference); return { reference, bytes: first };
    } finally { await handle.close(); }
  }
  async json(reference: FileRef): Promise<unknown> {
    const { bytes } = await this.read(reference.path, reference);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/u, '');
    const value: unknown = JSON.parse(text); let nodes = 0;
    const visit = (item: unknown, depth: number): void => { if (++nodes > 2_000_000 || depth > 64) throw new Error('JSON complexity bound exceeded'); if (item && typeof item === 'object') for (const child of Object.values(item)) visit(child, depth + 1); };
    visit(value, 0); return value;
  }
  async inventory(directory: string, skipNativePublication = false): Promise<FileRef[]> {
    relativePath(directory);
    if (directory.toLowerCase() === 'public/wasm' || directory.toLowerCase().startsWith('public/wasm/')) throw new Error('Native publication directory enumeration is forbidden');
    const rows: FileRef[] = [];
    const walk = async (name: string): Promise<void> => {
      if (skipNativePublication && name === 'public/wasm') { await this.safe(name); return; }
      const full = await this.safe(name); const stat = await lstat(full);
      if (stat.isDirectory()) {
        if (name.toLowerCase() === 'public/wasm') throw new Error('Native publication directory enumeration is forbidden');
        const leaves = await readdir(full); const seen = new Set<string>();
        for (const leaf of leaves.sort()) { if (seen.has(leaf.toLowerCase())) throw new Error('Case-aliased directory entries'); seen.add(leaf.toLowerCase()); await walk(`${name}/${leaf}`); }
      } else { if (rows.length >= 50_000) throw new Error('Inventory file bound exceeded'); rows.push((await this.read(name)).reference); }
    };
    await walk(directory); return rows.sort((a, b) => a.path.localeCompare(b.path));
  }
  async writeExclusive(value: string, body: unknown): Promise<void> {
    const absolute = await this.safe(value, true); const bytes = new TextEncoder().encode(JSON.stringify(body, null, 2) + '\n');
    if (bytes.length > this.maximumFileBytes) throw new Error('Output byte bound exceeded');
    const handle = await open(absolute, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await this.safe(value);
  }
}
