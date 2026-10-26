import { expect, it } from 'vitest';
import { createRadixScratch, stableDepthOrder } from '../src/renderer/webgl2/radix';
import { planSortScratch, sortScratchLimit } from '../src/renderer/webgl2/sortScratchLayout';
import type { SortPrecision } from '../src/renderer/sortPrecision';

// Independent comparison-sort oracle: no production key, transform or radix helpers.
function oracle(packed: Float32Array, frame: Float32Array, targets: Uint8Array, precision: SortPrecision, candidates?: Uint32Array) {
  const flags = new Uint32Array(frame.buffer), f = Math.fround, word = new DataView(new ArrayBuffer(4));
  const sources = candidates ? Array.from(candidates) : Array.from({ length: packed.length / 12 }, (_, i) => i);
  return sources.map((id, ordinal) => {
    let p = [packed[id*12], packed[id*12+1], packed[id*12+2], 1];
    if (flags[76] && (!flags[77] || targets[id] & 1)) {
      p = Array.from({ length: 4 }, (_, row) => f(f(f(f(frame[60+row]*p[0])+f(frame[64+row]*p[1]))+f(frame[68+row]*p[2]))+frame[72+row]));
    }
    const depth = f(f(f(f(frame[2]*p[0])+f(frame[6]*p[1]))+f(frame[10]*p[2]))+f(frame[14]*p[3]));
    word.setFloat32(0, depth, true);
    const bits = word.getUint32(0, true), key = ((bits & 0x80000000 ? ~bits : bits ^ 0x80000000) >>> 0) >>> (32-precision);
    return { id, ordinal, key };
  }).sort((a, b) => a.key-b.key || a.ordinal-b.ordinal).map(value => value.id);
}
function fixture(count: number, narrow = false, transformed = false) {
  const packed = new Float32Array(count*12), frame = new Float32Array(80), targets = new Uint8Array(count);
  const edge = [-1e20, -4, -2, -0, 0, 2**-149, -(2**-149), 1, 1+2**-23, 1e20];
  for (let i=0;i<count;i++) {
    packed[i*12]=(i%23-11)/7; packed[i*12+1]=(i%19-9)/3;
    packed[i*12+2]=narrow ? -2-(i*7919%257)/65536 : edge[i%edge.length]; targets[i]=i%3===1?1:0;
  }
  frame[10]=1;
  if (transformed) {
    frame[2]=.1234567; frame[6]=-.2345678; frame[10]=.9876543; frame[14]=-.3456789;
    frame.set([1.1,.2,.3,.01,-.4,.9,.2,-.02,.3,-.2,1.2,.03,.25,-.5,.75,1],60);
    new Uint32Array(frame.buffer).set([1,1],76);
  }
  return { packed, frame, targets };
}
for (const precision of [16,24,32] as const) for (const [name, count, narrow, transformed] of [
  ['signed-boundaries',257,false,false], ['projective-scoped',65539,false,true], ['narrow-span',65539,true,false],
] as const) it(`matches the independent ${precision}-bit oracle for ${name}, candidates and both histogram sizes`, async () => {
  const { packed, frame, targets } = fixture(count,narrow,transformed), original = packed.slice(), mask = targets.slice();
  const candidates=Uint32Array.from({length:count},(_,i)=>(count-1-i)*71%count), saved=candidates.slice();
  for (const chosen of [undefined,candidates]) {
    const expected=oracle(packed,frame,targets,precision,chosen);
    for (const bins of [256,65536]) {
      const scratch=createRadixScratch(count,bins);
      const actual=await stableDepthOrder(packed,count,12,frame,targets,async()=>{},scratch,chosen,undefined,precision);
      expect(Array.from(actual)).toEqual(expected);
      expect(scratch.keys.buffer.byteLength).toBe(count*4);
    }
  }
  expect(packed).toEqual(original); expect(targets).toEqual(mask); expect(candidates).toEqual(saved);
});

