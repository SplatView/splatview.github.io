import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { FilterGizmoFrame } from '../src/document/filterGizmo';
import { filterDefaults } from '../src/document/filterProtocol';
import { FilterGizmoDrawing, filterGizmoConfig } from '../src/ui/FilterGizmo';

// Literal native wire shapes test presentation only; geometric/camera oracles
// belong to the actual portable C++ contract and actual-App browser checks.
const frame: FilterGizmoFrame = { hitHandle: 2, center: [20, 30], primitives: [
  { handle: 1, role: 0, type: 0, points: [10, 20, 30, 40, 0, 0, 0, 0], weight: 2.5 },
  { handle: 2, role: 1, type: 1, points: [50, 60, 7, 0, 0, 0, 0, 0], weight: 1 },
  { handle: 15, role: 3, type: 2, points: [80, 90, 4, 0, 0, 0, 0, 0], weight: 1.5 },
  { handle: 4, role: 0, type: 3, points: [1, 2, 3, 4, 5, 6, 7, 8], weight: 1 },
  { handle: 0, role: 4, type: 0, points: [0, 0, 1, 1, 0, 0, 0, 0], weight: 1.2 },
] };

describe('native filter gizmo frame presentation', () => {
  it('interprets native endpoints, center/radius, center/half-size and four quad vertices', () => {
    const markup = renderToStaticMarkup(createElement(FilterGizmoDrawing, { frame }));
    expect(markup).toMatch(/<line[^>]*stroke-width="2.5"[^>]*x1="10"[^>]*y1="20"[^>]*x2="30"[^>]*y2="40"/);
    expect(markup).toMatch(/<circle[^>]*cx="50"[^>]*cy="60"[^>]*r="7"/);
    expect(markup).toMatch(/<rect[^>]*x="76"[^>]*y="86"[^>]*width="8"[^>]*height="8"/);
    expect(markup).toContain('points="1,2 3,4 5,6 7,8"');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).not.toContain('data-gizmo-handle="0"');
  });
  it('uses the captured handle over hover while preserving volume/axis presentation roles', () => {
    const markup = renderToStaticMarkup(createElement(FilterGizmoDrawing, { frame, capturedHandle: 15 }));
    expect(markup).toMatch(/class="filter-gizmo-role-3[^\"]*filter-gizmo-highlight"[^>]*data-gizmo-handle="15"/);
    expect(markup).not.toMatch(/class="filter-gizmo-role-1[^\"]*filter-gizmo-highlight/);
    expect(markup).toContain('filter-gizmo-plane'); expect(markup).toContain('filter-gizmo-role-4');
    expect(markup).toContain('data-gizmo-captured="15"');
  });
  it('marks temporarily unavailable widgets without inventing geometry or hit results', () => {
    const markup = renderToStaticMarkup(createElement(FilterGizmoDrawing, { frame, enabled: false }));
    expect(markup).toContain('filter-gizmo-disabled'); expect(markup).toContain('data-gizmo-hit="2"');
  });
  it('forwards the full definition and CSS viewport to the native value API', () => {
    const parameters = filterDefaults(), pointer = [123, 456] as const;
    const config = filterGizmoConfig('box', 'rotate', parameters, 1280, 720, 1.1, true, false, true, pointer);
    expect(config).toEqual({ kind: 'box', mode: 'rotate', parameters, viewport: { x: 0, y: 0, width: 1280, height: 720 },
      panelScale: 1.1, local: true, snap: false, showVolume: true, pointer });
    expect(config.parameters).toBe(parameters); expect(config.pointer).toBe(pointer);
  });
});
