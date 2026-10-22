import { bindResourceLeaseCredit, type ResourceLease } from '../document/resources';
import { synchronousSourceHook } from '../document/source';
import { groupBlockBytes, groupDescriptorBytes, validateGroupSourceDescriptor, type GroupSourceDescriptor } from '../document/sourceGroup';
import { prepareCanonicalSource, type SourceFingerprintSummary } from '../io/fingerprint';
import { parseSogMetadata, type PreparedSogMetadata } from '../io/sogMetadata';
import { prepareSogCatalog, type PreparedSogCatalog } from '../io/sogResources';
import { prepareSogDecoderMetadata, type PreparedSogDecoderMetadata } from '../io/sogDecoderMetadata';
import { assertSourceHeapRange, NativeSourceHash, SOURCE_HASH_MAX_CHUNK, type SourceHashModule } from './sourceHash';
import type { SourceInputChunk } from './sourceInput';

export type GroupSourceInputOptions = {
  read(resourceId: string, offset: number, length: number): PromiseLike<SourceInputChunk>;
  admit(bytes: number): ResourceLease;
  current(): void;
};
export type StagedGroupSourceInput = Readonly<{
  pointer: number; byteLength: number; descriptorPointer: number; descriptorByteLength: number;
  sourceCount: number; shDegree: 0 | 1 | 2 | 3 | null; canonicalByteLength: number; summary: Readonly<SourceFingerprintSummary>;
  assetDigest: Uint8Array<ArrayBuffer>; dispose(): void;
}>;
const bufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;

/** Original bytes are staged and hashed once. Decoder bytes are transported but
 * excluded from the content key, then authenticated by reconstructing them from
 * the staged original metadata and complete original resource graph. */
