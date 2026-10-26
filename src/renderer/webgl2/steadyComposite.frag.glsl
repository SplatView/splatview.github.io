precision highp float;
uniform sampler2D reconstructedColor;
uniform float backgroundShade;
layout(location=0) out vec4 color;
void main() {
  vec4 value=texelFetch(reconstructedColor,ivec2(gl_FragCoord.xy),0);
  color=vec4(value.rgb+(1.-value.a)*backgroundShade,1.);
}
