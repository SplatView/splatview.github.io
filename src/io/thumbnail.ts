import { MAX_SAVED_THUMBNAIL_BYTES, thumbnailPlan, type SavedViewRecord } from './savedView';
import { encodeRgba, ownRgbaImage, withRgbaImage, type OwnedRgbaImage, type OwnedImageOutput } from './image';

export type SavedViewOperation = {
  signal?: AbortSignal;
  current?: () => void;
  admit: (bytes: number) => () => void;
};
export function checkSavedViewOperation(operation: SavedViewOperation) {
  operation.signal?.throwIfAborted(); operation.current?.();
}
const digestHex = async (bytes: ArrayBuffer) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
  value => value.toString(16).padStart(2, '0')).join('');
function pngDimensions(bytes: ArrayBuffer, width: number, height: number) {
  const header = new DataView(bytes);
  if (bytes.byteLength < 33 || header.getUint32(0) !== 0x89504e47 || header.getUint32(4) !== 0x0d0a1a0a ||
      header.getUint32(8) !== 13 || header.getUint32(12) !== 0x49484452 || header.getUint32(16) !== width || header.getUint32(20) !== height)
    throw new Error('The PNG header does not match the expected image dimensions.');
}

/** Independent filter calibrated against raw Windows WIC Fant measurements.
 * Integer crop, no upscale and final opaque alpha follow the desktop endpoint.
 * Direct rational left-boundary carry, f32 sums and byte alpha association match
 * all 17 preserved fixtures. Fourteen additional vertical-alpha diagnostics
 * differ; this is not a claim to reproduce every private WIC implementation.
 * https://learn.microsoft.com/windows/win32/api/wincodec/ne-wincodec-wicbitmapinterpolationmode
 */
export async function resampleThumbnailRgba(source: OwnedRgbaImage, operation: SavedViewOperation, maxSide = 1024): Promise<OwnedRgbaImage> {
  checkSavedViewOperation(operation);
  const plan = thumbnailPlan(source.width, source.height, maxSide), target = plan.width, side = plan.side;
  return withRgbaImage(source, async pixels => {
    let retained: (() => void) | undefined = operation.admit(target * target * 4);
    let scratch: (() => void) | undefined;
    try {
      // One shared axis table and two f32 rows; never allocate a full decoded
      // intermediate image. Credit covers all typed arrays before allocation.
      scratch = operation.admit((side + target) * 4 + (target * 2 + 1) * 4 + target * 4 * 4 * 2 + 16384);
      const result = new Uint8ClampedArray(target * target * 4), sums = new Float32Array(target * 4), horizontal = new Float32Array(target * 4);
      const weights = new Float32Array(side + target), offsets = new Uint32Array(target + 1), starts = new Uint32Array(target);
      const f = Math.fround;
      let used = 0;
      for (let x = 0; x < target; x++) {
        const left = x * side, right = (x + 1) * side, first = Math.floor(left / target), remainder = left % target;
        offsets[x] = used; starts[x] = first;
        const transfer = f(remainder * (target - remainder) / (side * target));
        for (let sx = first; sx < Math.ceil(right / target); sx++) {
          let weight = f((Math.min(right, (sx + 1) * target) - Math.max(left, sx * target)) / side);
          // The measured fractional-left sample contributes its remaining
          // coverage twice; its linear complement moves to the next sample.
          if (remainder && sx === first) weight = f((target - remainder) ** 2 / (side * target));
          else if (remainder && sx === first + 1) weight = f(weight + transfer);
          weights[used++] = weight;
        }
      }
      offsets[target] = used;
      let work = 0;
      for (let y = 0; y < target; y++) {
        checkSavedViewOperation(operation); sums.fill(0);
        if (side === target) {
          // WIC skips its scaler for an identity crop. Preserve straight RGB,
          // including transparent source colors, before forcing opaque alpha.
          for (let x = 0; x < target; x++) {
            const from = ((plan.y + y) * source.width + plan.x + x) * 4, to = (y * target + x) * 4;
            result[to] = pixels[from]; result[to + 1] = pixels[from + 1]; result[to + 2] = pixels[from + 2]; result[to + 3] = 255;
          }
          work += side;
        } else {
          for (let iy = offsets[y]!; iy < offsets[y + 1]!; iy++) {
            const sy = starts[y]! + iy - offsets[y]!, wy = weights[iy]!;
            for (let x = 0; x < target; x++) {
              let r = 0, g = 0, b = 0, alpha = 0;
              for (let ix = offsets[x]!; ix < offsets[x + 1]!; ix++) {
                const sx = starts[x]! + ix - offsets[x]!, weight = weights[ix]!, at = ((plan.y + sy) * source.width + plan.x + sx) * 4, a = pixels[at + 3]!;
                r = f(r + f(Math.round(f(pixels[at]! * a / 255)) * weight));
                g = f(g + f(Math.round(f(pixels[at + 1]! * a / 255)) * weight));
                b = f(b + f(Math.round(f(pixels[at + 2]! * a / 255)) * weight));
                alpha = f(alpha + f(a * weight));
              }
              const at = x * 4; horizontal[at] = r; horizontal[at + 1] = g; horizontal[at + 2] = b; horizontal[at + 3] = alpha;
            }
            for (let at = 0; at < sums.length; at++) sums[at] = f(sums[at]! + f(horizontal[at]! * wy));
            work += side;
            if (work >= 65536) {
              work = 0; await new Promise<void>(resolve => setTimeout(resolve, 0)); checkSavedViewOperation(operation);
            }
          }
          for (let x = 0; x < target; x++) {
            const from = x * 4, to = (y * target + x) * 4, alpha = Math.round(sums[from + 3]!);
            // Fixed16/24/32 reciprocal tables are indistinguishable on the
            // measurements. Fixed16 is the explicit portable adapter choice.
            const reciprocal = alpha ? Math.floor(255 * 65536 / alpha) : 0;
            for (let channel = 0; channel < 3; channel++)
              result[to + channel] = Math.floor(Math.round(sums[from + channel]!) * reciprocal / 65536);
            result[to + 3] = 255;
          }
        }
        if (work >= 65536) {
          work = 0; await new Promise<void>(resolve => setTimeout(resolve, 0)); checkSavedViewOperation(operation);
        }
      }
      checkSavedViewOperation(operation);
      const image = ownRgbaImage(target, target, result, retained); retained = undefined; return image;
    } finally { scratch?.(); retained?.(); }
  });
}

