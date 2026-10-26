uniform sampler2D rawTexture;
uniform sampler2D previousColor;
uniform sampler2D previousAverage;
layout(location=0) out vec4 nextColor;
layout(location=1) out vec4 nextAverage;
vec3 ycocg(vec3 c) { return vec3(dot(c,vec3(.25,.5,.25)),(c.r-c.b)*.5,dot(c,vec3(-.25,.5,-.25))); }
vec3 radiance(vec4 c) { return c.rgb+(1.-c.a)*temporal.w; }
vec4 cubic(float t) {
  float t2=t*t,t3=t2*t;
  return vec4(-.5*t+t2-.5*t3,1.-2.5*t2+1.5*t3,.5*t+2.*t2-1.5*t3,-.5*t2+.5*t3);
}
vec4 historyAt(vec2 pixel) {
  ivec2 base=ivec2(floor(pixel-.5)); vec2 fraction=fract(pixel-.5);
  vec4 wx=cubic(fraction.x),wy=cubic(fraction.y),color=vec4(0.);
  for(int y=0;y<4;y++) for(int x=0;x<4;x++) {
    ivec2 q=clamp(base+ivec2(x-1,y-1),ivec2(0),ivec2(temporal.xy)-1);
    color+=wx[x]*wy[y]*texelFetch(previousColor,glPixel(q),0);
  }
  return color;
}
vec4 temporalAt(ivec2 p,vec4 current) {
  if(sampleFlags.y==0u || temporal.z<=0.) return current;
  vec2 pixel=vec2(p)+.5,previousPixel=pixel; vec4 historical=texelFetch(previousColor,glPixel(p),0);
  if(sampleFlags.z==0u) {
    uvec4 sampleData=texelFetch(sampleTexture,glPixel(p),0);
    vec2 ndc=pixel/temporal.xy*vec2(2.,-2.)+vec2(-1.,1.);
    vec4 unprojected=inverseProjection*vec4(ndc,1.,1.); vec3 ray=unprojected.xyz/-unprojected.z;
    float depth=uintBitsToFloat(sampleData.y);
    vec4 world=inverseView*(sampleData.x!=0u?vec4(ray*depth,1.):vec4(ray,0.));
    vec4 clip=previousViewProjection*world;
    previousPixel=(clip.xy/max(clip.w,1e-20)*vec2(.5,-.5)+.5)*temporal.xy;
    if(clip.w<=0. || any(lessThan(previousPixel,vec2(2.))) || any(greaterThanEqual(previousPixel,temporal.xy-2.))) return current;
    historical=historyAt(previousPixel);
  }
  vec3 mean=vec3(0.),second=vec3(0.);
  for(int y=-1;y<=1;y++) for(int x=-1;x<=1;x++) {
    ivec2 q=clamp(p+ivec2(x,y),ivec2(0),ivec2(temporal.xy)-1);
    vec3 value=ycocg(radiance(texelFetch(rawTexture,glPixel(q),0))); mean+=value; second+=value*value;
  }
  mean/=9.; vec3 sigma=sqrt(max(second/9.-mean*mean,vec3(0.)));
  float gamma=mix(4.,1.,min(length(pixel-previousPixel)/4.,1.)); vec3 extent=max(sigma*gamma,vec3(.01,.005,.005));
  vec3 delta=abs(ycocg(radiance(historical))-mean)/extent;
  return mix(current,historical,temporal.z/max(1.,max(delta.x,max(delta.y,delta.z))));
}
void main() {
  ivec2 p=canonicalPixel(); vec4 raw=texelFetch(rawTexture,glPixel(p),0),spatial=raw; float mass=1.;
  for(int n=0;n<4;n++) {
    ivec2 source=p-neighbors[n];
    if(all(greaterThanEqual(source,ivec2(0))) && all(lessThan(source,ivec2(temporal.xy)))) {
      float weight=outwardRatios(source)[n]; spatial+=texelFetch(rawTexture,glPixel(source),0)*weight; mass+=weight;
    }
  }
  spatial/=mass; vec4 color=temporalAt(p,spatial),average=vec4(0.); uint frames=sampleFlags.w;
  if(frames!=0u) {
    vec4 sampleColor=frames<=8u?spatial:raw; average=sampleColor;
    if(frames>1u) { average=texelFetch(previousAverage,glPixel(p),0); average+=(sampleColor-average)/float(frames); }
    color=mix(color,average,float(frames)/(float(frames)+8.));
  }
  float alpha=clamp(color.a,0.,1.); vec3 rgb=color.rgb*(color.a>0.?alpha/max(color.a,1e-8):0.);
  nextColor=vec4(rgb,alpha); nextAverage=average;
}
