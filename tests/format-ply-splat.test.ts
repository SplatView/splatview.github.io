import { admittedNativeCommand } from './fixtures/native-export';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { NativeSummary } from '../src/document/types';
import { wasmString, type ModuleFactory, type WasmModule } from '../src/workers/wasm';

// Independent oracle: no production parser/encoder, fixture builder or native
// math helper is imported. Literal records fix the intended logical inputs.
type Analytic = { position: number[]; scales: number[]; quaternion: number[]; opacity: number; dc: number[] };
const RECORDS = [
  [[100,20,-30],[-18,-17,-16],[2,1,0,0],-1,[-.5,.0625,.125]],
  [[101,21,-32],[-1.875,-.9375,.03125],[2,0,1,0],-.75,[-.375,.125,.09375]],
  [[102,22,-34],[-1.75,-.875,.0625],[2,0,0,1],-.5,[-.25,.1875,.0625]],
  [[103,23,-36],[-1.625,-.8125,.09375],[1,1,1,1],-.25,[-.125,.25,.03125]],
  [[104,24,-38],[-1.5,-.75,.125],[3,1,2,0],0,[0,.3125,0]],
  [[105,25,-40],[-1.375,-.6875,.15625],[3,0,1,2],.25,[.125,.375,-.03125]],
  [[106,26,-42],[-1.25,-.625,.1875],[3,2,0,1],.5,[.25,.4375,-.0625]],
  [[107,27,-44],[-1.125,-.5625,.21875],[2,-1,1,0],.75,[.375,.5,-.09375]],
  [[108,28,-46],[-1,-.5,.25],[2,0,-1,1],1,[.5,.5625,-.125]],
  [[109,29,-48],[-.875,-.4375,.28125],[2,1,0,-1],1.25,[.625,.625,-.15625]],
] as const;
const SPLAT_SCALES = [[2**-26,2**-25,2**-24],[.140625,.28125,.5625],[.15625,.3125,.625],
  [.171875,.34375,.6875],[.1875,.375,.75],[.203125,.40625,.8125],[.21875,.4375,.875],
  [.234375,.46875,.9375],[.25,.5,1],[.265625,.53125,1.0625]];
const SPLAT_RGBA = [[32,64,192,64],[48,72,184,80],[64,80,176,96],[80,88,168,112],
  [96,96,160,128],[112,104,152,144],[128,112,144,160],[144,120,136,176],
  [160,128,128,192],[176,136,120,208]];
