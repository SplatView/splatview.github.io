import type { ImageOperation } from './image';
import { MAX_SAVED_THUMBNAIL_BYTES, MAX_SAVED_VIEW_RECORD_BYTES, validateSavedViewRecord, type SavedViewRecord } from './savedView';
import { checkSavedViewOperation, verifySavedThumbnail } from './thumbnail';

const CONTAINER_OVERHEAD = 2048;
export const MAX_PORTABLE_SAVED_VIEW_BYTES = MAX_SAVED_THUMBNAIL_BYTES + MAX_SAVED_VIEW_RECORD_BYTES + CONTAINER_OVERHEAD;
const CRC_CHUNK_BYTES = 64 * 1024;
const RECORD_RETENTION_BYTES = MAX_SAVED_VIEW_RECORD_BYTES * 2 + 2048;
const SCRATCH_BYTES = MAX_SAVED_VIEW_RECORD_BYTES * 128 + CRC_CHUNK_BYTES + CONTAINER_OVERHEAD + 1024;
const VIEW_NAME = 'view.json', IMAGE_NAME = 'thumbnail.png';
const DIRECTORY_BYTES = 46 * 2 + VIEW_NAME.length + IMAGE_NAME.length;
// An imported PNG slice can retain its complete archive backing. Preserve that
// known backing size if it subsequently becomes a member of an exported Blob.
const knownBackingBytes = new WeakMap<Blob, number>();

export type PortableSavedView = { readonly record: SavedViewRecord; readonly image: Blob; dispose(): void };
export type PortableSavedViewOutput = { readonly blob: Blob; dispose(): void };
type Member = { name: typeof VIEW_NAME | typeof IMAGE_NAME; size: number; crc: number; flags: number;
  version: number; time: number; date: number; offset: number; body: number; end: number };

function invalid(reason: string): never { throw new Error(`Invalid portable saved view: ${reason}.`); }
function checkSize(blob: unknown): asserts blob is Blob {
  if (!(blob instanceof Blob) || blob.size < 22 + DIRECTORY_BYTES || blob.size > MAX_PORTABLE_SAVED_VIEW_BYTES)
    invalid('container size');
}
async function readRange(blob: Blob, start: number, end: number, operation: ImageOperation): Promise<Uint8Array<ArrayBuffer>> {
  checkSavedViewOperation(operation);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > blob.size)
    invalid('member range');
  const buffer = await blob.slice(start, end).arrayBuffer(); checkSavedViewOperation(operation);
  if (buffer.byteLength !== end - start) invalid('short read');
  return new Uint8Array(buffer);
}
function matchesName(bytes: Uint8Array, start: number, name: string) {
  for (let index = 0; index < name.length; index++) if (bytes[start + index] !== name.charCodeAt(index)) return false;
  return true;
}
function crcTable(): Uint32Array<ArrayBuffer> {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    table[index] = value;
  }
  return table;
}
function updateCrc(crc: number, bytes: Uint8Array, table: Uint32Array): number {
  for (const byte of bytes) crc = (crc >>> 8) ^ table[(crc ^ byte) & 255];
  return crc;
}
async function blobCrc(blob: Blob, table: Uint32Array, operation: ImageOperation): Promise<number> {
  let crc = 0xffff_ffff;
  for (let start = 0; start < blob.size; start += CRC_CHUNK_BYTES) {
    const bytes = await readRange(blob, start, Math.min(blob.size, start + CRC_CHUNK_BYTES), operation);
    crc = updateCrc(crc, bytes, table);
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}
function directory(bytes: Uint8Array<ArrayBuffer>, centralStart: number): Member[] {
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), members: Member[] = [];
  let cursor = 0;
  for (let index = 0; index < 2; index++) {
    if (cursor + 46 > bytes.length || header.getUint32(cursor, true) !== 0x02014b50) invalid('directory header');
    const version = header.getUint16(cursor + 6, true), flags = header.getUint16(cursor + 8, true);
    const method = header.getUint16(cursor + 10, true), size = header.getUint32(cursor + 24, true);
    const nameLength = header.getUint16(cursor + 28, true);
    if ((version !== 10 && version !== 20) || (flags !== 0 && flags !== 0x800) || method !== 0 ||
        header.getUint32(cursor + 20, true) !== size || header.getUint16(cursor + 30, true) !== 0 ||
        header.getUint16(cursor + 32, true) !== 0 || header.getUint16(cursor + 34, true) !== 0 ||
        cursor + 46 + nameLength > bytes.length) invalid('unsupported directory member');
    const name = nameLength === VIEW_NAME.length && matchesName(bytes, cursor + 46, VIEW_NAME) ? VIEW_NAME
      : nameLength === IMAGE_NAME.length && matchesName(bytes, cursor + 46, IMAGE_NAME) ? IMAGE_NAME : invalid('member name');
    if (members.some(member => member.name === name) || size < 1 ||
        size > (name === VIEW_NAME ? MAX_SAVED_VIEW_RECORD_BYTES : MAX_SAVED_THUMBNAIL_BYTES)) invalid('member count or size');
    const offset = header.getUint32(cursor + 42, true), body = offset + 30 + nameLength, end = body + size;
    if (offset >= centralStart || body > centralStart || end > centralStart) invalid('member offset or length');
    members.push({ name, size, crc: header.getUint32(cursor + 16, true), flags, version,
      time: header.getUint16(cursor + 12, true), date: header.getUint16(cursor + 14, true), offset, body, end });
    cursor += 46 + nameLength;
  }
  if (cursor !== bytes.length) invalid('extra directory bytes');
  const ordered = [...members].sort((a, b) => a.offset - b.offset);
  if (ordered[0].offset !== 0 || ordered[0].end !== ordered[1].offset || ordered[1].end !== centralStart)
    invalid('overlapping or noncontiguous members');
  return members;
}
async function checkLocalHeaders(blob: Blob, members: readonly Member[], operation: ImageOperation) {
  for (const member of members) {
    const bytes = await readRange(blob, member.offset, member.body, operation);
    const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (header.getUint32(0, true) !== 0x04034b50 || header.getUint16(4, true) !== member.version ||
        header.getUint16(6, true) !== member.flags || header.getUint16(8, true) !== 0 ||
        header.getUint16(10, true) !== member.time || header.getUint16(12, true) !== member.date ||
        header.getUint32(14, true) !== member.crc || header.getUint32(18, true) !== member.size ||
        header.getUint32(22, true) !== member.size || header.getUint16(26, true) !== member.name.length ||
        header.getUint16(28, true) !== 0 || !matchesName(bytes, 30, member.name)) invalid('inconsistent local header');
  }
}

