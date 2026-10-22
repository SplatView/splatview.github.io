@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var<storage, read> splats: array<u32>;
@group(0) @binding(2) var<storage, read> states: array<u32>;
@group(0) @binding(3) var<storage, read_write> projectedOut: array<Projected>;
@group(0) @binding(4) var<storage, read> order: array<vec2<u32>>;
@group(0) @binding(5) var<uniform> query: vec4<f32>;
@group(0) @binding(6) var<storage, read_write> queryOutput: array<u32>;
@group(0) @binding(7) var<storage, read> projected: array<Projected>;
// Session eligibility is independent of canonical selection/highlight states.
// Channels without a retained selected-edit owner alias canonical states.
@group(0) @binding(8) var<storage, read> colorTargets: array<u32>;
@group(0) @binding(9) var<storage, read> transformTargets: array<u32>;
@group(0) @binding(10) var<storage, read> opacityTargets: array<u32>;

fn coefficient(address: u32, i: u32) -> f32 {
  let values = unpack2x16float(splats[address + 10u + i / 2u]);
  return values[i % 2u];
}
fn coefficients(address: u32, i: u32) -> vec3<f32> {
  return vec3(coefficient(address,3u*i),coefficient(address,3u*i+1u),coefficient(address,3u*i+2u));
}
// Frozen desktop support bounds, with its interpolation margin. The final
// alpha cutoff still decides whether a sample contributes.
fn opacitySupport(opacity: f32) -> f32 {
  if(opacity>=.2141082512) { return 9.0; }
  if(opacity>=.0289764008) {
    if(opacity>=.0787660238) { return select(7.0,8.0,opacity>=.1298632188); }
    return select(5.0,6.0,opacity>=.0477740084);
  }
  if(opacity>=.0106598221) { return select(3.0,4.0,opacity>=.0175750755); }
  return select(1.0,2.0,opacity>=.0064655090);
}
fn luma(v: vec3<f32>) -> f32 { return dot(v,vec3(.299,.587,.114)); }
fn rotateColor(value: vec3<f32>) -> vec3<f32> {
  var v = vec3(luma(value))+(value-vec3(luma(value)))*frame.gradeA.w;
  if(frame.gradeD.z==0.0) { return v; }
  let cs=cos(radians(frame.gradeD.z)); let sn=sin(radians(frame.gradeD.z));
  return vec3(
    dot(vec3(.299+.701*cs+.168*sn,.587-.587*cs+.330*sn,.114-.114*cs-.497*sn),v),
    dot(vec3(.299-.299*cs-.328*sn,.587+.413*cs+.035*sn,.114-.114*cs+.292*sn),v),
    dot(vec3(.299-.300*cs+1.250*sn,.587-.588*cs-1.050*sn,.114+.886*cs-.203*sn),v));
}
fn halfColor(v: vec3<f32>) -> vec3<f32> {
  let clamped=clamp(v,vec3(-65504.0),vec3(65504.0));
  return vec3(unpack2x16float(pack2x16float(clamped.xy)),unpack2x16float(pack2x16float(vec2(clamped.z,0.0))).x);
}
fn gammaChannel(value: f32, radius: f32) -> vec2<f32> {
  let low=max(0.0,value-radius); let high=max(0.0,value+radius);
  if(high<=0.0) { return vec2(value,1.0); }
  if(high-low>high*.001) {
    let lowPower=pow(low,frame.gradeA.z); let highPower=pow(high,frame.gradeA.z);
    let gain=(highPower-lowPower)/(high-low); return vec2(lowPower+(value-low)*gain,gain);
  }
  let after=pow(value,frame.gradeA.z); return vec2(after,frame.gradeA.z*after/value);
}
fn color(address: u32, position: vec3<f32>, state: u32) -> vec3<f32> {
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
  var result=vec3(.5);
  if(frame.flags.z==0u || (frame.flags.w!=0u && (state&1u)==0u)) {
    for(var j=0u;j<count;j++) { result+=b[j]*coefficients(address,j); }
    return max(result,vec3(0.0));
  }
  let temperature=vec3(1.0+.3*frame.gradeB.y,1.0,1.0-.3*frame.gradeB.y);
  var dc=coefficients(address,0u)*temperature+vec3(.05,-.1,.05)*frame.gradeB.z;
  dc=(dc*frame.gradeA.x+vec3((frame.gradeA.x-1.0)*.5/b[0]))*frame.gradeA.y;
  var gain=vec3(1.0);
  if(frame.gradeA.z!=1.0) {
    var energy=vec3(0.0);
    for(var j=1u;j<count;j++) {
      let v=(coefficients(address,j)*temperature*frame.gradeA.x)*frame.gradeA.y; energy+=v*v;
    }
    let radius=sqrt(energy*(f32(count-1u)*.07957747154594767));
    let before=dc*b[0]+vec3(.5);
    let red=gammaChannel(before.x,radius.x); let green=gammaChannel(before.y,radius.y); let blue=gammaChannel(before.z,radius.z);
    gain=vec3(red.y,green.y,blue.y); dc=(vec3(red.x,green.x,blue.x)-vec3(.5))/b[0];
  }
  dc=rotateColor(dc);
  var rgb=dc*b[0]+vec3(.5);
  if(frame.gradeB.x!=1.0) {
    let sat=max(rgb.x,max(rgb.y,rgb.z))-min(rgb.x,min(rgb.y,rgb.z));
    rgb=clamp(vec3(luma(rgb))+(rgb-vec3(luma(rgb)))*(1.0+(1.0-sat)*(frame.gradeB.x-1.0)),vec3(0.0),vec3(1.0));
    dc=(rgb-vec3(.5))/b[0];
  }
  let shadow=1.0-smoothstep(0.0,.5,luma(rgb)); let highlight=smoothstep(.5,1.0,luma(rgb));
  dc*=1.0+frame.gradeB.w*shadow+frame.gradeC.x*highlight;
  dc+=vec3(frame.gradeC.y*(1.0-frame.gradeC.y)/b[0]);
  let phase=vec3(0.0,2.094395102393195,4.18879020478639);
  dc+=.5*cos(vec3(radians(frame.gradeC.z))-phase)*frame.gradeC.w*shadow/b[0];
  dc+=.5*cos(vec3(radians(frame.gradeD.x))-phase)*frame.gradeD.y*highlight/b[0];
  result+=b[0]*halfColor(dc);
  for(var k=1u;k<count;k++) {
    let v=((coefficients(address,k)*temperature*frame.gradeA.x)*frame.gradeA.y)*gain;
    result+=b[k]*halfColor(rotateColor(v));
  }
  return max(result,vec3(0.0));
}
@compute @workgroup_size(256)
fn project(@builtin(global_invocation_id) thread: vec3<u32>) {
  let i=thread.x; if(i>=frame.flags.x) { return; }
  let state=states[i]; let address=i*frame.flags.y;
  projectedOut[i]=Projected(vec4(0.0),vec4(0.0),vec4(0.0));
  if((state&2u)!=0u) { return; }
  var position=vec4(bitcast<f32>(splats[address]),bitcast<f32>(splats[address+1u]),bitcast<f32>(splats[address+2u]),1.0);
  let opacity=previewOpacity(bitcast<f32>(splats[address+3u]),opacityTargets[i],frame.gradeD.w,frame.geometryFlags.w);
  let transforming=frame.geometryFlags.x!=0u && (frame.geometryFlags.y==0u || (transformTargets[i]&1u)!=0u);
  if(transforming) { position=frame.geometry*position; }
  let p=frame.view*position;
  if(p.z>=-.001 || opacity<.0039) { return; }
  let c0=vec4(bitcast<f32>(splats[address+4u]),bitcast<f32>(splats[address+5u]),bitcast<f32>(splats[address+6u]),bitcast<f32>(splats[address+7u]));
  let c1=vec2(bitcast<f32>(splats[address+8u]),bitcast<f32>(splats[address+9u]));
  var covariance=mat3x3(vec3(c0.x,c0.y,c0.z),vec3(c0.y,c0.w,c1.x),vec3(c0.z,c1.x,c1.y));
  if(transforming) {
    let a=mat3x3(frame.geometry[0].xyz,frame.geometry[1].xyz,frame.geometry[2].xyz);
    covariance=a*covariance*transpose(a);
  }
  let depth=-p.z;
  let right=vec3(frame.view[0].x,frame.view[1].x,frame.view[2].x);
  let up=vec3(frame.view[0].y,frame.view[1].y,frame.view[2].y);
  let forward=vec3(frame.view[0].z,frame.view[1].z,frame.view[2].z);
  let jx=frame.viewport.z/depth*(right+p.x/depth*forward);
  let jy=frame.viewport.w/depth*(up+p.y/depth*forward);
  let a=dot(jx,covariance*jx)+.3; let b=dot(jx,covariance*jy); let c=dot(jy,covariance*jy)+.3;
  let middle=(a+c)*.5; let delta=sqrt(max(0.0,(a-c)*(a-c)*.25+b*b));
  let l1=max(.01,middle+delta); let l2=max(.01,middle-delta);
  var axis=select(vec2(0.0,1.0),vec2(1.0,0.0),a>=c);
  if(abs(b)>.00001) { axis=normalize(vec2(b,l1-a)); }
  let axis1=axis*min(1536.0,3.0*sqrt(l1)); let axis2=vec2(-axis.y,axis.x)*min(1536.0,3.0*sqrt(l2));
  let clip=frame.projection*p;
  if(clip.z<0.0 || clip.z>clip.w) { return; }
  let extent=(abs(axis1)+abs(axis2)+vec2(1.0))*2.0/frame.viewport.xy*clip.w;
  if(any(abs(clip.xy)>vec2(clip.w)+extent)) { return; }
  let rgb=color(address,position.xyz,colorTargets[i]);
  projectedOut[i]=Projected(vec4(clip.xy/clip.w,depth,1.0),vec4(axis1,axis2),vec4(rgb,opacity));
}
struct VertexOut {
  @builtin(position) position: vec4<f32>, @location(0) local: vec2<f32>,
  @location(1) @interpolate(flat) color: vec4<f32>, @location(2) @interpolate(flat) state: u32,
}
@vertex
fn vertex(@builtin(vertex_index) vertexIndex: u32, @builtin(instance_index) instance: u32) -> VertexOut {
  let corners=array<vec2<f32>,6>(vec2(-1.0,-1.0),vec2(1.0,-1.0),vec2(-1.0,1.0),vec2(-1.0,1.0),vec2(1.0,-1.0),vec2(1.0,1.0));
  let entry=order[instance].y; let gaussian=projected[entry&0xffffffu];
  let corner=corners[vertexIndex]; let offset=gaussian.axes.xy*corner.x+gaussian.axes.zw*corner.y;
  var result: VertexOut;
  result.position=vec4(gaussian.center.xy+2.0*offset/frame.viewport.xy,0.0,1.0);
  if(gaussian.center.w==0.0) { result.position=vec4(2.0,2.0,2.0,1.0); }
  result.local=corner*3.0; result.color=gaussian.color; result.state=entry>>24u; return result;
}
@fragment
fn fragment(input: VertexOut) -> @location(0) vec4<f32> {
  let r=dot(input.local,input.local); if(r>min(9.0,opacitySupport(input.color.a)+.001)) { discard; }
  let alpha=min(.99,input.color.a*exp(-.5*r)); if(alpha<1.0/255.0) { discard; }
  var rgb=input.color.rgb;
  if(frame.geometryFlags.z!=0u && (input.state&1u)!=0u) {
    let tint=select(vec3(1.0,.72,.12),vec3(.49,.824,.573),frame.geometryFlags.z==2u);
    rgb=mix(rgb,tint,.72);
  }
  return vec4(rgb*alpha,alpha);
}
@compute @workgroup_size(1)
fn pick() {
  var transmission=1.0; var strongest=0.0; var winner=0u; var depth=0.0; var opacity=0.0;
  let minimum=select(0.0,1.0/255.0,query.z>0.0);
  for(var reverse=0u;reverse<frame.flags.x;reverse++) {
    let entry=order[frame.flags.x-1u-reverse].y;
    let gaussian=projected[entry&0xffffffu]; if(gaussian.center.w==0.0) { continue; }
    let center=vec2((gaussian.center.x+1.0)*.5*frame.viewport.x,(1.0-gaussian.center.y)*.5*frame.viewport.y);
    let delta=vec2(query.x-center.x,center.y-query.y);
    let local=3.0*vec2(dot(delta,gaussian.axes.xy)/dot(gaussian.axes.xy,gaussian.axes.xy),dot(delta,gaussian.axes.zw)/dot(gaussian.axes.zw,gaussian.axes.zw));
    let r=dot(local,local); if(r>min(9.0,opacitySupport(gaussian.color.a)+.001)) { continue; }
    let alpha=min(.99,gaussian.color.a*exp(-.5*r)); if(alpha<1.0/255.0) { continue; }
    let weight=transmission*alpha;
    // Distant centers still obscure eligible contributors behind them.
    let eligible=query.z<=0.0 || dot(query.xy-center,query.xy-center)<=query.z*query.z;
    if(eligible && weight>=minimum && weight>strongest) { strongest=weight; winner=(entry&0xffffffu)+1u; }
    depth+=weight*gaussian.center.z; opacity+=weight; transmission*=1.0-alpha;
    if(transmission<1e-5) { break; }
  }
  queryOutput[0]=winner; queryOutput[1]=bitcast<u32>(depth/max(opacity,1e-20));
  queryOutput[2]=bitcast<u32>(opacity); queryOutput[3]=bitcast<u32>(strongest);
}
