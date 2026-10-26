import type { ComputeStage } from './computeProtocol';
import { validateSortPrecision, type SortPrecision } from '../sortPrecision';

/** Deterministic worker sort. Selection/deletion flags never enter the key. */
export type ComputeCheckpoint = () => Promise<void>;
export type RadixScratch={keys:Uint32Array<ArrayBuffer>;input:Uint32Array<ArrayBuffer>;output:Uint32Array<ArrayBuffer>;histogram:Uint32Array<ArrayBuffer>};
export const createRadixScratch=(count:number,histogramBins=256):RadixScratch=>({keys:new Uint32Array(count),input:new Uint32Array(count),output:new Uint32Array(count),histogram:new Uint32Array(histogramBins)});
const f = Math.fround;
export function transformPoint(m: Float32Array, offset: number, x: number, y: number, z: number): [number,number,number,number] {
  const row = (r:number) => f(f(f(f(m[offset+r]*x)+f(m[offset+r+4]*y))+f(m[offset+r+8]*z))+m[offset+r+12]);
  return [row(0),row(1),row(2),row(3)];
}
export function floatDepthKey(depth: number) {
  const value=new Float32Array(1); value[0]=depth;
  const bits=new Uint32Array(value.buffer)[0];
  return (bits ^ ((bits & 0x80000000) ? 0xffffffff:0x80000000)) >>> 0;
}

type KeyRange = { min: number; max: number; and: number; or: number };

// Keep the kernels synchronous so cancellation does not inhibit their hot loops.
// Chunk boundaries below retain the executor's existing cooperative work bounds.
function depthKeys(packed: Float32Array, stride: number, frame: Float32Array, targets: Uint8Array,
  candidates: Uint32Array | undefined, keys: Uint32Array, input: Uint32Array, first: number, end: number,
  scalar: Float32Array, bits: Uint32Array, drop: number, range: KeyRange) {
  const flags = new Uint32Array(frame.buffer, frame.byteOffset, frame.length), transform = flags[76], selected = flags[77];
  const vx = frame[2], vy = frame[6], vz = frame[10], vw = frame[14];
  const m0=frame[60],m1=frame[61],m2=frame[62],m3=frame[63],m4=frame[64],m5=frame[65],m6=frame[66],m7=frame[67],
    m8=frame[68],m9=frame[69],m10=frame[70],m11=frame[71],m12=frame[72],m13=frame[73],m14=frame[74],m15=frame[75];
  let { min, max, and, or } = range;
  for (let i = first; i < end; i++) {
    const id = candidates ? candidates[i] : i, at = id * stride;
    let x = packed[at], y = packed[at+1], z = packed[at+2], w = 1;
    if (transform && (!selected || (targets[id] & 1))) {
      // Preserve transformPoint's float32 operation order, including projective w.
      const tx=f(f(f(f(m0*x)+f(m4*y))+f(m8*z))+m12);
      const ty=f(f(f(f(m1*x)+f(m5*y))+f(m9*z))+m13);
      const tz=f(f(f(f(m2*x)+f(m6*y))+f(m10*z))+m14);
      w=f(f(f(f(m3*x)+f(m7*y))+f(m11*z))+m15); x=tx; y=ty; z=tz;
    }
    scalar[0]=f(f(f(f(vx*x)+f(vy*y))+f(vz*z))+f(vw*w));
    const key=(bits[0]^((bits[0]&0x80000000)?0xffffffff:0x80000000))>>>0, quantized=key>>>drop;
    keys[i]=key; input[i]=i; and &= key; or |= key;
    if (quantized < min) min=quantized;
    if (quantized > max) max=quantized;
  }
  range.min=min; range.max=max; range.and=and; range.or=or;
}
function countDigit(keys: Uint32Array, input: Uint32Array, histogram: Uint32Array, first: number, end: number, shift: number) {
  for (let i=first;i<end;i++) histogram[(keys[input[i]]>>>shift)&255]++;
}
function scatterDigit(keys: Uint32Array, input: Uint32Array, output: Uint32Array, histogram: Uint32Array, first: number, end: number, shift: number) {
  for (let i=first;i<end;i++) { const id=input[i]; output[histogram[(keys[id]>>>shift)&255]++]=id; }
}
function countRange(keys: Uint32Array, histogram: Uint32Array, first: number, end: number, drop: number, min: number) {
  for (let i=first;i<end;i++) histogram[(keys[i]>>>drop)-min]++;
}
function scatterRange(keys: Uint32Array, output: Uint32Array, histogram: Uint32Array, first: number, end: number, drop: number, min: number) {
  for (let i=first;i<end;i++) output[histogram[(keys[i]>>>drop)-min]++]=i;
}
function prefix(histogram: Uint32Array, bins: number) {
  let sum=0;
  for (let i=0;i<bins;i++) { const n=histogram[i]; histogram[i]=sum; sum+=n; }
}

export async function stableDepthOrder(packed: Float32Array, count: number, strideWords: number,
  frame: Float32Array, transformTargets: Uint8Array, checkpoint: ComputeCheckpoint, scratch?:RadixScratch, candidates?:Uint32Array,stage?:ComputeStage,precision:SortPrecision=32): Promise<Uint32Array<ArrayBuffer>> {
  validateSortPrecision(precision);
  count=candidates?.length??count;
  if(scratch && (scratch.keys.length<count || scratch.input.length<count || scratch.output.length<count || scratch.histogram.length<256)) throw new RangeError('Insufficient radix scratch.');
  const owned=scratch??createRadixScratch(count), keys=owned.keys;
  let input=owned.input.subarray(0,count), output=owned.output.subarray(0,count);
  const scalar=new Float32Array(1), bits=new Uint32Array(scalar.buffer), histogram=owned.histogram;
  const drop=32-precision, range:KeyRange={min:Infinity,max:-Infinity,and:-1,or:0};
  for(let first=0;first<count;first+=8192) {
    const end=Math.min(first+8192,count);
    depthKeys(packed,strideWords,frame,transformTargets,candidates,keys,input,first,end,scalar,bits,drop,range);
    if(end-first===8192) await checkpoint();
  }
  await checkpoint();
  stage?.('depth-key-generation');
  const varying=range.and^range.or, bins=range.max-range.min+1;
  if(count && (varying>>>drop)!==0 && bins<=histogram.length) {
    histogram.fill(0,0,bins);
    for(let first=0;first<count;first+=65536) {
      countRange(keys,histogram,first,Math.min(first+65536,count),drop,range.min); await checkpoint();
    }
    prefix(histogram,bins); await checkpoint();
    for(let first=0;first<count;first+=65536) {
      scatterRange(keys,output,histogram,first,Math.min(first+65536,count),drop,range.min); await checkpoint();
    }
    [input,output]=[output,input]; stage?.('counting-sort');
  } else for(let shift=drop;shift<32;shift+=8) {
    if(((varying>>>shift)&255)===0) continue;
    histogram.fill(0,0,256);
    for(let first=0;first<count;first+=65536) {
      countDigit(keys,input,histogram,first,Math.min(first+65536,count),shift); await checkpoint();
    }
    prefix(histogram,256);
    for(let first=0;first<count;first+=65536) {
      scatterDigit(keys,input,output,histogram,first,Math.min(first+65536,count),shift); await checkpoint();
    }
    [input,output]=[output,input]; stage?.(`radix-pass-${shift}`);
  }
  if(candidates) for(let first=0;first<count;first+=65536) {
    const end=Math.min(first+65536,count);
    for(let i=first;i<end;i++) input[i]=candidates[input[i]];
    if(end-first===65536) await checkpoint();
  }
  return input;
}
