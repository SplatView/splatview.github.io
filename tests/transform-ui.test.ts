import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { transformDefaults, type TransformMode, type TransformParameters } from '../src/document/transformProtocol';
import { TransformControls } from '../src/ui/TransformControls';
import { TRANSFORM_MODES, TransformModeMenu } from '../src/ui/TransformModeMenu';
import { GizmoDrawing } from '../src/ui/GizmoDrawing';
import { transformGizmoConfig } from '../src/ui/TransformGizmo';

function controls(mode: TransformMode, patch: Partial<Parameters<typeof TransformControls>[0]> = {}) {
  return renderToStaticMarkup(createElement(TransformControls, { parameters: { ...transformDefaults(), mode }, enabled: true,
    applyEnabled: true, cancelEnabled: true, pending: false, dirty: false, gizmoMode: null, gizmoEnabled: true,
    localAxes: false, snap: false, pivotMode: 'scene', pivotChosen: false, pivotPending: false, hasSelected: false,
    onParameters() {}, onFlip() {}, onCyclePivot() {}, onApply() {}, onCancel() {},
    onGizmo() {}, onLocalAxes() {}, onSnap() {}, ...patch }));
}
function button(markup: string, label: string) {
  const match = Array.from(markup.matchAll(/<button\b[^>]*>/g)).find(([tag]) => tag.includes(`aria-label="${label}"`));
  expect(match, label).toBeDefined(); return match![0];
}

