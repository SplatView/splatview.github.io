import { createElement, createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { filterDefaults, type SelectionFilterKind } from '../src/document/filterProtocol';
import { FilterControls } from '../src/ui/FilterControls';
import { filterDisplaySegments } from '../src/ui/FilterOverlay';
import { FILTER_CHOICES, SelectionMenus } from '../src/ui/SelectionMenus';
import { SelectionActions, SelectionControlsPopup } from '../src/ui/App';

function controls(kind: SelectionFilterKind, patch: Partial<Parameters<typeof FilterControls>[0]> = {}) {
  return renderToStaticMarkup(createElement(FilterControls, { kind, parameters: filterDefaults(), enabled: true,
    previewPending: false, dirty: true, showVolume: true, centerPicking: false, gizmoMode: null, gizmoEnabled: true,
    localAxes: false, snap: false, onParameters() {}, onReset() {}, onPreview() {},
    onCurrentView() {}, onPickCenter() {}, onVolume() {}, onGizmo() {}, onLocalAxes() {}, onSnap() {}, ...patch }));
}
function button(markup: string, name: string) {
  const match = Array.from(markup.matchAll(/<button\b[^>]*>/g)).find(([tag]) => tag.includes(`aria-label="${name}"`));
  expect(match, `button ${name}`).toBeDefined(); return match![0];
}
function extent(kind: SelectionFilterKind, parameters = filterDefaults()) {
  const points = filterDisplaySegments(kind, parameters).flat();
  return [0, 1, 2].map(axis => [Math.min(...points.map(point => point[axis])), Math.max(...points.map(point => point[axis]))]);
}

describe('captured six filter control sets', () => {
  it('retains exactly six ordered choices with Off only as the inactive selector value', () => {
    expect(FILTER_CHOICES.map(choice => [choice.value, choice.label, choice.icon])).toEqual([
      ['sphere', 'Sphere', 'Sphere'], ['box', 'Box', 'Box'], ['ellipsoid', 'Ellipsoid', 'Ellipsoid'],
      ['frustum', 'Frustum', 'Frustum'], ['opacity', 'Opacity filter', 'Opacity'], ['scale', 'Scale filter', 'ScaleFilter'],
    ]);
    const markup = renderToStaticMarkup(createElement(SelectionMenus, { tool: null, filter: null, enabled: true, onTool() {}, onFilter() {} }));
    expect(markup).toContain('aria-label="Selection tool"'); expect(markup).toContain('aria-label="Selection filter"');
    expect(markup).toContain('Navigate'); expect(markup).toContain('Off'); expect(markup).not.toContain('role="menuitem');
  });
  it('presents the committed Basic full-width Tool selector without a Filter or direct tool strip', () => {
    const markup = renderToStaticMarkup(createElement(SelectionMenus, { mode: 'basic', tool: 'brush', filter: null,
      enabled: true, onTool() {}, onFilter() {} }));
    expect(markup).toContain('selection-menus-basic');
    expect(Array.from(markup.matchAll(/<button\b/g))).toHaveLength(1);
    const trigger = button(markup, 'Selection tool');
    expect(trigger).toContain('class="color-selector active"');
    expect(trigger).toContain('aria-haspopup="menu"'); expect(trigger).toContain('aria-expanded="false"');
    expect(markup).toContain('>Tool</span>'); expect(markup).toContain('>Brush</span>');
    expect(markup).not.toContain('aria-label="Selection filter"'); expect(markup).not.toContain('role="menuitem');
    for (const name of ['Navigate', 'Single splat', 'Brush', 'Volume brush', 'Box select', 'Polygon', 'Color picker', 'Fill'])
      expect(markup).not.toContain(`aria-label="${name}"`);
  });
  it.each(['basic', 'pro'] as const)('%s anchors all five native tutorial targets on the real Tool trigger', mode => {
    const markup = renderToStaticMarkup(createElement(SelectionMenus, { mode, tool: null, filter: null,
      enabled: false, onTool() {}, onFilter() {} }));
    const trigger = button(markup, 'Selection tool');
    expect(trigger).toContain('data-tutorial-target="single brushes area color-select fill"');
    expect(trigger).toContain('disabled=""');
    expect(markup).not.toContain('role="menuitem');
    if (mode === 'pro') {
      expect(Array.from(markup.matchAll(/<button\b/g))).toHaveLength(2);
      expect(button(markup, 'Selection filter')).toContain('disabled=""');
    }
  });
  it.each([
    ['sphere', ['Center / position X', 'Center / position Y', 'Center / position Z', 'Radius']],
    ['box', ['Center / position X', 'Box size XYZ X', 'Box size XYZ Y', 'Box size XYZ Z', 'Rotation vector (degrees) X']],
    ['ellipsoid', ['Center / position X', 'Ellipsoid radii X', 'Ellipsoid radii Y', 'Ellipsoid radii Z', 'Rotation vector (degrees) X']],
    ['frustum', ['Center / position X', 'Rotation vector (degrees) X', 'Vertical field of view', 'Aspect ratio', 'Near plane', 'Far plane']],
    ['opacity', ['Minimum opacity', 'Maximum opacity']], ['scale', ['Minimum splat scale', 'Maximum scale']],
  ] as const)('%s exposes its captured labels', (kind, labels) => {
    const markup = controls(kind);
    for (const label of labels) expect(markup).toContain(`aria-label="${label}"`);
    expect(markup).toContain('aria-label="Reset filter"'); expect(markup).toContain('>Preview</button>');
  });
  it('keeps scalar/vector display precision and actual frustum/range defaults', () => {
    expect(controls('sphere')).toMatch(/aria-label="Radius"[^>]*value="1\.000"/);
    expect(controls('box')).toMatch(/aria-label="Box size XYZ X"[^>]*value="1\.00"/);
    const frustum = controls('frustum');
    expect(frustum).toMatch(/aria-label="Near plane"[^>]*value="0\.100"/);
    expect(frustum).toMatch(/aria-label="Far plane"[^>]*value="100\.000"/);
    expect(frustum).toMatch(/aria-label="Vertical field of view"[^>]*min="1"[^>]*max="179"[^>]*value="60"/);
    expect(controls('opacity')).toMatch(/aria-label="Maximum opacity"[^>]*min="0"[^>]*max="1"[^>]*value="1"/);
    expect(controls('scale')).toMatch(/aria-label="Maximum scale"[^>]*value="100\.000"/);
  });
  it('offers center/volume only for spatial kinds and current view only for Frustum', () => {
    for (const kind of ['sphere', 'box', 'ellipsoid', 'frustum'] as const) expect(controls(kind)).toContain('aria-label="Pick filter center"');
    for (const kind of ['opacity', 'scale'] as const) expect(controls(kind)).not.toContain('aria-label="Show selection volume"');
    expect(controls('frustum')).toContain('>Use current view</button>'); expect(controls('sphere')).not.toContain('Use current view');
    expect(controls('scale')).not.toContain('Use recommended max scale');
    expect(controls('scale', { recommendedMaxScale: .25 })).toContain('>Use recommended max scale</button>');
  });
  it('keeps Preview unavailable for unchanged or already running work', () => {
    for (const patch of [{ dirty: false }, { previewPending: true }, { enabled: false }, { previewEnabled: false }]) {
      expect(controls('sphere', patch)).toMatch(/<button[^>]*class="action-button filter-preview"[^>]*disabled=""/);
    }
  });
  it.each(['sphere', 'box', 'ellipsoid', 'frustum'] as const)('%s exposes joined captured gizmo/preferences groups', kind => {
    const markup = controls(kind);
    expect(markup).toContain('role="group" aria-label="Filter gizmo"');
    expect(markup).toContain('role="group" aria-label="Filter axes and snapping"');
    for (const label of ['Move', 'Rotate', 'Local axes', 'Snap']) expect(button(markup, label)).not.toContain('disabled');
    expect(button(markup, 'Scale').includes('disabled')).toBe(kind === 'frustum');
    expect(markup).toContain('Hold Ctrl to snap temporarily');
  });
  it('omits widgets for range filters and preserves preference/mode pressed states', () => {
    for (const kind of ['opacity', 'scale'] as const) {
      const markup = controls(kind); expect(markup).not.toContain('aria-label="Filter gizmo"');
      expect(markup).not.toContain('aria-label="Local axes"'); expect(markup).not.toContain('aria-label="Snap"');
    }
    const markup = controls('box', { gizmoMode: 'rotate', localAxes: true, snap: true });
    expect(button(markup, 'Rotate')).toContain('aria-pressed="true"');
    expect(button(markup, 'Move')).toContain('aria-pressed="false"');
    expect(button(markup, 'Local axes')).toContain('aria-pressed="true"'); expect(button(markup, 'Snap')).toContain('aria-pressed="true"');
    for (const label of ['Move', 'Rotate', 'Scale', 'Local axes', 'Snap']) expect(button(controls('box', { gizmoEnabled: false }), label)).toContain('disabled');
  });
});

describe('independent display geometry checks', () => {
  it('draws twelve rotated box edges with independent axis extents', () => {
    const parameters = { ...filterDefaults(), center: [10, 20, 30] as [number, number, number], size: [2, 4, 6] as [number, number, number], rotation: [0, 0, 90] as [number, number, number] };
    expect(filterDisplaySegments('box', parameters)).toHaveLength(12);
    extent('box', parameters).forEach((pair, axis) => {
      expect(pair[0]).toBeCloseTo([8, 19, 27][axis], 10); expect(pair[1]).toBeCloseTo([12, 21, 33][axis], 10);
    });
  });
  it('draws the near/far rectangles of a ninety-degree frustum without using the scene', () => {
    const parameters = { ...filterDefaults(), fov: 90, aspect: 2, near: 1, far: 3 };
    const segments = filterDisplaySegments('frustum', parameters); expect(segments).toHaveLength(12);
    const points = segments.flat();
    for (const point of points) {
      expect([1, 3]).toContain(-point[2]); expect(Math.abs(point[0])).toBeCloseTo(-2 * point[2], 10); expect(Math.abs(point[1])).toBeCloseTo(-point[2], 10);
    }
  });
  it('draws three sixty-four-segment rings at the supplied sphere/ellipsoid radii', () => {
    const parameters = { ...filterDefaults(), radius: 2, size: [2, 3, 4] as [number, number, number] };
    expect(filterDisplaySegments('sphere', parameters)).toHaveLength(192); expect(extent('sphere', parameters)).toEqual([[-2, 2], [-2, 2], [-2, 2]]);
    expect(filterDisplaySegments('ellipsoid', parameters)).toHaveLength(192); expect(extent('ellipsoid', parameters)).toEqual([[-2, 2], [-3, 3], [-4, 4]]);
    expect(filterDisplaySegments('opacity', parameters)).toEqual([]); expect(filterDisplaySegments('scale', parameters)).toEqual([]);
  });
  it('ignores inactive lens fields for Box and never changes the supplied definition', () => {
    const parameters = { ...filterDefaults(), fov: NaN, aspect: Infinity, near: NaN, far: Infinity };
    expect(filterDisplaySegments('box', parameters)).toHaveLength(12); expect(parameters.fov).toBeNaN();
    expect(parameters.size).toEqual([1, 1, 1]); expect(parameters.center).toEqual([0, 0, 0]);
  });
});

describe('filter Help and ordinary action availability', () => {
  it('limits filter Help to the five captured rows and uses Apple primary labels', () => {
    const markup = renderToStaticMarkup(createElement(SelectionControlsPopup, { tool: 'brush', filter: true, apple: true, returnFocus: createRef<HTMLButtonElement>(), onClose() {} }));
    expect(markup).toContain('<td>Combine</td>'); expect(markup).toContain('Cmd+Z / Cmd+Y'); expect(markup).toContain('<td>Cancel</td>');
    for (const label of ['Union', 'Subtract', 'Intersect', 'All / clear', 'Invert', 'Brush size', 'Close polygon']) expect(markup).not.toContain(`<td>${label}</td>`);
    expect((markup.match(/<tbody>.*?<\/tbody>/)?.[0].match(/<tr>/g) ?? [])).toHaveLength(5);
  });
  it('disables ordinary actions while preserving read-only Help during a filter', () => {
    const markup = renderToStaticMarkup(createElement(SelectionActions, { enabled: false, selected: 3, hasDeleted: true, filter: true, helpEnabled: true, onCommand() {} }));
    for (const label of ['Select all', 'Clear selection', 'Invert selection', 'Delete selected', 'Keep selected', 'Restore deleted']) expect(button(markup, label)).toContain('disabled=""');
    expect(button(markup, 'Selection controls')).not.toContain('disabled=');
  });
  it('keeps Restore mounted outside the ordinary actions and hides it when there are no deleted records', () => {
    for (const hasDeleted of [false, true]) {
      const markup = renderToStaticMarkup(createElement(SelectionActions, { enabled: true, selected: 0, hasDeleted, onCommand() {} }));
      expect(button(markup, 'Restore deleted')).not.toContain('disabled=');
      expect(markup).toContain(`<div class="selection-action-restore"${hasDeleted ? '' : ' hidden=""'}>`);
    }
  });
});