const C0 = .28209479177387814;
const sampledIds = [3,6,9]; // Literal independent membership, not decoder output.
// Signs are parity under (x,y,z)->(x,-y,-z) of the real SH polynomials
// y,z,x,xy,yz,(3zÂ²-rÂ²),xz,(xÂ²-yÂ²),y(3xÂ²-yÂ²),xyz,
// y(5zÂ²-rÂ²),z(5zÂ²-3rÂ²),x(5zÂ²-rÂ²),z(xÂ²-yÂ²),x(xÂ²-3yÂ²).
const SH_PARITY = [-1,-1,1,-1,1,1,-1,1,-1,1,-1,-1,1,-1,1];
const CASES = [
  { file:'sh3-ascii.ply', rest:45, degree:3 },
  { file:'sh3-le-unaligned.ply', rest:45, degree:3 },
  { file:'sh3-be.ply', rest:45, degree:3 },
  { file:'sh3-le-mixed.ply', rest:45, degree:3 },
  { file:'sh0-ascii.ply', rest:0, degree:0 },
  { file:'sh1-ascii.ply', rest:9, degree:1 },
  { file:'sh2-ascii.ply', rest:24, degree:2 },
  { file:'sh4-ascii.ply', rest:72, degree:3 },
  { file:'playcanvas-minimal.splat', rest:0, degree:0 },
  { file:'anisotropic.splat', rest:0, degree:0 },
] as const;
const NATIVE_BRANCH_PATHS = [
  'native/upstream/splatview/src/core/model.cpp',
  'native/upstream/splatview/src/core/ply_preview.cpp',
  'native/upstream/splatview/src/core/extra_formats.cpp',
  'native/upstream/splatview/src/core/format_utils.hpp',
  'native/upstream/splatview/src/core/scene_math.cpp',
  'native/upstream/splatview/src/core/ply_export.cpp',
  'native/upstream/splatview/src/core/scene_exports.cpp',
];
const FROZEN_SPLAT_PATH = 'native/upstream/splatview/tests/fixtures/minimal.splat';
const fixturePath = (name: string) => resolve('tests/fixtures/formats/ply-splat-v1',name);
const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(fixturePath(name)));
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
function analytic(id: number, splat = false): Analytic {
  const [position,logs,quaternion,logit,dc] = RECORDS[id];
  return { position:[...position], scales:splat ? SPLAT_SCALES[id] : logs.map(Math.exp),
    quaternion:[...quaternion], opacity:splat ? SPLAT_RGBA[id][3]/255 : sigmoid(logit),
    dc:splat ? SPLAT_RGBA[id].slice(0,3).map(value=>(value/255-.5)/C0) : [...dc] };
}
// Algebraic matrix oracle in double precision; tolerances account for native
// float32 normalization/exp and each covariance product/add, not wrong axes.
function covariance(scales: readonly number[], quaternion: readonly number[], rub: boolean): number[] {
  const length = Math.hypot(...quaternion), [w,x,y,z] = quaternion.map(value=>value/length);
  const r = [[1-2*(y*y+z*z),2*(x*y-w*z),2*(x*z+w*y)],
    [2*(x*y+w*z),1-2*(x*x+z*z),2*(y*z-w*x)],
    [2*(x*z-w*y),2*(y*z+w*x),1-2*(x*x+y*y)]];
  const d = rub ? [1,-1,-1] : [1,1,1];
  return [[0,0],[0,1],[0,2],[1,1],[1,2],[2,2]].map(([i,j])=>
    d[i]*d[j]*scales.reduce((sum,scale,k)=>sum+r[i][k]*r[j][k]*scale*scale,0));
}
function half(value: number): number {
  const sign = value & 0x8000 ? -1 : 1, exponent = (value >>> 10) & 31, fraction = value & 1023;
  if (exponent === 31) return fraction ? NaN : sign*Infinity;
  return sign * (exponent === 0 ? 2**-14 * fraction/1024 : 2**(exponent-15)*(1+fraction/1024));
}
function shExpected(id: number, rest: number): number[] {
  const dc = RECORDS[id][4], perChannel = rest/3;
  return Array.from({length:48},(_,index)=>{
    const coefficient=Math.floor(index/3), channel=index%3;
    if (coefficient===0) return dc[channel];
    const term=coefficient-1;
    return (term < Math.min(perChannel,15) ? ((id+1)/32+channel/4+(term+1)/64) : 0)*SH_PARITY[term];
  });
}
type Measurement = { maxAbsolute:number; maxNormalized:number; worst:string };
const measurements = new Map<string,Measurement>();
function close(actual: number, expected: number, bound: number, label: string, policy: string) {
  expect(Number.isFinite(actual),label).toBe(true);
  const difference=Math.abs(actual-expected), normalized=bound===0 ? difference : difference/bound;
  const previous=measurements.get(policy) ?? {maxAbsolute:0,maxNormalized:0,worst:''};
  if(difference>previous.maxAbsolute) previous.maxAbsolute=difference;
  if(normalized>previous.maxNormalized){previous.maxNormalized=normalized;previous.worst=label;}
  measurements.set(policy,previous);
  expect(difference,`${label}: ${actual} vs ${expected}, bound ${bound}`).toBeLessThanOrEqual(bound);
}
let core: WasmModule;
const decode = (pointer:number) => JSON.parse(core.UTF8ToString(pointer)) as NativeSummary;
function open(bytes:Uint8Array, limit=100, splat=false) {
  const pointer=core._malloc(Math.max(1,bytes.length));
  expect(pointer).not.toBe(0);
  try{core.HEAPU8.set(bytes,pointer);return decode(core._sv_open(pointer,bytes.length,splat?1:0,limit,128*1024*1024));}
  finally{core._free(pointer);}
}
const command = (value:unknown) => wasmString(core,JSON.stringify(admittedNativeCommand(core, value)),pointer=>decode(core._sv_command(pointer)));
function packed(count:number) {
  const pointer=core._sv_scene_ptr(), view=new DataView(core.HEAPU8.buffer);
  return Array.from({length:count},(_,id)=>({
    fields:Array.from({length:12},(_,index)=>view.getFloat32(pointer+144*id+4*index,true)),
    sh:Array.from({length:48},(_,index)=>half(view.getUint16(pointer+144*id+48+2*index,true))),
  }));
}
function header(bytes:Uint8Array) {
  const marker=new TextEncoder().encode('end_header\n');
  let end=-1;
  for(let i=0;i<=bytes.length-marker.length;i++)if(marker.every((value,j)=>bytes[i+j]===value)){end=i+marker.length;break;}
  if(end<0)throw new Error('No bounded PLY header terminator.');
  const text=new TextDecoder().decode(bytes.subarray(0,end));
  const properties=[...text.matchAll(/^property (\w+) (\w+)$/gm)].map(match=>({type:match[1],name:match[2]}));
  const count=Number(/^element vertex (\d+)$/m.exec(text)?.[1]);
  return {end,text,properties,count};
}
// Deliberately narrow independent export parser: rejects a changed layout,
// consumes exactly the declared records and does not reopen through native.
function parseExportPly(bytes:Uint8Array) {
  const h=header(bytes);expect(h.text).toContain('format binary_little_endian 1.0\n');
  expect(h.properties.every(property=>property.type==='float')).toBe(true);
  expect(bytes.length-h.end).toBe(4*h.count*h.properties.length);
  const data=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  return Array.from({length:h.count},(_,i)=>Object.fromEntries(h.properties.map((property,j)=>
    [property.name,data.getFloat32(h.end+4*(i*h.properties.length+j),true)])) as Record<string,number>);
}
function parseSplat(bytes:Uint8Array): Analytic[] {
  expect(bytes.length%32).toBe(0);
  const data=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  return Array.from({length:bytes.length/32},(_,i)=>({
    position:[0,1,2].map(axis=>data.getFloat32(32*i+4*axis,true)),
    scales:[0,1,2].map(axis=>data.getFloat32(32*i+12+4*axis,true)),
    quaternion:[0,1,2,3].map(axis=>(bytes[32*i+28+axis]-128)/128),
    dc:[0,1,2].map(channel=>(bytes[32*i+24+channel]/255-.5)/C0),opacity:bytes[32*i+27]/255,
  }));
}
function exportBytes(format:number,scope:number) {
  const result=command({command:'export',format,scope});expect(result.ok,result.error).toBe(true);
  return core.HEAPU8.slice(core._sv_output_ptr(),core._sv_output_ptr()+core._sv_output_len());
}
function checkPacked(input:Analytic[], ids:number[], rest:number, label:string, splat=false) {
  const actual=packed(ids.length);
  ids.forEach((id,index)=>{
    const source=input[id], row=actual[index], position=[source.position[0],-source.position[1],-source.position[2]];
    expect(row.fields.slice(0,3).map(value=>value===0?0:value),`${label} source${id} position`).toEqual(position.map(value=>value===0?0:value));
    close(row.fields[3],source.opacity,2e-7,`${label}/source${id}/opacity`,'decoded-opacity');
    const expected=covariance(source.scales,source.quaternion,true), norm=Math.max(...source.scales.map(value=>value*value));
    expected.forEach((value,component)=>close(row.fields[[4,5,6,7,8,9][component]],value,4e-6*norm,
      `${label}/source${id}/cov${component}`,'decoded-covariance'));
    expect(row.fields.slice(10)).toEqual([0,0]);
    if(splat){
      row.sh.slice(0,3).forEach((value,c)=>close(value,source.dc[c],.0005,`${label}/source${id}/dc${c}`,'splat-half-dc'));
      expect(row.sh.slice(3)).toEqual(Array.from({length:45},(_,i)=>0*SH_PARITY[Math.floor(i/3)]));
    }else expect(row.sh,`${label} source${id} all half SH/absent bands`).toEqual(shExpected(id,rest));
  });
}
function checkExports(input:Analytic[],ids:number[],rest:number,label:string,splat=false) {
  const ply=parseExportPly(exportBytes(0,0)), raw=exportBytes(2,0), exportedSplat=parseSplat(raw);
  expect(ply.length).toBe(ids.length);expect(exportedSplat.length).toBe(ids.length);
  ids.forEach((id,index)=>{
    const expected=input[id], p=ply[index], s=exportedSplat[index], norm=Math.max(...expected.scales.map(v=>v*v));
    expect([p.x,p.y,p.z].map(v=>v===0?0:v)).toEqual(expected.position.map(v=>v===0?0:v));
    expect(s.position.map(v=>v===0?0:v)).toEqual(expected.position.map(v=>v===0?0:v));
    expect([p.nx,p.ny,p.nz]).toEqual([0,0,0]);
    const pcov=covariance([p.scale_0,p.scale_1,p.scale_2].map(Math.exp),[p.rot_0,p.rot_1,p.rot_2,p.rot_3],false);
    const scov=covariance(s.scales,s.quaternion,false), ecov=covariance(expected.scales,expected.quaternion,false);
    ecov.forEach((value,component)=>{
      close(pcov[component],value,1e-5*norm,`${label}/source${id}/PLYcov${component}`,'export-ply-covariance');
      close(scov[component],value,.09*norm,`${label}/source${id}/SPLATcov${component}`,'export-splat-covariance');
    });
    close(sigmoid(p.opacity),Math.min(1-1e-7,Math.max(1e-7,expected.opacity)),3e-7,`${label}/source${id}/PLYopacity`,'export-ply-opacity');
    close(s.opacity,expected.opacity,.5/255+2e-7,`${label}/source${id}/SPLATopacity`,'export-splat-opacity');
    const bands=Math.min(rest/3,15);
    expect(Object.keys(p).filter(name=>name.startsWith('f_rest_')).length).toBe(3*bands);
    for(let c=0;c<3;c++){
      const packedDc=packed(ids.length)[index].sh[c];
      expect(p[`f_dc_${c}`]).toBe(packedDc);
      const expectedByte=Math.max(0,Math.min(255,Math.round((packedDc*C0+.5)*255)));
      expect(Math.abs(raw[32*index+24+c]-expectedByte)).toBeLessThanOrEqual(1);
      if(!splat)for(let term=0;term<bands;term++)expect(p[`f_rest_${c*bands+term}`]).toBe((id+1)/32+c/4+(term+1)/64);
    }
  });
}
beforeAll(async()=>{
  const url=pathToFileURL(resolve('public/wasm/splatview-core.mjs')).href;
  const factory=(await import(/* @vite-ignore */ url) as {default:ModuleFactory}).default;
  core=await factory({locateFile:(name:string)=>{
    if(name!=='splatview-core.wasm')throw new Error('Unexpected native artifact request.');
    return resolve('public/wasm/splatview-core.wasm');
  }});
});
// JSON-only Vitest suppresses captured console output. Direct stdout preserves
// the bounded numeric receipt in the observed terminal log as well.
afterAll(()=>process.stdout.write('PLY/SPLAT numeric policy maxima (normalized = error / fixed bound): '+JSON.stringify(Object.fromEntries(measurements))+'\n'));

