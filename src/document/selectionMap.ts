import { AdmissionError, checkedBytes, type ResourceLease } from './resources';
import type { Envelope, NativeSummary, Revision } from './types';
import { BUILD_ID, PROTOCOL_VERSION, sameRevision } from './types';

export const SELECTION_MAP_LAYOUT = 1;
export const SELECTION_MAP_CHUNK_BYTES = 1024 * 1024;
export const SELECTION_MAP_PIXELS = 262_144;
export const MapChannel = { depth: 1, opacity: 2, colors: 4, visible: 8 } as const;
export type SelectionMapDescriptor = {
  layoutVersion: number; mapId: number; fullWidth: number; fullHeight: number;
  mapWidth: number; mapHeight: number; sourceCount: number; channels: number;
};
export type SelectionMapData = {
  width: number; height: number; fullWidth: number; fullHeight: number; sourceCount: number;
  depths: Float32Array; opacities: Float32Array; colors?: Float32Array; visible?: Uint32Array;
};
export type SelectionMapLayout = { descriptor: SelectionMapDescriptor; pixels: number; payloadBytes: number; nativeBytes: number; chunkBytes: number; admissionBytes: number };
export type SelectionMapAdoptionOptions = { admit(bytes: number): ResourceLease; current(): void; signal?: AbortSignal };
export type AdoptedSelectionMap = { mapId: number; payloadBytes: number; nativeBytes: number; summary: NativeSummary; assertCurrent(): void; dispose(): Promise<void> };

