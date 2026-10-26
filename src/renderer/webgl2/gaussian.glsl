// Direct GLSL port of SplatView frame.wgsl and splats.wgsl. Canonical matrices
// and coverage are shared; only final raster depth is converted to GL clip space.
precision highp float;
precision highp int;
precision highp usampler2D;
layout(std140) uniform GaussianFrame {
  mat4 view; mat4 projection; vec4 eyeDegree; vec4 viewport; uvec4 flags;
  vec4 gradeA; vec4 gradeB; vec4 gradeC; vec4 gradeD; mat4 geometry; uvec4 geometryFlags;
};
uniform usampler2D wordsTexture;
uniform usampler2D statesTexture;
uniform usampler2D orderTexture;
uniform bool useOrder;

ivec2 address2d(uint index, ivec2 size) { return ivec2(int(index % uint(size.x)),int(index / uint(size.x))); }
uint sourceWord(uint address) { return texelFetch(wordsTexture,address2d(address,textureSize(wordsTexture,0)),0).r; }
float sourceFloat(uint address) { return uintBitsToFloat(sourceWord(address)); }
float coefficient(uint address,uint i) { vec2 v=unpackHalf2x16(sourceWord(address+10u+i/2u)); return v[int(i%2u)]; }
vec3 coefficients(uint address,uint i) { return vec3(coefficient(address,3u*i),coefficient(address,3u*i+1u),coefficient(address,3u*i+2u)); }
float opacitySupport(float a) {
  if(a>=.2141082512) return 9.;
  if(a>=.0289764008) {
    if(a>=.0787660238) return a>=.1298632188 ? 8.:7.;
    return a>=.0477740084 ? 6.:5.;
  }
  if(a>=.0106598221) return a>=.0175750755 ? 4.:3.;
  return a>=.0064655090 ? 2.:1.;
}
float previewOpacity(float a,uint state) {
  if((geometryFlags.w&1u)==0u || ((geometryFlags.w&2u)!=0u && (state&1u)==0u)) return a;
  return gradeD.w<=1. ? clamp(a*gradeD.w,0.,1.):clamp(a+(1.-a)*(gradeD.w-1.)/2.,0.,1.);
}
float luma(vec3 v) { return dot(v,vec3(.299,.587,.114)); }
vec3 rotateColor(vec3 value) {
  vec3 v=vec3(luma(value))+(value-vec3(luma(value)))*gradeA.w;
  if(gradeD.z==0.) return v;
  float cs=cos(radians(gradeD.z)), sn=sin(radians(gradeD.z));
  return vec3(dot(vec3(.299+.701*cs+.168*sn,.587-.587*cs+.330*sn,.114-.114*cs-.497*sn),v),
    dot(vec3(.299-.299*cs-.328*sn,.587+.413*cs+.035*sn,.114-.114*cs+.292*sn),v),
    dot(vec3(.299-.300*cs+1.250*sn,.587-.588*cs-1.050*sn,.114+.886*cs-.203*sn),v));
}
vec3 halfColor(vec3 value) {
  vec3 v=clamp(value,vec3(-65504.),vec3(65504.));
  return vec3(unpackHalf2x16(packHalf2x16(v.xy)),unpackHalf2x16(packHalf2x16(vec2(v.z,0.))).x);
}
vec2 gammaChannel(float value,float radius) {
  float low=max(0.,value-radius), high=max(0.,value+radius);
  if(high<=0.) return vec2(value,1.);
  if(high-low>high*.001) {
    float lowPower=pow(low,gradeA.z), highPower=pow(high,gradeA.z);
    float gain=(highPower-lowPower)/(high-low); return vec2(lowPower+(value-low)*gain,gain);
  }
  float after=pow(value,gradeA.z); return vec2(after,gradeA.z*after/value);
}
vec3 gaussianColor(uint address,vec3 position,uint state) {
  vec3 direction=position-eyeDegree.xyz, d=direction/max(length(direction),1e-20);
  float x=d.x,y=d.y,z=d.z,xx=x*x,yy=y*y,zz=z*z;
  float b[16]; b[0]=.2820947918;
  b[1]=-.4886025119*y; b[2]=.4886025119*z; b[3]=-.4886025119*x;
  b[4]=1.0925484306*x*y; b[5]=-1.0925484306*y*z;
  b[6]=.3153915653*(2.*zz-xx-yy); b[7]=-1.0925484306*x*z; b[8]=.5462742153*(xx-yy);
  b[9]=-.5900435899*y*(3.*xx-yy); b[10]=2.8906114426*x*y*z;
  b[11]=-.4570457995*y*(4.*zz-xx-yy); b[12]=.3731763326*z*(2.*zz-3.*xx-3.*yy);
  b[13]=-.4570457995*x*(4.*zz-xx-yy); b[14]=1.4453057213*z*(xx-yy); b[15]=-.5900435899*x*(xx-3.*yy);
  uint bands=uint(eyeDegree.w)+1u, count=bands*bands;
  vec3 result=vec3(.5);
  if(flags.z==0u || (flags.w!=0u && (state&1u)==0u)) {
    for(uint j=0u;j<count;j++) result+=b[j]*coefficients(address,j);
    return max(result,vec3(0.));
  }
  vec3 temperature=vec3(1.+.3*gradeB.y,1.,1.-.3*gradeB.y);
  vec3 dc=coefficients(address,0u)*temperature+vec3(.05,-.1,.05)*gradeB.z;
  dc=(dc*gradeA.x+vec3((gradeA.x-1.)*.5/b[0]))*gradeA.y;
  vec3 gain=vec3(1.);
  if(gradeA.z!=1.) {
    vec3 energy=vec3(0.);
    for(uint j=1u;j<count;j++) { vec3 v=(coefficients(address,j)*temperature*gradeA.x)*gradeA.y; energy+=v*v; }
    vec3 radius=sqrt(energy*(float(count-1u)*.07957747154594767)), before=dc*b[0]+vec3(.5);
    vec2 r=gammaChannel(before.x,radius.x), g=gammaChannel(before.y,radius.y), bl=gammaChannel(before.z,radius.z);
    gain=vec3(r.y,g.y,bl.y); dc=(vec3(r.x,g.x,bl.x)-vec3(.5))/b[0];
  }
  dc=rotateColor(dc); vec3 rgb=dc*b[0]+vec3(.5);
  if(gradeB.x!=1.) {
    float sat=max(rgb.x,max(rgb.y,rgb.z))-min(rgb.x,min(rgb.y,rgb.z));
    rgb=clamp(vec3(luma(rgb))+(rgb-vec3(luma(rgb)))*(1.+(1.-sat)*(gradeB.x-1.)),vec3(0.),vec3(1.));
    dc=(rgb-vec3(.5))/b[0];
  }
  float shadow=1.-smoothstep(0.,.5,luma(rgb)), highlight=smoothstep(.5,1.,luma(rgb));
  dc*=1.+gradeB.w*shadow+gradeC.x*highlight;
  dc+=vec3(gradeC.y*(1.-gradeC.y)/b[0]);
  vec3 phase=vec3(0.,2.094395102393195,4.18879020478639);
  dc+=.5*cos(vec3(radians(gradeC.z))-phase)*gradeC.w*shadow/b[0];
  dc+=.5*cos(vec3(radians(gradeD.x))-phase)*gradeD.y*highlight/b[0];
  result+=b[0]*halfColor(dc);
  for(uint k=1u;k<count;k++) {
    vec3 v=((coefficients(address,k)*temperature*gradeA.x)*gradeA.y)*gain;
    result+=b[k]*halfColor(rotateColor(v));
  }
  return max(result,vec3(0.));
}
struct Projected { vec4 center; vec4 axes; vec4 color; };
Projected projectGaussian(uint id,uvec4 targets) {
  Projected empty=Projected(vec4(0.),vec4(0.),vec4(0.));
  if((targets.x&2u)!=0u) return empty;
  uint address=id*flags.y;
  vec4 position=vec4(sourceFloat(address),sourceFloat(address+1u),sourceFloat(address+2u),1.);
  float opacity=previewOpacity(sourceFloat(address+3u),targets.w);
  bool transforming=geometryFlags.x!=0u && (geometryFlags.y==0u || (targets.z&1u)!=0u);
  if(transforming) position=geometry*position;
  vec4 p=view*position;
  if(p.z>=-.001 || opacity<.0039) return empty;
  vec4 c0=vec4(sourceFloat(address+4u),sourceFloat(address+5u),sourceFloat(address+6u),sourceFloat(address+7u));
  vec2 c1=vec2(sourceFloat(address+8u),sourceFloat(address+9u));
  mat3 covariance=mat3(vec3(c0.x,c0.y,c0.z),vec3(c0.y,c0.w,c1.x),vec3(c0.z,c1.x,c1.y));
  if(transforming) { mat3 a=mat3(geometry); covariance=a*covariance*transpose(a); }
  float depth=-p.z;
  vec3 right=vec3(view[0].x,view[1].x,view[2].x), up=vec3(view[0].y,view[1].y,view[2].y), forward=vec3(view[0].z,view[1].z,view[2].z);
  vec3 jx=viewport.z/depth*(right+p.x/depth*forward), jy=viewport.w/depth*(up+p.y/depth*forward);
  float a=dot(jx,covariance*jx)+.3, b=dot(jx,covariance*jy), c=dot(jy,covariance*jy)+.3;
  float middle=(a+c)*.5, delta=sqrt(max(0.,(a-c)*(a-c)*.25+b*b));
  float l1=max(.01,middle+delta), l2=max(.01,middle-delta);
  vec2 axis=a>=c ? vec2(1.,0.):vec2(0.,1.);
  if(abs(b)>.00001) axis=normalize(vec2(b,l1-a));
  vec2 axis1=axis*min(1536.,3.*sqrt(l1)), axis2=vec2(-axis.y,axis.x)*min(1536.,3.*sqrt(l2));
  vec4 clip=projection*p;
  if(clip.z<0. || clip.z>clip.w) return empty;
  vec2 extent=(abs(axis1)+abs(axis2)+vec2(1.))*2./viewport.xy*clip.w;
  if(any(greaterThan(abs(clip.xy),vec2(clip.w)+extent))) return empty;
  return Projected(vec4(clip.xy/clip.w,depth,1.),vec4(axis1,axis2),vec4(gaussianColor(address,position.xyz,targets.y),opacity));
}
