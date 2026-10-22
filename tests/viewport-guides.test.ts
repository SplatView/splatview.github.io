import { describe, expect, it } from 'vitest';
import { layoutViewportGuides, nextViewportGuides, viewportGuidesTooltip,
  type GuideLine, type ViewportGuides, type ViewportGuidesInput } from '../src/input/viewportGuides';

const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
// Independent orthographic cameras: the ground camera looks directly down world Y;
// the oblique camera separates all three positive unit-axis tips on screen.
const groundProjection = () => new Float32Array([.01, 0, 0, 0, 0, 0, 0, 0, 0, .01, 0, 0, 0, 0, .5, 1]);
const obliqueProjection = () => new Float32Array([.2, 0, 0, 0, 0, .2, 0, 0, .1, .1, 0, 0, 0, 0, .5, 1]);
function input(patch: Partial<ViewportGuidesInput> = {}): ViewportGuidesInput {
  return { mode: 'both', view: identity(), projection: obliqueProjection(), target: [0, 0, 0], distance: 5,
    width: 200, height: 100, background: 'black', ...patch };
}
function xPositive(patch: Partial<ViewportGuidesInput>): GuideLine {
  const line = layoutViewportGuides(input({ mode: 'axes', width: 100, height: 100, ...patch }))
    .lines.find(line => line.axis === 'X' && line.direction === 'positive');
  expect(line).toBeDefined();return line!;
}
function point(actual: { x: number; y: number }, x: number, y: number) {
  expect(actual.x).toBeCloseTo(x, 4);expect(actual.y).toBeCloseTo(y, 4);
}
function world(actual: readonly number[], expected: readonly number[]) {
  expect(actual).toHaveLength(3);
  actual.forEach((value, i) => expect(value).toBeCloseTo(expected[i], 6));
}

