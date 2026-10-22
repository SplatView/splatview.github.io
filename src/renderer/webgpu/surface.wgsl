// Surface projection uses floored map dimensions with the desktop's scalar
// low-pass/axis-cap scale. Visibility keeps the separate full-frame projection.
// Host packing and flags: surfaceQuery.ts. Struct field order is a 48-byte ABI.
const SURFACE_COLORS=1u;
const SURFACE_VISIBLE=2u;
const SURFACE_DOWNSAMPLED=4u;
const SURFACE_REGION=8u;
const SURFACE_TILE_SIZE=16u;
struct SurfaceParams {
  full: vec2<u32>, size: vec2<u32>, tiles: vec2<u32>, coverageMinPacked: u32, count: u32,
  channels: u32, dispatchWidth: u32, scale: f32, coverageMaxPacked: u32,
}
@group(0) @binding(0) var<uniform> params: SurfaceParams;
@group(0) @binding(1) var<storage, read> projected: array<Projected>;
@group(0) @binding(2) var<storage, read> order: array<vec2<u32>>;
@group(0) @binding(3) var<storage, read_write> counts: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> candidates: array<u32>;
@group(0) @binding(5) var<storage, read> tileSpans: array<vec2<u32>>;
@group(0) @binding(6) var<storage, read_write> output: array<vec2<f32>>;
@group(0) @binding(7) var<uniform> frame: Frame;
@group(0) @binding(8) var<storage, read> sourceSplats: array<u32>;
@group(0) @binding(9) var<storage, read> sourceStates: array<u32>;
@group(0) @binding(10) var<storage, read_write> auxiliary: array<vec4<f32>>;
@group(0) @binding(11) var<storage, read_write> visibleBits: array<atomic<u32>>;
@group(0) @binding(12) var<storage, read_write> colorOutput: array<vec4<f32>>;
@group(0) @binding(13) var<storage, read_write> mapProjected: array<Projected>;
@group(0) @binding(14) var<storage, read> transformTargets: array<u32>;
@group(0) @binding(15) var<storage, read> opacityTargets: array<u32>;