function integer(value: unknown, minimum: number, maximum: number, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new AdmissionError(`Invalid selection map ${name}.`);
}
export function validateSelectionMapDescriptor(value: unknown): SelectionMapLayout {
  if (!value || typeof value !== 'object') throw new AdmissionError('Invalid selection map descriptor.');
  const d = value as SelectionMapDescriptor;
  if (d.layoutVersion !== SELECTION_MAP_LAYOUT) throw new AdmissionError('Unsupported selection map layout.');
  integer(d.mapId, 1, Number.MAX_SAFE_INTEGER, 'ID');
  integer(d.fullWidth, 1, 0xffffffff, 'viewport width'); integer(d.fullHeight, 1, 0xffffffff, 'viewport height');
  integer(d.mapWidth, 1, SELECTION_MAP_PIXELS, 'width'); integer(d.mapHeight, 1, SELECTION_MAP_PIXELS, 'height');
  integer(d.sourceCount, 1, 3_000_000, 'source count'); integer(d.channels, 3, 15, 'channels');
  if ((d.channels & 3) !== 3) throw new AdmissionError('Selection maps require depth and opacity channels.');
  const fullPixels = checkedBytes(d.fullWidth, d.fullHeight), pixels = checkedBytes(d.mapWidth, d.mapHeight);
  if (fullPixels > 0xffffffff) throw new AdmissionError('The selection map viewport is too large.');
  const scale = Math.min(1, Math.sqrt(SELECTION_MAP_PIXELS / fullPixels));
  if (pixels > SELECTION_MAP_PIXELS || d.mapWidth !== Math.max(1, Math.floor(d.fullWidth * scale)) || d.mapHeight !== Math.max(1, Math.floor(d.fullHeight * scale)))
    throw new AdmissionError('Selection map dimensions do not match the bounded native viewport.');
  const membershipBytes = checkedBytes(Math.ceil(d.sourceCount / 32), 4);
  const payloadBytes = checkedBytes(pixels, d.channels & MapChannel.colors ? 20 : 8) + (d.channels & MapChannel.visible ? membershipBytes : 0);
  const nativeBytes = payloadBytes + membershipBytes, chunkBytes = Math.min(payloadBytes, SELECTION_MAP_CHUNK_BYTES);
  return { descriptor: { layoutVersion: d.layoutVersion, mapId: d.mapId, fullWidth: d.fullWidth, fullHeight: d.fullHeight,
    mapWidth: d.mapWidth, mapHeight: d.mapHeight, sourceCount: d.sourceCount, channels: d.channels },
    pixels, payloadBytes, nativeBytes, chunkBytes, admissionBytes: nativeBytes + chunkBytes * 2 };
}
function floats(value: unknown, count: number, name: string, maximum = Infinity): asserts value is Float32Array {
  if (!(value instanceof Float32Array) || !(value.buffer instanceof ArrayBuffer) || value.length !== count)
    throw new AdmissionError(`Invalid selection map ${name} channel.`);
  for (const entry of value) if (!Number.isFinite(entry) || entry < 0 || entry > maximum) throw new AdmissionError(`Invalid selection map ${name} value.`);
}
export function validateSelectionMap(data: SelectionMapData, mapId: number): SelectionMapLayout {
  if (!data || typeof data !== 'object') throw new AdmissionError('Invalid selection map data.');
  const channels = 3 | (data.colors === undefined ? 0 : MapChannel.colors) | (data.visible === undefined ? 0 : MapChannel.visible);
  const layout = validateSelectionMapDescriptor({ layoutVersion: SELECTION_MAP_LAYOUT, mapId, fullWidth: data.fullWidth, fullHeight: data.fullHeight,
    mapWidth: data.width, mapHeight: data.height, sourceCount: data.sourceCount, channels });
  floats(data.depths, layout.pixels, 'depth'); floats(data.opacities, layout.pixels, 'opacity', 1);
  if (data.colors !== undefined) floats(data.colors, layout.pixels * 3, 'RGB', 1);
  if (data.visible !== undefined) {
    if (!(data.visible instanceof Uint32Array) || !(data.visible.buffer instanceof ArrayBuffer) || data.visible.length !== Math.ceil(data.sourceCount / 32))
      throw new AdmissionError('Invalid selection map visibility channel.');
    const tail = data.sourceCount % 32;
    if (tail && (data.visible[data.visible.length - 1] >>> tail) !== 0) throw new AdmissionError('Selection map visibility names an out-of-range source.');
  }
  return layout;
}
/** A single acknowledged copy; retained caller arrays are never transferred. */
export function selectionMapChunk(data: SelectionMapData, layout: SelectionMapLayout, offset: number, length: number): ArrayBuffer {
  integer(offset, 0, layout.payloadBytes, 'chunk offset'); integer(length, 4, SELECTION_MAP_CHUNK_BYTES, 'chunk length');
  if (offset % 4 || length % 4 || offset + length > layout.payloadBytes) throw new AdmissionError('Invalid selection map chunk range.');
  const channels = [data.depths, data.opacities, data.colors, data.visible].filter((channel): channel is Float32Array | Uint32Array => channel !== undefined);
  const bytes = new Uint8Array(length); let channelOffset = 0, copied = 0;
  for (const channel of channels) {
    const end = channelOffset + channel.byteLength, from = Math.max(offset, channelOffset), to = Math.min(offset + length, end);
    if (to > from) {
      const source = new Uint8Array(channel.buffer, channel.byteOffset + from - channelOffset, to - from);
      bytes.set(source, from - offset); copied += to - from;
    }
    channelOffset = end;
  }
  if (copied !== length) throw new AdmissionError('Selection map channels changed during transfer.');
  return bytes.buffer;
}
export function validateMapEnvelope(value: unknown, expected?: { requestId: number; base: Revision }): asserts value is Envelope {
  if (!value || typeof value !== 'object') throw new Error('Invalid scene message envelope.');
  const e = value as Envelope;
  if (e.protocolVersion !== PROTOCOL_VERSION || e.buildId !== BUILD_ID) throw new Error('The application files have different versions. Reload SplatView.');
  integer(e.requestId, 1, Number.MAX_SAFE_INTEGER, 'request ID');
  if (!e.base || typeof e.base.documentId !== 'string' || !e.base.documentId.length || e.base.documentId.length > 128)
    throw new Error('Invalid scene message document identity.');
  for (const key of ['sourceGeneration', 'contentRevision', 'selectionRevision', 'draftRevision'] as const) integer(e.base[key], 0, Number.MAX_SAFE_INTEGER, key);
  if (expected && (e.requestId !== expected.requestId || !sameRevision(e.base, expected.base))) throw new Error('Discarded an obsolete scene message.');
}