describe('independent ten-input PLY/SPLAT packet v1',()=>{
  it('binds exactly ten fixture bytes, frozen provenance and native source branches',()=>{
    const manifest=JSON.parse(readFileSync(fixturePath('manifest.json'),'utf8')) as {
      inputs:{file:string;bytes:number;sha256:string;sourceCount:number;retainedDegree:number;cap3SourceIds:number[]|null}[];
      nativeBranches:{path:string;sha256:string}[]; frozenPackageTreeSha256:string;
      origin:{frozen:{source:string;sha256:string;revision:string;license:string}};
    };
    expect(manifest.inputs.map(row=>row.file)).toEqual(CASES.map(row=>row.file));
    for(const row of manifest.inputs){const bytes=fixture(row.file);expect(bytes.length).toBe(row.bytes);expect(sha(bytes)).toBe(row.sha256);
      expect(row.sourceCount).toBe(row.file==='playcanvas-minimal.splat'?4:10);
      expect(row.retainedDegree).toBe(CASES.find(item=>item.file===row.file)!.degree);
      expect(row.cap3SourceIds).toEqual(row.sourceCount===10?sampledIds:null);
    }
    expect(manifest.origin.frozen.source).toBe(FROZEN_SPLAT_PATH);
    expect(manifest.origin.frozen.revision).toBe('PlayCanvas splat-transform3.9.0 commit435b972a97a278c655d8f7015b1355215cba0d71');
    expect(manifest.origin.frozen.license).toBe('native/upstream/splatview/third_party/format-reference-licenses/playcanvas.txt');
    const sourceLock=JSON.parse(readFileSync('native/SOURCE_LOCK.json','utf8')) as {
      packages:{splatview:{treeSha256:string}}; files:{path:string;sha256:string}[];
    };
    expect(manifest.frozenPackageTreeSha256).toBe('f0b272ebe75f0c8380610e4c242faab76e3922f7494cf675d679c9d8dad37e61');
    expect(manifest.frozenPackageTreeSha256).toBe(sourceLock.packages.splatview.treeSha256);
    expect(sha(readFileSync(FROZEN_SPLAT_PATH))).toBe(manifest.origin.frozen.sha256);
    expect(manifest.origin.frozen.sha256).toBe(sourceLock.files.find(row=>row.path===FROZEN_SPLAT_PATH)!.sha256);
    expect(fixture('playcanvas-minimal.splat')).toEqual(new Uint8Array(readFileSync(FROZEN_SPLAT_PATH)));
    expect(manifest.nativeBranches.map(source=>source.path)).toEqual(NATIVE_BRANCH_PATHS);
    for(let i=0;i<NATIVE_BRANCH_PATHS.length;i++){
      expect(sha(readFileSync(NATIVE_BRANCH_PATHS[i]))).toBe(manifest.nativeBranches[i].sha256);
      expect(manifest.nativeBranches[i].sha256).toBe(sourceLock.files.find(row=>row.path===NATIVE_BRANCH_PATHS[i])!.sha256);
    }
    expect(header(fixture('sh3-le-unaligned.ply')).end%4).toBe(1);
    expect(new Set(header(fixture('sh3-le-mixed.ply')).properties.map(p=>p.type)).size).toBeGreaterThanOrEqual(10);
  });
  it('anchors independent matrix/parity math with literal axis and cross-term values',()=>{
    // q=(2,1,0,0) rotates only yz: Ryy=Rzz=3/5, Ryz=-4/5.
    // D flips xy/xz and leaves yz; anisotropic variances1,4,9 ->yz=-12/5.
    const expected=[1,0,0,7.2,-2.4,5.8];
    covariance([1,2,3],[2,1,0,0],true).forEach((value,i)=>expect(Math.abs(value-expected[i])).toBeLessThan(4e-15));
    expect(SH_PARITY).toEqual([-1,-1,1,-1,1,1,-1,1,-1,1,-1,-1,1,-1,1]);
    // Source9 of SH4: channel starts0/24/48; j14 remains, j15..23 drops.
    expect(shExpected(9,72).slice(45)).toEqual([.546875,.796875,1.046875]);
  });
  for(const sample of CASES){
    const splat=sample.file.endsWith('.splat'), frozen=sample.file==='playcanvas-minimal.splat';
    for(const capped of frozen?[false]:[false,true])it(`${sample.file}: ${capped?'cap3 exact IDs3,6,9':'all sources'} attributes and independent exports`,()=>{
      const bytes=fixture(sample.file), input=frozen?parseSplat(bytes):Array.from({length:10},(_,id)=>analytic(id,splat));
      if(frozen)expect(input.map(row=>row.position)).toEqual([[-1,0,-1],[0,0,-1],[-1,0,0],[0,0,0]]);
      const ids=frozen?[0,1,2,3]:capped?sampledIds:[0,1,2,3,4,5,6,7,8,9];
      const result=open(bytes,capped?3:100,splat);
      expect(result.ok,result.error).toBe(true);
      expect(result).toMatchObject({loaded:true,kind:0,format:splat?'SPLAT':'PLY',count:ids.length,
        sourceCount:frozen?4:10,shDegree:sample.degree,selected:0,visible:ids.length,yUp:true});
      checkPacked(input,ids,sample.rest,sample.file,splat);
      checkExports(input,ids,sample.rest,sample.file,splat);
    });
    it(`${sample.file}: exact All/Selected/Remainder and deleted export membership`,()=>{
      const result=open(fixture(sample.file),frozen?100:3,splat);expect(result.ok,result.error).toBe(true);
      const input=frozen?parseSplat(fixture(sample.file)):Array.from({length:10},(_,id)=>analytic(id,splat));
      const ids=frozen?[0,1,2,3]:sampledIds, positions=ids.map(id=>input[id].position);
      const read=(format:number,scope:number)=>format===0?parseExportPly(exportBytes(format,scope)).map(p=>[p.x,p.y,p.z]):parseSplat(exportBytes(format,scope)).map(p=>p.position);
      for(const format of [0,2])expect(read(format,0)).toEqual(positions);
      expect(command({command:'single',index:1}).selected).toBe(1);
      for(const format of [0,2]){expect(read(format,1)).toEqual([positions[1]]);expect(read(format,2)).toEqual(positions.filter((_,i)=>i!==1));}
      const deleted=command({command:'delete'});expect(deleted.ok,deleted.error).toBe(true);expect(deleted.visible).toBe(ids.length-1);
      for(const format of [0,2])expect(read(format,0)).toEqual(positions.filter((_,i)=>i!==1));
      const restored=command({command:'undo'});expect(restored.ok,restored.error).toBe(true);
      for(const format of [0,2])expect(read(format,0)).toEqual(positions);
    });
  }
});