fn coefficient(address: u32, i: u32) -> f32 {
  return unpack2x16float(sourceSplats[address+10u+i/2u])[i%2u];
}
// Frozen ungraded SH evaluation. Selection tint and display grading never
// enter color-connectivity maps; the current geometry still affects direction.
fn rawColor(address: u32, position: vec3<f32>) -> vec3<f32> {
  let direction=position-frame.eyeDegree.xyz;
  let d=direction/max(length(direction),1e-20);
  let x=d.x; let y=d.y; let z=d.z; let xx=x*x; let yy=y*y; let zz=z*z;
  var b: array<f32,16>;
  b[0]=0.2820947918;
  b[1]=-0.4886025119*y; b[2]=0.4886025119*z; b[3]=-0.4886025119*x;
  b[4]=1.0925484306*x*y; b[5]=-1.0925484306*y*z;
  b[6]=0.3153915653*(2.0*zz-xx-yy); b[7]=-1.0925484306*x*z; b[8]=0.5462742153*(xx-yy);
  b[9]=-0.5900435899*y*(3.0*xx-yy); b[10]=2.8906114426*x*y*z;
  b[11]=-0.4570457995*y*(4.0*zz-xx-yy); b[12]=0.3731763326*z*(2.0*zz-3.0*xx-3.0*yy);
  b[13]=-0.4570457995*x*(4.0*zz-xx-yy); b[14]=1.4453057213*z*(xx-yy); b[15]=-0.5900435899*x*(xx-3.0*yy);
  let bands=u32(frame.eyeDegree.w)+1u; let count=bands*bands;
  var rgb=vec3(.5);
  for(var j=0u;j<count;j++) {
    rgb+=b[j]*vec3(coefficient(address,3u*j),coefficient(address,3u*j+1u),coefficient(address,3u*j+2u));
  }
  return max(rgb,vec3(0.0));
}
fn surfaceProjection(position: vec4<f32>, covariance: mat3x3<f32>, opacity: f32) -> Projected {
  let empty=Projected(vec4(0.0),vec4(0.0),vec4(0.0));
  let p=frame.view*position; if(p.z>=-.001 || opacity<.0039) { return empty; }
  let depth=-p.z;
  let right=vec3(frame.view[0].x,frame.view[1].x,frame.view[2].x);
  let up=vec3(frame.view[0].y,frame.view[1].y,frame.view[2].y);
  let forward=vec3(frame.view[0].z,frame.view[1].z,frame.view[2].z);
  let focal=frame.viewport.zw*vec2<f32>(params.size)/vec2<f32>(params.full);
  let jx=focal.x/depth*(right+p.x/depth*forward);
  let jy=focal.y/depth*(up+p.y/depth*forward);
  let a=dot(jx,covariance*jx)+(.3*params.scale)*params.scale;
  let b=dot(jx,covariance*jy);
  let c=dot(jy,covariance*jy)+(.3*params.scale)*params.scale;
  let middle=(a+c)*.5; let delta=sqrt(max(0.0,(a-c)*(a-c)*.25+b*b));
  let floor=(.01*params.scale)*params.scale;
  let l1=max(floor,middle+delta); let l2=max(floor,middle-delta);
  var axis=select(vec2(0.0,1.0),vec2(1.0,0.0),a>=c);
  if(abs(b)>.00001) { axis=normalize(vec2(b,l1-a)); }
  let axis1=axis*min(1536.0*params.scale,3.0*sqrt(l1));
  let axis2=vec2(-axis.y,axis.x)*min(1536.0*params.scale,3.0*sqrt(l2));
  let clip=frame.projection*p; if(clip.z<0.0 || clip.z>clip.w) { return empty; }
  let extent=(abs(axis1)+abs(axis2)+vec2(1.0))*2.0/vec2<f32>(params.size)*clip.w;
  if(any(abs(clip.xy)>vec2(clip.w)+extent)) { return empty; }
  return Projected(vec4(clip.xy/clip.w,depth,1.0),vec4(axis1,axis2),vec4(0.0,0.0,0.0,opacity));
}
@compute @workgroup_size(256)
fn prepareAuxiliary(@builtin(global_invocation_id) id: vec3<u32>) {
  let i=id.x; if(i>=params.count) { return; }
  let address=i*frame.flags.y; let state=sourceStates[i];
  var position=vec4(bitcast<f32>(sourceSplats[address]),bitcast<f32>(sourceSplats[address+1u]),bitcast<f32>(sourceSplats[address+2u]),1.0);
  let transforming=frame.geometryFlags.x!=0u && (frame.geometryFlags.y==0u || (transformTargets[i]&1u)!=0u);
  if(transforming) { position=frame.geometry*position; }
  var payload=vec4(0.0);
  if((params.channels&SURFACE_COLORS)!=0u) { payload=vec4(rawColor(address,position.xyz),0.0); }
  if((params.channels&6u)!=0u) {
    let c0=vec4(bitcast<f32>(sourceSplats[address+4u]),bitcast<f32>(sourceSplats[address+5u]),bitcast<f32>(sourceSplats[address+6u]),bitcast<f32>(sourceSplats[address+7u]));
    let c1=vec2(bitcast<f32>(sourceSplats[address+8u]),bitcast<f32>(sourceSplats[address+9u]));
    var covariance=mat3x3(vec3(c0.x,c0.y,c0.z),vec3(c0.y,c0.w,c1.x),vec3(c0.z,c1.x,c1.y));
    if(transforming) {
      let a=mat3x3(frame.geometry[0].xyz,frame.geometry[1].xyz,frame.geometry[2].xyz);
      covariance=a*covariance*transpose(a);
    }
    let forward=vec3(frame.view[0].z,frame.view[1].z,frame.view[2].z);
    if((params.channels&SURFACE_VISIBLE)!=0u) { payload.w=3.0*sqrt(max(0.0,dot(forward,covariance*forward))); }
    if((params.channels&SURFACE_DOWNSAMPLED)!=0u) {
      mapProjected[i]=Projected(vec4(0.0),vec4(0.0),vec4(0.0));
      if((state&2u)==0u) {
        let opacity=previewOpacity(bitcast<f32>(sourceSplats[address+3u]),opacityTargets[i],frame.gradeD.w,frame.geometryFlags.w);
        mapProjected[i]=surfaceProjection(position,covariance,opacity);
      }
    }
  }
  if((params.channels&3u)!=0u) { auxiliary[i]=payload; }
}