/** A strict two-member stored ZIP profile; no extraction or decompression. */
export async function readPortableSavedView(blob: Blob, operation: ImageOperation): Promise<PortableSavedView> {
  checkSavedViewOperation(operation); checkSize(blob);
  let retained: (() => void) | undefined = operation.admit(blob.size + RECORD_RETENTION_BYTES);
  let scratch: (() => void) | undefined;
  try {
    scratch = operation.admit(SCRATCH_BYTES);
    const endBytes = await readRange(blob, blob.size - 22, blob.size, operation);
    const end = new DataView(endBytes.buffer);
    if (end.getUint32(0, true) !== 0x06054b50 || end.getUint16(4, true) !== 0 || end.getUint16(6, true) !== 0 ||
        end.getUint16(8, true) !== 2 || end.getUint16(10, true) !== 2 || end.getUint32(12, true) !== DIRECTORY_BYTES ||
        end.getUint16(20, true) !== 0) invalid('end of directory');
    const centralStart = end.getUint32(16, true);
    if (centralStart + DIRECTORY_BYTES + 22 !== blob.size) invalid('directory range');
    const members = directory(await readRange(blob, centralStart, centralStart + DIRECTORY_BYTES, operation), centralStart);
    await checkLocalHeaders(blob, members, operation); checkSavedViewOperation(operation);
    const view = members.find(member => member.name === VIEW_NAME)!, thumbnail = members.find(member => member.name === IMAGE_NAME)!;
    const table = crcTable(), json = await readRange(blob, view.body, view.end, operation);
    if (((updateCrc(0xffff_ffff, json, table) ^ 0xffff_ffff) >>> 0) !== view.crc) invalid('metadata CRC');
    const record = validateSavedViewRecord(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(json)));
    if (record.thumbnail.byteLength !== thumbnail.size) invalid('image length binding');
    const image = blob.slice(thumbnail.body, thumbnail.end, 'image/png');
    if (await blobCrc(image, table, operation) !== thumbnail.crc) invalid('image CRC');
    checkSavedViewOperation(operation);
    await verifySavedThumbnail(record, image, operation); checkSavedViewOperation(operation);
    knownBackingBytes.set(image, blob.size);
    let owner: (() => void) | undefined = retained; retained = undefined;
    return { record, image, dispose() { owner?.(); owner = undefined; } };
  } finally { scratch?.(); retained?.(); }
}

