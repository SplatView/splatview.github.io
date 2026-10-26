// Adapted from the reviewed WebGPU implementation. PlayCanvas MIT attribution:
// docs/third-party/STEADY_SPLATS_REFERENCES.md and public/licenses/PlayCanvas-MIT.txt.
precision highp float;
precision highp int;
precision highp usampler2D;
layout(std140) uniform SteadyParameters {
  mat4 inverseProjection; mat4 inverseView; mat4 previousViewProjection;
  uvec4 sampleFlags; vec4 temporal; uvec4 stripe;
};
ivec2 canonicalPixel() { return ivec2(int(gl_FragCoord.x),int(temporal.y)-1-int(gl_FragCoord.y)); }
ivec2 glPixel(ivec2 pixel) { return ivec2(pixel.x,int(temporal.y)-1-pixel.y); }
const ivec2 neighbors[4]=ivec2[4](ivec2(1,0),ivec2(-1,0),ivec2(0,1),ivec2(0,-1));
float opacitySupport(float a) {
  if(a>=.2141082512) return 9.;
  if(a>=.0289764008) { if(a>=.0787660238) return a>=.1298632188 ? 8.:7.; return a>=.0477740084 ? 6.:5.; }
  if(a>=.0106598221) return a>=.0175750755 ? 4.:3.;
  return a>=.0064655090 ? 2.:1.;
}
float steadyAlpha(float opacity,vec2 local) {
  float r=dot(local,local); if(r>min(9.,opacitySupport(opacity)+.001)) return 0.;
  float alpha=min(.99,opacity*exp(-.5*r)); return alpha>=1./255. ? alpha:0.;
}