export async function stageGroupSourceInput(module: SourceHashModule, input: GroupSourceDescriptor,
  options: GroupSourceInputOptions): Promise<StagedGroupSourceInput> {
  const source = validateGroupSourceDescriptor(input);
  if (!options || typeof options.read !== 'function' || typeof options.admit !== 'function' || typeof options.current !== 'function')
    throw new Error('Grouped source input ownership hooks are required.');
  const check = () => synchronousSourceHook(Reflect.apply(options.current, options, []));
  const byteLength = groupBlockBytes(source), descriptorByteLength = groupDescriptorBytes(source);
  const leases = new Set<ResourceLease>(), pointers: number[] = [];
  let hash: NativeSourceHash | undefined, metadata: PreparedSogMetadata | undefined;
  let catalog: PreparedSogCatalog | undefined, decoder: PreparedSogDecoderMetadata | undefined;
  let disposed = false;
  const reserve = (bytes: number) => {
    check(); const raw = Reflect.apply(options.admit, options, [bytes]) as ResourceLease;
    synchronousSourceHook(raw);
    if (typeof raw !== 'function') throw new Error('Invalid grouped source input reservation.');
    let live = true;
    const lease = (() => { if (!live) return; live = false; leases.delete(lease); synchronousSourceHook(raw()); }) as ResourceLease;
    leases.add(lease); Object.defineProperty(lease, 'bytes', { get: () => raw.bytes });
    lease.resize = amount => { if (!live) throw new Error('The grouped input reservation was retired.'); synchronousSourceHook(raw.resize(amount)); };
    bindResourceLeaseCredit(lease, raw);
    if (raw.bytes !== bytes) throw new Error('Invalid grouped source input reservation.');
    check(); return lease;
  };
  const allocate = (bytes: number) => {
    const pointer = module._malloc(bytes);
    if (!Number.isInteger(pointer) || pointer <= 0 || pointer > 0xffff_ffff) throw new Error('There is not enough native memory to stage this SOG group.');
    assertSourceHeapRange(module, pointer, bytes); pointers.push(pointer); check(); return pointer;
  };
  const disposeFactories = () => {
    const owners = [decoder, catalog, metadata]; decoder = undefined; catalog = undefined; metadata = undefined;
    const errors: unknown[] = [];
    for (const owner of owners) try { owner?.dispose(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Grouped metadata retirement failed.');
  };
  const dispose = () => {
    if (disposed) return; disposed = true; const errors: unknown[] = [];
    try { disposeFactories(); } catch (error) { errors.push(error); }
    try { hash?.dispose(); hash = undefined; } catch (error) { errors.push(error); }
    for (const pointer of pointers.splice(0).reverse()) try { module._free(pointer); } catch (error) { errors.push(error); }
    for (const lease of [...leases].reverse()) try { synchronousSourceHook(lease()); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Grouped source input retirement failed.');
  };
  try {
    check(); reserve(byteLength + descriptorByteLength + 32);
    // Both registered input spans exist before the first wire range request.
    const pointer = allocate(byteLength), descriptorPointer = allocate(descriptorByteLength);
    const header = new DataView(module.HEAPU8.buffer, descriptorPointer, descriptorByteLength);
    header.setUint32(0, 0x47535653, true); header.setUint32(4, 1, true);
    header.setUint32(8, source.resources.length - 1, true);
    header.setUint32(12, source.resources[0].byteLength, true); header.setUint32(16, source.decoder.byteLength, true);
    source.resources.slice(1).forEach((resource, index) => header.setUint32(20 + 4 * index, resource.byteLength, true));
    reserve(32 * (source.resources.length + 3)); hash = new NativeSourceHash(module);
    const digests: Uint8Array[] = [];
    let blockOffset = 0;
    for (const resource of [...source.resources, source.decoder]) {
      check(); const original = resource.resourceId !== source.decoder.resourceId;
      if (original) { hash.reset(); hash.begin(resource.byteLength); }
      for (let offset = 0; offset < resource.byteLength;) {
        check(); const length = Math.min(SOURCE_HASH_MAX_CHUNK, resource.byteLength - offset);
        // A cancelled owner still joins this actual delivery before freeing its
        // native spans. The received chunk retains its own release authority.
        const chunk = await Reflect.apply(options.read, options, [resource.resourceId, offset, length]) as SourceInputChunk;
        let consumed = false;
        try {
          if (!chunk || typeof chunk.consume !== 'function' || typeof chunk.release !== 'function') throw new Error('Invalid grouped source chunk.');
          check(); const bytes = chunk.bytes;
          if (bufferLength.call(bytes) !== length || resizable?.call(bytes)) throw new Error('Invalid grouped source byte buffer.');
          const view = new Uint8Array(bytes); check(); assertSourceHeapRange(module, pointer + blockOffset + offset, length);
          module.HEAPU8.set(view, pointer + blockOffset + offset);
          if (original) hash.update(offset, pointer + blockOffset + offset, length);
          check(); synchronousSourceHook(Reflect.apply(chunk.consume, chunk, [])); consumed = true; offset += length; check();
        } finally { if (!consumed && chunk && typeof chunk.release === 'function') synchronousSourceHook(Reflect.apply(chunk.release, chunk, [])); }
      }
      if (original) digests.push(hash.finish());
      blockOffset += resource.byteLength;
    }
    if (blockOffset !== byteLength) throw new Error('Incomplete grouped source input.');
    check();
    // Copy H privately before parser/catalog/hash/native calls may grow WASM.
    const H = source.resources[0].byteLength, privateLease = reserve(H);
    assertSourceHeapRange(module, pointer, H); let originalMetadata: Uint8Array | undefined = module.HEAPU8.slice(pointer, pointer + H);
    const configured = { admit: reserve, current: check };
    metadata = parseSogMetadata(originalMetadata, configured); originalMetadata = undefined; synchronousSourceHook(privateLease());
    const sourceCount = metadata.sourceCount, shDegree = metadata.shDegree;
    catalog = prepareSogCatalog(source.resources.map(resource => ({ resourceId: resource.resourceId,
      acquisitionPath: resource.path, byteLength: resource.byteLength })), configured);
    decoder = prepareSogDecoderMetadata(metadata, source.path, catalog, configured);
    if (decoder.primaryResourceId !== source.resourceId || decoder.totalBytes !== source.byteLength ||
        decoder.resources.length !== source.resources.length || decoder.byteLength !== source.decoder.byteLength)
      throw new Error('The rewritten SOG descriptor does not match the complete original group.');
    const graph = new Map(decoder.resources.map(resource => [resource.resourceId, resource]));
    for (const resource of source.resources) {
      const expected = graph.get(resource.resourceId);
      if (!expected || expected.byteLength !== resource.byteLength || expected.acquisitionPath !== resource.path || expected.role !== resource.role)
        throw new Error('The SOG original resource union changed.');
    }
    let decoderOffset = 0;
    decoder.writeDecoder(segment => {
      check(); assertSourceHeapRange(module, pointer + source.byteLength + decoderOffset, segment.length);
      const received = module.HEAPU8.subarray(pointer + source.byteLength + decoderOffset, pointer + source.byteLength + decoderOffset + segment.length);
      if (segment.some((byte, index) => byte !== received[index])) throw new Error('The received SOG decoder metadata differs from its original source.');
      decoderOffset += segment.length;
    });
    if (decoderOffset !== source.decoder.byteLength) throw new Error('Incomplete rewritten SOG metadata.');
    disposeFactories(); check();
    // Rebase after resolving the original references. A legal ../asset/file
    // alias may temporarily leave the final graph's common directory prefix.
    const canonical = prepareCanonicalSource({ kind: 'group', resources: source.resources.map((resource, index) =>
      ({ path: graph.get(resource.resourceId)!.fingerprintPath, role: resource.role,
        byteLength: resource.byteLength, sha256: digests[index] })) });
    const capacity = Math.min(SOURCE_HASH_MAX_CHUNK, canonical.canonicalByteLength); reserve(3 * capacity);
    const scratch = allocate(capacity); hash.reset(); hash.begin(canonical.canonicalByteLength); let offset = 0;
    canonical.write(segment => { check(); assertSourceHeapRange(module, scratch, segment.length); module.HEAPU8.set(segment, scratch);
      hash!.update(offset, scratch, segment.length); offset += segment.length; check(); }, capacity);
    if (offset !== canonical.canonicalByteLength) throw new Error('Incomplete SOG canonical key.');
    const assetDigest = hash.finish(); hash.dispose(); hash = undefined; check();
    return Object.freeze({ get pointer() { if (disposed) throw new Error('The SOG staged input is disposed.'); check(); return pointer; },
      get descriptorPointer() { if (disposed) throw new Error('The SOG staged input is disposed.'); check(); return descriptorPointer; },
      byteLength, descriptorByteLength, sourceCount, shDegree, canonicalByteLength: canonical.canonicalByteLength,
      summary: Object.freeze({ scheme: canonical.scheme, resourceCount: canonical.resourceCount, totalBytes: canonical.totalBytes }), assetDigest, dispose });
  } catch (error) {
    try { dispose(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'SOG staging and cleanup failed.'); }
    throw error;
  }
}