describe('captured Pro transform representation controls', () => {
  it('retains the four ordered native mode names and a display-only closed selector', () => {
    expect(TRANSFORM_MODES.map(choice => [choice.value, choice.label])).toEqual([
      ['euler', 'Euler XYZ (degrees)'], ['quaternion', 'Quaternion (wxyz)'], ['axis-angle', 'Axis + angle'], ['matrix', 'Affine 4x4 matrix'],
    ]);
    const markup = renderToStaticMarkup(createElement(TransformModeMenu, { mode: 'quaternion', enabled: true, onMode() {} }));
    expect(markup).toContain('aria-label="Transform mode"'); expect(markup).toContain('Quaternion (wxyz)');
    expect(markup).toContain('aria-expanded="false"'); expect(markup).not.toContain('role="menuitem');
  });
  it.each([
    ['euler', ['Translation X', 'Scale XYZ Y', 'Pivot Z', 'Rotation XYZ X']],
    ['quaternion', ['Translation X', 'Scale XYZ Y', 'Pivot Z', 'Quaternion w', 'Quaternion z']],
    ['axis-angle', ['Translation X', 'Scale XYZ Y', 'Pivot Z', 'Axis X', 'Angle in degrees']],
    ['matrix', ['Affine matrix row 1 column 4', 'Affine matrix row 4 column 1']],
  ] as const)('%s exposes its captured active fields', (mode, labels) => {
    const markup = controls(mode); for (const label of labels) expect(markup).toContain(`aria-label="${label}"`);
  });
  it('retains vector two-decimal and scalar/quaternion three-decimal formatting', () => {
    expect(controls('euler')).toMatch(/aria-label="Translation X"[^>]*value="0\.00"/);
    expect(controls('euler')).toMatch(/aria-label="Scale XYZ X"[^>]*value="1\.00"/);
    expect(controls('quaternion')).toMatch(/aria-label="Quaternion w"[^>]*value="1\.000"/);
    expect(controls('axis-angle')).toMatch(/aria-label="Angle in degrees"[^>]*value="0\.000"/);
  });
  it('displays affine rows in user order and hides pose/pivot entry without hiding flips or gizmos', () => {
    const parameters: TransformParameters = { ...transformDefaults(), mode: 'matrix',
      matrix: [1, 0, 0, 2, 0, 1, 0, 3, 0, 0, 1, 4, 0, 0, 0, 1] };
    const markup = controls('matrix', { parameters });
    expect(markup).toMatch(/aria-label="Affine matrix row 1 column 4"[^>]*value="2\.000"/);
    expect(markup).toMatch(/aria-label="Affine matrix row 2 column 4"[^>]*value="3\.000"/);
    expect(markup).toMatch(/aria-label="Affine matrix row 3 column 4"[^>]*value="4\.000"/);
    expect((markup.match(/aria-label="Affine matrix row/g) ?? [])).toHaveLength(16);
    for (const label of ['Translation X', 'Scale XYZ X', 'Pivot X', 'Cycle pivot', 'Rotation XYZ X']) expect(markup).not.toContain(`aria-label="${label}"`);
    for (const label of ['Move', 'Rotate', 'Scale', 'Flip X', 'Flip Y', 'Flip Z']) expect(button(markup, label)).not.toContain('disabled');
  });
  it('shows exactly the separate native widget, axes/snap and rotational flip groups with selected state', () => {
    const parameters = { ...transformDefaults(), flips: [true, false, true] as [boolean, boolean, boolean] };
    const markup = controls('euler', { parameters, gizmoMode: 'rotate', localAxes: true, snap: true });
    for (const group of ['Transform gizmo', 'Transform axes and snapping', 'Transform flips']) expect(markup).toContain(`role="group" aria-label="${group}"`);
    for (const label of ['Rotate', 'Local axes', 'Snap', 'Flip X', 'Flip Z']) expect(button(markup, label)).toContain('aria-pressed="true"');
    expect(button(markup, 'Flip Y')).toContain('aria-pressed="false"');
    expect(markup).toContain('Hold Ctrl to snap temporarily'); expect(markup).toContain('aria-label="Cycle pivot"');
  });
  it('fences numeric and widget controls independently, with an explicit dirty-preview cancellation path', () => {
    const markup = controls('euler', { enabled: false, applyEnabled: false, gizmoEnabled: false, dirty: true, cancelEnabled: true });
    expect(markup).toMatch(/aria-label="Translation X"[^>]*disabled=""/);
    for (const label of ['Move', 'Rotate', 'Scale', 'Local axes', 'Snap', 'Flip X']) expect(button(markup, label)).toContain('disabled');
    expect(markup).toContain('Cancel transform preview'); expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Apply transform/);
    expect(markup).not.toMatch(/<button[^>]*disabled=""[^>]*>Cancel transform preview/);
  });
  it('keeps idle Apply mounted in a hidden container and exposes neutral restoration when dirty', () => {
    const idle = controls('euler'); expect(idle).toContain('class="transform-apply-actions" hidden=""');
    expect(idle).toContain('Apply transform'); expect(idle).not.toContain('Cancel transform preview');
    const restoration = controls('euler', { dirty: true });
    expect(restoration).not.toContain('class="transform-apply-actions" hidden=""');
    expect(restoration).toContain('Cancel transform preview');
  });
  it('keeps a refused finite numeric value visible without a UI composition or clamp', () => {
    const parameters = { ...transformDefaults(), scale: [0, -2, 1] as [number, number, number] };
    const markup = controls('euler', { parameters });
    expect(markup).toMatch(/aria-label="Scale XYZ X"[^>]*value="0\.00"/);
    expect(markup).toMatch(/aria-label="Scale XYZ Y"[^>]*value="-2\.00"/);
  });
});

describe('native transform gizmo presentation boundary', () => {
  it.each(['euler', 'quaternion', 'axis-angle', 'matrix'] as const)('Basic keeps the seven compact native actions without %s entry fields', mode => {
    const parameters = { ...transformDefaults(), mode, flips: [true, false, true] as [boolean, boolean, boolean] };
    const markup = controls(mode, { mode: 'basic', parameters, gizmoMode: 'rotate', localAxes: true, snap: true });
    const labels = Array.from(markup.matchAll(/<button\b[^>]*aria-label="([^"]+)"/g), match => match[1]);
    expect(labels).toEqual(['Move', 'Rotate', 'Scale', 'Snap', 'Flip X', 'Flip Y', 'Flip Z']);
    for (const label of labels) expect(button(markup, label)).not.toContain('disabled');
    for (const label of ['Rotate', 'Snap', 'Flip X', 'Flip Z']) expect(button(markup, label)).toContain('aria-pressed="true"');
    expect(markup).not.toContain('<input'); expect(markup).not.toContain('data-tutorial-target="transform-values"');
    expect(markup).not.toContain('aria-label="Local axes"'); expect(markup).not.toContain('aria-label="Cycle pivot"');
    expect(markup).toContain('class="transform-apply-actions" hidden=""');
  });
  it('keeps Basic explicit preview completion and independent widget/action fences', () => {
    const markup = controls('euler', { mode: 'basic', enabled: false, applyEnabled: false, gizmoEnabled: false,
      dirty: true, cancelEnabled: true, pending: true });
    for (const label of ['Move', 'Rotate', 'Scale', 'Snap', 'Flip X', 'Flip Y', 'Flip Z'])
      expect(button(markup, label)).toContain('disabled');
    expect(markup).not.toContain('class="transform-apply-actions" hidden=""');
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Apply transform/);
    expect(markup).not.toMatch(/<button[^>]*disabled=""[^>]*>Cancel transform preview/);
    expect(markup).toContain('role="status"'); expect(markup).not.toContain('<input');
  });
  it('forwards the native widget matrix and pivot without transposing/composing the returned geometry', () => {
    const widgetMatrix = transformDefaults().matrix, pivot: [number, number, number] = [2, 3, 4], pointer = [123, 456] as const;
    const config = transformGizmoConfig('rotate', widgetMatrix, pivot, 1280, 720, 1.1, true, false, pointer);
    expect(config).toEqual({ mode: 'rotate', widgetMatrix, pivot, viewport: { x: 0, y: 0, width: 1280, height: 720 }, panelScale: 1.1, local: true, snap: false, pointer });
    expect(config.widgetMatrix).toBe(widgetMatrix); expect(config.pivot).toBe(pivot); expect(config.pointer).toBe(pointer);
  });
  it('uses shared bounded drawing records with a distinct transform target', () => {
    const markup = renderToStaticMarkup(createElement(GizmoDrawing, { target: 'transform', capturedHandle: 15,
      frame: { hitHandle: 1, center: [20, 30], primitives: [{ handle: 15, role: 3, type: 2, points: [80, 90, 4, 0, 0, 0, 0, 0], weight: 1.5 }] } }));
    expect(markup).toContain('data-transform-gizmo="true"'); expect(markup).not.toContain('data-filter-gizmo');
    expect(markup).toContain('data-gizmo-captured="15"'); expect(markup).toContain('filter-gizmo-highlight');
    expect(markup).toMatch(/<rect[^>]*x="76"[^>]*y="86"[^>]*width="8"[^>]*height="8"/);
  });
});