describe('captured desktop viewport guides as pure bounded layout', () => {
  it('cycles through the four native modes and preserves their exact help text', () => {
    let mode: ViewportGuides = 'none';
    const sequence: ViewportGuides[] = [];
    for (let i = 0; i < 5; i++) { sequence.push(mode);mode = nextViewportGuides(mode); }
    expect(sequence).toEqual(['none', 'grid', 'axes', 'both', 'none']);
    expect(['none', 'grid', 'axes', 'both'].map(mode => viewportGuidesTooltip(mode as ViewportGuides))).toEqual([
      'Guides: none. Click for grid.', 'Guides: horizontal grid. Click for XYZ axes.',
      'Guides: XYZ axes. Click for both.', 'Guides: grid and axes. Click to hide.',
    ]);
    expect(nextViewportGuides('invalid' as ViewportGuides)).toBe('none');
  });

  it.each([[1, .05], [2.5, .2], [5, .2], [6.2499995, .2], [6.25, .5], [12.5, 1], [25, 2], [62.5, 5], [125, 10]])(
    'quantizes distance %s into the 1/2/5 spacing %s', (distance, step) => {
      expect(layoutViewportGuides(input({ distance })).step).toBeCloseTo(step, 12);
    });

  it('draws the entire 41 by 41 grid patch on the world XZ plane, including origin lines', () => {
    const layout = layoutViewportGuides(input({ mode: 'grid', projection: groundProjection() }));
    expect(layout.lines).toHaveLength(82);expect(layout.labels).toEqual([]);expect(layout.origin).toBeNull();
    expect(layout.lines.every(line => line.kind === 'grid' && line.width === 1 && line.worldFrom[1] === 0 && line.worldTo[1] === 0)).toBe(true);
    world(layout.lines[0].worldFrom, [-4, 0, -4]);world(layout.lines[0].worldTo, [-4, 0, 4]);
    world(layout.lines[81].worldFrom, [-4, 0, 4]);world(layout.lines[81].worldTo, [4, 0, 4]);
    expect(layout.lines.filter(line => line.cell === 0)).toHaveLength(2);
    expect(layout.lines[40].color).toEqual({ r: 230, g: 230, b: 230, a: 56 });
    expect(layout.lines[0].color.a).toBe(17);expect(layout.lines[42].color.a).toBe(27);
    expect(layout.lines[50]).toMatchObject({ cell: 5, major: true, color: { a: 46 } });
    expect(layout.lines.filter(line => line.major)).toHaveLength(18);
  });

  it('floors target X/Z cells and keeps the patch centered on those cells without using target Y', () => {
    const layout = layoutViewportGuides(input({ mode: 'grid', projection: groundProjection(), target: [.31, 99, -.01] }));
    expect(layout.lines).toHaveLength(82);
    expect(layout.lines[40]).toMatchObject({ cell: 1, major: false });
    expect(layout.lines[41]).toMatchObject({ cell: -1, major: false });
    world(layout.lines[40].worldFrom, [.2, 0, -4.2]);world(layout.lines[40].worldTo, [.2, 0, 3.8]);
    world(layout.lines[41].worldFrom, [-3.8, 0, -.2]);world(layout.lines[41].worldTo, [4.2, 0, -.2]);
    const negative = layoutViewportGuides(input({ mode: 'grid', projection: groundProjection(), target: [-.01, -99, -.21] }));
    expect(negative.lines[40].cell).toBe(-1);expect(negative.lines[41].cell).toBe(-2);
    world(negative.lines[40].worldFrom, [-.2, 0, -4.4]);
    expect(layoutViewportGuides(input({ mode: 'grid', projection: groundProjection(), target: [.31, -999, -.01] }))).toEqual(layout);
    // World coordinates are the float32 positions sent by the native renderer.
    expect(layout.lines[40].worldFrom[0]).toBe(.20000000298023224);
    expect(layout.lines[40].worldFrom[2]).toBe(-4.199999809265137);
  });

  it.each(['black', 'gray', 'white'] as const)('selects scene contrast independently on a %s background', background => {
    const layout = layoutViewportGuides(input({ mode: 'grid', projection: groundProjection(), background }));
    const shade = background === 'black' ? 230 : 26;
    expect(layout.lines[40].color).toEqual({ r: shade, g: shade, b: shade, a: 56 });
  });

  it('uses three RGB axes with four-times-long negative rays, native opacity and exact label offsets', () => {
    const layout = layoutViewportGuides(input({ mode: 'axes' }));
    expect(layout.lines).toHaveLength(6);
    const colors = [{ r: 236, g: 100, b: 100 }, { r: 125, g: 210, b: 146 }, { r: 105, g: 165, b: 245 }];
    const negatives = [[-4, 0, 0], [0, -4, 0], [0, 0, -4]], tips = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    ['X', 'Y', 'Z'].forEach((axis, i) => {
      const negative = layout.lines[i * 2], positive = layout.lines[i * 2 + 1];
      expect(negative).toMatchObject({ kind: 'axis', axis, direction: 'negative', width: 1, color: { ...colors[i], a: 61 } });
      expect(positive).toMatchObject({ kind: 'axis', axis, direction: 'positive', width: 1.5, color: { ...colors[i], a: 204 } });
      world(negative.worldFrom, negatives[i]);world(negative.worldTo, [0, 0, 0]);
      world(positive.worldFrom, [0, 0, 0]);world(positive.worldTo, tips[i]);
      expect(layout.labels[i]).toMatchObject({ text: axis, color: { ...colors[i], a: 255 } });
    });
    point(layout.lines[1].to, 120, 50);point(layout.lines[3].to, 100, 40);point(layout.lines[5].to, 110, 45);
    point(layout.labels[0], 124, 52);point(layout.labels[1], 104, 42);point(layout.labels[2], 114, 47);
    expect(layout.labels[0].shadowX).toBeCloseTo(125, 4);expect(layout.labels[0].shadowY).toBe(53);
    expect(layout.origin).toEqual({ x: 100, y: 50, radius: 2.5, color: { r: 230, g: 230, b: 230, a: 204 } });
  });

  it('draws grid lines under the axes and keeps the per-frame work bounded at 88 segments', () => {
    const layout = layoutViewportGuides(input());
    expect(layout.lines).toHaveLength(88);
    expect(layout.lines.slice(0, 82).every(line => line.kind === 'grid')).toBe(true);
    expect(layout.lines.slice(82).every(line => line.kind === 'axis')).toBe(true);
    expect(layout.labels).toHaveLength(3);
  });

  it('applies optional DPI geometry scale while leaving world positions and projection unchanged', () => {
    const normal = layoutViewportGuides(input({ mode: 'axes' }));
    const scaled = layoutViewportGuides(input({ mode: 'axes', scale: 2, background: 'white' }));
    expect(scaled.lines.map(line => [line.from, line.to, line.worldFrom, line.worldTo])).toEqual(normal.lines.map(line => [line.from, line.to, line.worldFrom, line.worldTo]));
    expect(scaled.lines.map(line => line.width)).toEqual([2, 3, 2, 3, 2, 3]);
    point(scaled.labels[0], 128, 54);
    expect(scaled.labels[0].shadowX).toBeCloseTo(130, 4);expect(scaled.labels[0].shadowY).toBe(56);
    expect(scaled.origin).toMatchObject({ radius: 5, color: { r: 26, g: 26, b: 26, a: 204 } });
  });

  it('composes column-major projection times view in the same order as the scene shader', () => {
    const view = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1]);
    const projection = new Float32Array([.1, 0, 0, 0, 0, .25, 0, 0, .2, 0, 0, 0, -.5, -.5, .5, 1]);
    const layout = layoutViewportGuides(input({ mode: 'axes', view, projection }));
    point(layout.origin!, 120, 50);
    point(layout.lines.find(line => line.axis === 'X' && line.direction === 'positive')!.to, 130, 50);
    point(layout.lines.find(line => line.axis === 'Y' && line.direction === 'positive')!.to, 120, 37.5);
    point(layout.lines.find(line => line.axis === 'Z' && line.direction === 'positive')!.to, 140, 50);
  });

  it.each([
    { projection: [4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, -2, 0, .5, 1], from: [0, 50], to: [100, 50] },
    { projection: [0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, -2, .5, 1], from: [50, 100], to: [50, 0] },
    { projection: [1, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, -1, 1], from: [75, 50], to: [100, 50] },
    { projection: [1, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], from: [50, 50], to: [75, 50] },
  ])('clips a crossing against the native six-plane frustum: $from → $to', ({ projection, from, to }) => {
    const line = xPositive({ projection });
    point(line.from, from[0], from[1]);point(line.to, to[0], to[1]);
    world(line.worldFrom, [0, 0, 0]);world(line.worldTo, [1, 0, 0]);
  });

  it.each([[-1.001, 0, .5, 1], [1.001, 0, .5, 1], [0, -1.001, .5, 1], [0, 1.001, .5, 1], [0, 0, -.00001, 1], [0, 0, 1.00001, 1], [0, 0, 0, -1]])(
    'rejects a segment wholly outside clip position (%s,%s,%s,%s)', (x, y, z, w) => {
      const projection = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, x, y, z, w];
      const layout = layoutViewportGuides(input({ projection }));
      expect(layout.lines).toEqual([]);expect(layout.labels).toEqual([]);expect(layout.origin).toBeNull();
    });

  it('clips a behind-eye crossing before perspective division', () => {
    const projection = [.5, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, -.25, -.25];
    const layout = layoutViewportGuides(input({ mode: 'axes', projection, width: 100, height: 100 }));
    expect(layout.lines).toHaveLength(1);expect(layout.origin).toBeNull();
    point(layout.lines[0].from, 100, 50);point(layout.lines[0].to, 83.333333, 50);
  });

  it('accepts positive w below .001 and does not add padding to the D3D near plane', () => {
    const projection = [.000005, 0, 0, 0, 0, .000005, 0, 0, 0, 0, 0, 0, 0, 0, .00000001, .00001];
    const layout = layoutViewportGuides(input({ mode: 'axes', projection, width: 100, height: 100 }));
    point(xPositive({ projection }).to, 75, 50);
    expect(layout.origin).toMatchObject({ x: 50, y: 50 });expect(layout.labels.map(label => label.text)).toEqual(['X', 'Y', 'Z']);
  });

  it('keeps the native 1e-8 line divide floor separate from point label projection', () => {
    const projection = [.0000000025, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, .0000000025, .000000005];
    const layout = layoutViewportGuides(input({ mode: 'axes', projection, width: 100, height: 100 }));
    point(xPositive({ projection }).to, 62.5, 50);
    point(layout.labels.find(label => label.text === 'X')!, 79, 52);
  });

  it('reserves strict 16-pixel label bounds and uses strict viewport bounds for the origin', () => {
    // The X tip is exactly 84: a 100px viewport excludes labels at width - 16.
    const edge = [.5, 0, 0, 0, 0, .5, 0, 0, 0, 0, 0, 0, .18, 0, .5, 1];
    let layout = layoutViewportGuides(input({ mode: 'axes', projection: edge, width: 100, height: 100 }));
    expect(layout.labels.some(label => label.text === 'X')).toBe(false);
    const inside = [...edge];inside[12] = .16;
    layout = layoutViewportGuides(input({ mode: 'axes', projection: inside, width: 100, height: 100 }));
    expect(layout.labels.some(label => label.text === 'X')).toBe(true);
    const rightEdge = [...edge];rightEdge[12] = 1;
    expect(layoutViewportGuides(input({ mode: 'axes', projection: rightEdge })).origin).toBeNull();
    const leftEdge = [...edge];leftEdge[12] = -1;
    point(layoutViewportGuides(input({ mode: 'axes', projection: leftEdge })).origin!, 0, 50);
  });

  it('clips every output segment to finite viewport coordinates even for a tiny viewport', () => {
    const layout = layoutViewportGuides(input({ width: .25, height: .5 }));
    expect(layout.lines.length).toBeLessThanOrEqual(88);expect(layout.labels).toEqual([]);
    for (const line of layout.lines) for (const p of [line.from, line.to]) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
      expect(p.x).toBeGreaterThanOrEqual(0);expect(p.x).toBeLessThanOrEqual(.25);
      expect(p.y).toBeGreaterThanOrEqual(0);expect(p.y).toBeLessThanOrEqual(.5);
    }
  });

  it.each([
    { mode: 'none' }, { mode: 'invalid' }, { width: 0 }, { width: NaN }, { width: Infinity }, { width: 1e100 },
    { height: -1 }, { height: Infinity }, { scale: 0 }, { scale: -1 }, { scale: NaN }, { scale: Infinity }, { scale: 3e38 },
    { distance: 0 }, { distance: -1 }, { distance: NaN }, { distance: Infinity }, { distance: 1e100 },
    { target: [0, NaN, 0] }, { target: [Infinity, 0, 0] }, { target: [0, 0] },
    { view: [1] }, { projection: new Array(16).fill(Infinity) }, { view: new Array(16).fill(1e100) }, { background: 'invalid' },
  ] as Partial<ViewportGuidesInput>[])('case %#: returns no drawing data for invalid input %j', patch => {
    expect(layoutViewportGuides(input(patch))).toEqual({ step: 0, lines: [], labels: [], origin: null });
  });

  it('does not mutate camera state or retain live camera arrays in its output', () => {
    const source = input(), before = structuredClone(source), layout = layoutViewportGuides(source), saved = structuredClone(layout);
    expect(source).toEqual(before);
    (source.view as Float32Array)[12] = 100;(source.target as number[])[0] = -100;
    expect(layout).toEqual(saved);
    expect(layoutViewportGuides(source)).not.toEqual(layout);
  });
});
