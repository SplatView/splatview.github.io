import { SURFACE_MAX_PACKED_COORDINATE, SURFACE_TILE_SIZE, type SurfaceRegion } from './surfaceQuery';

const DEPTH_SAMPLE_HALO = 2;

/** Undefined denotes the full surface; an empty rectangle denotes no samples. */
export function containsSurfaceRegion(coverage: SurfaceRegion | undefined, requested: SurfaceRegion | undefined): boolean {
  if (!coverage) return true;
  if (!requested) return false;
  if (!requested.width || !requested.height) return true;
  return requested.x >= coverage.x && requested.y >= coverage.y &&
    requested.x + requested.width <= coverage.x + coverage.width &&
    requested.y + requested.height <= coverage.y + coverage.height;
}

/** Copy the union so a growing request never changes a published or in-flight region. */
export function unionSurfaceRegions(a: SurfaceRegion | undefined, b: SurfaceRegion | undefined): SurfaceRegion | undefined {
  if (!a || !b) return undefined;
  if (!a.width || !a.height) return Object.freeze({ ...b });
  if (!b.width || !b.height) return Object.freeze({ ...a });
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return Object.freeze({ x, y, width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y });
}

/**
 * Exact conservative depth-sample coverage for an accumulated 3D-brush path.
 * Points use physical framebuffer coordinates, not CSS pixels. Bound all
 * endpoints before clipping so offscreen segments crossing the view survive.
 * The two-pixel halo includes native nearest/bilinear depth samples; outward
 * tile alignment permits the existing tile compositor to skip untouched work.
 * Ambiguous inputs keep the full query instead of reducing selection coverage.
 */
export function volumeSurfaceRegion(options: {
  points: readonly (readonly number[])[];
  viewportWidth: number;
  viewportHeight: number;
  mapWidth: number;
  mapHeight: number;
}): SurfaceRegion | undefined {
  const { points, viewportWidth, viewportHeight, mapWidth, mapHeight } = options;
  if (![viewportWidth, viewportHeight, mapWidth, mapHeight].every(value =>
    Number.isSafeInteger(value) && value > 0 && value <= SURFACE_MAX_PACKED_COORDINATE) ||
    mapWidth > viewportWidth || mapHeight > viewportHeight || !points.length) return undefined;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const point of points) {
    if (!Array.isArray(point) || point.length !== 2 ||
      !Number.isSafeInteger(point[0]) || !Number.isSafeInteger(point[1]) ||
      Math.abs(point[0]) > 0x7fff_ffff || Math.abs(point[1]) > 0x7fff_ffff) return undefined;
    minX = Math.min(minX, point[0]); minY = Math.min(minY, point[1]);
    maxX = Math.max(maxX, point[0]); maxY = Math.max(maxY, point[1]);
  }
  // Native volume sampling rejects framebuffer points outside these bounds.
  if (maxX < 0 || maxY < 0 || minX >= viewportWidth || minY >= viewportHeight)
    return Object.freeze({ x: 0, y: 0, width: 0, height: 0 });

  const firstX = Math.max(0, Math.floor(Math.max(0, minX) * mapWidth / viewportWidth) - DEPTH_SAMPLE_HALO);
  const firstY = Math.max(0, Math.floor(Math.max(0, minY) * mapHeight / viewportHeight) - DEPTH_SAMPLE_HALO);
  const lastX = Math.min(mapWidth, Math.floor(Math.min(viewportWidth - 1, maxX) * mapWidth / viewportWidth) + DEPTH_SAMPLE_HALO + 1);
  const lastY = Math.min(mapHeight, Math.floor(Math.min(viewportHeight - 1, maxY) * mapHeight / viewportHeight) + DEPTH_SAMPLE_HALO + 1);
  const x = Math.floor(firstX / SURFACE_TILE_SIZE) * SURFACE_TILE_SIZE, y = Math.floor(firstY / SURFACE_TILE_SIZE) * SURFACE_TILE_SIZE;
  return Object.freeze({ x, y, width: Math.min(mapWidth, Math.ceil(lastX / SURFACE_TILE_SIZE) * SURFACE_TILE_SIZE) - x,
    height: Math.min(mapHeight, Math.ceil(lastY / SURFACE_TILE_SIZE) * SURFACE_TILE_SIZE) - y });
}
