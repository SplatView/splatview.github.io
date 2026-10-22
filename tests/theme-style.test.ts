import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { themeStyle } from '../src/app/themePreferences';
import { UI_SIZES, uiSizeStyle } from '../src/app/uiPreferences';

const css = readFileSync('src/styles/app.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
  selectors: selector.trim().split(/,\s*/), body,
}));
function rule(selector: string) {
  const found = rules.filter(candidate => candidate.selectors.includes(selector));
  expect(found.length, `Missing CSS rule: ${selector}`).toBeGreaterThan(0);
  return found.map(candidate => candidate.body).join('\n');
}

describe('desktop theme CSS coverage', () => {
  it('connects every published theme color to inherited chrome variables, including body portals', () => {
    const root = rule(':root');
    for (const name of Object.keys(themeStyle('dark')).filter(name => name.startsWith('--ui-'))) {
      expect(root, `Published theme color ${name} must reach the stylesheet`).toContain(`var(${name},`);
    }
    expect(root).toContain('color: var(--text)');
    for (const selector of ['.panel', '.color-actions-menu', '.ui-theme-menu', '.ui-size-menu', '.collection-tooltip']) {
      expect(rule(selector)).toContain('background: var(--panel)');
    }
  });

  it('leaves fixed color declarations only in palette fallbacks and scene overlays', () => {
    // RGB has meaning in the scene. These selectors must not follow the chosen
    // chrome palette; new fixed-color UI rules require an explicit review.
    const sceneSelector = /^(?:\.viewport-shell|\.alignment-(?:marker(?: \.alignment-marker-ring)?|segment|normal(?:-head)?|floor-grid)|\.alignment-(?:scale|plane|floor) (?:\.alignment-(?:confirm|retry)|\[aria-label="Cancel alignment"\]) \.icon|\.filter-(?:volume-overlay|gizmo-role-[0124]|gizmo-highlight)|\.filter-(?:confirm|cancel) \.icon|\.gesture-overlay (?:rect|polyline))$/;
    const fixed = rules.filter(candidate => /#[\da-f]{3,8}\b|\brgba?\(/i.test(candidate.body));
    expect(fixed.length).toBeGreaterThan(10);
    for (const entry of fixed) for (const selector of entry.selectors) {
      expect(selector === ':root' || sceneSelector.test(selector), `Fixed chrome color in ${selector}`).toBe(true);
    }
  });

  it('defines every local color variable instead of silently inheriting an unresolved handle color', () => {
    const defined = new Set([...css.matchAll(/(--[a-z-]+)\s*:/g)].map(match => match[1]));
    const used = new Set([...css.matchAll(/var\((--[a-z-]+)/g)].map(match => match[1]));
    for (const name of used) if (!name.startsWith('--ui-')) expect(defined.has(name), `Undefined ${name}`).toBe(true);
    expect(rule('.filter-gizmo-role-3')).toContain('color: var(--text)');
  });

  it('preserves scene background, axis and picking colors when chrome changes', () => {
    expect(rule('.viewport-shell')).toContain('background: #000');
    expect(rule('.filter-gizmo-role-0')).toContain('rgb(236, 100, 100)');
    expect(rule('.filter-gizmo-role-1')).toContain('rgb(125, 210, 146)');
    expect(rule('.filter-gizmo-role-2')).toContain('rgb(105, 165, 245)');
    expect(rule('.filter-gizmo-role-4')).toContain('rgba(108, 210, 232, .9)');
    expect(rule('.filter-gizmo-highlight')).toContain('rgb(255, 215, 135)');
  });

  it('puts an empty scene on the theme window while preserving the loaded scene background', () => {
    expect(rule('.viewport-shell[data-scene-ready=false]')).toContain('background: var(--window)');
    const emptyCanvas = rule('.viewport-shell[data-scene-ready=false] > canvas');
    expect(emptyCanvas).toContain('visibility: hidden');
    expect(emptyCanvas).not.toContain('display: none');
    expect(rule('canvas')).not.toContain('visibility: hidden');
    expect(rule('.viewport-shell')).toContain('background: #000');
  });

  it('retains shared compact label/field settings rows and 28px menu choices at every font size', () => {
    // Match the complete shared selector group. The older rule() helper splits
    // commas inside :is(), whose middle class is not a standalone CSS rule.
    const declarations = (selectors: string[]) => {
      const found = rules.filter(candidate => candidate.selectors.length === selectors.length &&
        selectors.every(selector => candidate.selectors.includes(selector)));
      expect(found.length, `Missing shared Settings rule: ${selectors.join(', ')}`).toBe(1);
      return Object.fromEntries(found[0].body.split(';').map(value => value.trim()).filter(Boolean).map(value => {
        const colon = value.indexOf(':');
        return [value.slice(0, colon).trim(), value.slice(colon + 1).trim().replace(/\s+/g, ' ')];
      }));
    };
    expect(declarations(['.font-size-setting', '.theme-setting', '.language-setting'])).toMatchObject({
      display: 'grid', 'grid-template-columns': 'min(43%, calc(108px + 7.2 * var(--ui-font-increase))) minmax(0, 1fr)',
      'align-items': 'center', gap: '6px',
    });
    expect(declarations(['.font-size-trigger', '.theme-trigger', '.language-trigger'])).toMatchObject({
      height: 'calc(21px + var(--ui-font-increase))', 'min-height': '0', background: 'var(--field)',
      display: 'flex', 'justify-content': 'space-between',
    });
    expect(UI_SIZES.map(info => {
      expect(uiSizeStyle(info.size)).toMatchObject({ '--ui-font-increase': `${info.fontIncrease}px` });
      return 21 + info.fontIncrease;
    })).toEqual([21, 23, 25]);
    expect(declarations(['.ui-size-option', '.ui-theme-option', '.ui-language-option'])).toMatchObject({
      height: '28px', 'min-height': '28px',
    });
    const fontHeightOverride = rules.find(candidate => candidate.selectors.some(selector =>
      selector.startsWith('.viewport-shell:not([data-ui-size=small]) :where(button')))!;
    for (const name of ['font-size', 'theme', 'language']) {
      expect(fontHeightOverride.selectors.join(',')).toContain(`:not(.${name}-trigger)`);
    }
    expect(rule('.theme-caption')).toContain('text-overflow: ellipsis');
    expect(rule('.theme-value')).toContain('text-overflow: ellipsis');
    expect(rule('.preference-chevron')).toContain('color: var(--muted)');
    const activeChevron = rules.find(candidate => candidate.selectors.join(', ') ===
      ':is(.font-size-trigger, .theme-trigger, .language-trigger):is(:hover, [aria-expanded=true]) .preference-chevron');
    expect(activeChevron?.body).toContain('color: var(--accent)');
    expect(rule('.ui-theme-option .icon')).toContain('color: inherit');
    expect(rule('.preference-selected-dot')).toContain('background: currentColor');
  });

  it('uses palette roles for selected interaction, primary text, error contrast and modal dimming', () => {
    expect(rule('button.active:hover:not(:disabled)')).toContain('background: var(--selected-hover)');
    expect(rule('button.active:active:not(:disabled)')).toContain('background: var(--selected-pressed)');
    expect(rule('.empty-state .primary-open')).toContain('color: var(--on-accent)');
    expect(rule('.error-banner')).toContain('color: var(--error)');
    expect(rule('.grade-controls .grade-value-entry[aria-invalid=true]')).toContain('var(--error)');
    expect(rule('.dialog-backdrop')).toContain('background: var(--modal-dim)');
    expect(rule('::selection')).toContain('background: var(--selection)');
    expect(rule('.icon')).toContain('color: var(--icon)');
    expect(rule(':root')).toContain('--icon: var(--ui-icon, #a8a8a8)');
  });
});
