// Stable sorted-pair compaction. Accept exactly the existing projector's flag.
@group(0) @binding(0) var<uniform> frame:Frame;
@group(0) @binding(1) var<storage,read> projected:array<Projected>;
@group(0) @binding(2) var<storage,read_write> ranks:array<u32>;
@group(0) @binding(3) var<storage,read_write> counts:array<u32>;
@group(0) @binding(4) var<storage,read_write> visible:array<vec2<u32>>;
@group(0) @binding(5) var<storage,read_write> indirect:array<u32>;
@group(0) @binding(7) var<storage,read> offsets:array<u32>;
@group(0) @binding(8) var<storage,read> blockOffsets:array<u32>;
@group(0) @binding(9) var<storage,read> totalCount:array<u32>;
@group(0) @binding(10) var<storage,read> ordered:array<vec2<u32>>;
var<workgroup> prefix:array<u32,256>;
@compute @workgroup_size(256)
fn countVisible(@builtin(global_invocation_id) thread:vec3<u32>,@builtin(local_invocation_index) lane:u32,@builtin(workgroup_id) group:vec3<u32>) {
  let i=thread.x; var accepted=false;
  if(i<frame.flags.x) { accepted=projected[ordered[i].y&0xffffffu].center.w!=0.0; }
  prefix[lane]=select(0u,1u,accepted); workgroupBarrier();
  for(var step=1u;step<256u;step*=2u) {
    let value=prefix[lane]; var previous=0u;
    if(lane>=step) { previous=prefix[lane-step]; }
    workgroupBarrier(); prefix[lane]=value+previous; workgroupBarrier();
  }
  if(i<frame.flags.x) { ranks[i]=select(0xffffffffu,prefix[lane]-1u,accepted); }
  if(lane==255u) { counts[group.x]=prefix[255]; }
}
@compute @workgroup_size(1)
fn publishVisible() {
  let total=totalCount[0];
  indirect[0]=6u;indirect[1]=total;indirect[2]=0u;indirect[3]=0u;indirect[4]=0u;
}
@compute @workgroup_size(256)
fn scatterVisible(@builtin(global_invocation_id) thread:vec3<u32>) {
  let i=thread.x;
  if(i<frame.flags.x && ranks[i]!=0xffffffffu) { visible[offsets[i/256u]+blockOffsets[i/65536u]+ranks[i]]=ordered[i]; }
}
