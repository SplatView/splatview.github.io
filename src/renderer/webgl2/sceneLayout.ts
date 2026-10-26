import { AdmissionError, checkedBytes, packedStride } from '../../document/resources';

export type TextureLayout = Readonly<{ width: number; height: number; entries: number; bytes: number }>;
/** Linear integer texels; padding belongs to the physical allocation. */
export function linearTextureLayout(entries: number, bytesPerTexel: number, maximum: number, preferred = 2048): TextureLayout {
  checkedBytes(entries, bytesPerTexel);
  if (!entries || !Number.isSafeInteger(maximum) || maximum < 1) throw new AdmissionError('Invalid graphics texture size.');
  const width = Math.min(entries, preferred, maximum), height = Math.ceil(entries / width);
  if (height > maximum) throw new AdmissionError('This scene exceeds the WebGL2 texture limit. Load fewer splats.');
  return Object.freeze({ width, height, entries, bytes: checkedBytes(checkedBytes(width, height), bytesPerTexel) });
}

export function planGlScene(count: number, degree: number, maximum: number) {
  const stride = packedStride(degree);
  if (!Number.isSafeInteger(count) || count < 1 || count > 3_000_000)
    throw new AdmissionError('This scene exceeds the current loaded-splat limit.');
  const words = linearTextureLayout(checkedBytes(count, stride / 4), 4, maximum, 8192);
  const states = linearTextureLayout(count, 16, maximum), order = linearTextureLayout(count, 4, maximum);
  return Object.freeze({ stride, words, states, order,
    // The worker owns one packed mirror. Canonical masks stay with the scene.
    bytes: checkedBytes(words.bytes + states.bytes + order.bytes + checkedBytes(count, stride + 1), 1) });
}

/** Split partial linear uploads at rows without padding or rewriting neighbors. */
export function textureUploadSpans(first: number, count: number, layout: TextureLayout) {
  if (![first,count].every(Number.isSafeInteger) || first < 0 || count < 0 || first + count > layout.entries)
    throw new RangeError('Invalid graphics texture upload range.');
  const spans: {x:number;y:number;width:number;height:number;offset:number;entries:number}[] = [];
  let at=first, remaining=count, offset=0;
  while (remaining) {
    const x=at%layout.width, y=Math.floor(at/layout.width);
    const rows=x===0 ? Math.floor(remaining/layout.width):0;
    const width=rows ? layout.width:Math.min(remaining,layout.width-x), height=rows || 1, entries=width*height;
    spans.push({x,y,width,height,offset,entries}); at+=entries; offset+=entries; remaining-=entries;
  }
  return spans;
}
