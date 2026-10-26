import type { ImageOperation } from '../src/io/image';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdmissionError } from '../src/document/resources';
import { MAX_PORTABLE_SAVED_VIEW_BYTES, readPortableSavedView, writePortableSavedView } from '../src/io/portableSavedView';
import { MAX_SAVED_THUMBNAIL_BYTES, MAX_SAVED_VIEW_RECORD_BYTES, validateSavedViewRecord, type SavedViewRecord } from '../src/io/savedView';


// Independent fixture: Python stdlib zipfile.ZipFile(ZIP_STORED), two ZipInfo
// entries dated 1980-01-01, compact json.dumps metadata, zlib-built red RGBA PNG.
// This literal predates and does not call the application ZIP writer. Browser
// PNG decoding is intentionally stubbed in this container-isolation suite.
const FIXTURE = 'UEsDBBQAAAAAAAAAIQB+67XmiAIAAIgCAAAJAAAAdmlldy5qc29ueyJraW5kIjoic3BsYXR2aWV3LXNhdmVkLXZpZXciLCJzY2hlbWFWZXJzaW9uIjoxLCJyZWNvcmRJZCI6ImluZGVwZW5kZW50LXB5dGhvbi1yZWNvcmQiLCJhcHBWZXJzaW9uIjoiMC4xLjAiLCJjcmVhdGVkQXQiOjEwMDAsInVwZGF0ZWRBdCI6MjAwMCwic291cmNlIjp7InNjaGVtZSI6InNwbGF0dmlldy1zb3VyY2UtdjEiLCJhc3NldERpZ2VzdCI6IjAxMjM0NTY3ODlhYmNkZWYwMTIzNDU2Nzg5YWJjZGVmMDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWYiLCJyZXNvdXJjZUNvdW50IjoxLCJ0b3RhbEJ5dGVzIjo1MTIsInNvdXJjZUtpbmRIaW50IjoiUExZIn0sInNvdXJjZUtpbmQiOiJwb2ludHMiLCJ2aWV3Ijp7InRhcmdldCI6WzEsLTIsM10sInlhdyI6MC41LCJwaXRjaCI6LTAuMjUsImRpc3RhbmNlIjo4LCJyYWRpdXMiOjIsImZvdiI6NDUsInlVcCI6dHJ1ZSwicm9sbCI6MC4xMjUsImJhY2tncm91bmQiOiJncmF5In0sInRodW1ibmFpbCI6eyJ0eXBlIjoiaW1hZ2UvcG5nIiwid2lkdGgiOjEsImhlaWdodCI6MSwiYnl0ZUxlbmd0aCI6NzAsInNoYTI1NiI6IjRmZjZhYjY3MGE1OGMxNDI3MGUwMzRlMjA5MGQ5YTQzMmNhYTI2M2ExNGUwYTI1Nzg1Mzg2YjBjMTJmODgwYjUifSwiZGlzcGxheU5hbWUiOiJyZW5hbWVkLnBseSJ9UEsDBBQAAAAAAAAAIQA5YQprRgAAAEYAAAANAAAAdGh1bWJuYWlsLnBuZ4lQTkcNChoKAAAADUlIRFIAAAABAAAAAQgGAAAAHxXEiQAAAA1JREFUeJxj+M/A8B8ABQAB/4mZPR0AAAAASUVORK5CYIJQSwECFAAUAAAAAAAAACEAfuu15ogCAACIAgAACQAAAAAAAAAAAAAAgAEAAAAAdmlldy5qc29uUEsBAhQAFAAAAAAAAAAhADlhCmtGAAAARgAAAA0AAAAAAAAAAAAAAIABrwIAAHRodW1ibmFpbC5wbmdQSwUGAAAAAAIAAgByAAAAIAMAAAAA';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
const ORIGINAL = Buffer.from(FIXTURE, 'base64');
const ORIGINAL_JSON = ORIGINAL.subarray(39, 687);
const CENTRAL = 800, SECOND_CENTRAL = 855, END = 914, IMAGE_LOCAL = 687;
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const draft = (): SavedViewRecord => JSON.parse(ORIGINAL_JSON.toString('utf8'));
const image = () => new Blob([PNG], { type: 'image/png' });
const archive = () => new Blob([ORIGINAL], { type: 'application/zip' });

