import { checkedBytes } from '../document/resources';
import type { SavedViewOperation } from './thumbnail';

export type OwnedRgbaImage = Readonly<{
  width: number; height: number; pixels: Uint8ClampedArray<ArrayBuffer>; dispose(): void;
}>;
export type OwnedImageOutput = Readonly<{ blob: Blob; dispose(): void }>;
type ImageOwner = { pixels: Uint8ClampedArray<ArrayBuffer>; release(): void; borrowers: number; closing: boolean; retired: boolean };
const owners = new WeakMap<OwnedRgbaImage, ImageOwner>();
const claimedBuffers = new WeakSet<ArrayBuffer>();
const check = (operation: SavedViewOperation) => { operation.signal?.throwIfAborted(); operation.current?.(); };

/** The same bounded raw-image dimensions as the desktop thumbnail endpoint. */
export function rgbaImageBytes(width: number, height: number): number {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > 16384 || height > 16384)
    throw new RangeError('Invalid raw image dimensions.');
  const bytes = checkedBytes(checkedBytes(width, height), 4);
  if (bytes > 256 * 1024 * 1024) throw new RangeError('The raw image exceeds the image budget.');
  return bytes;
}
function retire(owner: ImageOwner) {
  if (!owner.closing || owner.borrowers || owner.retired) return;
  owner.retired = true;
  try {
    const buffer = owner.pixels.buffer;
    if (buffer.byteLength) structuredClone(buffer, { transfer: [buffer] });
  } finally { owner.release(); }
}
/** Consume an already admitted, tightly packed buffer on success. The caller
 * retains cleanup responsibility if validation throws before ownership moves. */
export function ownRgbaImage(width: number, height: number, pixels: Uint8ClampedArray<ArrayBuffer>, release: () => void): OwnedRgbaImage {
  const bytes = rgbaImageBytes(width, height);
  if (!(pixels instanceof Uint8ClampedArray) || !(pixels.buffer instanceof ArrayBuffer) ||
      pixels.byteOffset !== 0 || pixels.byteLength !== bytes || pixels.buffer.byteLength !== bytes || typeof release !== 'function' || claimedBuffers.has(pixels.buffer))
    throw new TypeError('A tightly packed owned RGBA image is required.');
  const owner: ImageOwner = { pixels, release, borrowers: 0, closing: false, retired: false };
  claimedBuffers.add(pixels.buffer);
  const image = Object.freeze({ width, height, pixels, dispose() { owner.closing = true; retire(owner); } });
  owners.set(image, owner); return image;
}
/** A pending encoder/filter borrows the raw buffer until its actual Promise
 * joins. Disposing its parent cannot release or detach bytes still in use. */
export async function withRgbaImage<T>(source: OwnedRgbaImage,
  read: (pixels: Uint8ClampedArray<ArrayBuffer>) => T | Promise<T>): Promise<T> {
  const owner = owners.get(source);
  if (!owner || owner.closing || owner.retired || source.pixels.byteLength !== rgbaImageBytes(source.width, source.height))
    throw new Error('The raw image owner is unavailable.');
  owner.borrowers++;
  try { return await read(owner.pixels); }
  finally { owner.borrowers--; retire(owner); }
}

/** Encode one immutable raw frame without consuming it. Browser encoding is
 * an explicit PNG/JPEG adapter; matching JPEG bytes across encoders is not
 * promised. Both working storage and returned Blob ownership remain admitted. */
export async function encodeRgba(source: OwnedRgbaImage, type: 'image/png' | 'image/jpeg',
  operation: SavedViewOperation, quality = .95): Promise<OwnedImageOutput> {
  check(operation);
  if (type !== 'image/png' && type !== 'image/jpeg') throw new TypeError('Choose PNG or JPEG image output.');
  if (!Number.isFinite(quality) || quality < 0 || quality > 1) throw new RangeError('Invalid image quality.');
  return withRgbaImage(source, async pixels => {
    check(operation);
    const bytes = rgbaImageBytes(source.width, source.height), encodedLimit = checkedBytes(bytes * 2 + 65536, 1);
    // Canvas plus encoder workspace, and the complete bounded encoded output
    // while admission of its independent retained owner is still pending.
    const scratch = operation.admit(checkedBytes(bytes * 2 + encodedLimit, 1));
    let canvas: OffscreenCanvas | undefined, retained: (() => void) | undefined;
    try {
      canvas = new OffscreenCanvas(source.width, source.height);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Image encoding is unavailable.');
      context.putImageData(new ImageData(pixels, source.width, source.height), 0, 0); check(operation);
      const blob = await canvas.convertToBlob({ type, quality }); check(operation);
      if (blob.type !== type) throw new Error('The browser returned a different image format.');
      if (!Number.isSafeInteger(blob.size) || blob.size < 1 || blob.size > encodedLimit)
        throw new Error('The encoded image exceeds the image budget.');
      retained = operation.admit(blob.size); check(operation);
      let release: (() => void) | undefined = retained; retained = undefined;
      return Object.freeze({ blob, dispose() { const pending = release; release = undefined; pending?.(); } });
    } finally {
      if (canvas) { canvas.width = 0; canvas.height = 0; }
      retained?.(); scratch();
    }
  });
}
