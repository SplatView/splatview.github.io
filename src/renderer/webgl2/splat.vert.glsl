// gaussian.glsl precedes this source after the GLSL version declaration.
out vec2 local;
flat out vec4 gaussianCenter;
flat out vec4 gaussianAxes;
flat out vec4 gaussianColorOpacity;
flat out uint sourceId;
uniform bool stochasticDepth;
void main() {
  uint index=uint(gl_InstanceID);
  uint id=useOrder ? texelFetch(orderTexture,address2d(index,textureSize(orderTexture,0)),0).r:index;
  uvec4 targets=texelFetch(statesTexture,address2d(id,textureSize(statesTexture,0)),0);
  Projected g=projectGaussian(id,targets);
  vec2 corners[4]=vec2[4](vec2(-1.,-1.),vec2(1.,-1.),vec2(-1.,1.),vec2(1.,1.));
  vec2 corner=corners[gl_VertexID], offset=g.axes.xy*corner.x+g.axes.zw*corner.y;
  float z=-1.;
  if(stochasticDepth) { vec4 clip=projection*vec4(0.,0.,-g.center.z,1.); z=2.*clip.z/max(clip.w,1e-20)-1.; }
  gl_Position=vec4(g.center.xy+2.*offset/viewport.xy,z,1.);
  if(g.center.w==0.) gl_Position=vec4(2.,2.,2.,1.);
  vec4 color=g.color;
  if(geometryFlags.z!=0u && (targets.x&1u)!=0u) {
    vec3 tint=geometryFlags.z==2u ? vec3(.49,.824,.573):vec3(1.,.72,.12);
    color.rgb=mix(color.rgb,tint,.72);
  }
  local=corner*3.; gaussianCenter=g.center; gaussianAxes=g.axes; gaussianColorOpacity=color; sourceId=id+1u;
}