fn support(opacity: f32) -> f32 {
  if(opacity>=.2141082512) { return 9.0; }
  if(opacity>=.0289764008) {
    if(opacity>=.0787660238) { return select(7.0,8.0,opacity>=.1298632188); }
    return select(5.0,6.0,opacity>=.0477740084);
  }
  if(opacity>=.0106598221) { return select(3.0,4.0,opacity>=.0175750755); }
  return select(1.0,2.0,opacity>=.0064655090);
}
struct TileFootprint { first: vec2<u32>, last: vec2<u32>, valid: u32, }
// Invert the same local-coordinate rows used by fragmentAlpha. Projected axes
// are orthogonal in real arithmetic, but using their actual dot lengths and
// determinant also covers the small FP32 residue of rotated / unequal axes.
fn candidateExtent(gaussian: Projected, center: vec2<f32>) -> vec2<f32> {
  let a=gaussian.axes.xy; let b=gaussian.axes.zw;
  let quad=abs(a)+abs(b); let aa=dot(a,a); let bb=dot(b,b);
  let determinant=a.x*b.y-a.y*b.x;
  let opacity=gaussian.color.a;
  // Keep the previous quad if the inverse is poorly conditioned or opacity
  // lies at the cutoff. Exact fragment acceptance remains the final authority.
  if(!(aa>0.0 && bb>0.0 && abs(determinant)>sqrt(aa*bb)*.001) ||
    !(opacity>(1.0/255.0)*1.0001)) { return quad; }
  // Alpha survives only within r <= 2*log(opacity*255), additionally bounded
  // by native integer support and the quad radius. The .001 squared-radius
  // allowance exceeds WGSL f32 exp/log error on this [0,9] domain, including
  // cutoff equality. Do not shrink using an unpadded transcendental result.
  let radius=min(9.0,min(support(opacity)+.001,2.0*log(opacity*255.0)+.001));
  let x=vec2(aa*b.y,bb*a.y); let y=vec2(aa*b.x,bb*a.x);
  let extent=sqrt(vec2(dot(x,x),dot(y,y)))*(sqrt(radius)/(3.0*abs(determinant)));
  if(any(!(extent>=vec2(0.0))) || any(extent>vec2(3.402823466e+38))) { return quad; }
  // Cover the local inverse, dot/divide/sqrt and center-subtraction rounding.
  // This is at least 32 relative FP32 ULP plus a small absolute pixel halo.
  let padding=(abs(center)+quad+vec2(1.0))*.000004+vec2(.001);
  return min(quad,extent)+padding;
}
fn coverageMin() -> vec2<u32> {
  return vec2(params.coverageMinPacked&65535u,params.coverageMinPacked>>16u);
}
fn coverageMax() -> vec2<u32> {
  return vec2(params.coverageMaxPacked&65535u,params.coverageMaxPacked>>16u);
}
// Counting and filling must use identical conservative bounds. Keeping this
// shared also avoids counting once with one rounding rule and scattering with
// another at clipped or partial edge tiles.
fn tileFootprint(rank: u32) -> TileFootprint {
  let empty=TileFootprint(vec2(0u),vec2(0u),0u);
  let gaussian=projected[order[rank].y&0xffffffu];
  if(gaussian.center.w==0.0) { return empty; }
  let center=vec2((gaussian.center.x+1.0)*.5,(1.0-gaussian.center.y)*.5)*vec2<f32>(params.size);
  let extent=candidateExtent(gaussian,center);
  // Exact ellipse/alpha/top-left tests still happen at each pixel. Clamping
  // only after rejecting a disjoint box avoids wrapping at offscreen bounds.
  let low=center-extent; let high=center+extent;
  if(any(high<vec2(.5)) || any(low>vec2<f32>(params.size)-vec2(.5))) { return empty; }
  var first=vec2<u32>(max(vec2(0.0),floor(low)))/SURFACE_TILE_SIZE;
  var last=vec2<u32>(min(vec2<f32>(params.size)-vec2(1.0),max(vec2(0.0),floor(high))))/SURFACE_TILE_SIZE;
  if((params.channels&SURFACE_REGION)!=0u) {
    let minimum=coverageMin(); let maximum=coverageMax();
    if(any(minimum>=maximum)) { return empty; }
    first=max(first,minimum/SURFACE_TILE_SIZE); last=min(last,(maximum-vec2(1u))/SURFACE_TILE_SIZE);
    if(any(first>last)) { return empty; }
  }
  return TileFootprint(first,last,1u);
}
@compute @workgroup_size(256)
fn bin(@builtin(global_invocation_id) id: vec3<u32>) {
  let rank=id.x; if(rank>=params.count) { return; }
  let bounds=tileFootprint(rank); if(bounds.valid==0u) { return; }
  for(var y=bounds.first.y;y<=bounds.last.y;y++) {
    for(var x=bounds.first.x;x<=bounds.last.x;x++) {
      atomicAdd(&counts[y*params.tiles.x+x],1u);
    }
  }
}
@compute @workgroup_size(256)
fn scatter(@builtin(global_invocation_id) id: vec3<u32>) {
  let rank=id.x; if(rank>=params.count) { return; }
  let bounds=tileFootprint(rank); if(bounds.valid==0u) { return; }
  for(var y=bounds.first.y;y<=bounds.last.y;y++) {
    for(var x=bounds.first.x;x<=bounds.last.x;x++) {
      let tile=y*params.tiles.x+x;
      let slot=atomicAdd(&counts[tile],1u);
      candidates[tileSpans[tile].x+slot]=rank+1u;
    }
  }
}

