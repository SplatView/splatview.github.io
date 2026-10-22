import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdmissionError, bindResourceLeaseCredit, MiB, ResourceLedger, type ResourceLease } from '../src/document/resources';
import { NATIVE_LOAD_BUDGET_BYTES } from '../src/document/sceneInputLimits';
import { MAX_SOURCE_READ_BYTES } from '../src/io/readBroker';
import { assertPreparedSogGroup, MAX_SOG_GROUP_METADATA_BYTES,
  prepareSogGroup, type PreparedSogGroup, type SogGroupAcquisitionOptions } from '../src/io/sogGroup';

// Acquisition tests use arbitrary resource bytes: they qualify identity,
// admission and ownership, never WebP decoding or Gaussian numerical results.
const names = ['lo.webp', 'hi.webp', 'scale.webp', 'quat.webp', 'color.webp'];
function document() {
  return { version: 1, means: { shape: [3, 3], files: names.slice(0, 2), mins: [0, 0, 0], maxs: [1, 2, 3] },
    scales: { files: [names[2]], mins: [-1, -2, -3], maxs: [1, 2, 3] }, quats: { files: [names[3]] },
    sh0: { files: [names[4]], mins: [0, 0, 0, -1], maxs: [1, 1, 1, 2] } };
}
function modernDocument() {
  const legacy = document();
  return { version: 2, count: 3, means: { files: legacy.means.files, mins: legacy.means.mins, maxs: legacy.means.maxs },
    scales: { files: legacy.scales.files, codebook: [-2, .5, 1e100] }, quats: legacy.quats,
    sh0: { files: legacy.sh0.files, codebook: [-1, .125, 1e100] }, shN: null };
}
type LeaseRecord = { actual: ResourceLease; wrapper: ResourceLease; calls: number; amount: number };
type Account = { ledger: ResourceLedger; records: LeaseRecord[]; options: SogGroupAcquisitionOptions; cancel(): void };
const accounts: Account[] = [], groups: PreparedSogGroup[] = [];
function account(limit = 256 * MiB): Account {
  const ledger = new ResourceLedger(limit), records: LeaseRecord[] = [];
  let active = true;
  const options: SogGroupAcquisitionOptions = { current() { if (!active) throw new Error('Acquisition owner changed.'); }, admit(amount) {
    const actual = ledger.reserve('source', amount), entry = { actual, calls: 0, amount } as LeaseRecord;
    const wrapper = (() => { entry.calls++; actual(); }) as ResourceLease;
    Object.defineProperty(wrapper, 'bytes', { configurable: true, get: () => actual.bytes });
    wrapper.resize = bytes => actual.resize(bytes); entry.wrapper = wrapper; records.push(entry);
    return bindResourceLeaseCredit(wrapper, actual);
  } };
  const result = { ledger, records, options, cancel() { active = false; } }; accounts.push(result); return result;
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function file(name: string, body: BlobPart = name) {
  const value = new File([body], name), slices: number[][] = [];
  const original = value.slice;
  Object.defineProperty(value, 'slice', { configurable: true, value(start: number, end: number) {
    slices.push([start, end]); return original.call(value, start, end);
  } });
  return { file: value, slices };
}
function fixture(text = JSON.stringify(document())) {
  const primary = file('meta.json', text), referenced = names.map(name => file(name));
  return { primary, referenced, selected: [primary.file, ...referenced.map(item => item.file)] };
}
async function prepare(selected: readonly File[], options: SogGroupAcquisitionOptions) {
  const group = await prepareSogGroup(selected, options); groups.push(group); return group;
}
const originalBlob = (group: PreparedSogGroup) => group.sources.find(item => item.resourceId === group.descriptor.resourceId)!.blob;
const rewrittenBlob = (group: PreparedSogGroup) => group.sources.find(item => item.resourceId === group.descriptor.decoder.resourceId)!.blob;
const hash = async (blob: Blob) => createHash('sha256').update(new Uint8Array(await blob.arrayBuffer())).digest('hex');
afterEach(() => {
  for (const group of groups.splice(0)) group.dispose();
  for (const item of accounts.splice(0)) {
    expect(item.ledger.usage.bytes).toBe(0); expect(item.ledger.usage.allocations).toBe(0);
    expect(item.records.map(entry => entry.calls)).toEqual(item.records.map(() => 1));
  }
  vi.restoreAllMocks();
});

describe('bounded flat unpacked SOG acquisition', () => {
  it('captures v2 count and codebooks once, rewrites only filenames and retains independent original/decoder owners without texture reads', async () => {
    const text = ' \n' + JSON.stringify({ ...modernDocument(), unknown: { untouched: 'v2 metadata' } }) + '\n';
    const input = fixture(text), owner = account(), group = await prepare([...input.selected].reverse(), owner.options);
    assertPreparedSogGroup(group); expect(group.version).toBe(2); expect(group.sourceCount).toBe(3); expect(group.shDegree).toBe(0);
    expect(await originalBlob(group).text()).toBe(text); expect(await hash(originalBlob(group))).toBe(await hash(input.primary.file));
    const rewritten = JSON.parse(await rewrittenBlob(group).text());
    expect(rewritten).toMatchObject({ version: 2, count: 3, scales: { codebook: [-2, .5, 1e100] }, sh0: { codebook: [-1, .125, 1e100] }, shN: null,
      unknown: { untouched: 'v2 metadata' } });
    expect(rewritten.means).not.toHaveProperty('shape'); expect(rewritten.means.files).toEqual(['r0002.webp', 'r0001.webp']);
    expect(input.primary.slices).toEqual([[0, input.primary.file.size]]); expect(input.referenced.every(item => item.slices.length === 0)).toBe(true);
    expect(owner.ledger.usage.bytes).toBeGreaterThanOrEqual(2 * (group.descriptor.resources[0].byteLength + group.descriptor.decoder.byteLength));
    group.dispose(); expect(() => assertPreparedSogGroup(group)).toThrow(/disposed/);
  });

  it('includes v2 aliases and arbitrary declared extras once while an unrelated neighbor stays unread and excluded', async () => {
    const metadata = modernDocument(); metadata.scales.files = ['./color.webp', 'declared-extra.bin'];
    const input = fixture(JSON.stringify(metadata)), extra = file('declared-extra.bin', new Uint8Array([7, 9]));
    const unrelated = file('unrelated.bin', new Uint8Array([13, 17])), owner = account();
    const group = await prepare([...input.selected, extra.file, unrelated.file], owner.options);
    expect(group.version).toBe(2); expect(group.descriptor.resources.map(item => item.path)).toEqual(['meta.json', 'color.webp', 'declared-extra.bin', 'hi.webp', 'lo.webp', 'quat.webp']);
    expect(group.sources.some(item => item.blob === unrelated.file)).toBe(false); expect(unrelated.slices).toEqual([]); expect(extra.slices).toEqual([]);
    const rewritten = JSON.parse(await rewrittenBlob(group).text()); expect(rewritten.scales.files[0]).toBe(rewritten.sh0.files[0]);
  });

  it('preserves original v2 fractional number lexemes while reporting captured version/count integer conversions', async () => {
    const metadata = { ...modernDocument(), version: 2.9, count: 3.9 }, text = JSON.stringify(metadata);
    const input = fixture(text), owner = account(), group = await prepare(input.selected, owner.options);
    expect(group.version).toBe(2); expect(group.sourceCount).toBe(3); expect(await originalBlob(group).text()).toBe(text);
    expect(JSON.parse(await rewrittenBlob(group).text())).toMatchObject({ version: 2.9, count: 3.9 });
    expect(input.referenced.every(item => item.slices.length === 0)).toBe(true);
  });

  it.each([.9, -1, 10_000_001, true])('refuses v2 count %s before any texture body read', async count => {
    const input = fixture(JSON.stringify({ ...modernDocument(), count })), owner = account();
    await expect(prepareSogGroup(input.selected, owner.options)).rejects.toThrow(/count|integer/);
    expect(input.referenced.every(item => item.slices.length === 0)).toBe(true);
  });
  it('captures original metadata exactly, returns an inert primary-first graph and separately admitted rewritten metadata', async () => {
    const input = fixture(' \n' + JSON.stringify({ ...document(), unknown: { untouched: '\\u00e9', literal: 'keep' } }) + '\n');
    const owner = account(), group = await prepare([...input.selected].reverse(), owner.options);
    assertPreparedSogGroup(group); expect(group.sourceCount).toBe(3); expect(group.version).toBe(1); expect(group.shDegree).toBe(0);
    const source = group.descriptor;
    expect(Object.keys(source).sort()).toEqual(['byteLength', 'decoder', 'kind', 'operationId', 'path', 'resourceId', 'resources', 'role']);
    expect(source).toMatchObject({ kind: 'group', path: 'meta.json', role: 'primary' });
    expect(source.resources.map(item => item.path)).toEqual(['meta.json', 'color.webp', 'hi.webp', 'lo.webp', 'quat.webp', 'scale.webp']);
    expect(source.resources.map(item => item.role)).toEqual(['primary', 'referenced', 'referenced', 'referenced', 'referenced', 'referenced']);
    expect(source.byteLength).toBe(input.selected.reduce((total, item) => total + item.size, 0));
    expect(new Set([source.operationId, ...source.resources.map(item => item.resourceId), source.decoder.resourceId]).size).toBe(8);
    expect(Object.isFrozen(source)).toBe(true); expect(source.resources.every(Object.isFrozen)).toBe(true); expect(Object.isFrozen(group.sources)).toBe(true);
    expect(group.sources.map(item => item.resourceId)).toEqual([...source.resources.map(item => item.resourceId), source.decoder.resourceId]);
    expect(await originalBlob(group).text()).toBe(await input.primary.file.text());
    expect(await hash(originalBlob(group))).toBe(await hash(input.primary.file));
    const rewritten = JSON.parse(await rewrittenBlob(group).text());
    expect(rewritten.means.files).toEqual(['r0002.webp', 'r0001.webp']);
    expect(rewritten.scales.files).toEqual(['r0004.webp']); expect(rewritten.sh0.files).toEqual(['r0000.webp']);
    expect(rewritten.unknown).toEqual({ untouched: '\\u00e9', literal: 'keep' });
    expect(source.decoder.byteLength).toBe(rewrittenBlob(group).size);
    expect(originalBlob(group)).not.toBe(input.primary.file);
    expect(input.primary.slices).toEqual([[0, input.primary.file.size]]);
    expect(input.referenced.every(item => item.slices.length === 0)).toBe(true);
    expect(owner.ledger.usage.bytes).toBeGreaterThanOrEqual(2 * (source.resources[0].byteLength + source.decoder.byteLength));
    group.dispose(); group.dispose(); expect(() => assertPreparedSogGroup(group)).toThrow(/disposed/);
    expect(() => group.sources).toThrow(/disposed/);
  });

  it('deduplicates canonical declaration aliases and includes arbitrary declared extras without reading any body', async () => {
    const metadata = document(); metadata.means.files = ['./lo.webp', '.\\hi.webp', 'declared-extra.bin', './lo.webp'];
    metadata.scales.files.push('declared-extra.bin');
    const input = fixture(JSON.stringify(metadata)), extra = file('declared-extra.bin', new Uint8Array([7, 9]));
    const unrelated = file('unrelated.bin', new Blob([...Array<Blob>(512).fill(new Blob([new Uint8Array(MiB)])), new Uint8Array(1)]));
    const owner = account(), group = await prepare([...input.selected, extra.file, unrelated.file], owner.options);
    expect(group.descriptor.resources.map(item => item.path)).toEqual(['meta.json', 'color.webp', 'declared-extra.bin', 'hi.webp', 'lo.webp', 'quat.webp', 'scale.webp']);
    expect(group.descriptor.byteLength).toBe(input.selected.reduce((sum, value) => sum + value.size, 0) + 2);
    expect(group.sources.some(item => item.blob === unrelated.file)).toBe(false);
    expect(unrelated.file.size).toBeGreaterThan(NATIVE_LOAD_BUDGET_BYTES); expect(unrelated.slices).toEqual([]); expect(extra.slices).toEqual([]);
    const decoder = JSON.parse(await rewrittenBlob(group).text());
    expect(decoder.means.files).toEqual(['r0003.webp', 'r0002.webp', 'r0001.webp', 'r0003.webp']);
    expect(decoder.scales.files).toEqual(['r0005.webp', 'r0001.webp']);
  });

  it('orders non-ASCII original paths by UTF-8, independently from declaration/selection order', async () => {
    const metadata = document(); metadata.means.files.push('\ue000.bin', '\u{10000}.bin');
    const input = fixture(JSON.stringify(metadata)), owner = account();
    const group = await prepare([...input.selected, file('\u{10000}.bin').file, file('\ue000.bin').file], owner.options);
    expect(group.descriptor.resources.map(item => item.path).slice(-2)).toEqual(['\ue000.bin', '\u{10000}.bin']);
  });

  it('retains a zero-byte declared extra as an original resource without pretending it is a decoded WebP', async () => {
    const metadata = document(); metadata.quats.files.push('empty-extra.bin');
    const input = fixture(JSON.stringify(metadata)), extra = file('empty-extra.bin', new Blob()), owner = account();
    const group = await prepare([...input.selected, extra.file], owner.options);
    expect(group.descriptor.resources.find(item => item.path === 'empty-extra.bin')).toMatchObject({ byteLength: 0, role: 'referenced' });
    expect(group.descriptor.byteLength).toBe(input.selected.reduce((total, item) => total + item.size, 0));
    expect(group.sources.some(item => item.blob === extra.file)).toBe(true); expect(extra.slices).toEqual([]);
  });

  it('refuses a long flat alias when its path-resolution peak cannot be admitted', async () => {
    const metadata = document(); metadata.means.files[0] = './'.repeat(20_000) + 'lo.webp';
    const input = fixture(JSON.stringify(metadata)), owner = account(MiB), attempted: number[] = [];
    const original = owner.options.admit; owner.options.admit = bytes => { attempted.push(bytes); return original(bytes); };
    await expect(prepareSogGroup(input.selected, owner.options)).rejects.toThrow(/budget/);
    expect(attempted.at(-1)).toBeGreaterThan(MiB); expect(input.primary.slices).toHaveLength(1);
    expect(input.referenced.every(item => item.slices.length === 0)).toBe(true);
  });

  it('uses intrinsic Blob sizes and genuine Files instead of forged size/name values', async () => {
    const input = fixture(), owner = account();
    Object.defineProperty(input.primary.file, 'size', { get() { throw new Error('forged size'); } });
    Object.defineProperty(input.primary.file, 'name', { value: 'wrong.json' });
    const group = await prepare(input.selected, owner.options);
    expect(group.descriptor.resources[0].path).toBe('meta.json'); expect(group.descriptor.resources[0].byteLength).toBe(await originalBlob(group).arrayBuffer().then(bytes => bytes.byteLength));
    const fakeOwner = account();
    await expect(prepareSogGroup([{ name: 'meta.json', size: 3 } as unknown as File], fakeOwner.options)).rejects.toThrow();
  });

  it('never rereads a metadata slice override that would yield a changed graph on the next read', async () => {
    const first = JSON.stringify(document()), next = first.replace('[3,3]', '[4,3]');
    expect(next.length).toBe(first.length);
    const input = fixture(first), owner = account(); let reads = 0;
    Object.defineProperty(input.primary.file, 'slice', { value: () => { reads++; return new Blob([reads === 1 ? first : next]); } });
    const group = await prepare(input.selected, owner.options);
    expect(reads).toBe(1); expect(group.sourceCount).toBe(3);
    expect(await originalBlob(group).text()).toBe(first); expect(JSON.parse(await rewrittenBlob(group).text()).means.shape).toEqual([3, 3]);
  });

  it('reads large metadata in sequential one-MiB credited ranges and pins only the authenticated snapshot', async () => {
    const text = JSON.stringify(document()) + ' '.repeat(2 * MiB), input = fixture(text), owner = account();
    const group = await prepare(input.selected, owner.options);
    expect(input.primary.slices).toEqual([[0, MAX_SOURCE_READ_BYTES], [MAX_SOURCE_READ_BYTES, 2 * MAX_SOURCE_READ_BYTES], [2 * MAX_SOURCE_READ_BYTES, text.length]]);
    expect(await originalBlob(group).text()).toBe(text); expect(input.referenced.every(item => item.slices.length === 0)).toBe(true);
  });

  it.each([
    ['no exact metadata', (input: ReturnType<typeof fixture>) => input.selected.slice(1)],
    ['case-only metadata', (input: ReturnType<typeof fixture>) => [file('META.JSON', JSON.stringify(document())).file, ...input.selected.slice(1)]],
    ['duplicate metadata', (input: ReturnType<typeof fixture>) => [...input.selected, file('meta.json', JSON.stringify(document())).file]],
    ['case alias metadata', (input: ReturnType<typeof fixture>) => [...input.selected, file('Meta.Json').file]],
    ['duplicate neighbor', (input: ReturnType<typeof fixture>) => [...input.selected, file('neighbor').file, file('neighbor').file]],
    ['case alias neighbor', (input: ReturnType<typeof fixture>) => [...input.selected, file('Neighbor').file, file('neighbor').file]],
    ['nested selected name', (input: ReturnType<typeof fixture>) => [...input.selected, file('folder/neighbor').file]],
    ['backslash selected name', (input: ReturnType<typeof fixture>) => [...input.selected, file('folder\\neighbor').file]],
    ['empty selected name', (input: ReturnType<typeof fixture>) => [...input.selected, file('').file]],
  ] as const)('refuses %s before reading any body', async (_name, change) => {
    const input = fixture(), owner = account();
    await expect(prepareSogGroup(change(input), owner.options)).rejects.toThrow(); expect(input.primary.slices).toEqual([]);
    expect(input.referenced.every(item => item.slices.length === 0)).toBe(true);
  });

  it.each(['missing', 'nested', 'case mismatch', 'self', 'escape', 'absolute'] as const)('refuses a %s declaration without texture reads', async kind => {
    const metadata = document(); metadata.means.files[0] = ({ missing: 'missing.webp', nested: 'folder/lo.webp', 'case mismatch': 'Lo.webp', self: 'meta.json', escape: '../lo.webp', absolute: '/lo.webp' })[kind];
    const input = fixture(JSON.stringify(metadata)), owner = account();
    await expect(prepareSogGroup(input.selected, owner.options)).rejects.toThrow();
    expect(input.primary.slices).toHaveLength(1); expect(input.referenced.every(item => item.slices.length === 0)).toBe(true);
  });

  it('refuses directory-selection metadata instead of discovering a root from webkitRelativePath', async () => {
    const input = fixture(), owner = account(); Object.defineProperty(input.primary.file, 'webkitRelativePath', { value: 'asset/meta.json' });
    await expect(prepareSogGroup(input.selected, owner.options)).rejects.toThrow(/Folder/); expect(input.primary.slices).toEqual([]);
  });

  it('explicitly refuses unsupported version3 after bounded parsing and before texture reads', async () => {
    const input = fixture(JSON.stringify({ ...modernDocument(), version: 3 })), owner = account();
    await expect(prepareSogGroup(input.selected, owner.options)).rejects.toThrow(/versions 1 and 2/);
    expect(input.referenced.every(item => item.slices.length === 0)).toBe(true);
  });

  for (const degree of [null, 1, 2, 3] as const) it(`authenticates ${degree === null ? 'legacy unknown SH' : 'v2 SH' + degree} with both SH resources and aliased extras but no texture reads`, async () => {
    const base = degree === null ? document() : modernDocument(); base.means.files.push('shared-extra.bin');
    const shN = degree === null ? { files: ['./centroids.webp', 'labels.webp', 'shared-extra.bin'], mins: -1, maxs: 1 } :
      { files: ['./centroids.webp', 'labels.webp', 'shared-extra.bin'], bands: degree, count: 65.9, codebook: [-0, .25, 1e100] };
    const text = JSON.stringify({ ...base, shN }), input = fixture(text), owner = account();
    const shFiles = ['centroids.webp', 'labels.webp', 'shared-extra.bin'].map(name => file(name));
    const group = await prepare([...input.selected, ...shFiles.map(item => item.file)], owner.options);
    expect(group.shDegree).toBe(degree); expect(group.version).toBe(degree === null ? 1 : 2); expect(group.sourceCount).toBe(3);
    expect(group.descriptor.resources).toHaveLength(9);
    expect(group.descriptor.resources.filter(item => item.path === 'shared-extra.bin')).toHaveLength(1);
    expect(Object.keys(group.descriptor)).not.toContain('shDegree'); expect(await originalBlob(group).text()).toBe(text);
    const rewritten = JSON.parse(await rewrittenBlob(group).text()); expect(rewritten.shN.files[2]).toBe(rewritten.means.files[2]);
    if (degree !== null) expect(rewritten.shN).toMatchObject({ bands: degree, count: 65.9, codebook: [0, .25, 1e100] });
    expect([...input.referenced, ...shFiles].every(item => item.slices.length === 0)).toBe(true);
    group.dispose(); expect(() => assertPreparedSogGroup(group)).toThrow(/disposed/);
  });

  it('refuses a missing authenticated SH resource before any texture body read', async () => {
    const input = fixture(JSON.stringify({ ...modernDocument(), shN: { files: ['centroids.webp', 'labels.webp'], bands: 3, count: 65, codebook: [0] } }));
    const centroid = file('centroids.webp'), owner = account();
    await expect(prepareSogGroup([...input.selected, centroid.file], owner.options)).rejects.toThrow(/labels.webp/);
    expect([...input.referenced, centroid].every(item => item.slices.length === 0)).toBe(true);
  });

  it('refuses an original union exhausting decode memory, including declared unused extras, before any texture body read', async () => {
    const metadata = document(); metadata.means.files.push('extra1', 'extra2', 'extra3');
    const primary = file('meta.json', JSON.stringify(metadata));
    const large = new Blob(Array(64).fill(new Blob([new Uint8Array(MiB)])));
    const resources = [...names, 'extra1', 'extra2', 'extra3'].map(name => file(name, large));
    const owner = account();
    expect(primary.file.size + resources.reduce((sum, item) => sum + item.file.size, 0)).toBeGreaterThan(NATIVE_LOAD_BUDGET_BYTES);
    await expect(prepareSogGroup([primary.file, ...resources.map(item => item.file)], owner.options))
      .rejects.toThrow('The scene source does not fit within the available decode memory budget.');
    expect(primary.slices).toHaveLength(1); expect(resources.every(item => item.slices.length === 0)).toBe(true);
  });

  it('rejects original metadata above sixteen MiB before even its first slice', async () => {
    const input = fixture(), owner = account(), primary = file('meta.json', new Blob(Array(17).fill(new Blob([new Uint8Array(MiB)]))));
    await expect(prepareSogGroup([primary.file, ...input.selected.slice(1)], owner.options)).rejects.toThrow(/16 MiB/);
    expect(primary.slices).toEqual([]);
  });

  it('checks decoder expansion against sixteen MiB before allocating any output destination', async () => {
    const metadata = document(); metadata.means.files = ['a', 'b']; metadata.scales.files = ['c']; metadata.quats.files = ['d']; metadata.sh0.files = ['e'];
    const text = JSON.stringify(metadata), primary = file('meta.json', text + ' '.repeat(MAX_SOG_GROUP_METADATA_BYTES - text.length));
    const resources = ['a', 'b', 'c', 'd', 'e'].map(name => file(name)), owner = account();
    await expect(prepareSogGroup([primary.file, ...resources.map(item => item.file)], owner.options)).rejects.toThrow(/rewritten metadata exceeds/);
    expect(owner.records.some(item => item.amount === 2 * MAX_SOG_GROUP_METADATA_BYTES)).toBe(true); // parser snapshot, not an output claim
    expect(resources.every(item => item.slices.length === 0)).toBe(true);
  });

  it('joins the actual held metadata read before releasing any input/read credit on cancellation', async () => {
    const input = fixture(), owner = account(), gate = deferred<ArrayBuffer>(); let reading = false;
    const bytes = await input.primary.file.arrayBuffer();
    Object.defineProperty(input.primary.file, 'slice', { value: () => {
      const part = new Blob([bytes]); Object.defineProperty(part, 'arrayBuffer', { value: () => { reading = true; return gate.promise; } }); return part;
    } });
    const result = prepareSogGroup(input.selected, owner.options).then(() => undefined, error => error as Error);
    await vi.waitFor(() => expect(reading).toBe(true)); const retained = owner.ledger.usage.bytes;
    owner.cancel(); await Promise.resolve(); await Promise.resolve();
    expect(owner.ledger.usage.bytes).toBe(retained); expect(owner.records.map(item => item.calls)).toEqual([0, 0, 0]);
    gate.resolve(bytes); expect(await result).toMatchObject({ message: 'Acquisition owner changed.' });
    expect(owner.ledger.usage.bytes).toBe(0); expect(input.referenced.every(item => item.slices.length === 0)).toBe(true);
  });

  it('retires failed metadata I/O after its actual rejection and returns no source owner', async () => {
    const input = fixture(), owner = account();
    Object.defineProperty(input.primary.file, 'slice', { value: () => {
      const part = new Blob(); Object.defineProperty(part, 'arrayBuffer', { value: async () => { throw new Error('read failed'); } }); return part;
    } });
    await expect(prepareSogGroup(input.selected, owner.options)).rejects.toThrow(/read failed/);
  });

  it('refuses a short metadata read without passing a partial snapshot to the parser', async () => {
    const input = fixture(), owner = account();
    Object.defineProperty(input.primary.file, 'slice', { value: () => new Blob(['short']) });
    await expect(prepareSogGroup(input.selected, owner.options)).rejects.toThrow(/wrong byte length/);
    expect(input.referenced.every(item => item.slices.length === 0)).toBe(true);
  });

  it('refuses asynchronous ownership hooks before reading and observes their rejected promise', async () => {
    const input = fixture(), owner = account();
    owner.options.current = () => Promise.reject(new Error('async current'));
    await expect(prepareSogGroup(input.selected, owner.options)).rejects.toThrow(/synchronously/);
    await Promise.resolve(); await Promise.resolve(); expect(input.primary.slices).toEqual([]);
  });

  it('refuses a completed group after its source owner changes without automatically retiring borrowed work', async () => {
    const input = fixture(), owner = account(), group = await prepare(input.selected, owner.options);
    const retained = owner.ledger.usage.bytes; owner.cancel();
    expect(() => assertPreparedSogGroup(group)).toThrow(/owner changed/);
    expect(() => group.descriptor).toThrow(/owner changed/);
    expect(owner.ledger.usage.bytes).toBe(retained);
    group.dispose(); expect(owner.ledger.usage.bytes).toBe(0);
  });

  it.each([1, 2, 3, 4, 7, 10, 14] as const)('cleans every genuine lease when admission %s is refused', async refused => {
    const input = fixture(), owner = account(); const original = owner.options.admit; let attempts = 0;
    owner.options.admit = bytes => { if (++attempts === refused) throw new AdmissionError('refused reservation'); return original(bytes); };
    await expect(prepareSogGroup(input.selected, owner.options)).rejects.toThrow(/refused reservation/);
    expect(attempts).toBe(refused); expect(input.referenced.every(item => item.slices.length === 0)).toBe(true);
  });

  it('refuses a reused lease without releasing its active credit twice', async () => {
    const input = fixture(), owner = account(); let first: ResourceLease | undefined;
    const original = owner.options.admit; owner.options.admit = bytes => first ??= original(bytes);
    await expect(prepareSogGroup(input.selected, owner.options)).rejects.toThrow(/reused an owned lease/);
    expect(owner.records).toHaveLength(1); expect(owner.records[0].calls).toBe(1);
  });

  it('refuses a distinct wrapper aliasing the same genuine credit without stealing its owner', async () => {
    const input = fixture(), owner = account(); let first: ResourceLease | undefined, aliasCalls = 0;
    const original = owner.options.admit; owner.options.admit = bytes => {
      if (!first) return first = original(bytes);
      const alias = (() => { aliasCalls++; first!(); }) as ResourceLease;
      Object.defineProperty(alias, 'bytes', { get: () => first!.bytes }); alias.resize = next => first!.resize(next);
      return bindResourceLeaseCredit(alias, first);
    };
    await expect(prepareSogGroup(input.selected, owner.options)).rejects.toThrow(/reused an owned credit/);
    expect(aliasCalls).toBe(0); expect(owner.records[0].calls).toBe(1);
  });

  it('refuses unbound admission callables and retires that refused callable once', async () => {
    const input = fixture(); let released = 0;
    const lease = (() => { released++; }) as ResourceLease; Object.defineProperty(lease, 'bytes', { value: 0 }); lease.resize = () => undefined;
    await expect(prepareSogGroup(input.selected, { current() {}, admit() { return lease; } })).rejects.toThrow(/authenticated credit/);
    expect(released).toBe(1);
  });

  it('rejects invented preparation owners and reentrant disposal before a getter can publish sources', async () => {
    expect(() => assertPreparedSogGroup({ descriptor: {}, sources: [] })).toThrow(/not issued/);
    const input = fixture(), owner = account(), group = await prepare(input.selected, owner.options);
    Object.defineProperty(owner.records.find(item => item.calls === 0)!.wrapper, 'bytes', { get() { group.dispose(); return 0; } });
    expect(() => group.sources).toThrow(); expect(owner.ledger.usage.bytes).toBe(0);
  });

  it('checks every retained authenticated credit after a later arbitrary getter revokes an earlier one', async () => {
    const input = fixture(), owner = account(), group = await prepare(input.selected, owner.options);
    const live = owner.records.filter(item => item.calls === 0);
    Object.defineProperty(live.at(-1)!.wrapper, 'bytes', { get() { live[0].actual(); return live.at(-1)!.actual.bytes; } });
    expect(() => assertPreparedSogGroup(group)).toThrow(/credit/);
  });
});
