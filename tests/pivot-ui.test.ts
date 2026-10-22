import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TRANSLATED_LOCALES, translate } from '../src/app/i18n';
import { editingTranslations } from '../src/app/translations/editing';
import { transformDefaults } from '../src/document/transformProtocol';
import { currentDesktopIcons } from '../src/generated/currentDesktopIcons';
import { desktopIcons } from '../src/generated/desktop';
import { TransformControls } from '../src/ui/TransformControls';

function controls(patch: Partial<Parameters<typeof TransformControls>[0]> = {}) {
  return renderToStaticMarkup(createElement(TransformControls, { parameters: transformDefaults(), mode: 'pro', enabled: true,
    applyEnabled: true, cancelEnabled: true, pending: false, dirty: false, gizmoMode: null, gizmoEnabled: true,
    localAxes: false, snap: false, pivotMode: 'scene', pivotChosen: false, pivotPending: false, hasSelected: false,
    onParameters() {}, onFlip() {}, onCyclePivot() {}, onApply() {}, onCancel() {}, onGizmo() {}, onLocalAxes() {}, onSnap() {}, ...patch }));
}
function pivot(markup: string) {
  return [...markup.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)]
    .map(match => match[0]).find(tag => tag.includes('aria-label="Cycle pivot"'));
}

describe('desktop pivot cycle presentation', () => {
  it.each([
    ['scene', false, 'CenterPivot', 'Pivot: scene center\nClick for origin (0,0,0)'],
    ['scene', true, 'CenterPivot', 'Pivot: scene center\nClick for selection center'],
    ['selection', true, 'SelectionPivot', 'Pivot: selection center\nClick for origin (0,0,0)'],
    ['origin', false, 'OriginPivot', 'Pivot: origin (0,0,0)\nClick for scene center'],
    ['custom', true, 'PickCenter', 'Pivot: custom\nClick for scene center'],
  ] as const)('shows the %s mode with selected=%s using the exact desktop icon and next-action tooltip', (pivotMode, hasSelected, icon, tooltip) => {
    const action = pivot(controls({ pivotMode, hasSelected }));
    expect(action).toBeDefined(); expect(action).toContain(`title="${tooltip}"`);
    expect(action).toContain(currentDesktopIcons[icon] ?? desktopIcons[icon]);
    expect(action).toContain('aria-pressed="false"'); expect(action).not.toContain('disabled');
  });

  it('marks an explicitly chosen pivot and fences a pending native focus without hiding its reference', () => {
    const action = pivot(controls({ pivotMode: 'selection', pivotChosen: true, pivotPending: true, hasSelected: true }));
    expect(action).toContain('transform-option-button active'); expect(action).toContain('aria-pressed="true"');
    expect(action).toContain('aria-busy="true"'); expect(action).toContain('disabled=""');
    expect(action).toContain(currentDesktopIcons.SelectionPivot);
    expect(pivot(controls({ enabled: false }))).toContain('disabled=""');
  });

  it('fences pivot references during native Apply while retaining coalescible translation fields', () => {
    const markup = controls({ pending: true });
    for (const axis of ['X', 'Y', 'Z']) {
      expect(markup).toMatch(new RegExp(`aria-label="Pivot ${axis}"[^>]*disabled=""`));
      const translation = markup.match(new RegExp(`<input[^>]*aria-label="Translation ${axis}"[^>]*>`))?.[0];
      expect(translation).toBeDefined(); expect(translation).not.toContain('disabled');
    }
    expect(pivot(markup)).toContain('disabled=""');
  });

  it('keeps the desktop Pro and affine-matrix visibility rules', () => {
    expect(pivot(controls({ mode: 'basic' }))).toBeUndefined();
    expect(pivot(controls({ parameters: { ...transformDefaults(), mode: 'matrix' } }))).toBeUndefined();
    for (const mode of ['euler', 'quaternion', 'axis-angle'] as const)
      expect(pivot(controls({ parameters: { ...transformDefaults(), mode } }))).toBeDefined();
  });

  it('retains all six exact desktop pivot keys and seven locale columns', () => {
    const capture = JSON.parse(readFileSync('reference/targets/windows-pivot-20261016-01/CAPTURE_MANIFEST.json', 'utf8')) as {
      localeOrder: string[]; translations: { key: string; translations: string[]; catalogLine: number }[];
    };
    expect(capture.localeOrder).toEqual(TRANSLATED_LOCALES);
    expect(capture.translations.map(row => row.catalogLine)).toEqual([302, 303, 304, 305, 306, 307]);
    for (const row of capture.translations) {
      expect(editingTranslations[row.key]).toEqual(row.translations);
      expect(translate(row.key, 'en')).toBe(row.key);
      for (const [index, locale] of TRANSLATED_LOCALES.entries())
        expect(translate(row.key, locale)).toBe(row.translations[index]);
    }
  });
});
