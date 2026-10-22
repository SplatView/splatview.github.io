struct Sampling { viewport: vec2<u32>, grid: vec2<u32> }
struct Histogram { bins: array<atomic<u32>, 768> }
@group(0) @binding(0) var image: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> histogram: Histogram;
@group(0) @binding(2) var<uniform> sampling: Sampling;

@compute @workgroup_size(16, 16)
fn histogramSample(@builtin(global_invocation_id) id: vec3<u32>) {
  if (any(id.xy >= sampling.grid)) { return; }
  let center = (vec2<f32>(id.xy) + vec2<f32>(0.5)) *
    vec2<f32>(sampling.viewport) / vec2<f32>(sampling.grid);
  let pixel = min(vec2<u32>(center), sampling.viewport - vec2<u32>(1));
  let color = vec3<u32>(round(clamp(textureLoad(image, vec2<i32>(pixel), 0).rgb,
    vec3<f32>(0.0), vec3<f32>(1.0)) * 255.0));
  atomicAdd(&histogram.bins[color.r], 1u);
  atomicAdd(&histogram.bins[256u + color.g], 1u);
  atomicAdd(&histogram.bins[512u + color.b], 1u);
}
