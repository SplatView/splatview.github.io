import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OpacityControls } from '../src/ui/OpacityControls';

function controls(patch: Partial<Parameters<typeof OpacityControls>[0]> = {}) {
  return renderToStaticMarkup(createElement(OpacityControls, { scale: 1, enabled: true, applyEnabled: true,
    cancelEnabled: true, pending: false, dirty: false, onScale() {}, onApply() {}, onCancel() {}, ...patch }));
}

describe('Pro Fade / boost presentation', () => {
  it('exposes percentage bounds and neutral 100%, distinct from the RGB Fade field', () => {
    const markup = controls();
    expect(markup).toContain('role="group" aria-label="Opacity controls"');
    expect(markup).toMatch(/type="range" min="0" max="500" step="any" aria-label="Fade \/ boost"/);
    expect(markup).toContain('aria-valuetext="100%"'); expect(markup).toContain('value="100"');
    expect(markup).toContain('<output>100%</output>'); expect(markup).not.toContain('aria-label="Fade"');
  });
  it('preserves the native value before editing while rounding only its displayed percentage', () => {
    const markup = controls({ scale: .375123456789 });
    expect(markup).toContain('value="37.5123456789"');
    expect(markup).toContain('aria-valuetext="38%"'); expect(markup).toContain('<output>38%</output>');
  });
  it.each([[0, '0'], [5, '500']] as const)('presents endpoint scale %s in percentage units', (scale, value) => {
    const markup = controls({ scale }); expect(markup).toContain(`value="${value}"`);
    expect(markup).toContain(`<output>${value}%</output>`);
  });
  it('offers explicit Apply and keeps Cancel independently available during pending work', () => {
    const markup = controls({ enabled: false, applyEnabled: false, dirty: true, cancelEnabled: true, pending: true });
    expect(markup).toMatch(/aria-label="Fade \/ boost"[^>]*disabled=""/);
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Apply opacity/);
    expect(markup).not.toMatch(/<button[^>]*disabled=""[^>]*>Cancel opacity preview/);
    expect(markup).toContain('role="status">Updating opacity');
  });
  it('keeps idle Apply mounted in a hidden container without a draft cancellation action', () => {
    const markup = controls(); expect(markup).toContain('class="opacity-apply-actions" hidden=""');
    expect(markup).toContain('Apply opacity'); expect(markup).not.toContain('Cancel opacity preview');
    expect(controls({ dirty: true })).not.toContain('class="opacity-apply-actions" hidden=""');
  });
});
