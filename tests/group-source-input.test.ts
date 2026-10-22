import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ResourceLedger } from '../src/document/resources';
import { groupBlockBytes, groupDescriptorBytes, groupWorkerBytes, type GroupSourceDescriptor } from '../src/document/sourceGroup';
import { stageGroupSourceInput, type GroupSourceInputOptions } from '../src/workers/groupSourceInput';
import { GroupHashModule, groupFixture, groupShFixture, independentGroupKey } from './fixtures/group-source';

function staging(source: GroupSourceDescriptor, bytes: Map<string, Uint8Array>) {
  const module = new GroupHashModule(), ledger = new ResourceLedger(groupWorkerBytes(source));
  const reads: { id: string; offset: number; length: number }[] = [], consumed: string[] = [], released: string[] = [];
  let current = true;
  const options: GroupSourceInputOptions = { current() { if (!current) throw new DOMException('Replaced group.', 'AbortError'); },
    admit: bytes => ledger.reserve('source', bytes), async read(id, offset, length) {
      expect(module.mallocSizes.slice(0, 2)).toEqual([groupBlockBytes(source), groupDescriptorBytes(source)]);
      reads.push({ id, offset, length }); let live = true;
      return { bytes: bytes.get(id)!.slice(offset, offset + length).buffer,
        consume() { expect(live).toBe(true); live = false; consumed.push(id); },
        release() { if (live) { live = false; released.push(id); } } };
    } };
  return { module, ledger, reads, consumed, released, options, cancel() { current = false; } };
}
describe('grouped native source input staging', () => {
  it.each([[1, 1], [1, 2], [1, 3], [2, 1], [2, 2], [2, 3]] as const)('authenticates v%i SH%i original resources and retains its private degree hint after parser retirement', async (version, degree) => {
    const fixture = await groupShFixture(version, degree), source = fixture.group.descriptor, value = staging(source, fixture.bytes);
    try {
      const stage = await stageGroupSourceInput(value.module, source, value.options);
      const vector = JSON.parse(readFileSync(`tests/fixtures/sog-group-sh/packets/v${version}-sh${degree}/source-key-vectors.json`, 'utf8')).vectors[0];
      expect(stage.shDegree).toBe(version === 1 ? null : degree); expect(stage.sourceCount).toBe(3);
      expect(Buffer.from(stage.assetDigest).toString('hex')).toBe(vector.assetDigest);
      expect(independentGroupKey(source, fixture.bytes)).toBe(vector.assetDigest);
      expect(value.consumed).toEqual([...source.resources, source.decoder].map(resource => resource.resourceId));
      expect(Buffer.from(value.module.HEAPU8.slice(stage.pointer, stage.pointer + stage.byteLength)))
        .toEqual(Buffer.concat([...source.resources, source.decoder].map(resource => Buffer.from(fixture.bytes.get(resource.resourceId)!))));
      expect(Object.keys(source)).not.toContain('shDegree');
      stage.dispose(); expect(value.module.allocations.size).toBe(0); expect(value.ledger.usage.bytes).toBe(0);
    } finally { fixture.dispose(); }
  });
  it('stages authenticated v2 originals and codebooks with the independent literal key, leaving decoder bytes outside identity', async () => {
    const fixture = await groupFixture(undefined, 2), source = fixture.group.descriptor, value = staging(source, fixture.bytes);
    try {
      const stage = await stageGroupSourceInput(value.module, source, value.options);
      const vector = JSON.parse(readFileSync('tests/fixtures/sog-group-v2/source-key-vectors.json', 'utf8')).vectors[0];
      expect(fixture.group.version).toBe(2); expect(stage.sourceCount).toBe(3);
      expect(stage.summary).toMatchObject({ resourceCount: vector.resourceCount, totalBytes: vector.totalBytes });
      expect(Buffer.from(stage.assetDigest).toString('hex')).toBe(vector.assetDigest);
      expect(independentGroupKey(source, fixture.bytes)).toBe(vector.assetDigest);
      expect(Buffer.from(value.module.HEAPU8.slice(stage.pointer, stage.pointer + stage.byteLength)))
        .toEqual(Buffer.concat([...source.resources, source.decoder].map(resource => Buffer.from(fixture.bytes.get(resource.resourceId)!))));
      expect(value.consumed).toEqual([...source.resources, source.decoder].map(resource => resource.resourceId));
      expect(value.module.updates.filter(update => update.pass < source.resources.length).map(update => update.bytes))
        .toEqual(source.resources.map(resource => fixture.bytes.get(resource.resourceId)));
      stage.dispose(); expect(value.module.allocations.size).toBe(0); expect(value.ledger.usage.bytes).toBe(0);
    } finally { fixture.dispose(); }
  });

  it.each(['original-count', 'decoder-count'] as const)('refuses independently changed v2 %s despite valid JSON and unchanged byte lengths', async kind => {
    const fixture = await groupFixture(undefined, 2), source = fixture.group.descriptor;
    const resource = kind === 'original-count' ? source.resourceId : source.decoder.resourceId;
    const original = fixture.bytes.get(resource)!;
    const changed = new TextEncoder().encode(new TextDecoder().decode(original).replace(/"count":\s*3/, value => value.slice(0, -1) + '2'));
    expect(changed.byteLength).toBe(original.byteLength); expect(changed).not.toEqual(original); expect(JSON.parse(new TextDecoder().decode(changed)).count).toBe(2);
    fixture.bytes.set(resource, changed); const value = staging(source, fixture.bytes);
    try {
      await expect(stageGroupSourceInput(value.module, source, value.options)).rejects.toThrow(/decoder metadata differs/);
      expect(value.module.allocations.size).toBe(0); expect(value.ledger.usage.bytes).toBe(0);
    } finally { fixture.dispose(); }
  });
  it('stages exact SVSG bytes, hashes each original at its final pointer, and matches the independent literal group key', async () => {
    const fixture = await groupFixture(), source = fixture.group.descriptor, value = staging(source, fixture.bytes);
    value.module.growOnUpdate = true;
    try {
      const stage = await stageGroupSourceInput(value.module, source, value.options);
      expect(stage.sourceCount).toBe(3); expect(stage.summary).toMatchObject({ resourceCount: 6, totalBytes: 701 });
      const vector = JSON.parse(readFileSync('tests/fixtures/sog-group-v1/source-key-vectors.json', 'utf8')).vectors[0];
      expect(Buffer.from(stage.assetDigest).toString('hex')).toBe(vector.assetDigest);
      expect(independentGroupKey(source, fixture.bytes)).toBe(vector.assetDigest);
      const block = Buffer.concat([...source.resources, source.decoder].map(resource => Buffer.from(fixture.bytes.get(resource.resourceId)!)));
      expect(Buffer.from(value.module.HEAPU8.slice(stage.pointer, stage.pointer + stage.byteLength))).toEqual(block);
      const descriptor = new DataView(value.module.HEAPU8.buffer, stage.descriptorPointer, stage.descriptorByteLength);
      expect(Array.from({ length: stage.descriptorByteLength / 4 }, (_, index) => descriptor.getUint32(4 * index, true)))
        .toEqual([0x47535653, 1, 5, source.resources[0].byteLength, source.decoder.byteLength, ...source.resources.slice(1).map(resource => resource.byteLength)]);
      let offset = 0;
      for (const [pass, resource] of source.resources.entries()) {
        const updates = value.module.updates.filter(update => update.pass === pass);
        expect(updates).toHaveLength(1); expect(updates[0].pointer).toBe(stage.pointer + offset);
        expect(updates[0].bytes).toEqual(fixture.bytes.get(resource.resourceId)); offset += resource.byteLength;
      }
      expect(value.consumed).toEqual([...source.resources, source.decoder].map(resource => resource.resourceId));
      stage.dispose(); stage.dispose(); expect(value.module.allocations.size).toBe(0); expect(value.ledger.usage.bytes).toBe(0);
    } finally { fixture.dispose(); }
  });
  it('includes an empty declared extra in the original key and descriptor without issuing an empty read', async () => {
    const fixture = await groupFixture(new Uint8Array()), source = fixture.group.descriptor, value = staging(source, fixture.bytes);
    try {
      const stage = await stageGroupSourceInput(value.module, source, value.options);
      const extra = source.resources.find(resource => resource.path === 'declared-extra.bin')!;
      expect(extra.byteLength).toBe(0); expect(value.reads.some(read => read.id === extra.resourceId)).toBe(false);
      expect(Buffer.from(stage.assetDigest).toString('hex')).toBe(independentGroupKey(source, fixture.bytes));
      expect(stage.summary.resourceCount).toBe(6); stage.dispose(); expect(value.ledger.usage.bytes).toBe(0);
    } finally { fixture.dispose(); }
  });
  it.each(['rewritten-byte', 'omitted-extra', 'unrelated-extra'] as const)('refuses %s before any decoder borrow and releases all owners', async kind => {
    const fixture = await groupFixture(); let source = fixture.group.descriptor;
    if (kind === 'rewritten-byte') fixture.bytes.get(source.decoder.resourceId)![0] ^= 1;
    else if (kind === 'omitted-extra') {
      const omitted = source.resources.find(resource => resource.path === 'declared-extra.bin')!;
      source = { ...source, byteLength: source.byteLength - omitted.byteLength, resources: source.resources.filter(resource => resource !== omitted) };
    } else {
      source = { ...source, byteLength: source.byteLength + 1,
        resources: [...source.resources, { resourceId: 'unrelated', byteLength: 1, path: 'z-unrelated.bin', role: 'referenced' }] };
      fixture.bytes.set('unrelated', new Uint8Array([1]));
    }
    const value = staging(source, fixture.bytes);
    try { await expect(stageGroupSourceInput(value.module, source, value.options)).rejects.toThrow(/SOG|resource|source/);
      expect(value.module.allocations.size).toBe(0); expect(value.ledger.usage.bytes).toBe(0); }
    finally { fixture.dispose(); }
  });
  it.each([1, 2, 3])('releases every staged owner after native allocation %i is refused', async allocation => {
    const fixture = await groupFixture(), value = staging(fixture.group.descriptor, fixture.bytes); value.module.failAllocation = allocation;
    try { await expect(stageGroupSourceInput(value.module, fixture.group.descriptor, value.options)).rejects.toThrow(/memory|range/);
      expect(value.module.allocations.size).toBe(0); expect(value.ledger.usage.bytes).toBe(0); }
    finally { fixture.dispose(); }
  });
  it('joins a held real read before releasing stage spans after replacement', async () => {
    const fixture = await groupFixture(), value = staging(fixture.group.descriptor, fixture.bytes);
    let resolve!: (chunk: Awaited<ReturnType<GroupSourceInputOptions['read']>>) => void;
    value.options.read = () => new Promise(done => { resolve = done; });
    const pending = stageGroupSourceInput(value.module, fixture.group.descriptor, value.options);
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    value.cancel(); await Promise.resolve(); expect(value.module.allocations.size).toBe(3); expect(value.ledger.usage.bytes).toBeGreaterThan(0);
    let released = false;
    resolve({ bytes: fixture.bytes.get(fixture.group.descriptor.resourceId)!.slice().buffer, consume() { throw new Error('Cancelled input consumed.'); }, release() { released = true; } });
    await rejection; expect(released).toBe(true); expect(value.module.allocations.size).toBe(0); expect(value.ledger.usage.bytes).toBe(0); fixture.dispose();
  });
});