// Sort each tile's global ranks ascending. Zero is an empty slot and ends up
// first, so the reverse traversal is precisely the stable near-to-far order.
// Every comparator pair has one writer; a workgroup owns one disjoint tile.
// Ordinary spans stay in 4 KiB of workgroup memory, avoiding global-memory
// traffic at every comparator stage. Dense spans retain the storage path.
var<workgroup> sortSpan: vec2<u32>;
var<workgroup> localRanks: array<u32,1024>;
@compute @workgroup_size(256)
fn sortTile(@builtin(workgroup_id) group: vec3<u32>, @builtin(local_invocation_index) lane: u32) {
  if(lane==0u) { sortSpan=tileSpans[group.y*params.tiles.x+group.x]; }
  // This barrier/load establishes a uniform value for the early returns and
  // barrier-containing branches below, even though the plan is storage data.
  let span=workgroupUniformLoad(&sortSpan);
  let base=span.x; let capacity=span.y;
  if(capacity<=1u) { return; }
  if(capacity<=1024u) {
    for(var i=lane;i<capacity;i+=256u) { localRanks[i]=candidates[base+i]; }
    workgroupBarrier();
    for(var length=2u;;length*=2u) {
      for(var distance=length/2u;distance>0u;distance/=2u) {
        for(var i=lane;i<capacity;i+=256u) {
          let other=i^distance;
          if(other>i) {
            let a=localRanks[i]; let b=localRanks[other];
            let ascending=(i&length)==0u;
            if(select((a < b),(a > b),ascending)) {
              localRanks[i]=b; localRanks[other]=a;
            }
          }
        }
        workgroupBarrier();
      }
      if(length==capacity) { break; }
    }
    for(var i=lane;i<capacity;i+=256u) { candidates[base+i]=localRanks[i]; }
    return;
  }
  for(var length=2u;;length*=2u) {
    for(var distance=length/2u;distance>0u;distance/=2u) {
      for(var i=lane;i<capacity;i+=256u) {
        let other=i^distance;
        if(other>i) {
          let a=candidates[base+i]; let b=candidates[base+other];
          let ascending=(i&length)==0u;
          if(select((a < b),(a > b),ascending)) {
            candidates[base+i]=b; candidates[base+other]=a;
          }
        }
      }
      storageBarrier();
    }
    if(length==capacity) { break; }
  }
}

@compute @workgroup_size(16,16)
fn composite(@builtin(global_invocation_id) id: vec3<u32>) {
  if(any(id.xy>=params.size)) { return; }
  if((params.channels&SURFACE_REGION)!=0u && (any(id.xy<coverageMin()) || any(id.xy>=coverageMax()))) { return; }
  let sample=vec2<f32>(id.xy)+vec2(.5);
  let tile=(id.y/SURFACE_TILE_SIZE)*params.tiles.x+id.x/SURFACE_TILE_SIZE;
  let span=tileSpans[tile]; let base=span.x;
  var transmission=1.0; var depth=0.0; var opacity=0.0; var rgb=vec3(0.0);
  let count=atomicLoad(&counts[tile]);
  // The complete compact allocation was admitted before filling these lists.
  for(var i=0u;i<count;i++) {
    let rank=candidates[base+span.y-1u-i]-1u;
    let gaussian=projected[order[rank].y&0xffffffu];
    let alpha=fragmentAlpha(gaussian,sample,params.size); if(alpha==0.0) { continue; }
    let weight=transmission*alpha;
    if((params.channels&SURFACE_COLORS)!=0u) { rgb+=weight*auxiliary[order[rank].y&0xffffffu].xyz; }
    depth+=weight*gaussian.center.z; opacity+=weight; transmission*=1.0-alpha;
    // Native surface depth accumulates all surviving fragments, with no T exit.
  }
  let normalized=depth/max(opacity,1e-20);
  let finite=(bitcast<u32>(normalized)&0x7f800000u)!=0x7f800000u;
  output[id.y*params.size.x+id.x]=vec2(select(0.0,normalized,opacity>=1.0/255.0 && finite && normalized>0.0),clamp(opacity,0.0,1.0));
  if((params.channels&SURFACE_COLORS)!=0u) {
    colorOutput[id.y*params.size.x+id.x]=vec4(select(vec3(0.0),clamp(rgb/max(opacity,1e-20),vec3(0.0),vec3(1.0)),opacity>=1.0/255.0),0.0);
  }
}

