import type { ImageOperation } from '../src/io/image';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { encodeRgba, ownRgbaImage, rgbaImageBytes, withRgbaImage } from '../src/io/image';
import { createSavedThumbnail, resampleThumbnailRgba } from '../src/io/thumbnail';

function gate<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done; }), resolve }; }
function budget() {
  const entries = new Map<number, number>(); let next = 0, released = 0;
  const admit = vi.fn((bytes: number) => {
    const id = ++next; entries.set(id, bytes); let live = true;
    return () => { if (live) { live = false; released++; entries.delete(id); } };
  });
  return { admit, bytes: () => [...entries.values()].reduce((sum, bytes) => sum + bytes, 0), allocations: () => entries.size, released: () => released };
}
function raw(width: number, height: number, operation: ImageOperation, values?: number[]) {
  const pixels = new Uint8ClampedArray(width * height * 4); if (values) pixels.set(values);
  return ownRgbaImage(width, height, pixels, operation.admit(pixels.byteLength));
}
// These unit doubles test ownership/failure ordering only. Actual encoder,
// decoded-pixel/MIME and clipboard behavior belong to browser observations.
function encoder(pending: Promise<Blob>) {
  const put = vi.fn(), convert = vi.fn(() => pending), canvases: { width: number; height: number }[] = [];
  vi.stubGlobal('ImageData', class { constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {} });
  vi.stubGlobal('OffscreenCanvas', class {
    constructor(public width: number, public height: number) { canvases.push(this); }
    getContext() { return { putImageData: put }; }
    convertToBlob = convert;
  });
  return { put, convert, canvases };
}
afterEach(() => { vi.unstubAllGlobals(); });

describe('owned raw images', () => {
  it('validates tightly packed bounded buffers without consuming a refused caller lease', () => {
    const release = vi.fn();
    expect(() => ownRgbaImage(1, 1, new Uint8ClampedArray(8), release)).toThrow();
    expect(() => ownRgbaImage(1, 1, new Uint8ClampedArray(new ArrayBuffer(8), 4, 4), release)).toThrow();
    expect(() => rgbaImageBytes(16384, 16384)).toThrow(); expect(() => rgbaImageBytes(1.5, 2)).toThrow();
    expect(release).not.toHaveBeenCalled();
  });
  it('rejects duplicate raw-buffer ownership and detaches before releasing its credit exactly once', () => {
    const pixels = new Uint8ClampedArray([1, 2, 3, 4]), lengths: number[] = [];
    const image = ownRgbaImage(1, 1, pixels, () => lengths.push(pixels.byteLength));
    expect(() => ownRgbaImage(1, 1, pixels, vi.fn())).toThrow(); image.dispose(); image.dispose();
    expect(lengths).toEqual([0]); expect(image.pixels.byteLength).toBe(0);
  });
  it('keeps the raw allocation alive until every asynchronous borrower actually joins', async () => {
    const memory = budget(), image = raw(1, 1, memory), first = gate<void>(), second = gate<void>();
    const a = withRgbaImage(image, () => first.promise), b = withRgbaImage(image, () => second.promise);
    image.dispose(); expect(image.pixels.byteLength).toBe(4); expect(memory.bytes()).toBe(4);
    await expect(withRgbaImage(image, () => undefined)).rejects.toThrow('unavailable');
    first.resolve(undefined); await a; expect(image.pixels.byteLength).toBe(4);
    second.resolve(undefined); await b; expect(image.pixels.byteLength).toBe(0); expect(memory.bytes()).toBe(0);
  });
  it('joins a throwing borrower before retiring its disposed source', async () => {
    const memory = budget(), image = raw(1, 1, memory);
    await expect(withRgbaImage(image, () => { image.dispose(); throw new Error('reader failure'); })).rejects.toThrow('reader failure');
    expect(memory.bytes()).toBe(0); expect(image.pixels.byteLength).toBe(0);
  });
});