/** One raw filter and one PNG encode; the returned owner survives hashing and
 * the caller's atomic metadata/image transaction until explicitly disposed. */
export async function createSavedThumbnail(source: OwnedRgbaImage, operation: SavedViewOperation, maxSide = 1024) {
  const resized = await resampleThumbnailRgba(source, operation, maxSide);
  let output: OwnedImageOutput | undefined;
  try {
    output = await encodeRgba(resized, 'image/png', operation); checkSavedViewOperation(operation);
    const image = output.blob;
    if (image.size > MAX_SAVED_THUMBNAIL_BYTES) throw new Error('The thumbnail exceeds the image budget.');
    const release = operation.admit(image.size + 64);
    let sha256: string;
    try { const bytes = await image.arrayBuffer(); checkSavedViewOperation(operation); sha256 = await digestHex(bytes); checkSavedViewOperation(operation); }
    finally { release(); }
    const retained = output; output = undefined;
    return Object.freeze({ image, thumbnail: { type: 'image/png' as const, width: resized.width, height: resized.height, byteLength: image.size, sha256 },
      dispose: () => retained.dispose() });
  } finally { output?.dispose(); resized.dispose(); }
}

/** Verify both encoded identity and actual PNG decoding before a stored pair is usable. */
export async function verifySavedThumbnail(record: SavedViewRecord, image: unknown, operation: SavedViewOperation): Promise<Blob> {
  checkSavedViewOperation(operation);
  if (!(image instanceof Blob) || image.type !== 'image/png' || image.size !== record.thumbnail.byteLength)
    throw new Error('The saved thumbnail is missing or corrupt.');
  const release = operation.admit(image.size * 3 + record.thumbnail.width * record.thumbnail.height * 4 + 16 * 1024);
  let bitmap: ImageBitmap | undefined;
  try {
    const bytes = await image.arrayBuffer(); checkSavedViewOperation(operation);
    // Check the bounded PNG header before asking the browser to allocate decoded pixels.
    pngDimensions(bytes, record.thumbnail.width, record.thumbnail.height);
    const hash = await digestHex(bytes); checkSavedViewOperation(operation);
    if (hash !== record.thumbnail.sha256) throw new Error('The saved thumbnail does not match its view.');
    bitmap = await createImageBitmap(image, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    checkSavedViewOperation(operation);
    if (bitmap.width !== record.thumbnail.width || bitmap.height !== record.thumbnail.height)
      throw new Error('The saved thumbnail dimensions do not match its view.');
    return image;
  } finally { bitmap?.close(); release(); }
}
