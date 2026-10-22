// Construction only. The independent test oracle does not import this module.
// Run with the pinned Node: node tools/formats/build-ply-splat-v1.mjs [--write].
// Default checks reproducibility without writing. --write owns only the fixed
// tests/fixtures/formats/ply-splat-v1 files named below.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const directory = resolve('tests/fixtures/formats/ply-splat-v1');
const write = process.argv.slice(2).length === 1 && process.argv[2] === '--write';
if (process.argv.length > (write ? 3 : 2)) throw new Error('Use no arguments or --write.');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const quaternions = [[2,1,0,0],[2,0,1,0],[2,0,0,1],[1,1,1,1],[3,1,2,0],
  [3,0,1,2],[3,2,0,1],[2,-1,1,0],[2,0,-1,1],[2,1,0,-1]];
const source = Array.from({ length: 10 }, (_, id) => ({
  x: 100 + id, y: 20 + id, z: -30 - 2 * id,
  scale_0: id === 0 ? -18 : -2 + id / 8,
  scale_1: id === 0 ? -17 : -1 + id / 16,
  scale_2: id === 0 ? -16 : id / 32,
  rot_0: quaternions[id][0], rot_1: quaternions[id][1],
  rot_2: quaternions[id][2], rot_3: quaternions[id][3],
  opacity: (id - 4) / 4,
  f_dc_0: (id - 4) / 8, f_dc_1: (id + 1) / 16, f_dc_2: (4 - id) / 32,
  nx: 1, ny: 0, nz: -1, ignored: 7,
}));
function properties(rest, mixed) {
  const names = ['x','y','z','f_dc_0','f_dc_1','f_dc_2',
    ...Array.from({length:rest},(_,i)=>`f_rest_${i}`),
    'opacity','scale_0','scale_1','scale_2','rot_0','rot_1','rot_2','rot_3'];
  if (mixed) names.push('nx','ny','nz','ignored');
  const types = {x:'int32',y:'uint',z:'int16',rot_0:'uchar',rot_1:'char',rot_2:'short',rot_3:'int',
    scale_0:'double',scale_1:'float64',nx:'uint8',ny:'uint16',nz:'int8',ignored:'uint32'};
  return (mixed ? names.slice().reverse() : names).map(name => [mixed ? types[name] ?? 'float32' : 'float',name]);
}
function ply(rest, encoding, mixed = false, alignment = false) {
  const props = properties(rest, mixed), perChannel = rest / 3;
  let header = ['ply',`format ${encoding} 1.0`,'comment independent analytic PLY/SPLAT packet v1',
    'element vertex 10',...props.map(([type,name])=>`property ${type} ${name}`)];
  // Make the binary float32 payload provably unaligned (offset mod4 ==1).
  if (alignment) {
    let padding = 'comment alignment ';
    while (([...header,padding,'end_header',''].join('\n').length % 4) !== 1) padding += 'x';
    header.push(padding);
  }
  header = header.concat('end_header','').join('\n');
  const rows = source.map((record,id)=>props.map(([,name])=>{
    if (!name.startsWith('f_rest_')) return record[name];
    const index = Number(name.slice(7)), channel = Math.floor(index / perChannel), term = index % perChannel;
    return (id + 1) / 32 + channel / 4 + (term + 1) / 64;
  }));
  if (encoding === 'ascii') return Buffer.from(header + rows.map(row=>row.join(' ')).join('\n') + '\n');
  const sizes = {float:4,float32:4,double:8,float64:8,int32:4,uint:4,int16:2,uchar:1,char:1,short:2,int:4,uint8:1,uint16:2,int8:1,uint32:4};
  const stride = props.reduce((sum,[type])=>sum+sizes[type],0), body=Buffer.alloc(stride*10), view=new DataView(body.buffer,body.byteOffset,body.byteLength);
  let offset=0; const little=encoding==='binary_little_endian';
  rows.forEach(row=>row.forEach((value,index)=>{
    const type=props[index][0];
    if (type==='float'||type==='float32') view.setFloat32(offset,value,little);
    else if (type==='double'||type==='float64') view.setFloat64(offset,value,little);
    else if (['uint','uint32'].includes(type)) view.setUint32(offset,value,little);
    else if (['int','int32'].includes(type)) view.setInt32(offset,value,little);
    else if (['short','int16'].includes(type)) view.setInt16(offset,value,little);
    else if (type==='uint16') view.setUint16(offset,value,little);
    else if (['char','int8'].includes(type)) view.setInt8(offset,value);
    else view.setUint8(offset,value);
    offset+=sizes[type];
  }));
  return Buffer.concat([Buffer.from(header),body]);
}
const splat=Buffer.alloc(320), data=new DataView(splat.buffer,splat.byteOffset,splat.byteLength);
const rotations=[[192,160,128,128],[192,128,160,128],[192,128,128,160],[160,160,160,160],
  [224,160,192,128],[224,128,160,192],[224,192,128,160],[192,96,160,128],[192,128,96,160],[192,160,128,96]];