fn topLeft(edge: vec2<f32>) -> bool { return edge.y<0.0 || (edge.y==0.0 && edge.x>0.0); }
fn fragmentAlpha(gaussian: Projected, sample: vec2<f32>, dimensions: vec2<u32>) -> f32 {
  let center=vec2((gaussian.center.x+1.0)*.5,(1.0-gaussian.center.y)*.5)*vec2<f32>(dimensions);
  let delta=vec2(sample.x-center.x,center.y-sample.y);
  let local=3.0*vec2(dot(delta,gaussian.axes.xy)/dot(gaussian.axes.xy,gaussian.axes.xy),
    dot(delta,gaussian.axes.zw)/dot(gaussian.axes.zw,gaussian.axes.zw));
  // Pixel-center coverage of the native quad follows the top-left fill rule.
  // This matters when an ellipse boundary falls exactly on a pixel center.
  let u=vec2(gaussian.axes.x,-gaussian.axes.y); let v=vec2(gaussian.axes.z,-gaussian.axes.w);
  if(any(abs(local)>vec2(3.0)) ||
    (local.x==-3.0 && !topLeft(v)) || (local.x==3.0 && !topLeft(-v)) ||
    (local.y==3.0 && !topLeft(u)) || (local.y==-3.0 && !topLeft(-u))) { return 0.0; }
  let r=dot(local,local); if(r>min(9.0,support(gaussian.color.a)+.001)) { return 0.0; }
  let alpha=min(.99,gaussian.color.a*exp(-.5*r)); return select(0.0,alpha,alpha>=1.0/255.0);
}
@compute @workgroup_size(64)
fn markVisible(@builtin(workgroup_id) group: vec3<u32>, @builtin(local_invocation_index) lane: u32) {
  let source=group.y*params.dispatchWidth+group.x;
  if(source>=params.count) { return; }
  let gaussian=projected[source]; if(gaussian.center.w==0.0) { return; }
  let center=vec2((gaussian.center.x+1.0)*.5,(1.0-gaussian.center.y)*.5)*vec2<f32>(params.full);
  let extent=abs(gaussian.axes.xy)+abs(gaussian.axes.zw);
  let low=max(vec2(0.0),ceil(center-extent-vec2(.5)));
  let high=min(vec2<f32>(params.full)-vec2(1.0),floor(center+extent-vec2(.5)));
  if(any(low>high)) { return; }
  let first=vec2<u32>(low); let size=vec2<u32>(high)-first+vec2(1u);
  let count=size.x*size.y;
  let word=source/32u; let bit=1u<<(source%32u);
  for(var pixel=lane;pixel<count;pixel+=64u) {
    if((atomicLoad(&visibleBits[word])&bit)!=0u) { break; }
    let at=first+vec2(pixel%size.x,pixel/size.x); let sample=vec2<f32>(at)+vec2(.5);
    if(fragmentAlpha(gaussian,sample,params.full)==0.0) { continue; }
    let mapAt=min(vec2<u32>(sample*vec2<f32>(params.size)/vec2<f32>(params.full)),params.size-vec2(1u));
    let surface=output[mapAt.y*params.size.x+mapAt.x];
    if(surface.y<1.0/255.0 || gaussian.center.z<=surface.x+auxiliary[source].w+gaussian.center.z*.005) {
      atomicOr(&visibleBits[word],bit); break;
    }
  }
}
