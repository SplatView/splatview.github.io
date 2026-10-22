struct Dispatch { count: u32, groups: u32, blocks: u32, digit: u32 }
@group(0) @binding(0) var<uniform> params: Dispatch;
@group(0) @binding(1) var<storage, read> source: array<u32>;
@group(0) @binding(2) var<storage, read_write> offsets: array<u32>;
@group(0) @binding(3) var<storage, read_write> sums: array<u32>;
var<workgroup> values: array<u32,256>;
@compute @workgroup_size(256)
fn local(@builtin(workgroup_id) group: vec3<u32>, @builtin(local_invocation_index) lane: u32) {
  let i=group.x*256u+lane; var value=0u;
  if(i<params.groups) { value=source[group.y*params.groups+i]; }
  values[lane]=value; workgroupBarrier();
  for(var stride=1u;stride<256u;stride*=2u) {
    var add=0u; if(lane>=stride) { add=values[lane-stride]; }
    workgroupBarrier(); values[lane]+=add; workgroupBarrier();
  }
  if(i<params.groups) { offsets[group.y*params.groups+i]=values[lane]-value; }
  if(lane==255u) { sums[group.y*params.blocks+group.x]=values[lane]; }
}
@compute @workgroup_size(256)
fn blocks(@builtin(workgroup_id) group: vec3<u32>, @builtin(local_invocation_index) lane: u32) {
  var value=0u; if(lane<params.blocks) { value=source[group.x*params.blocks+lane]; }
  values[lane]=value; workgroupBarrier();
  for(var stride=1u;stride<256u;stride*=2u) {
    var add=0u; if(lane>=stride) { add=values[lane-stride]; }
    workgroupBarrier(); values[lane]+=add; workgroupBarrier();
  }
  if(lane<params.blocks) { offsets[group.x*params.blocks+lane]=values[lane]-value; }
  if(lane==255u) { sums[group.x]=values[lane]; }
}
@compute @workgroup_size(16)
fn bins(@builtin(local_invocation_index) lane: u32) {
  var total=0u; for(var i=0u;i<lane;i++) { total+=source[i]; } offsets[lane]=total;
}
