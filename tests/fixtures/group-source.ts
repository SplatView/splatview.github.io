import { createHash, type Hash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ResourceLedger } from '../../src/document/resources';
import { prepareSogGroup } from '../../src/io/sogGroup';
import type { GroupSourceDescriptor } from '../../src/document/sourceGroup';
import type { SourceHashModule } from '../../src/workers/sourceHash';

export const fixtureNames = ['meta.json', 'appearance.webp', 'declared-extra.bin', 'positions-high.webp', 'positions-low.webp', 'rotations.webp'];
export async function groupFixture(extraBytes?: Uint8Array, version: 1 | 2 = 1) {
  const ledger = new ResourceLedger(128 * 1024 * 1024);
  const files = fixtureNames.map(name => new File([name === 'declared-extra.bin' && extraBytes ? new Uint8Array(extraBytes) :
    new Uint8Array(readFileSync(resolve(`tests/fixtures/sog-group-v${version}/collection/asset`, name)))], name));
  const group = await prepareSogGroup(files, { admit: bytes => ledger.reserve('source', bytes), current() {} });
  const bytes = new Map(await Promise.all(group.sources.map(async source => [source.resourceId, new Uint8Array(await source.blob.arrayBuffer())] as const)));
  return { group, bytes, ledger, dispose() { group.dispose(); } };
}
/** Real higher-SH inputs; expected numeric records live in the independent packet. */
export async function groupShFixture(version: 1 | 2, degree: 1 | 2 | 3) {
  const ledger = new ResourceLedger(128 * 1024 * 1024);
  const names = [...fixtureNames, 'centroids.webp', 'labels.webp'];
  const files = names.map(name => new File([
    new Uint8Array(readFileSync(resolve(`tests/fixtures/sog-group-sh/packets/v${version}-sh${degree}/collection/asset`, name))),
  ], name));
  const group = await prepareSogGroup(files, { admit: bytes => ledger.reserve('source', bytes), current() {} });
  const bytes = new Map(await Promise.all(group.sources.map(async source => [source.resourceId, new Uint8Array(await source.blob.arrayBuffer())] as const)));
  return { group, bytes, ledger, dispose() { group.dispose(); } };
}
export function independentGroupKey(source: GroupSourceDescriptor, bytes: ReadonlyMap<string, Uint8Array>): string {
  const count = Buffer.alloc(4); count.writeUInt32BE(source.resources.length);
  const chunks = [Buffer.from('SplatViewSource\0v1\0', 'ascii'), Buffer.from([1]), count];
  const resources = [...source.resources].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  for (const resource of resources) {
    const path = Buffer.from(resource.path, 'utf8'), framing = Buffer.alloc(5), length = Buffer.alloc(8);
    framing[0] = resource.role === 'primary' ? 1 : 0; framing.writeUInt32BE(path.length, 1); length.writeBigUInt64BE(BigInt(resource.byteLength));
    chunks.push(framing, path, length, createHash('sha256').update(bytes.get(resource.resourceId)!).digest());
  }
  return createHash('sha256').update(Buffer.concat(chunks)).digest('hex');
}
/** Transport/staging double with an independent Node SHA256; no decoder math. */
export class GroupHashModule implements SourceHashModule {
  HEAPU8 = new Uint8Array(new ArrayBuffer(65536));
  allocations = new Map<number, number>();
  mallocSizes: number[] = []; freed: number[] = [];
  updates: { pass: number; offset: number; pointer: number; bytes: Uint8Array }[] = [];
  growOnUpdate = false; failAllocation = 0;
  private next = 64; private handle = 0; private expected = 0; private consumed = 0; private state = 0;
  private hashing?: Hash; private digest?: Buffer; private pass = -1;
  _malloc(bytes: number) {
    this.mallocSizes.push(bytes); if (this.failAllocation === this.mallocSizes.length) return 0;
    const pointer = this.next; this.next += Math.ceil(bytes / 8) * 8 + 8;
    this.allocations.set(pointer, bytes); this.grow(this.next); return pointer;
  }
  _free(pointer: number) { if (!this.allocations.delete(pointer)) throw new Error('Foreign or duplicate free.'); this.freed.push(pointer); }
  private grow(length: number) {
    if (length <= this.HEAPU8.length) return;
    const heap = new Uint8Array(new ArrayBuffer(Math.ceil(Math.max(length, this.HEAPU8.length * 2) / 65536) * 65536));
    heap.set(this.HEAPU8); this.HEAPU8 = heap;
  }
  _sv_source_hash_create() { if (this.handle) return 0; return this.handle = 1; }
  _sv_source_hash_delete(handle: number) { if (handle !== this.handle) return 1; this.handle = 0; return 0; }
  _sv_source_hash_begin(handle: number, bytes: number) {
    if (handle !== this.handle) return 1;
    this.expected = bytes; this.consumed = 0; this.state = 1; this.hashing = createHash('sha256'); this.pass++; return 0;
  }
  _sv_source_hash_update(handle: number, offset: number, pointer: number, length: number) {
    if (handle !== this.handle || this.state !== 1 || offset !== this.consumed || length > this.expected - offset || length > 1024 * 1024) return 1;
    if (this.growOnUpdate) { this.grow(this.HEAPU8.length + 1); this.growOnUpdate = false; }
    const bytes = this.HEAPU8.slice(pointer, pointer + length); this.updates.push({ pass: this.pass, offset, pointer, bytes });
    this.hashing!.update(bytes); this.consumed += length; return 0;
  }
  _sv_source_hash_finish(handle: number) {
    if (handle !== this.handle || this.consumed !== this.expected || this.state !== 1) return 1;
    this.digest = this.hashing!.digest(); this.state = 2; return 0;
  }
  _sv_source_hash_digest(handle: number, pointer: number, length: number) {
    if (handle !== this.handle || this.state !== 2 || length !== 32) return 1;
    this.HEAPU8.set(this.digest!, pointer); return 0;
  }
  _sv_source_hash_reset(handle: number) { if (handle !== this.handle) return 1; this.state = 0; return 0; }
  _sv_source_hash_state() { return this.state; }
  _sv_source_hash_expected_bytes() { return this.expected; }
  _sv_source_hash_consumed_bytes() { return this.consumed; }
}
