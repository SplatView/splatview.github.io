// Exact front-to-back pick candidates. Radius affects winner eligibility only.
@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var<storage, read> projected: array<Projected>;
@group(0) @binding(2) var<storage, read> order: array<vec2<u32>>;
@group(0) @binding(3) var<uniform> query: vec4<f32>;
@group(0) @binding(4) var<storage, read_write> queryOutput: array<u32>;
@group(0) @binding(5) var<storage, read_write> ranks: array<u32>;
@group(0) @binding(6) var<storage, read_write> counts: array<u32>;
@group(0) @binding(7) var<storage, read_write> candidates: array<u32>;
var<workgroup> prefix: array<u32,256>;

@compute @workgroup_size(256)
fn countCandidates(@builtin(global_invocation_id) thread:vec3<u32>, @builtin(local_invocation_index) lane:u32,
  @builtin(workgroup_id) group:vec3<u32>) {
  let i=thread.x; var accepted=false;
  if(i<frame.flags.x) {
    let g=projected[order[frame.flags.x-1u-i].y&0xffffffu];
    if(g.center.w!=0.0) {
      let center=vec2((g.center.x+1.0)*.5*frame.viewport.x,(1.0-g.center.y)*.5*frame.viewport.y);
      let extent=abs(g.axes.xy)+abs(g.axes.zw);
      let padding=(abs(center.x)+abs(center.y)+extent.x+extent.y+1.0)*.000004+.001;
      // Invalid/extreme bounds conservatively retain the baseline candidate.
      accepted=!all(abs(center)<vec2(1e30)) || !all(abs(extent)<vec2(1e30)) || all(abs(query.xy-center)<=extent+vec2(padding));
    }
  }
  prefix[lane]=select(0u,1u,accepted); workgroupBarrier();
  for(var step=1u;step<256u;step*=2u) {
    let value=prefix[lane]; var previous=0u;
    if(lane>=step) { previous=prefix[lane-step]; }
    workgroupBarrier(); prefix[lane]=value+previous; workgroupBarrier();
  }
  if(i<frame.flags.x) { ranks[i]=select(0xffffffffu,prefix[lane]-1u,accepted); }
  if(lane==255u) { counts[group.x+1u]=prefix[255]; }
}
@compute @workgroup_size(1)
fn candidateOffsets() {
  var total=0u;
  for(var group=1u;group<=((frame.flags.x+255u)/256u);group++) {
    let count=counts[group]; counts[group]=total; total+=count;
  }
  counts[0]=total;
}
@compute @workgroup_size(256)
fn scatterCandidates(@builtin(global_invocation_id) thread:vec3<u32>) {
  let i=thread.x; if(i>=frame.flags.x || ranks[i]==0xffffffffu) { return; }
  candidates[counts[i/256u+1u]+ranks[i]]=order[frame.flags.x-1u-i].y;
}
// These frozen support thresholds and contribution operations match pick() in
// splats.wgsl; the baseline remains an independent runtime comparison oracle.
fn opacitySupport(opacity:f32)->f32 {
  if(opacity>=.2141082512) { return 9.0; }
  if(opacity>=.0289764008) {
    if(opacity>=.0787660238) { return select(7.0,8.0,opacity>=.1298632188); }
    return select(5.0,6.0,opacity>=.0477740084);
  }
  if(opacity>=.0106598221) { return select(3.0,4.0,opacity>=.0175750755); }
  return select(1.0,2.0,opacity>=.0064655090);
}
@compute @workgroup_size(1)
fn pickCandidates() {
  var transmission=1.0; var strongest=0.0; var winner=0u; var depth=0.0; var opacity=0.0;
  let minimum=select(0.0,1.0/255.0,query.z>0.0);
  for(var i=0u;i<counts[0];i++) {
    let entry=candidates[i]; let gaussian=projected[entry&0xffffffu];
    let center=vec2((gaussian.center.x+1.0)*.5*frame.viewport.x,(1.0-gaussian.center.y)*.5*frame.viewport.y);
    let delta=vec2(query.x-center.x,center.y-query.y);
    let local=3.0*vec2(dot(delta,gaussian.axes.xy)/dot(gaussian.axes.xy,gaussian.axes.xy),dot(delta,gaussian.axes.zw)/dot(gaussian.axes.zw,gaussian.axes.zw));
    let r=dot(local,local); if(r>min(9.0,opacitySupport(gaussian.color.a)+.001)) { continue; }
    let alpha=min(.99,gaussian.color.a*exp(-.5*r)); if(alpha<1.0/255.0) { continue; }
    let weight=transmission*alpha;
    let eligible=query.z<=0.0 || dot(query.xy-center,query.xy-center)<=query.z*query.z;
    if(eligible && weight>=minimum && weight>strongest) { strongest=weight; winner=(entry&0xffffffu)+1u; }
    depth+=weight*gaussian.center.z; opacity+=weight; transmission*=1.0-alpha;
    if(transmission<1e-5) { break; }
  }
  queryOutput[0]=winner; queryOutput[1]=bitcast<u32>(depth/max(opacity,1e-20));
  queryOutput[2]=bitcast<u32>(opacity); queryOutput[3]=bitcast<u32>(strongest);
}