function asciiChange(name:string,change:(headerLines:string[],rows:string[][])=>void) {
  const bytes=fixture(name), h=header(bytes), lines=h.text.trimEnd().split('\n'), rows=new TextDecoder().decode(bytes.subarray(h.end)).trim().split('\n').map(row=>row.trim().split(/\s+/));
  change(lines,rows);return new TextEncoder().encode(lines.join('\n')+'\n'+rows.map(row=>row.join(' ')).join('\n')+'\n');
}
function asciiRemove(property:string) {
  return asciiChange('sh3-ascii.ply',(lines,rows)=>{
    const line=lines.findIndex(row=>row===`property float ${property}`), index=lines.slice(0,line).filter(row=>row.startsWith('property ')).length;
    lines.splice(line,1);rows.forEach(row=>row.splice(index,1));
  });
}
function binaryFloat(name:string,source:number,property:string,value:number) {
  const bytes=fixture(name),h=header(bytes), index=h.properties.findIndex(p=>p.name===property);
  new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).setFloat32(h.end+4*(source*h.properties.length+index),value,true);return bytes;
}
function preserveRefusal(bytes:Uint8Array,splat=false,limit=100) {
  const old=open(fixture('sh3-ascii.ply'));expect(old.ok,old.error).toBe(true);
  expect(command({command:'single',index:2}).selected).toBe(1);
  expect(command({command:'delete'}).ok).toBe(true);expect(command({command:'undo'}).canRedo).toBe(true);
  const before=command({command:'summary'}), packedBefore=packed(10), statesBefore=core.HEAPU8.slice(core._sv_states_ptr(),core._sv_states_ptr()+10);
  const refused=open(bytes,limit,splat);expect(refused.ok).toBe(false);expect(refused.error).toBeTruthy();
  const after=command({command:'summary'});
  for(const field of ['count','sourceCount','format','shDegree','selected','visible','revision','contentRevision','canUndo','canRedo','memoryBytes'] as const)
    expect(after[field],field).toEqual(before[field]);
  expect(packed(10)).toEqual(packedBefore);expect(core.HEAPU8.slice(core._sv_states_ptr(),core._sv_states_ptr()+10)).toEqual(statesBefore);
  // A retained canRedo flag alone cannot prove the old history is usable.
  const redone=command({command:'redo'});expect(redone.ok,redone.error).toBe(true);
  expect(redone.visible).toBe(9);expect(redone.canRedo).toBe(false);
  expect(Array.from(core.HEAPU8.slice(core._sv_states_ptr(),core._sv_states_ptr()+10),state=>(state&2)!==0))
    .toEqual([false,false,true,false,false,false,false,false,false,false]);
  const positions=RECORDS.map(record=>[...record[0]]);
  for(const format of [0,2]){
    const bytes=exportBytes(format,0), exported=format===0?parseExportPly(bytes).map(row=>[row.x,row.y,row.z]):parseSplat(bytes).map(row=>row.position);
    expect(exported).toEqual(positions.filter((_,id)=>id!==2));
  }
  const undone=command({command:'undo'});expect(undone.ok,undone.error).toBe(true);
  expect(undone.visible).toBe(10);expect(undone.canRedo).toBe(true);
  expect(packed(10)).toEqual(packedBefore);
  expect(core.HEAPU8.slice(core._sv_states_ptr(),core._sv_states_ptr()+10)).toEqual(statesBefore);
  for(const format of [0,2]){
    const bytes=exportBytes(format,0), exported=format===0?parseExportPly(bytes).map(row=>[row.x,row.y,row.z]):parseSplat(bytes).map(row=>row.position);
    expect(exported).toEqual(positions);
  }
}
describe('source-reviewed accepted/refused PLY/SPLAT edge policy',()=>{
  for(const property of ['x','scale_0','rot_3','opacity','f_dc_2'])it(`missing Gaussian ${property} refuses without replacing edited owner`,()=>preserveRefusal(asciiRemove(property)));
  it('duplicate property, duplicate element, unknown type and Gaussian list refuse',()=>{
    const original=fixture('sh3-ascii.ply'), text=new TextDecoder().decode(original);
    for(const changed of [text.replace('end_header','property float x\nend_header'),
      text.replace('element vertex 10','element vertex 10\nelement vertex 0'),
      text.replace('property float x','property float128 x'),
      text.replace('property float x','property list uchar float x')])preserveRefusal(new TextEncoder().encode(changed));
  });
  it('orphan rest properties use accepted contiguous prefixes with their new channel stride',()=>{
    for(const [missing,rest,degree] of [['f_rest_0',0,0],['f_rest_9',9,1]] as const){
      const result=open(asciiRemove(missing));expect(result.ok,result.error).toBe(true);expect(result.shDegree).toBe(degree);
      const actual=packed(10)[0].sh;
      for(let coefficient=1;coefficient<16;coefficient++)for(let channel=0;channel<3;channel++){
        const term=coefficient-1, sourceFlat=channel*(rest/3)+term;
        const sourceChannel=Math.floor(sourceFlat/15), sourceTerm=sourceFlat%15;
        const expected=(term<rest/3?(.03125+sourceChannel/4+(sourceTerm+1)/64):0)*SH_PARITY[term];
        expect(actual[3*coefficient+channel]).toBe(expected);
      }
    }
    preserveRefusal(asciiRemove('f_rest_8'));
  });
  it('Gaussian ASCII declared integer fractional text is accepted, not range/type refused',()=>{
    const bytes=asciiChange('sh0-ascii.ply',(lines,rows)=>{lines[lines.indexOf('property float x')]='property uchar x';rows[0][0]='300.5';});
    const result=open(bytes);expect(result.ok,result.error).toBe(true);expect(packed(10)[0].fields[0]).toBe(300.5);
  });
  it('binary invalid sampled-out geometry is accepted only when that source is skipped',()=>{
    const skipped=binaryFloat('sh3-le-unaligned.ply',0,'rot_0',0);
    const h=header(skipped), q1=h.properties.findIndex(p=>p.name==='rot_1');new DataView(skipped.buffer).setFloat32(h.end+4*q1,0,true);
    expect(open(skipped,3).ok).toBe(true);preserveRefusal(skipped);
    preserveRefusal(binaryFloat('sh3-le-unaligned.ply',3,'scale_0',1000),false,3);
  });
  it('ASCII still consumes malformed skipped tokens; semantic invalid skipped values can be accepted',()=>{
    const malformed=asciiChange('sh3-ascii.ply',(_lines,rows)=>{rows[0][0]='not-a-number';});preserveRefusal(malformed,false,3);
    const semantic=asciiChange('sh3-ascii.ply',(lines,rows)=>{
      const index=lines.filter(row=>row.startsWith('property ')).findIndex(row=>row.endsWith(' scale_0'));rows[0][index]='1000';
    });expect(open(semantic,3).ok).toBe(true);preserveRefusal(semantic);
  });
  it('binary infinite opacity maps to endpoints, while NaN opacity and retained invalid SH refuse',()=>{
    for(const value of [Infinity,-Infinity]){
      const result=open(binaryFloat('sh3-le-unaligned.ply',3,'opacity',value),3);expect(result.ok,result.error).toBe(true);
      expect(packed(3)[0].fields[3]).toBe(value>0?1:0);
      const exported=parseExportPly(exportBytes(0,0));close(sigmoid(exported[0].opacity),value>0?1-1e-7:1e-7,3e-7,'endpoint exported PLY','export-ply-opacity');
    }
    preserveRefusal(binaryFloat('sh3-le-unaligned.ply',3,'opacity',NaN),false,3);
    preserveRefusal(binaryFloat('sh3-le-unaligned.ply',3,'f_rest_0',Infinity),false,3);
  });
  it('SH4 dropped terms are not consumed as retained coefficients',()=>{
    const bytes=asciiChange('sh4-ascii.ply',(lines,rows)=>{
      const props=lines.filter(line=>line.startsWith('property '));for(const source of [15,39,63]){
        const index=props.findIndex(line=>line.endsWith(` f_rest_${source}`));rows.forEach(row=>{row[index]='65505';});
      }
    });const result=open(bytes);expect(result.ok,result.error).toBe(true);expect(packed(10)[9].sh).toEqual(shExpected(9,72));
  });
  it('zero centered SPLAT quaternion refuses, all-zero bytes normalize, partial/empty payloads refuse',()=>{
    const zero=fixture('anisotropic.splat');zero.set([128,128,128,128],28);preserveRefusal(zero,true);
    const nonzero=fixture('anisotropic.splat');nonzero.set([0,0,0,0],28);expect(open(nonzero,100,true).ok).toBe(true);
    preserveRefusal(nonzero.subarray(0,nonzero.length-1),true);preserveRefusal(new Uint8Array(0),true);
  });
});
