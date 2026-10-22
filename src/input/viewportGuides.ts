// Ported from captured SplatView src/viewport_guides.cpp and viewport_drawing.cpp;
// palette values are from ui_design.hpp. See reference/targets/windows-r0-20261012-02/source/.
import type { BackgroundColor } from './background';

export type ViewportGuides = 'none' | 'grid' | 'axes' | 'both';
export type GuidePoint = Readonly<{ x: number; y: number }>;
export type GuideColor = Readonly<{ r: number; g: number; b: number; a: number }>;
export type GuideWorldPoint = readonly [number, number, number];
export type GuideAxis = 'X' | 'Y' | 'Z';
export type GuideLine = Readonly<{
  from: GuidePoint; to: GuidePoint; color: GuideColor; width: number;
  kind: 'grid' | 'axis'; worldFrom: GuideWorldPoint; worldTo: GuideWorldPoint;
  axis?: GuideAxis; direction?: 'negative' | 'positive'; cell?: number; major?: boolean;
}>;
export type GuideLabel = Readonly<{
  text: GuideAxis; x: number; y: number; shadowX: number; shadowY: number; color: GuideColor;
}>;
export type GuideOrigin = Readonly<{ x: number; y: number; radius: number; color: GuideColor }>;
export type ViewportGuidesLayout = Readonly<{
  step: number; lines: readonly GuideLine[]; labels: readonly GuideLabel[]; origin: GuideOrigin | null;
}>;
export type ViewportGuidesInput = Readonly<{
  mode: ViewportGuides; view: ArrayLike<number>; projection: ArrayLike<number>;
  target: ArrayLike<number>; distance: number; width: number; height: number;
  background: BackgroundColor; scale?: number;
}>;

export function nextViewportGuides(mode: ViewportGuides): ViewportGuides {
  switch (mode) {
    case 'none': return 'grid';
    case 'grid': return 'axes';
    case 'axes': return 'both';
    default: return 'none';
  }
}
export function viewportGuidesTooltip(mode: ViewportGuides): string {
  switch (mode) {
    case 'none': return 'Guides: none. Click for grid.';
    case 'grid': return 'Guides: horizontal grid. Click for XYZ axes.';
    case 'axes': return 'Guides: XYZ axes. Click for both.';
    case 'both': return 'Guides: grid and axes. Click to hide.';
  }
}

const f32 = Math.fround;
const empty = (): ViewportGuidesLayout => ({ step: 0, lines: [], labels: [], origin: null });
const axisNames = ['X', 'Y', 'Z'] as const;
// Captured uiDesign::sceneColors, converted by ImGui's UNORM8 rounding below.
const axisInk = [[.925, .392, .392], [.49, .824, .573], [.412, .647, .961]] as const;
type ClipPoint = readonly [number, number, number, number];

function finiteFloat(value: number) {
  return typeof value === 'number' && Number.isFinite(value) && Number.isFinite(f32(value));
}
function validVector(value: ArrayLike<number>, length: number) {
  if (!value || value.length !== length) return false;
  for (let i = 0; i < length; i++) if (!finiteFloat(value[i])) return false;
  return true;
}
function color(ink: readonly [number, number, number], alpha = 1): GuideColor {
  const byte = (value: number) => Math.floor(f32(f32(Math.min(1, Math.max(0, f32(value))) * 255) + .5));
  return { r: byte(ink[0]), g: byte(ink[1]), b: byte(ink[2]), a: byte(alpha) };
}
function multiply(projection: ArrayLike<number>, view: ArrayLike<number>): number[] {
  const result = new Array<number>(16);
  // Camera arrays have the same column-major projection * view convention as WGSL.
  for (let column = 0; column < 4; column++) for (let row = 0; row < 4; row++) {
    let value = f32(f32(projection[row]) * f32(view[column * 4]));
    for (let k = 1; k < 4; k++)
      value = f32(value + f32(f32(projection[k * 4 + row]) * f32(view[column * 4 + k])));
    result[column * 4 + row] = value;
  }
  return result;
}
function transform(point: GuideWorldPoint, matrix: readonly number[]): ClipPoint {
  const result = new Array<number>(4);
  for (let row = 0; row < 4; row++) {
    let value = f32(point[0] * matrix[row]);
    value = f32(value + f32(point[1] * matrix[4 + row]));
    value = f32(value + f32(point[2] * matrix[8 + row]));
    result[row] = f32(value + matrix[12 + row]);
  }
  return result as unknown as ClipPoint;
}
function screen(point: ClipPoint, width: number, height: number): GuidePoint | null {
  if (!point.every(Number.isFinite)) return null;
  const w = Math.max(f32(1e-8), point[3]);
  const x = f32(f32(f32(f32(point[0] / w) + 1) * width) * .5);
  const y = f32(f32(f32(1 - f32(point[1] / w)) * height) * .5);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  // The SVG viewport clips the stroke, like the native draw-list clip rectangle.
  return { x, y };
}
function clippedLine(a: GuideWorldPoint, b: GuideWorldPoint, vp: readonly number[], width: number, height: number) {
  const p = transform(a, vp), q = transform(b, vp);
  const planes = ([x, y, z, w]: ClipPoint) => [f32(x + w), f32(w - x), f32(y + w), f32(w - y), z, f32(w - z)];
  const d0 = planes(p), d1 = planes(q);
  let first = 0, last = 1;
  // Exact Direct3D homogeneous frustum: -w <= x,y <= w and 0 <= z <= w.
  for (let i = 0; i < 6; i++) {
    if (!Number.isFinite(d0[i]) || !Number.isFinite(d1[i]) || d0[i] < 0 && d1[i] < 0) return null;
    if (d0[i] < 0) first = Math.max(first, f32(d0[i] / f32(d0[i] - d1[i])));
    if (d1[i] < 0) last = Math.min(last, f32(d0[i] / f32(d0[i] - d1[i])));
  }
  if (first > last) return null;
  const at = (t: number) => p.map((value, i) => f32(value + f32(f32(q[i] - value) * t))) as unknown as ClipPoint;
  const from = screen(at(first), width, height), to = screen(at(last), width, height);
  return from && to ? { from, to } : null;
}
function project(point: GuideWorldPoint, vp: readonly number[], width: number, height: number): GuidePoint | null {
  const clip = transform(point, vp), [x, y, z, w] = clip;
  if (!(w > 0) || !clip.every(Number.isFinite) || z < 0 || z > w || Math.abs(x) > w || Math.abs(y) > w) return null;
  // Unlike line interpolation, visible point projection does not floor positive w.
  return { x: f32(f32(f32(f32(x / w) + 1) * width) * .5), y: f32(f32(f32(1 - f32(y / w)) * height) * .5) };
}