describe('owned PNG/JPEG encoding', () => {
  it.each(['image/png', 'image/jpeg'] as const)('retains %s output and raw borrowers through the real encoding Promise', async type => {
    const memory = budget(), image = raw(1, 1, memory, [17, 83, 201, 255]), held = gate<Blob>(), observed = encoder(held.promise);
    const encoding = encodeRgba(image, type, memory); image.dispose();
    expect(image.pixels.byteLength).toBe(4); expect(memory.allocations()).toBe(2);
    expect(observed.convert).toHaveBeenCalledWith({ type, quality: .95 });
    const blob = new Blob(['encoded'], { type }); held.resolve(blob); const output = await encoding;
    expect(output.blob).toBe(blob); expect(image.pixels.byteLength).toBe(0); expect(memory.bytes()).toBe(blob.size);
    expect(observed.canvases.map(({ width, height }) => ({ width, height }))).toEqual([{ width: 0, height: 0 }]);
    output.dispose(); output.dispose(); expect(memory.bytes()).toBe(0); expect(memory.allocations()).toBe(0);
  });
  it('refuses a browser MIME fallback and releases all encoder storage', async () => {
    const memory = budget(), image = raw(1, 1, memory); encoder(Promise.resolve(new Blob(['png'], { type: 'image/png' })));
    await expect(encodeRgba(image, 'image/jpeg', memory)).rejects.toThrow('different image format');
    expect(memory.bytes()).toBe(4); image.dispose(); expect(memory.bytes()).toBe(0);
  });
  it('keeps scratch and disposed raw bytes admitted until a cancelled encoding Promise joins', async () => {
    const memory = budget(), abort = new AbortController(), held = gate<Blob>(), image = raw(1, 1, memory); encoder(held.promise);
    const encoding = encodeRgba(image, 'image/png', { ...memory, signal: abort.signal });
    abort.abort(); image.dispose(); expect(memory.allocations()).toBe(2); expect(image.pixels.byteLength).toBe(4);
    held.resolve(new Blob(['png'], { type: 'image/png' })); await expect(encoding).rejects.toThrow();
    expect(memory.bytes()).toBe(0); expect(image.pixels.byteLength).toBe(0);
  });
  it('cleans independent Blob admission when a final current check refuses publication', async () => {
    const memory = budget(), image = raw(1, 1, memory), blob = new Blob(['png'], { type: 'image/png' }); encoder(Promise.resolve(blob));
    let stale = false;
    const operation = { admit(bytes: number) { const release = memory.admit(bytes); if (bytes === blob.size) stale = true; return release; },
      current() { if (stale) throw new Error('stale image'); } };
    await expect(encodeRgba(image, 'image/png', operation)).rejects.toThrow('stale image');
    expect(memory.bytes()).toBe(4); image.dispose(); expect(memory.bytes()).toBe(0);
  });
  it('refuses invalid type/quality before allocating canvas or encoder storage', async () => {
    const memory = budget(), image = raw(1, 1, memory), observed = encoder(Promise.resolve(new Blob()));
    await expect(encodeRgba(image, 'image/webp' as 'image/png', memory)).rejects.toThrow('PNG or JPEG');
    await expect(encodeRgba(image, 'image/jpeg', memory, 2)).rejects.toThrow('quality');
    expect(observed.convert).not.toHaveBeenCalled(); expect(memory.bytes()).toBe(4); image.dispose();
  });
});

describe('deterministic portable thumbnails', () => {
  it('uses an integer-centered crop, does not upscale and forces alpha after preserving identity RGB', async () => {
    const memory = budget(), source = raw(4, 1, memory, [1, 2, 3, 0, 11, 22, 33, 17, 44, 55, 66, 88, 77, 88, 99, 255]);
    const image = await resampleThumbnailRgba(source, memory, 1024);
    expect([image.width, image.height]).toEqual([1, 1]); expect([...image.pixels]).toEqual([11, 22, 33, 255]);
    expect(source.pixels.byteLength).toBe(16); image.dispose(); source.dispose(); expect(memory.bytes()).toBe(0);
  });
  it('preserves the independently measured opaque 3-to-2 corner impulse', async () => {
    const memory = budget(), source = raw(3, 3, memory); source.pixels[0] = 255;
    for (let at = 3; at < source.pixels.length; at += 4) source.pixels[at] = 255;
    const image = await resampleThumbnailRgba(source, memory, 2);
    expect([...image.pixels]).toEqual([113, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255]);
    image.dispose(); source.dispose(); expect(memory.bytes()).toBe(0);
  });
  it('matches the independently measured 7-to-3 center impulse through both filtered axes', async () => {
    const memory = budget(), source = raw(7, 7, memory); source.pixels[(3 * 7 + 3) * 4] = 255;
    for (let at = 3; at < source.pixels.length; at += 4) source.pixels[at] = 255;
    const image = await resampleThumbnailRgba(source, memory, 3);
    expect([...image.pixels]).toEqual([0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255,
      0, 0, 0, 255, 70, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255]);
    image.dispose(); source.dispose(); expect(memory.bytes()).toBe(0);
  });
  it.each(['x', 'y'] as const)('matches measured opaque 8-to-3 %s impulses including the fractional half rounding', async axis => {
    const memory = budget(), source = raw(8, 8, memory);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const at = (y * 8 + x) * 4; source.pixels[at + 3] = 255;
      if ((axis === 'x' ? x : y) === 5) { source.pixels[at] = 255; source.pixels[at + 1] = 127; source.pixels[at + 2] = 1; }
    }
    const image = await resampleThumbnailRgba(source, memory, 3);
    // Literal raw WIC measurements: source impulse 5 contributes 32/16/0
    // to output 1, and 43/21/0 to output 2 (the latter is a half boundary).
    const expected = axis === 'x'
      ? [0, 0, 0, 255, 32, 16, 0, 255, 43, 21, 0, 255, 0, 0, 0, 255, 32, 16, 0, 255, 43, 21, 0, 255, 0, 0, 0, 255, 32, 16, 0, 255, 43, 21, 0, 255]
      : [0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 32, 16, 0, 255, 32, 16, 0, 255, 32, 16, 0, 255, 43, 21, 0, 255, 43, 21, 0, 255, 43, 21, 0, 255];
    expect([...image.pixels]).toEqual(expected); image.dispose(); source.dispose(); expect(memory.bytes()).toBe(0);
  });
  it('matches the measured opaque 3-to-2 two-dimensional center impulse and all three amplitude channels', async () => {
    const memory = budget(), source = raw(3, 3, memory);
    for (let at = 3; at < source.pixels.length; at += 4) source.pixels[at] = 255;
    source.pixels.set([255, 127, 1, 255], (1 * 3 + 1) * 4);
    const image = await resampleThumbnailRgba(source, memory, 2);
    expect([...image.pixels]).toEqual([28, 14, 0, 255, 14, 7, 0, 255, 14, 7, 0, 255, 7, 4, 0, 255]);
    image.dispose(); source.dispose(); expect(memory.bytes()).toBe(0);
  });
  it('checks cancellation at bounded row yields and joins disposed source ownership', async () => {
    const memory = budget(), abort = new AbortController(), source = raw(300, 300, memory);
    const filtering = resampleThumbnailRgba(source, { ...memory, signal: abort.signal }, 300);
    abort.abort(); source.dispose(); await expect(filtering).rejects.toThrow();
    expect(memory.bytes()).toBe(0); expect(source.pixels.byteLength).toBe(0);
  });
  it('returns a PNG owner that survives hashing until the caller finishes storage', async () => {
    const memory = budget(), source = raw(1, 1, memory, [1, 2, 3, 255]), blob = new Blob(['png'], { type: 'image/png' });
    const observed = encoder(Promise.resolve(blob)); const thumbnail = await createSavedThumbnail(source, memory);
    expect(observed.convert).toHaveBeenCalledTimes(1); expect(thumbnail.image).toBe(blob);
    expect(thumbnail.thumbnail).toMatchObject({ width: 1, height: 1, byteLength: blob.size, type: 'image/png' });
    expect(thumbnail.thumbnail.sha256).toMatch(/^[0-9a-f]{64}$/); expect(memory.bytes()).toBe(source.pixels.byteLength + blob.size);
    thumbnail.dispose(); thumbnail.dispose(); source.dispose(); expect(memory.bytes()).toBe(0);
  });
});

