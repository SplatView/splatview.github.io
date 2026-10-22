import { describe, expect, it } from 'vitest';
import { MapChannel, SELECTION_MAP_CHUNK_BYTES, selectionMapChunk, validateMapEnvelope, validateSelectionMap, validateSelectionMapDescriptor,
  type SelectionMapData } from '../src/document/selectionMap';
import { BUILD_ID, PROTOCOL_VERSION } from '../src/document/types';

function data(): SelectionMapData {
  return { width: 2, height: 1, fullWidth: 2, fullHeight: 1, sourceCount: 33,
    depths: new Float32Array([1, 2]), opacities: new Float32Array([.5, 1]),
    colors: new Float32Array([0, .25, .5, .75, 1, 0]), visible: new Uint32Array([0x80000001, 1]) };
}
const descriptor = () => validateSelectionMap(data(), 1).descriptor;
describe('selection map admission and channel contract', () => {
  it('accounts native deletion membership and both acknowledged chunk copies', () => {
    const layout = validateSelectionMap(data(), 7);
    expect(layout.descriptor.channels).toBe(15); expect(layout.payloadBytes).toBe(48);
    expect(layout.nativeBytes).toBe(56); expect(layout.admissionBytes).toBe(152);
  });
  it('requires only depth and opacity, with optional independent channels', () => {
    const value = data(); delete value.colors; delete value.visible;
    expect(validateSelectionMap(value, 1).descriptor.channels).toBe(3);
    value.visible = new Uint32Array(2); expect(validateSelectionMap(value, 1).descriptor.channels).toBe(3 | MapChannel.visible);
  });
  it('uses independently floored native dimensions for an odd large viewport', () => {
    const d = { ...descriptor(), fullWidth: 1025, fullHeight: 769, mapWidth: 591, mapHeight: 443 };
    const scale = Math.sqrt(262144 / (1025 * 769)); d.mapWidth = Math.floor(1025 * scale); d.mapHeight = Math.floor(769 * scale);
    expect(validateSelectionMapDescriptor(d).pixels).toBe(d.mapWidth * d.mapHeight);
    expect(() => validateSelectionMapDescriptor({ ...d, mapWidth: d.mapWidth + 1 })).toThrow(/dimensions/);
  });
  it.each([
    ['layoutVersion', 2], ['mapId', 0], ['mapId', 1.5], ['mapId', Number.MAX_SAFE_INTEGER + 1],
    ['sourceCount', 0], ['sourceCount', 3_000_001], ['fullWidth', Infinity], ['fullWidth', -1], ['fullHeight', 0],
    ['mapWidth', 0], ['mapHeight', 1.2], ['channels', 1], ['channels', 7.5], ['channels', 16],
  ])('rejects hostile descriptor %s=%s', (key, value) => {
    expect(() => validateSelectionMapDescriptor({ ...descriptor(), [key]: value })).toThrow();
  });
  it('rejects unsafe full viewport products before computing dimensions', () => {
    expect(() => validateSelectionMapDescriptor({ ...descriptor(), fullWidth: 0xffffffff, fullHeight: 0xffffffff })).toThrow(/large/);
  });
  it('matches the native uint32 full viewport pixel bound', () => {
    expect(() => validateSelectionMapDescriptor({ ...descriptor(), fullWidth: 100000, fullHeight: 100000, mapWidth: 512, mapHeight: 512 })).toThrow(/large/);
  });
  it.each(['depths', 'opacities', 'colors', 'visible'] as const)('requires exact %s channel type and length', key => {
    expect(() => validateSelectionMap({ ...data(), [key]: new Float64Array(2) } as unknown as SelectionMapData, 1)).toThrow();
    expect(() => validateSelectionMap({ ...data(), [key]: new (key === 'visible' ? Uint32Array : Float32Array)(1) }, 1)).toThrow();
  });
  it.each([NaN, Infinity, -Infinity, -1])('rejects invalid depth %s', value => {
    const d = data(); d.depths[0] = value; expect(() => validateSelectionMap(d, 1)).toThrow(/depth/);
  });
  it.each(['opacities', 'colors'] as const)('validates finite normalized %s', key => {
    for (const value of [NaN, Infinity, -.01, 1.01]) { const d = data(); d[key]![0] = value; expect(() => validateSelectionMap(d, 1)).toThrow(); }
  });
  it('accepts zero depth for empty pixels and rejects nonzero visibility tail bits', () => {
    const d = data(); d.depths[0] = 0; expect(() => validateSelectionMap(d, 1)).not.toThrow();
    d.visible![1] = 2; expect(() => validateSelectionMap(d, 1)).toThrow(/out-of-range/);
  });
  it('rejects shared memory to prevent channels changing concurrently during validation', () => {
    const d = data(); d.depths = new Float32Array(new SharedArrayBuffer(8)); expect(() => validateSelectionMap(d, 1)).toThrow(/depth/);
  });
  it('rejects detached buffers', () => {
    const d = data(); structuredClone(d.depths.buffer, { transfer: [d.depths.buffer] }); expect(() => validateSelectionMap(d, 1)).toThrow(/depth/);
  });
  it('copies channel slices and transitions byte-exactly without detaching caller memory', () => {
    const d = data(), storage = new Float32Array([999, 1, 2, 999]); d.depths = storage.subarray(1, 3);
    const layout = validateSelectionMap(d, 5), chunks = [selectionMapChunk(d, layout, 0, 12), selectionMapChunk(d, layout, 12, 36)];
    const actual = new Uint8Array(48); actual.set(new Uint8Array(chunks[0])); actual.set(new Uint8Array(chunks[1]), 12);
    const expected = new Uint8Array(48); let offset = 0;
    for (const channel of [d.depths, d.opacities, d.colors!, d.visible!]) { expected.set(new Uint8Array(channel.buffer, channel.byteOffset, channel.byteLength), offset); offset += channel.byteLength; }
    expect(actual).toEqual(expected); expect(storage.byteLength).toBe(16); expect(d.visible!.byteLength).toBe(8);
  });
  it.each([[1, 4], [0, 3], [0, SELECTION_MAP_CHUNK_BYTES + 4], [44, 8], [-4, 4]])('rejects invalid chunk offset/length %s/%s', (offset, length) => {
    const d = data(); expect(() => selectionMapChunk(d, validateSelectionMap(d, 1), offset, length)).toThrow();
  });
  it('detects detached channels during an in-flight transfer', () => {
    const d = data(), layout = validateSelectionMap(d, 1); structuredClone(d.opacities.buffer, { transfer: [d.opacities.buffer] });
    expect(() => selectionMapChunk(d, layout, 0, layout.payloadBytes)).toThrow(/changed/);
  });
});
describe('selection map message envelopes', () => {
  const envelope = () => ({ protocolVersion: PROTOCOL_VERSION, buildId: BUILD_ID, requestId: 4,
    base: { documentId: 'document', sourceGeneration: 1, contentRevision: 2, selectionRevision: 3, draftRevision: 4 } });
  it('accepts the exact request identity and revision', () => { const e = envelope(); expect(() => validateMapEnvelope(e, e)).not.toThrow(); });
  it.each(['protocolVersion', 'buildId', 'requestId'])('rejects a malformed %s', key => {
    expect(() => validateMapEnvelope({ ...envelope(), [key]: key === 'buildId' ? 'obsolete' : 0 })).toThrow();
  });
  it('rejects wrong document/revision/request controls', () => {
    const e = envelope();
    expect(() => validateMapEnvelope({ ...e, requestId: 5 }, e)).toThrow(/obsolete/);
    for (const key of ['documentId', 'sourceGeneration', 'contentRevision', 'selectionRevision', 'draftRevision'] as const)
      expect(() => validateMapEnvelope({ ...e, base: { ...e.base, [key]: key === 'documentId' ? 'other' : 9 } }, e)).toThrow(/obsolete/);
  });
  it('rejects absent base, empty document and unsafe revisions', () => {
    const e = envelope();
    for (const base of [undefined, { ...e.base, documentId: '' }, { ...e.base, contentRevision: -1 }, { ...e.base, draftRevision: Number.MAX_SAFE_INTEGER + 1 }])
      expect(() => validateMapEnvelope({ ...e, base })).toThrow();
  });
});