source.forEach((record,id)=>{
  [record.x,record.y,record.z].forEach((value,i)=>data.setFloat32(32*id+4*i,value,true));
  const scales=id===0?[2**-26,2**-25,2**-24]:[.125+id/64,.25+id/32,.5+id/16];
  scales.forEach((value,i)=>data.setFloat32(32*id+12+4*i,value,true));
  splat.set([32+16*id,64+8*id,192-8*id,64+16*id,...rotations[id]],32*id+24);
});
const frozenPath='native/upstream/splatview/tests/fixtures/minimal.splat';
const inputs=[['sh3-ascii.ply',ply(45,'ascii'),3],['sh3-le-unaligned.ply',ply(45,'binary_little_endian',false,true),3],
  ['sh3-be.ply',ply(45,'binary_big_endian'),3],['sh3-le-mixed.ply',ply(45,'binary_little_endian',true),3],
  ...[[0,0],[9,1],[24,2],[72,3]].map(([rest,degree])=>[`sh${rest===72?4:degree}-ascii.ply`,ply(rest,'ascii'),degree]),
  ['playcanvas-minimal.splat',readFileSync(frozenPath),0],['anisotropic.splat',splat,0]];
const lock=JSON.parse(readFileSync('native/SOURCE_LOCK.json','utf8'));
const references=[['native/upstream/splatview/src/core/model.cpp','Gaussian header, SH prefix, scalar/endian decode and deterministic sampling'],
  ['native/upstream/splatview/src/core/ply_preview.cpp','Shared strict header and Gaussian classification'],
  ['native/upstream/splatview/src/core/extra_formats.cpp','Raw 32-byte SPLAT'],
  ['native/upstream/splatview/src/core/format_utils.hpp','RDF to RUB and source membership'],
  ['native/upstream/splatview/src/core/scene_math.cpp','Packed covariance and half SH'],
  ['native/upstream/splatview/src/core/ply_export.cpp','Independent exported PLY checks'],
  ['native/upstream/splatview/src/core/scene_exports.cpp','Independent exported SPLAT checks']];
const manifest={schemaVersion:1,packet:'ply-splat-v1',scope:'Ten small native-decoder/export interoperability inputs; no renderer/Mac/large-scene acceptance',
  construction:'tools/formats/build-ply-splat-v1.mjs',oracle:'tests/format-ply-splat.test.ts (independent literal records, matrix math, byte parsers; never imports builder)',
  policyId:'ply-splat-numeric-v1',policies:{
    position:'Exact float32 literal coordinates and exact source membership/order',
    decodedCovariance:'Per-component error <= 4e-6 * max(source axis variance); no absolute floor, including tiny scales',
    exportedPlyCovariance:'Per-component error <= 1e-5 * max(source axis variance); recompute from independently parsed axes',
    exportedSplatCovariance:'Per-component error <= 0.09 * max(source axis variance); at most one +1 endpoint clamp (1/128), other quaternion components <=1/256; normalized quaternion/rotation perturbation plus float32 scale roundoff',
    opacity:'Decode absolute <=2e-7; PLY export <=3e-7 after independent sigmoid and endpoint clamp; SPLAT export <=0.5/255+2e-7',
    sh:'Generated coefficients are exactly representable binary16. All48 packed values exact including zero absent bands; SPLAT DC half error <=0.0005 and color byte export <=1byte',
  },origin:{generated:'Analytic fixtures authored for this browser project; no third-party generated inputs',
    frozen:{source:frozenPath,sha256:hash(readFileSync(frozenPath)),revision:'PlayCanvas splat-transform3.9.0 commit435b972a97a278c655d8f7015b1355215cba0d71',
      license:'native/upstream/splatview/third_party/format-reference-licenses/playcanvas.txt'}},
  frozenPackageTreeSha256:lock.packages.splatview.treeSha256,
  nativeBranches:references.map(([path,branch])=>({path,branch,sha256:hash(readFileSync(path))})),
  inputs:inputs.map(([file,bytes,retainedDegree])=>({file,bytes:bytes.length,sha256:hash(bytes),
    sourceCount:file==='playcanvas-minimal.splat'?4:10,retainedDegree,
    cap3SourceIds:file==='playcanvas-minimal.splat'?null:[3,6,9]}))};
const outputs=[...inputs.map(([name,bytes])=>[name,bytes]),['manifest.json',Buffer.from(JSON.stringify(manifest,null,2)+'\n')]];
if(write)mkdirSync(directory,{recursive:true});
for(const [name,bytes] of outputs){const path=resolve(directory,name);if(write)writeFileSync(path,bytes);else if(!readFileSync(path).equals(bytes))throw new Error(`Fixture differs: ${name}`);}
console.log(`${write?'Wrote':'Verified'} ten fixtures and manifest; independent oracle not executed.`);