type WicFixture = { id: string; input: { path: string; width: number; height: number; byteLength: number; sha256: string };
  output: { path: string; byteLength: number; sha256: string }; plan: { requestedSize: number; width: number; height: number } };
const wic = JSON.parse(readFileSync(new URL('./fixtures/thumbnail-wic/reference-manifest.json', import.meta.url), 'utf8')) as { fixtures: WicFixture[] };
const digest = (bytes: Uint8Array | Uint8ClampedArray) => createHash('sha256').update(bytes).digest('hex');
function referenceBytes(fixture: WicFixture, role: 'input' | 'output'): Uint8Array<ArrayBuffer> {
  // This multi-MiB constant case is regenerated from the independent captured
  // formula instead of duplicating its source and output arrays in the repo.
  if (fixture.id === 'maximum-request-clamp') {
    const result = new Uint8Array(fixture[role].byteLength);
    for (let at = 0; at < result.length; at += 4) {
      result[at] = 19; result[at + 1] = 83; result[at + 2] = 173; result[at + 3] = 255;
    }
    return result;
  }
  return new Uint8Array(readFileSync(new URL('./fixtures/thumbnail-wic/' + fixture[role].path, import.meta.url)));
}
function rgba(bgra: Uint8Array): Uint8ClampedArray<ArrayBuffer> {
  const result = new Uint8ClampedArray(bgra.length);
  for (let at = 0; at < bgra.length; at += 4) {
    result[at] = bgra[at + 2]; result[at + 1] = bgra[at + 1]; result[at + 2] = bgra[at]; result[at + 3] = bgra[at + 3];
  }
  return result;
}
it('matches all 17 actual WIC final references through the production filter, including the full-size formula-generated case', async () => {
  expect(wic.fixtures).toHaveLength(17);
  for (const fixture of wic.fixtures) {
    const input = referenceBytes(fixture, 'input'), expected = referenceBytes(fixture, 'output');
    expect(input.byteLength).toBe(fixture.input.byteLength); expect(digest(input)).toBe(fixture.input.sha256);
    expect(expected.byteLength).toBe(fixture.output.byteLength); expect(digest(expected)).toBe(fixture.output.sha256);
    const memory = budget(), pixels = rgba(input), source = ownRgbaImage(fixture.input.width, fixture.input.height, pixels, memory.admit(pixels.byteLength));
    const filtered = await resampleThumbnailRgba(source, memory, fixture.plan.requestedSize);
    try {
      expect([filtered.width, filtered.height]).toEqual([fixture.plan.width, fixture.plan.height]);
      expect(digest(filtered.pixels), fixture.id).toBe(digest(rgba(expected)));
    } finally { filtered.dispose(); source.dispose(); }
    expect(memory.bytes()).toBe(0);
  }
}, 15000);
