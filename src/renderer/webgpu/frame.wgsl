struct Frame {
  view: mat4x4<f32>, projection: mat4x4<f32>, eyeDegree: vec4<f32>, viewport: vec4<f32>,
  flags: vec4<u32>, gradeA: vec4<f32>, gradeB: vec4<f32>, gradeC: vec4<f32>, gradeD: vec4<f32>,
  geometry: mat4x4<f32>, geometryFlags: vec4<u32>,
}
struct Projected { center: vec4<f32>, axes: vec4<f32>, color: vec4<f32> }

// Desktop processing.cpp opacity operation. Apply before alpha culling and
// footprint support so boost can revive transparent records without re-sorting.
fn previewOpacity(alpha: f32, state: u32, scale: f32, flags: u32) -> f32 {
  if((flags&1u)==0u || ((flags&2u)!=0u && (state&1u)==0u)) { return alpha; }
  if(scale<=1.0) { return clamp(alpha*scale,0.0,1.0); }
  return clamp(alpha+(1.0-alpha)*(scale-1.0)/2.0,0.0,1.0);
}
