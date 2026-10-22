import type { SurfaceMap } from '../src/renderer/webgpu/surfaceQuery';

// Compile-time guards, checked by npm run typecheck/build. This function is
// never executed; it proves borrowed metadata cannot be rewritten by callers.
export function assertPublishedSurfaceMapContract(map: SurfaceMap) {
  // Native transport and existing oracle fixtures can still access array
  // contents. Readonly metadata does not imply readonly typed-array storage.
  map.depths[0] = 0;
  map.opacities[0] = 0;
  if (map.colors) map.colors[0] = 0;
  if (map.visible) map.visible[0] = 0;

  // @ts-expect-error Published map dimensions cannot be replaced.
  map.width = 1;
  // @ts-expect-error Published map dimensions cannot be replaced.
  map.height = 1;
  // @ts-expect-error Native framebuffer dimensions cannot be replaced.
  map.fullWidth = 1;
  // @ts-expect-error Native framebuffer dimensions cannot be replaced.
  map.fullHeight = 1;
  // @ts-expect-error Cache coverage cannot be replaced through a borrower.
  map.region = undefined;
  // @ts-expect-error Published depth channel references cannot be replaced.
  map.depths = new Float32Array();
  // @ts-expect-error Published opacity channel references cannot be replaced.
  map.opacities = new Float32Array();
  // @ts-expect-error Published optional channel references cannot be replaced.
  map.colors = undefined;
  // @ts-expect-error Published optional channel references cannot be replaced.
  map.visible = undefined;
  // @ts-expect-error Map accounting metadata cannot be rewritten.
  map.allocationBytes = 0;
  // @ts-expect-error GPU source identity cannot be rewritten.
  map.deviceEpoch = 0;
  if (map.profile) {
    // @ts-expect-error Published diagnostics are snapshots, not counters to edit.
    map.profile.totalMs = 0;
  }

  map.assertCurrent();
  map.dispose();
}