// Deliberately independent bit-at-a-time CRC, rather than the implementation's
// lookup table; standard known-vector assertions below pin its interpretation.
function referenceCrc(bytes: Uint8Array): number {
  let crc = -1;
  for (const byte of bytes) {
    crc ^= byte;
    for (let index = 0; index < 8; index++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ -1) >>> 0;
}
// Repackage the independently pinned Python headers for body/schema attacks.
// This helper is never used to establish the ordinary reader's acceptance.
function fixtureWithBodies(json: Uint8Array, png: Uint8Array = PNG, reverse = false): Blob {
  const inputs = [
    { body: json, local: Buffer.from(ORIGINAL.subarray(0, 39)), central: Buffer.from(ORIGINAL.subarray(CENTRAL, SECOND_CENTRAL)) },
    { body: png, local: Buffer.from(ORIGINAL.subarray(IMAGE_LOCAL, IMAGE_LOCAL + 43)), central: Buffer.from(ORIGINAL.subarray(SECOND_CENTRAL, END)) },
  ];
  if (reverse) inputs.reverse();
  const pieces: BlobPart[] = [], directory: BlobPart[] = [];
  let position = 0;
  for (const input of inputs) {
    const crc = referenceCrc(input.body);
    input.local.writeUInt32LE(crc, 14); input.local.writeUInt32LE(input.body.length, 18); input.local.writeUInt32LE(input.body.length, 22);
    input.central.writeUInt32LE(crc, 16); input.central.writeUInt32LE(input.body.length, 20); input.central.writeUInt32LE(input.body.length, 24);
    input.central.writeUInt32LE(position, 42);
    pieces.push(input.local, new Uint8Array(input.body)); directory.push(input.central);
    position += input.local.length + input.body.length;
  }
  const end = Buffer.from(ORIGINAL.subarray(END)); end.writeUInt32LE(position, 16);
  return new Blob([...pieces, ...directory, end], { type: 'application/zip' });
}
function changed(change: (bytes: Buffer) => void): Blob {
  const bytes = Buffer.from(ORIGINAL); change(bytes); return new Blob([bytes]);
}
function ledger(options: Partial<ImageOperation> & { refuseAt?: number } = {}) {
  let sequence = 0, bytes = 0, peak = 0;
  const active = new Map<number, number>(), admissions: number[] = [];
  const operation: ImageOperation = { ...options, admit(amount) {
    expect(Number.isSafeInteger(amount) && amount > 0).toBe(true);
    admissions.push(amount); if (++sequence === options.refuseAt) throw new AdmissionError('test admission refusal');
    const id = sequence; active.set(id, amount); bytes += amount; peak = Math.max(bytes, peak);
    let released = false;
    return () => { expect(released).toBe(false); released = true; bytes -= amount; active.delete(id); };
  } };
  return { operation, active, admissions, bytes: () => bytes, peak: () => peak };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function observed(blob: Blob, onRead: (start: number, end: number) => Promise<void> | void, offset = 0): Blob {
  const nativeSlice = blob.slice.bind(blob), nativeRead = blob.arrayBuffer.bind(blob);
  Object.defineProperty(blob, 'slice', { value(start = 0, end = blob.size, type = '') {
    return observed(nativeSlice(start, end, type), onRead, offset + start);
  } });
  Object.defineProperty(blob, 'arrayBuffer', { value: async () => { await onRead(offset, offset + blob.size); return nativeRead(); } });
  return blob;
}
let close: ReturnType<typeof vi.fn>;
beforeEach(() => {
  close = vi.fn();
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 1, height: 1, close })));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('independent portable saved-view container', () => {
  it('pins the Python ZIP and independent CRC values before reader acceptance', async () => {
    expect(ORIGINAL.length).toBe(936); expect(sha(ORIGINAL)).toBe('6aa99443b6fcaba3c9f118182025dcbcf052b748e9d3ad092b2faac107367264');
    expect(referenceCrc(Buffer.from('123456789'))).toBe(0xcbf43926);
    expect(referenceCrc(ORIGINAL_JSON)).toBe(0xe6b5eb7e); expect(referenceCrc(PNG)).toBe(0x6b0a6139);
    const owners = ledger(), pair = await readPortableSavedView(archive(), owners.operation);
    expect(pair.record).toEqual(draft()); expect(Object.isFrozen(pair.record.view.target)).toBe(true);
    expect(Buffer.from(await pair.image.arrayBuffer())).toEqual(PNG); expect(pair.image.type).toBe('image/png');
    expect(close).toHaveBeenCalledTimes(1); expect(owners.active.size).toBe(1);
    expect(owners.bytes()).toBe(936 + 8192 * 2 + 2048);
    pair.dispose(); pair.dispose(); expect(owners.bytes()).toBe(0);
  });
  it('reads all bounded directory/local headers before either member body', async () => {
    const reads: number[][] = [], owners = ledger();
    const pair = await readPortableSavedView(observed(archive(), (start, end) => { reads.push([start, end]); }), owners.operation);
    expect(reads.slice(0, 4)).toEqual([[914, 936], [800, 914], [0, 39], [687, 730]]);
    expect(reads[4]).toEqual([39, 687]); expect(reads.slice(0, 4).every(([a, b]) => b - a <= 114)).toBe(true);
    pair.dispose(); expect(owners.bytes()).toBe(0);
  });
  it('accepts reversed member order and explicit UTF8 name flags without changing identity', async () => {
    const reversed = fixtureWithBodies(ORIGINAL_JSON, PNG, true), owners = ledger();
    const bytes = Buffer.from(await reversed.arrayBuffer());
    const second = 43 + PNG.length, central = bytes.length - 136;
    bytes.writeUInt16LE(0x800, 6); bytes.writeUInt16LE(0x800, second + 6);
    bytes.writeUInt16LE(0x800, central + 8); bytes.writeUInt16LE(0x800, central + 59 + 8);
    const pair = await readPortableSavedView(new Blob([bytes]), owners.operation);
    expect(pair.record).toEqual(draft()); pair.dispose(); expect(owners.bytes()).toBe(0);
  });
  it('writes independently inspectable stored entries with the pinned body CRCs', async () => {
    const owners = ledger(), output = await writePortableSavedView(draft(), image(), owners.operation);
    expect(output.blob.type).toBe('application/zip'); expect(output.blob.size).toBe(936);
    const bytes = Buffer.from(await output.blob.arrayBuffer());
    expect(bytes.readUInt32LE(0)).toBe(0x04034b50); expect(bytes.readUInt16LE(8)).toBe(0);
    expect(bytes.subarray(30, 39).toString()).toBe('view.json');
    expect(bytes.readUInt32LE(14)).toBe(0xe6b5eb7e); expect(bytes.subarray(39, 687)).toEqual(ORIGINAL_JSON);
    expect(bytes.readUInt32LE(IMAGE_LOCAL + 14)).toBe(0x6b0a6139);
    expect(bytes.subarray(730, CENTRAL)).toEqual(PNG);
    expect(bytes.readUInt32LE(END)).toBe(0x06054b50); expect(bytes.readUInt16LE(END + 10)).toBe(2);
    expect(bytes.readUInt32LE(END + 12)).toBe(114); expect(bytes.readUInt32LE(END + 16)).toBe(800);
    expect(bytes.readUInt32LE(SECOND_CENTRAL + 42)).toBe(687);
    expect(owners.active.size).toBe(1); expect(owners.bytes()).toBe(70 + 2 * (8192 + 2048));
    output.dispose(); output.dispose(); expect(owners.bytes()).toBe(0);
  });
  it('uses schema1 JSON numeric zeros for valid signed-zero camera fields', async () => {
    const value = draft(), expected = draft();
    (value.view.target as unknown as number[])[0] = -0;
    Object.assign(value.view, { yaw: -0, pitch: -0, roll: -0 });
    (expected.view.target as unknown as number[])[0] = 0;
    Object.assign(expected.view, { yaw: 0, pitch: 0, roll: 0 });
    const writeOwners = ledger(), output = await writePortableSavedView(value, image(), writeOwners.operation);
    // Inspect the first local member directly, independently of our ZIP reader.
    const bytes = Buffer.from(await output.blob.arrayBuffer());
    const nameEnd = 30 + bytes.readUInt16LE(26), bodyStart = nameEnd + bytes.readUInt16LE(28);
    expect(bytes.subarray(30, nameEnd).toString('ascii')).toBe('view.json');
    const json = bytes.subarray(bodyStart, bodyStart + bytes.readUInt32LE(22)).toString('utf8');
    expect(json).toContain('"target":[0,-2,3]');
    for (const field of ['yaw', 'pitch', 'roll']) expect(json).toContain(`"${field}":0`);
    expect(JSON.parse(json)).toEqual(expected);
    const readOwners = ledger(), pair = await readPortableSavedView(output.blob, readOwners.operation);
    expect(pair.record).toEqual(expected);
    for (const zero of [pair.record.view.target[0], pair.record.view.yaw, pair.record.view.pitch, pair.record.view.roll]) {
      expect(Object.is(zero, 0)).toBe(true); expect(Object.is(zero, -0)).toBe(false);
    }
    for (const zero of [value.view.target[0], value.view.yaw, value.view.pitch, value.view.roll])
      expect(Object.is(zero, -0)).toBe(true);
    expect(Buffer.from(await pair.image.arrayBuffer())).toEqual(PNG);
    pair.dispose(); output.dispose(); expect(readOwners.bytes() + writeOwners.bytes()).toBe(0);
  });
  it('retains the whole known imported backing when an image slice is exported again', async () => {
    const readOwners = ledger(), writeOwners = ledger();
    const pair = await readPortableSavedView(archive(), readOwners.operation);
    const output = await writePortableSavedView(pair.record, pair.image, writeOwners.operation);
    pair.dispose(); expect(readOwners.bytes()).toBe(0);
    expect(writeOwners.bytes()).toBe(936 + 8192 + 2048);
    expect(Buffer.from(await output.blob.arrayBuffer()).subarray(730, 800)).toEqual(PNG);
    output.dispose(); expect(writeOwners.bytes()).toBe(0);
  });
  it('reserves a possible imported archive backing after a stored Blob loses its identity', async () => {
    const readOwners = ledger(), writeOwners = ledger();
    const pair = await readPortableSavedView(archive(), readOwners.operation);
    const cloned = structuredClone(pair.image); pair.dispose();
    expect(cloned).not.toBe(pair.image); expect(readOwners.bytes()).toBe(0);
    const output = await writePortableSavedView(pair.record, cloned, writeOwners.operation);
    expect(writeOwners.bytes()).toBe(70 + 2 * (8192 + 2048));
    expect(writeOwners.bytes()).toBeGreaterThan(936 + 8192 + 2048);
    expect(Buffer.from(await output.blob.arrayBuffer()).subarray(730, 800)).toEqual(PNG);
    output.dispose(); expect(writeOwners.bytes()).toBe(0);
  });
});

