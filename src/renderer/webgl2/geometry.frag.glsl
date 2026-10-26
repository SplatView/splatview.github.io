precision highp float;
in vec3 world;
in vec2 corner;
in vec3 rgb;
uniform bool mesh;
layout(location=0) out vec4 color;
void main() {
  if(!mesh && dot(corner,corner)>1.) discard;
  float lighting=1.;
  if(mesh) {
    vec3 normal=cross(dFdx(world),dFdy(world)); float lengthSquared=dot(normal,normal);
    if(lengthSquared>0.) lighting=.35+.65*abs(dot(normal*inversesqrt(lengthSquared),normalize(vec3(.4,.7,.5))));
  }
  color=vec4(rgb*lighting,1.);
}
