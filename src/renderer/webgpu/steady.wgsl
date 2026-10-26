// Adapted from PlayCanvas PR 9819 (MIT). Attribution/license: steadyNoise.ts
// and docs/third-party/STEADY_SPLATS_REFERENCES.md. Compiled with frame.wgsl
// and splats.wgsl so sampling and PDF evaluation share native alpha support.
struct SteadySettings {
  inverseProjection: mat4x4<f32>, inverseView: mat4x4<f32>, previousViewProjection: mat4x4<f32>,
  flags: vec4<u32>, // sample frame, valid history, stationary camera, stationary samples
  temporal: vec4<f32>, // width, height, color retention, background shade
  stripe: vec4<u32>, // row start, row count, noise cycle shift, unused
}
@group(1) @binding(0) var<uniform> steady: SteadySettings;
@group(1) @binding(1) var steadyNoise: texture_3d<f32>;
@group(1) @binding(2) var steadyRaw: texture_2d<f32>;
@group(1) @binding(3) var steadySamples: texture_2d<u32>;
@group(1) @binding(4) var steadyWeights: texture_2d<f32>;
@group(1) @binding(5) var steadyWeightsOut: texture_storage_2d<rgba32float, write>;
@group(1) @binding(6) var steadyPrevious: texture_2d<f32>;
@group(1) @binding(7) var steadyOutput: texture_storage_2d<rgba16float, write>;
struct SteadyEntry { id: u32, depth: f32, horizontal: u32, vertical: u32 }
struct SteadyPixel { entries: array<SteadyEntry, 4>, state: u32 }
@group(1) @binding(8) var<storage, read_write> steadyHistory: array<SteadyPixel>;
@group(1) @binding(9) var<storage, read_write> steadyRest: array<vec4<f32>>;
const STEADY_NEIGHBORS = array<vec2<i32>,4>(vec2(1,0),vec2(-1,0),vec2(0,1),vec2(0,-1));

fn steadyAlpha(opacity: f32, local: vec2<f32>) -> f32 {
  let r=dot(local,local);
  if(r>min(9.0,opacitySupport(opacity)+.001)) { return 0.0; }
  let alpha=min(.99,opacity*exp(-.5*r));
  return select(0.0,alpha,alpha>=1.0/255.0);
}
fn steadyAlphaAt(g: Projected, pixel: vec2<f32>) -> f32 {
  let center=(g.center.xy*vec2(.5,-.5)+.5)*steady.temporal.xy;
  let delta=(pixel-center)*vec2(1.0,-1.0);
  return steadyAlpha(g.color.a,3.0*vec2(dot(delta,g.axes.xy)/dot(g.axes.xy,g.axes.xy),dot(delta,g.axes.zw)/dot(g.axes.zw,g.axes.zw)));
}
fn steadyPrimitivePhase(id: u32) -> u32 {
  let state=id*747796405u+2891336453u;
  let word=((state>>((state>>28u)+4u))^state)*277803737u;
  return (word>>22u)^word;
}
struct SteadyVertex {
  @builtin(position) position: vec4<f32>, @location(0) local: vec2<f32>,
  @location(1) @interpolate(flat) index: u32,
}
@vertex
fn steadyVertex(@builtin(vertex_index) vertexIndex: u32, @builtin(instance_index) index: u32) -> SteadyVertex {
  let corners=array<vec2<f32>,6>(vec2(-1.0,-1.0),vec2(1.0,-1.0),vec2(-1.0,1.0),vec2(-1.0,1.0),vec2(1.0,-1.0),vec2(1.0,1.0));
  let g=projected[index]; let corner=corners[vertexIndex];
  let offset=g.axes.xy*corner.x+g.axes.zw*corner.y;
  let clip=frame.projection*vec4(0.0,0.0,-g.center.z,1.0);
  var result: SteadyVertex;
  result.position=vec4(g.center.xy+2.0*offset/frame.viewport.xy,clip.z/max(clip.w,1e-20),1.0);
  if(g.center.w==0.0) { result.position=vec4(2.0,2.0,2.0,1.0); }
  result.local=corner*3.0; result.index=index; return result;
}
struct SteadySample { @location(0) color: vec4<f32>, @location(1) sample: vec2<u32> }
@fragment
fn steadyFragment(input: SteadyVertex) -> SteadySample {
  let g=projected[input.index]; let alpha=steadyAlpha(g.color.a,input.local);
  if(alpha<=0.0) { discard; }
  let id=input.index+1u;
  let offset=vec2(id*3242174889u,id*2447445415u)>>vec2(27u);
  let coordinate=vec3<i32>(vec2<i32>((vec2<u32>(input.position.xy)+offset)&vec2(31u)),i32(steady.flags.x&63u));
  let rank=u32(textureLoad(steadyNoise,coordinate,0).r*255.0+.5);
  let rotated=(rank<<24u)+steadyPrimitivePhase(id)+steady.stripe.z;
  if(alpha<=f32(rotated>>8u)*(1.0/16777216.0)) { discard; }
  var rgb=g.color.rgb;
  if(frame.geometryFlags.z!=0u && (states[input.index]&1u)!=0u) {
    let tint=select(vec3(1.0,.72,.12),vec3(.49,.824,.573),frame.geometryFlags.z==2u);
    rgb=mix(rgb,tint,.72);
  }
  return SteadySample(vec4(rgb,1.0),vec2(id,bitcast<u32>(g.center.z)));
}