describe('bounded portable ZIP refusal', () => {
  const malformed: [string, (bytes: Buffer) => void][] = [
    ['EOCD signature', b => b.writeUInt32LE(0, END)],
    ['EOCD disk', b => b.writeUInt16LE(1, END + 4)],
    ['EOCD directory disk', b => b.writeUInt16LE(1, END + 6)],
    ['per-disk count', b => b.writeUInt16LE(1, END + 8)],
    ['extra member count', b => b.writeUInt16LE(3, END + 10)],
    ['directory length', b => b.writeUInt32LE(113, END + 12)],
    ['directory offset', b => b.writeUInt32LE(0xffff_ffff, END + 16)],
    ['archive comment', b => b.writeUInt16LE(1, END + 20)],
    ['directory signature', b => b.writeUInt32LE(0, CENTRAL)],
    ['ZIP64 version', b => b.writeUInt16LE(45, CENTRAL + 6)],
    ['encrypted', b => b.writeUInt16LE(1, CENTRAL + 8)],
    ['data descriptor', b => b.writeUInt16LE(8, CENTRAL + 8)],
    ['unknown flag', b => b.writeUInt16LE(0x40, CENTRAL + 8)],
    ['compressed method', b => b.writeUInt16LE(8, CENTRAL + 10)],
    ['compressed length', b => b.writeUInt32LE(647, CENTRAL + 20)],
    ['oversize JSON', b => { b.writeUInt32LE(8193, CENTRAL + 20); b.writeUInt32LE(8193, CENTRAL + 24); }],
    ['oversize PNG', b => { b.writeUInt32LE(MAX_SAVED_THUMBNAIL_BYTES + 1, SECOND_CENTRAL + 20); b.writeUInt32LE(MAX_SAVED_THUMBNAIL_BYTES + 1, SECOND_CENTRAL + 24); }],
    ['zero body', b => { b.writeUInt32LE(0, CENTRAL + 20); b.writeUInt32LE(0, CENTRAL + 24); }],
    ['unexpected filename', b => b.write('evil.json', CENTRAL + 46, 'ascii')],
    ['directory name length', b => b.writeUInt16LE(65535, CENTRAL + 28)],
    ['directory extra', b => b.writeUInt16LE(1, CENTRAL + 30)],
    ['directory comment', b => b.writeUInt16LE(1, CENTRAL + 32)],
    ['member disk', b => b.writeUInt16LE(1, CENTRAL + 34)],
    ['member before zero', b => b.writeUInt32LE(0xffff_ffff, CENTRAL + 42)],
    ['prefix gap', b => b.writeUInt32LE(1, CENTRAL + 42)],
    ['member overlap', b => b.writeUInt32LE(0, SECOND_CENTRAL + 42)],
    ['local signature', b => b.writeUInt32LE(0, 0)],
    ['local version mismatch', b => b.writeUInt16LE(10, 4)],
    ['local flag mismatch', b => b.writeUInt16LE(0x800, 6)],
    ['local compression', b => b.writeUInt16LE(8, 8)],
    ['local time mismatch', b => b.writeUInt16LE(1, 10)],
    ['local date mismatch', b => b.writeUInt16LE(1, 12)],
    ['local CRC mismatch', b => b.writeUInt32LE(0, 14)],
    ['local compressed length', b => b.writeUInt32LE(647, 18)],
    ['local plain length', b => b.writeUInt32LE(647, 22)],
    ['local name length', b => b.writeUInt16LE(8, 26)],
    ['local extra', b => b.writeUInt16LE(1, 28)],
    ['local name mismatch', b => b.write('evil.json', 30, 'ascii')],
    ['second local header', b => b.writeUInt16LE(1, IMAGE_LOCAL + 28)],
    ['metadata body CRC', b => { b[39 + 10] ^= 1; }],
    ['PNG body CRC', b => { b[730 + 40] ^= 1; }],
  ];
  it.each(malformed)('refuses %s and releases every owner', async (_, mutate) => {
    const owners = ledger(); await expect(readPortableSavedView(changed(mutate), owners.operation)).rejects.toThrow();
    expect(owners.bytes()).toBe(0); expect(createImageBitmap).not.toHaveBeenCalled();
  });
  it('rejects duplicate fixed names even when each directory entry is otherwise well formed', async () => {
    const bytes = Buffer.from(ORIGINAL);
    // Make the second central record a duplicate first entry and shrink the
    // exact directory length accordingly; the declared profile refuses it.
    const duplicate = Buffer.concat([bytes.subarray(0, CENTRAL), bytes.subarray(CENTRAL, SECOND_CENTRAL),
      bytes.subarray(CENTRAL, SECOND_CENTRAL), bytes.subarray(END)]);
    duplicate.writeUInt32LE(110, duplicate.length - 10);
    const owners = ledger(); await expect(readPortableSavedView(new Blob([duplicate]), owners.operation)).rejects.toThrow();
    expect(owners.bytes()).toBe(0);
  });
  it.each(['prefix', 'suffix', 'central gap', 'truncated'] as const)('rejects %s bytes', async kind => {
    let blob: Blob;
    if (kind === 'prefix') blob = new Blob([new Uint8Array([0]), ORIGINAL]);
    else if (kind === 'suffix') blob = new Blob([ORIGINAL, new Uint8Array([0])]);
    else if (kind === 'truncated') blob = new Blob([ORIGINAL.subarray(0, ORIGINAL.length - 1)]);
    else {
      const end = Buffer.from(ORIGINAL.subarray(END)); end.writeUInt32LE(CENTRAL + 1, 16);
      blob = new Blob([ORIGINAL.subarray(0, CENTRAL), new Uint8Array([0]), ORIGINAL.subarray(CENTRAL, END), end]);
    }
    const owners = ledger(); await expect(readPortableSavedView(blob, owners.operation)).rejects.toThrow(); expect(owners.bytes()).toBe(0);
  });
  it('rejects oversized or tiny input before admission or reads', async () => {
    expect(MAX_PORTABLE_SAVED_VIEW_BYTES).toBe(16 * 1024 * 1024 + 8192 + 2048);
    const owners = ledger(), large = new Blob([new Uint8Array(MAX_PORTABLE_SAVED_VIEW_BYTES + 1)]);
    await expect(readPortableSavedView(large, owners.operation)).rejects.toThrow(/size/);
    await expect(readPortableSavedView(new Blob(), owners.operation)).rejects.toThrow(/size/);
    expect(owners.admissions).toEqual([]);
  });
});