function localHeader(name: string, size: number, crc: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(30 + name.length), header = new DataView(bytes.buffer);
  header.setUint32(0, 0x04034b50, true); header.setUint16(4, 20, true);
  header.setUint16(12, 0x21, true); // 1980-01-01; no environment-dependent ZIP timestamp.
  header.setUint32(14, crc, true); header.setUint32(18, size, true); header.setUint32(22, size, true);
  header.setUint16(26, name.length, true);
  for (let index = 0; index < name.length; index++) bytes[30 + index] = name.charCodeAt(index);
  return bytes;
}
function centralHeader(name: string, size: number, crc: number, offset: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(46 + name.length), header = new DataView(bytes.buffer);
  header.setUint32(0, 0x02014b50, true); header.setUint16(4, 20, true); header.setUint16(6, 20, true);
  header.setUint16(14, 0x21, true); header.setUint32(16, crc, true);
  header.setUint32(20, size, true); header.setUint32(24, size, true); header.setUint16(28, name.length, true);
  header.setUint32(42, offset, true);
  for (let index = 0; index < name.length; index++) bytes[46 + index] = name.charCodeAt(index);
  return bytes;
}

/** Construct admitted Blob parts while preserving the immutable PNG backing. */
export async function writePortableSavedView(input: SavedViewRecord, image: Blob, operation: ImageOperation): Promise<PortableSavedViewOutput> {
  checkSavedViewOperation(operation);
  if (!(image instanceof Blob) || image.size < 1 || image.size > MAX_SAVED_THUMBNAIL_BYTES) invalid('image size');
  // IndexedDB/structured clone loses WeakMap identity while a Blob may still
  // share its imported archive backing. Unknown PNG owners conservatively
  // include one bounded metadata/container region in addition to the output's.
  let retained: (() => void) | undefined = operation.admit((knownBackingBytes.get(image) ??
    image.size + MAX_SAVED_VIEW_RECORD_BYTES + CONTAINER_OVERHEAD) +
    MAX_SAVED_VIEW_RECORD_BYTES + CONTAINER_OVERHEAD);
  let scratch: (() => void) | undefined;
  try {
    scratch = operation.admit(SCRATCH_BYTES);
    // Snapshot before the first awaited verification; the caller cannot amend
    // camera/source metadata while the image hash or browser decode is pending.
    const record = validateSavedViewRecord(input);
    await verifySavedThumbnail(record, image, operation); checkSavedViewOperation(operation);
    const json = new TextEncoder().encode(JSON.stringify(record)), table = crcTable();
    const viewCrc = (updateCrc(0xffff_ffff, json, table) ^ 0xffff_ffff) >>> 0;
    const imageCrc = await blobCrc(image, table, operation); checkSavedViewOperation(operation);
    const viewHeader = localHeader(VIEW_NAME, json.length, viewCrc), imageHeader = localHeader(IMAGE_NAME, image.size, imageCrc);
    const imageOffset = viewHeader.length + json.length, centralOffset = imageOffset + imageHeader.length + image.size;
    const endBytes = new Uint8Array(22), end = new DataView(endBytes.buffer);
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, 2, true); end.setUint16(10, 2, true);
    end.setUint32(12, DIRECTORY_BYTES, true); end.setUint32(16, centralOffset, true);
    const blob = new Blob([viewHeader, json, imageHeader, image,
      centralHeader(VIEW_NAME, json.length, viewCrc, 0), centralHeader(IMAGE_NAME, image.size, imageCrc, imageOffset), endBytes],
    { type: 'application/zip' });
    if (blob.size > MAX_PORTABLE_SAVED_VIEW_BYTES) invalid('output size');
    checkSavedViewOperation(operation);
    let owner: (() => void) | undefined = retained; retained = undefined;
    return { blob, dispose() { owner?.(); owner = undefined; } };
  } finally { scratch?.(); retained?.(); }
}