@compute @workgroup_size(8,8)
fn steadyHistoryPass(@builtin(global_invocation_id) global: vec3<u32>) {
  let p=vec2<i32>(global.xy+vec2(0u,steady.stripe.x));
  if(any(p>=vec2<i32>(steady.temporal.xy)) || global.y>=steady.stripe.y) { return; }
  let base=global.x+global.y*u32(steady.temporal.x);
  var state=0u;
  if(steady.flags.y!=0u) { state=steadyHistory[base].state; }
  let head=state&3u; let count=state>>2u;
  let sample=textureLoad(steadySamples,p,0);
  let id=sample.x;
  var depth=3.402823e38; var alpha=1.0; var neighbors=vec4(1.0);
  if(id!=0u) {
    depth=bitcast<f32>(sample.y); let g=projected[id-1u];
    alpha=steadyAlphaAt(g,vec2<f32>(p)+.5);
    for(var n=0u;n<4u;n++) { neighbors[n]=steadyAlphaAt(g,vec2<f32>(p+STEADY_NEIGHBORS[n])+.5); }
  }
  var ratio=neighbors/max(alpha,1e-20); var duplicate=false;
  for(var k=0u;k<count;k++) {
    let entry=steadyHistory[base].entries[(head+k)&3u];
    duplicate=duplicate || (entry.id==id && id!=0u);
    if(entry.id!=0u && entry.id!=id && entry.depth<depth) {
      ratio*=vec4(unpack2x16float(entry.horizontal),unpack2x16float(entry.vertical));
    }
  }
  textureStore(steadyWeightsOut,p,ratio);
  if(id!=0u && !duplicate) {
    let next=(head+3u)&3u;
    let occlusion=(1.0-neighbors)/max(1.0-alpha,1e-6);
    steadyHistory[base].entries[next]=SteadyEntry(id,depth,pack2x16float(occlusion.xy),pack2x16float(occlusion.zw));
    steadyHistory[base].state=next|(min(count+1u,4u)<<2u);
  } else if(steady.flags.y==0u) { steadyHistory[base].state=0u; }
}