describe('metadata and actual thumbnail-verifier binding', () => {
  it.each(['malformed UTF8', 'BOM', 'invalid JSON', 'future schema', 'unknown field', 'image byte binding', 'image SHA binding'] as const)
  ('refuses %s with valid container CRCs', async kind => {
    const value = draft(); let json: Uint8Array;
    if (kind === 'malformed UTF8') json = new Uint8Array([0x7b, 0x22, 0xc0, 0xaf, 0x22, 0x7d]);
    else if (kind === 'BOM') json = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), ORIGINAL_JSON]);
    else if (kind === 'invalid JSON') json = Buffer.from('{');
    else {
      if (kind === 'future schema') (value as unknown as { schemaVersion: number }).schemaVersion = 2;
      if (kind === 'unknown field') Object.assign(value, { surprise: true });
      if (kind === 'image byte binding') (value.thumbnail as { byteLength: number }).byteLength++;
      if (kind === 'image SHA binding') (value.thumbnail as { sha256: string }).sha256 = '0'.repeat(64);
      json = Buffer.from(JSON.stringify(value));
    }
    const owners = ledger(); await expect(readPortableSavedView(fixtureWithBodies(json), owners.operation)).rejects.toThrow();
    expect(owners.bytes()).toBe(0); expect(createImageBitmap).not.toHaveBeenCalled();
  });
  it('checks PNG signature/IHDR before decoding, even after a matching SHA and CRC replacement', async () => {
    const png = Buffer.from(PNG); png[0] = 0;
    const value = draft(); (value.thumbnail as { sha256: string }).sha256 = sha(png);
    const owners = ledger();
    await expect(readPortableSavedView(fixtureWithBodies(Buffer.from(JSON.stringify(value)), png), owners.operation)).rejects.toThrow(/PNG header/);
    expect(createImageBitmap).not.toHaveBeenCalled(); expect(owners.bytes()).toBe(0);
  });
  it('requires the browser-decoded dimensions and closes its returned bitmap on refusal', async () => {
    vi.mocked(createImageBitmap).mockResolvedValue({ width: 2, height: 1, close } as unknown as ImageBitmap);
    const owners = ledger(); await expect(readPortableSavedView(archive(), owners.operation)).rejects.toThrow(/dimensions/);
    expect(close).toHaveBeenCalledTimes(1); expect(owners.bytes()).toBe(0);
  });
  it('propagates browser decode failure and releases scratch and retained input', async () => {
    vi.mocked(createImageBitmap).mockRejectedValue(new Error('decode unavailable'));
    const owners = ledger(); await expect(readPortableSavedView(archive(), owners.operation)).rejects.toThrow(/decode unavailable/);
    expect(owners.bytes()).toBe(0); expect(close).not.toHaveBeenCalled();
  });
  it('migrates only the known absent background while preserving complete source and camera fields', async () => {
    const value = draft(); delete (value.view as unknown as Record<string, unknown>).background;
    const owners = ledger(), pair = await readPortableSavedView(fixtureWithBodies(Buffer.from(JSON.stringify(value))), owners.operation);
    expect(pair.record.view.background).toBe('black'); expect(pair.record.source).toEqual(value.source);
    expect(pair.record.view).toEqual({ ...value.view, background: 'black' }); pair.dispose(); expect(owners.bytes()).toBe(0);
  });
  it('checks the writer pair before creating output and rejects mismatched schema/image/hash', async () => {
    for (const kind of ['schema', 'MIME', 'length', 'SHA'] as const) {
      const value = draft(), owners = ledger(); let png = image();
      if (kind === 'schema') (value as unknown as { schemaVersion: number }).schemaVersion = 2;
      if (kind === 'MIME') png = new Blob([PNG], { type: 'application/octet-stream' });
      if (kind === 'length') png = new Blob([PNG.subarray(1)], { type: 'image/png' });
      if (kind === 'SHA') (value.thumbnail as { sha256: string }).sha256 = 'f'.repeat(64);
      await expect(writePortableSavedView(value, png, owners.operation), kind).rejects.toThrow(); expect(owners.bytes()).toBe(0);
    }
  });
  it('validates a private record snapshot before an awaited image digest', async () => {
    const entered = deferred<void>(), held = deferred<void>(), original = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (...args) => { entered.resolve(); await held.promise; return original(...args); });
    const value = draft(), owners = ledger(), pending = writePortableSavedView(value, image(), owners.operation);
    await entered.promise;
    (value.view.target as unknown as number[])[0] = 1000; (value as { sourceKind: string }).sourceKind = 'mesh';
    held.resolve(); const output = await pending;
    vi.restoreAllMocks(); const readOwners = ledger(), pair = await readPortableSavedView(output.blob, readOwners.operation);
    expect(pair.record.view.target).toEqual([1, -2, 3]); expect(pair.record.sourceKind).toBe('points');
    pair.dispose(); output.dispose(); expect(readOwners.bytes() + owners.bytes()).toBe(0);
  });
});

