precision highp float;
in vec2 local;
flat in vec4 gaussianColorOpacity;
layout(location=0) out vec4 color;
float support(float a) {
  if(a>=.2141082512) return 9.;
  if(a>=.0289764008) { if(a>=.0787660238) return a>=.1298632188 ? 8.:7.; return a>=.0477740084 ? 6.:5.; }
  if(a>=.0106598221) return a>=.0175750755 ? 4.:3.;
  return a>=.0064655090 ? 2.:1.;
}
void main() {
  float r=dot(local,local);
  if(r>min(9.,support(gaussianColorOpacity.a)+.001)) discard;
  float alpha=min(.99,gaussianColorOpacity.a*exp(-.5*r)); if(alpha<1./255.) discard;
  color=vec4(gaussianColorOpacity.rgb*alpha,alpha);
}
