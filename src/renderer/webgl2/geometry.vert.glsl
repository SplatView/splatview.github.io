precision highp float;
layout(location=0) in vec3 position;
layout(location=1) in vec4 color;
uniform mat4 geometryView;
uniform mat4 geometryProjection;
uniform vec3 geometryViewport;
uniform bool mesh;
out vec3 world;
out vec2 corner;
out vec3 rgb;
void main() {
  vec2 corners[6]=vec2[6](vec2(-1.,-1.),vec2(1.,-1.),vec2(-1.,1.),vec2(-1.,1.),vec2(1.,-1.),vec2(1.,1.));
  corner=mesh?vec2(0.):corners[gl_VertexID];
  vec4 clip=geometryProjection*(geometryView*vec4(position,1.));
  clip.xy+=corner*geometryViewport.z*2./geometryViewport.xy*clip.w;
  clip.z=2.*clip.z-clip.w;
  gl_Position=clip; world=position; rgb=color.rgb;
}