describe('portable operation cancellation and memory ownership', () => {
  it.each([1, 2, 3] as const)('unwinds reader admission refusal %i', async refuseAt => {
    const owners = ledger({ refuseAt }); await expect(readPortableSavedView(archive(), owners.operation)).rejects.toBeInstanceOf(AdmissionError);
    expect(owners.bytes()).toBe(0);
  });
  it.each([1, 2, 3] as const)('unwinds writer admission refusal %i', async refuseAt => {
    const owners = ledger({ refuseAt }); await expect(writePortableSavedView(draft(), image(), owners.operation)).rejects.toBeInstanceOf(AdmissionError);
    expect(owners.bytes()).toBe(0);
  });
  it.each([1, 2, 3, 4, 5, 6, 7])('observes cancellation after actual reader Blob read %i', async readNumber => {
    const entered = deferred<void>(), held = deferred<void>(), abort = new AbortController(), owners = ledger({ signal: abort.signal });
    let count = 0;
    const source = observed(archive(), async () => { if (++count === readNumber) { entered.resolve(); await held.promise; } });
    const pending = readPortableSavedView(source, owners.operation); const rejected = expect(pending).rejects.toHaveProperty('name', 'AbortError');
    await entered.promise; expect(owners.bytes()).toBeGreaterThan(0); abort.abort(); held.resolve(); await rejected;
    expect(owners.bytes()).toBe(0); expect(createImageBitmap).not.toHaveBeenCalled();
  });
  it.each([1, 2])('observes cancellation after actual writer Blob read %i', async readNumber => {
    const entered = deferred<void>(), held = deferred<void>(), abort = new AbortController(), owners = ledger({ signal: abort.signal });
    let count = 0;
    const png = observed(image(), async () => { if (++count === readNumber) { entered.resolve(); await held.promise; } });
    const pending = writePortableSavedView(draft(), png, owners.operation); const rejected = expect(pending).rejects.toHaveProperty('name', 'AbortError');
    await entered.promise; abort.abort(); held.resolve(); await rejected; expect(owners.bytes()).toBe(0);
  });
  it.each(['read', 'write'] as const)('observes cancellation after an actual %s digest', async kind => {
    const entered = deferred<void>(), held = deferred<void>(), original = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (...args) => { entered.resolve(); await held.promise; return original(...args); });
    const abort = new AbortController(), owners = ledger({ signal: abort.signal });
    const pending = kind === 'read' ? readPortableSavedView(archive(), owners.operation) : writePortableSavedView(draft(), image(), owners.operation);
    const rejected = expect(pending).rejects.toHaveProperty('name', 'AbortError');
    await entered.promise; abort.abort(); held.resolve(); await rejected;
    expect(createImageBitmap).not.toHaveBeenCalled(); expect(owners.bytes()).toBe(0);
  });
  it.each(['read', 'write'] as const)('closes the bitmap on cancellation after an actual %s decode', async kind => {
    const entered = deferred<void>(), held = deferred<ImageBitmap>();
    vi.mocked(createImageBitmap).mockImplementation(async () => { entered.resolve(); return held.promise; });
    const abort = new AbortController(), owners = ledger({ signal: abort.signal });
    const pending = kind === 'read' ? readPortableSavedView(archive(), owners.operation) : writePortableSavedView(draft(), image(), owners.operation);
    const rejected = expect(pending).rejects.toHaveProperty('name', 'AbortError');
    await entered.promise; abort.abort(); held.resolve({ width: 1, height: 1, close } as unknown as ImageBitmap); await rejected;
    expect(close).toHaveBeenCalledTimes(1); expect(owners.bytes()).toBe(0);
  });
  it('checks request identity after reads and refuses an already cancelled operation before admission', async () => {
    let current = true;
    const owners = ledger({ current() { if (!current) throw new Error('stale request'); } });
    const source = observed(archive(), () => { current = false; });
    await expect(readPortableSavedView(source, owners.operation)).rejects.toThrow(/stale request/); expect(owners.bytes()).toBe(0);
    const abort = new AbortController(); abort.abort(); const cancelled = ledger({ signal: abort.signal });
    await expect(readPortableSavedView(archive(), cancelled.operation)).rejects.toHaveProperty('name', 'AbortError');
    await expect(writePortableSavedView(draft(), image(), cancelled.operation)).rejects.toHaveProperty('name', 'AbortError');
    expect(cancelled.admissions).toEqual([]);
  });
  it('streams image CRC in bounded reads rather than concatenating an archive buffer', async () => {
    const png = Buffer.concat([PNG, Buffer.alloc(150_000)]), value = draft();
    (value.thumbnail as { byteLength: number; sha256: string }).byteLength = png.length;
    (value.thumbnail as { sha256: string }).sha256 = sha(png);
    const reads: number[] = [], owners = ledger();
    const source = observed(fixtureWithBodies(Buffer.from(JSON.stringify(value)), png), (start, end) => { reads.push(end - start); });
    const pair = await readPortableSavedView(source, owners.operation);
    expect(reads.slice(5, -1)).toEqual([65536, 65536, png.length - 131072]);
    expect(reads.at(-1)).toBe(png.length); // separately admitted existing PNG verifier
    pair.dispose(); expect(owners.bytes()).toBe(0);
  });
  it('accepts the exact8192-byte metadata boundary and rejects the next byte', async () => {
    const value = draft(); (value as { displayName: string }).displayName = '';
    const baseline = Buffer.byteLength(JSON.stringify(value));
    (value as { displayName: string }).displayName = 'a'.repeat(MAX_SAVED_VIEW_RECORD_BYTES - baseline);
    expect(validateSavedViewRecord(value).displayName.length).toBe(MAX_SAVED_VIEW_RECORD_BYTES - baseline);
    const owners = ledger(), pair = await readPortableSavedView(fixtureWithBodies(Buffer.from(JSON.stringify(value))), owners.operation);
    pair.dispose(); expect(owners.bytes()).toBe(0);
    (value as { displayName: string }).displayName += 'a';
    await expect(readPortableSavedView(fixtureWithBodies(Buffer.from(JSON.stringify(value))), owners.operation)).rejects.toThrow();
    expect(owners.bytes()).toBe(0);
  });
});
