in vec2 local;
flat in vec4 gaussianCenter;
flat in vec4 gaussianAxes;
flat in vec4 gaussianColorOpacity;
flat in uint sourceId;
uniform highp sampler3D noiseTexture;
layout(location=0) out vec4 rawColor;
layout(location=1) out uvec4 sampleData;
layout(location=2) out vec4 projectedAxes;
layout(location=3) out float projectedOpacity;
uint primitivePhase(uint id) {
  uint state=id*747796405u+2891336453u;
  uint word=((state>>((state>>28u)+4u))^state)*277803737u;
  return (word>>22u)^word;
}
void main() {
  float alpha=steadyAlpha(gaussianColorOpacity.a,local); if(alpha<=0.) discard;
  uvec2 offset=uvec2(sourceId*3242174889u,sourceId*2447445415u)>>uvec2(27u);
  ivec3 coordinate=ivec3((uvec2(canonicalPixel())+offset)&uvec2(31u),int(sampleFlags.x&63u));
  uint rank=uint(texelFetch(noiseTexture,coordinate,0).r*255.+.5);
  uint rotated=(rank<<24u)+primitivePhase(sourceId)+stripe.z;
  if(alpha<=float(rotated>>8u)*(1./16777216.)) discard;
  rawColor=vec4(gaussianColorOpacity.rgb,1.);
  sampleData=uvec4(sourceId,floatBitsToUint(gaussianCenter.z),floatBitsToUint(gaussianCenter.x),floatBitsToUint(gaussianCenter.y));
  projectedAxes=gaussianAxes; projectedOpacity=gaussianColorOpacity.a;
}
