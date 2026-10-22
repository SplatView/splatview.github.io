struct Dispatch { count: u32, groups: u32, blocks: u32, digit: u32 }
@group(0) @binding(0) var<uniform> params: Dispatch;
@group(0) @binding(1) var<storage, read> input: array<vec2<u32>>;
@group(0) @binding(2) var<storage, read_write> ranks: array<u32>;
@group(0) @binding(3) var<storage, read_write> output: array<vec2<u32>>;
@group(0) @binding(4) var<storage, read_write> counts: array<u32>;
@group(0) @binding(5) var<storage, read> groupOffsets: array<u32>;
@group(0) @binding(6) var<storage, read> blockOffsets: array<u32>;
@group(0) @binding(7) var<storage, read> binOffsets: array<u32>;
@group(0) @binding(8) var<storage, read> splats: array<u32>;
@group(0) @binding(9) var<storage, read> states: array<u32>;
@group(0) @binding(10) var<uniform> frame: Frame;
@group(0) @binding(11) var<storage, read> transformTargets: array<u32>;
var<workgroup> masks: array<atomic<u32>,128>;
@compute @workgroup_size(256)
fn generate(@builtin(global_invocation_id) thread: vec3<u32>) {
  let i=thread.x; if(i>=params.count) { return; }
  let address=i*frame.flags.y;
  var p=vec4(bitcast<f32>(splats[address]),bitcast<f32>(splats[address+1u]),bitcast<f32>(splats[address+2u]),1.0);
  let state=states[i];
  if(frame.geometryFlags.x!=0u && (frame.geometryFlags.y==0u || (transformTargets[i]&1u)!=0u)) { p=frame.geometry*p; }
  let depth=(frame.view*p).z; let bits=bitcast<u32>(depth);
  let key=bits^select(0x80000000u,0xffffffffu,(bits&0x80000000u)!=0u);
  output[i]=vec2(key,i|(state<<24u));
}
@compute @workgroup_size(256)
fn rank(@builtin(workgroup_id) group: vec3<u32>, @builtin(local_invocation_index) lane: u32) {
  if(lane<128u) { atomicStore(&masks[lane],0u); } workgroupBarrier();
  let i=group.x*256u+lane; var bin=0u;
  if(i<params.count) { bin=(input[i].x>>params.digit)&15u; atomicOr(&masks[bin*8u+lane/32u],1u<<(lane%32u)); }
  workgroupBarrier();
  if(i<params.count) {
    var localRank=countOneBits(atomicLoad(&masks[bin*8u+lane/32u])&((1u<<(lane%32u))-1u));
    for(var w=0u;w<lane/32u;w++) { localRank+=countOneBits(atomicLoad(&masks[bin*8u+w])); }
    ranks[i]=(bin<<8u)|localRank;
  }
  if(lane<16u) {
    var total=0u; for(var w=0u;w<8u;w++) { total+=countOneBits(atomicLoad(&masks[lane*8u+w])); }
    counts[lane*params.groups+group.x]=total;
  }
}
@compute @workgroup_size(256)
fn scatter(@builtin(global_invocation_id) thread: vec3<u32>) {
  let i=thread.x; if(i>=params.count) { return; }
  let bin=ranks[i]>>8u; let group=i/256u;
  let at=binOffsets[bin]+blockOffsets[bin*params.blocks+group/256u]+groupOffsets[bin*params.groups+group]+(ranks[i]&255u);
  output[at]=input[i];
}