fn steadyYCoCg(c: vec3<f32>) -> vec3<f32> {
  return vec3(dot(c,vec3(.25,.5,.25)),(c.r-c.b)*.5,dot(c,vec3(-.25,.5,-.25)));
}
fn steadyRadiance(c: vec4<f32>) -> vec3<f32> { return c.rgb+(1.0-c.a)*steady.temporal.w; }
fn steadyCubic(t: f32) -> vec4<f32> {
  let t2=t*t; let t3=t2*t;
  return vec4(-.5*t+t2-.5*t3,1.0-2.5*t2+1.5*t3,.5*t+2.0*t2-1.5*t3,-.5*t2+.5*t3);
}
fn steadyHistoryAt(pixel: vec2<f32>) -> vec4<f32> {
  let base=vec2<i32>(floor(pixel-.5)); let fraction=fract(pixel-.5);
  let wx=steadyCubic(fraction.x); let wy=steadyCubic(fraction.y); var color=vec4(0.0);
  for(var y=0;y<4;y++) { for(var x=0;x<4;x++) {
    let q=clamp(base+vec2(x-1,y-1),vec2(0),vec2<i32>(steady.temporal.xy)-1);
    color+=wx[x]*wy[y]*textureLoad(steadyPrevious,q,0);
  }}
  return color;
}
fn steadyTemporalAt(p: vec2<i32>, current: vec4<f32>) -> vec4<f32> {
  if(steady.flags.y==0u || steady.temporal.z<=0.0) { return current; }
  let pixel=vec2<f32>(p)+.5; var previousPixel=pixel;
  var historical=textureLoad(steadyPrevious,p,0);
  if(steady.flags.z==0u) {
    let sample=textureLoad(steadySamples,p,0);
    let ndc=pixel/steady.temporal.xy*vec2(2.0,-2.0)+vec2(-1.0,1.0);
    let unprojected=steady.inverseProjection*vec4(ndc,1.0,1.0);
    let ray=unprojected.xyz/-unprojected.z;
    let depth=bitcast<f32>(sample.y);
    let world=steady.inverseView*select(vec4(ray,0.0),vec4(ray*depth,1.0),sample.x!=0u);
    let clip=steady.previousViewProjection*world;
    previousPixel=(clip.xy/max(clip.w,1e-20)*vec2(.5,-.5)+.5)*steady.temporal.xy;
    if(clip.w<=0.0 || any(previousPixel<vec2(2.0)) || any(previousPixel>=steady.temporal.xy-2.0)) { return current; }
    historical=steadyHistoryAt(previousPixel);
  }
  var mean=vec3(0.0); var second=vec3(0.0);
  for(var y=-1;y<=1;y++) { for(var x=-1;x<=1;x++) {
    let q=clamp(p+vec2(x,y),vec2(0),vec2<i32>(steady.temporal.xy)-1);
    let value=steadyYCoCg(steadyRadiance(textureLoad(steadyRaw,q,0)));
    mean+=value; second+=value*value;
  }}
  mean/=9.0;
  let sigma=sqrt(max(second/9.0-mean*mean,vec3(0.0)));
  let gamma=mix(4.0,1.0,min(length(pixel-previousPixel)/4.0,1.0));
  let extent=max(sigma*gamma,vec3(.01,.005,.005));
  let delta=abs(steadyYCoCg(steadyRadiance(historical))-mean)/extent;
  return mix(current,historical,steady.temporal.z/max(1.0,max(delta.x,max(delta.y,delta.z))));
}
@compute @workgroup_size(8,8)
fn steadyResolvePass(@builtin(global_invocation_id) global: vec3<u32>) {
  let p=vec2<i32>(global.xy+vec2(0u,steady.stripe.x));
  if(any(p>=vec2<i32>(steady.temporal.xy)) || global.y>=steady.stripe.y) { return; }
  let raw=textureLoad(steadyRaw,p,0); var spatial=raw; var mass=1.0;
  for(var n=0u;n<4u;n++) {
    let source=p-STEADY_NEIGHBORS[n];
    if(all(source>=vec2(0)) && all(source<vec2<i32>(steady.temporal.xy))) {
      let weight=textureLoad(steadyWeights,source,0)[n];
      spatial+=textureLoad(steadyRaw,source,0)*weight; mass+=weight;
    }
  }
  spatial/=mass;
  var color=steadyTemporalAt(p,spatial);
  let frames=steady.flags.w;
  if(frames!=0u) {
    let index=global.x+global.y*u32(steady.temporal.x);
    let sample=select(raw,spatial,frames<=8u); var average=sample;
    if(frames>1u) { average=steadyRest[index]; average+=(sample-average)/f32(frames); }
    steadyRest[index]=average;
    color=mix(color,average,f32(frames)/(f32(frames)+8.0));
  }
  let alpha=clamp(color.a,0.0,1.0);
  let rgb=color.rgb*select(0.0,alpha/max(color.a,1e-8),color.a>0.0);
  textureStore(steadyOutput,p,vec4(rgb,alpha));
}
@vertex
fn steadyCompositeVertex(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
  let corners=array<vec2<f32>,3>(vec2(-1.0,-1.0),vec2(3.0,-1.0),vec2(-1.0,3.0));
  return vec4(corners[index],0.0,1.0);
}
@fragment
fn steadyCompositeFragment(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  let color=textureLoad(steadyPrevious,vec2<i32>(position.xy),0);
  return vec4(color.rgb+(1.0-color.a)*steady.temporal.w,1.0);
}