it('chooses exact counting for an admitted narrow range, reuses the pool and skips uniform digits on the bounded fallback', async () => {
  const { packed,frame,targets }=fixture(65539,true), stages:string[]=[], scratch=createRadixScratch(65539,65536);
  const first=await stableDepthOrder(packed,65539,12,frame,targets,async()=>{},scratch,undefined,s=>stages.push(s),24);
  expect(stages).toEqual(['depth-key-generation','counting-sort']);
  const copied=first.slice(); structuredClone(copied.buffer,{transfer:[copied.buffer]});
  stages.length=0;
  const fallback=await stableDepthOrder(packed,65539,12,frame,targets,async()=>{},undefined,undefined,s=>stages.push(s),32);
  expect(stages).toEqual(['depth-key-generation','radix-pass-0','radix-pass-8']);
  const reused=await stableDepthOrder(packed,65539,12,frame,targets,async()=>{},scratch,undefined,undefined,32);
  expect(reused).toEqual(fallback); expect(first.buffer.byteLength).toBe(65539*4);
});

for (const phase of ['key','histogram','prefix','scatter','remap'] as const) it(`joins cancellation during ${phase} without publishing an order`, async () => {
  const count=65539, {packed,frame,targets}=fixture(count,true), candidates=Uint32Array.from({length:count},(_,i)=>count-1-i);
  let calls=0, stage='';
  const stop={key:1,histogram:10,prefix:12,scatter:13,remap:15}[phase];
  await expect(stableDepthOrder(packed,count,12,frame,targets,async()=>{
    if (++calls===stop) throw new DOMException('cancel','AbortError');
  },createRadixScratch(count,65536),candidates,s=>{stage=s;},24)).rejects.toMatchObject({name:'AbortError'});
  expect(calls).toBe(stop);
  expect(stage).toBe(phase==='key'?'':phase==='remap'?'counting-sort':'depth-key-generation');
});

it('charges the physical retained arrays, keeps the transient allocation small and preserves the 16 MiB cap', () => {
  for (const count of [1,100,65535,65536,1_000_000]) {
    const plan=planSortScratch(count), scratch=createRadixScratch(count,plan.histogramBins);
    expect(Object.values(scratch).reduce((sum,value)=>sum+value.byteLength,0)).toBe(plan.bytes);
    expect(createRadixScratch(count).histogram.byteLength).toBe(1024);
  }
  expect(planSortScratch(0).bytes).toBe(0);
  expect(planSortScratch(1_376_256).bytes).toBe(sortScratchLimit);
  expect(planSortScratch(1_376_257).bytes).toBeGreaterThan(sortScratchLimit);
  for (const count of [-1,.5,NaN,Infinity,3_000_001]) expect(()=>planSortScratch(count)).toThrow();
});

it('cancels the wide-range radix fallback and safely reuses partially written pooled storage', async () => {
  const count=65539, {packed,frame,targets}=fixture(count), scratch=createRadixScratch(count,65536);
  let keysDone=false, calls=0;
  await expect(stableDepthOrder(packed,count,12,frame,targets,async()=>{
    if(keysDone && ++calls===3) throw new DOMException('cancel','AbortError');
  },scratch,undefined,()=>{keysDone=true;})).rejects.toMatchObject({name:'AbortError'});
  expect(calls).toBe(3);
  const actual=await stableDepthOrder(packed,count,12,frame,targets,async()=>{},scratch);
  expect(Array.from(actual)).toEqual(oracle(packed,frame,targets,32));
});

it('keeps stable identity for empty/singleton/equal keys and validates all pooled array capacities', async () => {
  for(const count of [0,1,8193]) {
    const packed=new Float32Array(count*12), frame=new Float32Array(80), candidates=Uint32Array.from({length:count},(_,i)=>count-1-i);
    frame[10]=1; let checkpoints=0;
    const actual=await stableDepthOrder(packed,count,12,frame,new Uint8Array(count),async()=>{checkpoints++;},undefined,candidates);
    expect(actual).toEqual(candidates); expect(checkpoints).toBeGreaterThan(0);
  }
  for(const field of ['keys','input','output','histogram'] as const) {
    const scratch=createRadixScratch(10); scratch[field]=new Uint32Array(0);
    await expect(stableDepthOrder(new Float32Array(120),10,12,new Float32Array(80),new Uint8Array(10),async()=>{},scratch)).rejects.toThrow('Insufficient radix scratch');
  }
});
