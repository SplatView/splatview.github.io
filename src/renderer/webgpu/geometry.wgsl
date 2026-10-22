// Frozen Windows geometry.hlsl, with the native camera matrices and byte RGB.
// The first 160 bytes intentionally share the Gaussian frame allocation.
struct GeometryFrame {
  view: mat4x4<f32>, projection: mat4x4<f32>, eye: vec4<f32>, viewport: vec4<f32>,
}
@group(0) @binding(0) var<uniform> frame: GeometryFrame;
struct GeometryOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) world: vec3<f32>,
  @location(1) corner: vec2<f32>,
  @location(2) color: vec3<f32>,
}
@vertex
fn pointVertex(@location(0) position: vec3<f32>, @location(1) color: vec4<f32>,
  @builtin(vertex_index) id: u32) -> GeometryOutput {
  // The two triangles match the desktop triangle strip, with the same corners.
  let corners = array<vec2<f32>, 6>(vec2(-1.,-1.), vec2(1.,-1.), vec2(-1.,1.),
    vec2(-1.,1.), vec2(1.,-1.), vec2(1.,1.));
  let corner = corners[id];
  var clip = frame.projection * (frame.view * vec4(position, 1.));
  clip.x += corner.x * frame.viewport.z * 2. / frame.viewport.x * clip.w;
  clip.y += corner.y * frame.viewport.z * 2. / frame.viewport.y * clip.w;
  return GeometryOutput(clip, position, corner, color.rgb);
}
@vertex
fn meshVertex(@location(0) position: vec3<f32>, @location(1) color: vec4<f32>) -> GeometryOutput {
  return GeometryOutput(frame.projection * (frame.view * vec4(position, 1.)), position, vec2(0.), color.rgb);
}
@fragment
fn pointFragment(input: GeometryOutput) -> @location(0) vec4<f32> {
  if (dot(input.corner, input.corner) > 1.) { discard; }
  return vec4(input.color, 1.);
}
@fragment
fn meshFragment(input: GeometryOutput) -> @location(0) vec4<f32> {
  let normal = cross(dpdx(input.world), dpdy(input.world));
  let lengthSquared = dot(normal, normal);
  var lighting = 1.;
  if (lengthSquared > 0.) {
    lighting = .35 + .65 * abs(dot(normal * inverseSqrt(lengthSquared), normalize(vec3(.4,.7,.5))));
  }
  return vec4(input.color * lighting, 1.);
}