/** Bounded presentation-only desktop world references; all dimensions are CSS pixels. */
export function layoutViewportGuides(input: ViewportGuidesInput): ViewportGuidesLayout {
  const { mode, view, projection, target, background } = input;
  const scale = f32(input.scale ?? 1), width = f32(input.width), height = f32(input.height), distance = f32(input.distance);
  if (mode !== 'grid' && mode !== 'axes' && mode !== 'both' || !finiteFloat(input.width) || !finiteFloat(input.height) ||
      !(width > 0) || !(height > 0) || !finiteFloat(scale) || !(scale > 0) || !Number.isFinite(f32(scale * 2.5)) ||
      !finiteFloat(input.distance) || !(distance > 0) ||
      !validVector(view, 16) || !validVector(projection, 16) || !validVector(target, 3) ||
      background !== 'black' && background !== 'gray' && background !== 'white') return empty();
  const desired = distance * .08;
  const unit = 10 ** Math.floor(Math.log10(desired)), ratio = desired / unit;
  const step = unit * (ratio >= 5 ? 5 : ratio >= 2 ? 2 : 1);
  const centerX = Math.floor(f32(target[0]) / step), centerZ = Math.floor(f32(target[2]) / step);
  const length = f32(step * 5);
  if (!(step > 0) || !Number.isFinite(step) || !Number.isFinite(centerX) || !Number.isFinite(centerZ) || !Number.isFinite(length)) return empty();
  const vp = multiply(projection, view), lines: GuideLine[] = [], labels: GuideLabel[] = [];
  const neutral = (background === 'black' ? [.9, .9, .9] : [.1, .1, .1]) as readonly [number, number, number];
  let origin: GuideOrigin | null = null;
  const addLine = (worldFrom: GuideWorldPoint, worldTo: GuideWorldPoint, ink: GuideColor, strokeWidth: number,
    metadata: Pick<GuideLine, 'kind' | 'axis' | 'direction' | 'cell' | 'major'>) => {
    const projected = clippedLine(worldFrom, worldTo, vp, width, height);
    if (projected) lines.push({ ...projected, worldFrom, worldTo, color: ink, width: strokeWidth, ...metadata });
  };
  if (mode === 'grid' || mode === 'both') {
    const lowX = f32((centerX - 20) * step), highX = f32((centerX + 20) * step);
    const lowZ = f32((centerZ - 20) * step), highZ = f32((centerZ + 20) * step);
    for (let i = -20; i <= 20; i++) {
      const x = centerX + i, z = centerZ + i;
      const fade = f32(1 - f32(f32(f32(.7) * Math.abs(f32(i))) / 20));
      const gridInk = (cell: number) => color(neutral, f32(f32(Math.abs(cell) % 5 === 0 ? .22 : .11) * fade));
      addLine([f32(x * step), 0, lowZ], [f32(x * step), 0, highZ], gridInk(x), scale,
        { kind: 'grid', cell: x, major: Math.abs(x) % 5 === 0 });
      addLine([lowX, 0, f32(z * step)], [highX, 0, f32(z * step)], gridInk(z), scale,
        { kind: 'grid', cell: z, major: Math.abs(z) % 5 === 0 });
    }
  }
  if (mode === 'axes' || mode === 'both') {
    for (let axis = 0; axis < 3; axis++) {
      const tip: [number, number, number] = [0, 0, 0];tip[axis] = length;
      const negative: [number, number, number] = [0, 0, 0];negative[axis] = f32(-length * 4);
      addLine(negative, [0, 0, 0], color(axisInk[axis], .24), scale,
        { kind: 'axis', axis: axisNames[axis], direction: 'negative' });
      addLine([0, 0, 0], tip, color(axisInk[axis], .8), f32(1.5 * scale),
        { kind: 'axis', axis: axisNames[axis], direction: 'positive' });
      const projected = project(tip, vp, width, height);
      if (projected && projected.x >= 0 && projected.x < width - 16 * scale && projected.y >= 0 && projected.y < height - 16 * scale) {
        const x = f32(projected.x + 4 * scale), y = f32(projected.y + 2 * scale);
        labels.push({ text: axisNames[axis], x, y, shadowX: f32(x + scale), shadowY: f32(y + scale), color: color(axisInk[axis]) });
      }
    }
    const projected = project([0, 0, 0], vp, width, height);
    if (projected && projected.x >= 0 && projected.x < width && projected.y >= 0 && projected.y < height)
      origin = { ...projected, radius: f32(2.5 * scale), color: color(neutral, .8) };
  }
  return { step, lines, labels, origin };
}
