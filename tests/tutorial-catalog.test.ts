import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import translations from './fixtures/tutorial-v7-translations.json';
import { TUTORIAL_ADAPTATIONS, TUTORIAL_NATIVE_OMISSIONS, TUTORIAL_ALL_STEPS as TUTORIAL_STEPS, TUTORIAL_STEP_IDS, TUTORIAL_TARGETS, TUTORIAL_VERSION } from '../src/app/tutorialCatalog';
import { tutorialTranslations } from '../src/app/translations/tutorial';
import { selectionTranslations } from '../src/app/translations/selection';
import { editingTranslations } from '../src/app/translations/editing';
import { TRANSLATED_LOCALES, translate } from '../src/app/i18n';

// Tracked exact desktop bytes keep this oracle usable without the ignored clone.
// Original proprietary ownership and source/license hashes accompany the rows.
const referenceBytes = readFileSync(resolve('tests/fixtures/tutorial-v7.hpp'));
const reference = referenceBytes.toString('utf8');
const rows = new Map(translations.rows.map(row => [row.values[0], row]));
function capturedSteps() {
  return [...reference.matchAll(/TutorialStep\{([\s\S]*?)\}/g)].map(match => {
    const split = match[1].indexOf('TutorialTarget::'); expect(split).toBeGreaterThanOrEqual(0);
    const strings = [...match[1].slice(0, split).matchAll(/"(?:[^"\\]|\\.)*"/g)].map(item => JSON.parse(item[0]) as string);
    const suffix = match[1].slice(split);
    return { title: strings[0], text: strings.slice(1).join(''), target: /^TutorialTarget::(\w+)/.exec(suffix)![1],
      section: /,\s*"([^"]+)"/.exec(suffix)?.[1] ?? null, tools: /,\s*true\b/.test(suffix),
      displayMode: /ToolsMode::Basic/.test(suffix) ? 'basic' : 'pro', line: reference.slice(0, match.index).split('\n').length };
  });
}
const step = (id: typeof TUTORIAL_STEP_IDS[number]) => TUTORIAL_STEPS.find(value => value.id === id)!;

describe('pinned desktop v7 tutorial with explicit browser adaptations', () => {
  it('binds exact native bytes, version, ownership and decoded line provenance independently of the catalog', () => {
    expect(translations.authority.desktopVersion).toBe('1.0.2');
    expect(translations.authority.desktopCommit).toBe('4e1be155511fb49f08fd8c863d785ac008a4c43a');
    expect(translations.authority.licenseIdentifier).toBe('LicenseRef-OpsiClear-Proprietary');
    expect(translations.authority.copyright).toContain('OpsiClear LLC');
    expect(translations.authority.tutorialHeader.bytes).toBe(referenceBytes.byteLength);
    const hash = createHash('sha256').update(referenceBytes).digest('hex');
    expect(hash).toBe('1e0fe1551a5d9f475c43635892146e03b09430e666180de52cf88072a2f05055');
    expect(translations.authority.tutorialHeader.sha256).toBe(hash);
    expect(reference).toContain('tutorialVersion = 7'); expect(TUTORIAL_VERSION).toBe(7);
    const native = capturedSteps(); expect(native).toHaveLength(48);
    expect(TUTORIAL_NATIVE_OMISSIONS).toEqual(['AgentAccess']);
    expect(native.filter(value => value.target === 'AgentAccess')).toHaveLength(1);
    expect(TUTORIAL_STEPS.map(value => ({ title: value.nativeTitle, text: value.nativeText, target: value.nativeTarget,
      section: value.section, tools: value.tools, displayMode: value.displayMode, line: value.nativeSourceLine })))
      .toEqual(native.filter(value => value.target !== 'AgentAccess'));
  });
  it('preserves native order and default Pro presentation with stable semantic identities', () => {
    expect(reference).toContain('ToolsMode mode{ToolsMode::Pro}');
    expect(TUTORIAL_STEPS).toHaveLength(47); expect(TUTORIAL_STEPS.every(value => value.displayMode === 'pro')).toBe(true);
    expect(TUTORIAL_STEPS.filter(value => !value.tools)).toHaveLength(9);
    expect(TUTORIAL_STEPS.filter(value => value.tools && value.section === null)).toHaveLength(5);
    expect(TUTORIAL_STEPS.filter(value => value.section === 'Selection')).toHaveLength(17);
    expect(TUTORIAL_STEPS.filter(value => value.section === 'Transform')).toHaveLength(11);
    expect(TUTORIAL_STEPS.filter(value => value.section === 'Color')).toHaveLength(5);
    expect([...new Set(TUTORIAL_STEPS.map(value => value.section).filter(Boolean))]).toEqual(['Selection', 'Transform', 'Color']);
    expect(TUTORIAL_STEPS.map(value => value.index)).toEqual(Array.from({ length: 47 }, (_, index) => index + 1));
    expect(TUTORIAL_STEPS.map(value => value.id)).toEqual(TUTORIAL_STEP_IDS); expect(new Set(TUTORIAL_STEP_IDS).size).toBe(47);
    expect(TUTORIAL_STEP_IDS.every(id => !/^step-\d/.test(id))).toBe(true);
    expect(TUTORIAL_STEPS.filter(value => value.target === 'filter').map(value => value.id)).toEqual(['filter-choice', 'filter-confirm']);
    expect(step('filter-choice').nativeSourceLine).toBe(127); expect(step('filter-confirm').nativeSourceLine).toBe(155);
    expect(TUTORIAL_STEPS[0].id).toBe('open'); expect(TUTORIAL_STEPS.at(-1)?.id).toBe('pro-color');
    expect(Object.keys(TUTORIAL_ADAPTATIONS).every(id => (TUTORIAL_STEP_IDS as readonly string[]).includes(id))).toBe(true);
    expect(Object.isFrozen(TUTORIAL_STEPS)).toBe(true); expect(TUTORIAL_STEPS.every(Object.isFrozen)).toBe(true);
  });
  it('covers the complete current target enum except native Agent access, including all nine new groups', () => {
    const body = /enum class TutorialTarget\s*\{([\s\S]*?)\}/.exec(reference)![1];
    const expected = body.split(',').map(value => value.trim()).filter(value => value && value !== 'AgentAccess')
      .map(value => value.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase());
    expect(expected).toHaveLength(46); expect(TUTORIAL_TARGETS).toEqual(expected);
    expect([...new Set(TUTORIAL_STEPS.map(value => value.target))].sort()).toEqual([...expected].sort());
    for (const target of ['current-view', 'selection-edits', 'duplicate', 'range', 'selection-finish', 'transform-mode', 'coordinates', 'snap-flips', 'pivot'])
      expect(TUTORIAL_TARGETS).toContain(target);
  });
  it('describes implemented browser behavior without native shell or prospective hover-analysis promises', () => {
    expect(step('save').text).toContain('export scope'); expect(step('save').text).toContain('save a copy');
    expect(step('thumbnail')).toMatchObject({ title: 'Remember view', nativeTitle: 'Set Explorer thumbnail' });
    expect(step('thumbnail').text).toContain('in this browser'); expect(step('thumbnail').text).toContain('Settings');
    expect(step('lens').text).toContain('when the scene has focus'); expect(step('capture').text).toContain('Command+C');
    expect(step('undo-redo').text).toContain('use Command instead of Ctrl');
    expect(step('fill').text).toContain('G selects Fill when the scene has focus'); expect(step('fill').text).not.toContain('Ctrl+G');
    expect(step('refine').text).toContain('Volume for center distance or Sigma for touching ellipsoids');
    expect(step('refine').text).toContain('when you click Grow or Shrink');
    expect(step('range').text).toContain('successful pick fixes its center'); expect(step('range').text).toContain('shown in Tools');
    expect(step('range').text).toContain('finish typing'); expect(step('range').text).not.toContain('follows the cursor');
    expect(step('selection-finish').text).toContain('eligible selection history in this session');
    expect(step('gizmo').title).toBe('Move, rotate and scale'); expect(step('gizmo').text).toContain('X cancels the session');
    expect(step('transform-reset').text).toContain('gizmo session is cancelled first');
    expect(step('snap-flips').text).toContain('Command on Mac');
    expect(step('transform-values').text).toContain('Apply commits the preview; Cancel discards uncommitted values');
    expect(step('auto-color').text).toBe('Choose an automatic correction from Auto color. The Color controls show the result.');
    expect(step('presets').text).toContain('Apply color to commit the preview');
    expect(step('color-reset').text).toBe('Reset the current color and opacity preview.');
    expect(TUTORIAL_STEPS.every(value => !value.text.includes('Hover to preview') && !value.text.includes('Explorer thumbnail'))).toBe(true);
  });
  it('pins referenced locale rows and translates every displayed key across all eight locales', () => {
    expect(translations.locales).toEqual(['en', ...TRANSLATED_LOCALES]); expect(translations.rows).toHaveLength(94); expect(rows.size).toBe(94);
    const nativeKeys = new Set(TUTORIAL_STEPS.flatMap(value => [value.nativeTitle, value.nativeText]));
    expect([...rows.keys()].sort()).toEqual([...nativeKeys].sort());
    expect(translations.authority.translations.sha256).toBe('ac3f88336d930a838f3180e1fe74a018137902bf1f2c2afd9e491ac76f90a4c2');
    for (const row of translations.rows) {
      expect(Number.isSafeInteger(row.sourceLine) && row.sourceLine > 0).toBe(true);
      expect(row.values).toHaveLength(8); expect(row.values.every(value => typeof value === 'string' && value.trim().length > 0)).toBe(true);
    }
    const shared = { 'Current view only': selectionTranslations['Current view only'], 'Duplicate selection': editingTranslations['Duplicate selection'] };
    for (const value of TUTORIAL_STEPS) for (const [key, original] of [[value.title, value.nativeTitle], [value.text, value.nativeText]]) {
      expect(translate(key, 'en')).toBe(key);
      for (const [index, locale] of TRANSLATED_LOCALES.entries()) {
        if (key !== original) {
          const authored = tutorialTranslations[key] ?? selectionTranslations[key]; expect(authored, key).toBeDefined(); expect(authored).toHaveLength(7);
          expect(translate(key, locale), key).toBe(authored[index]); expect(authored[index], key).not.toBe(key);
        } else {
          const expected = Object.hasOwn(shared, key) ? shared[key as keyof typeof shared][index] : rows.get(key)!.values[index + 1];
          expect(translate(key, locale), key).toBe(expected);
        }
      }
    }
    const displayed = new Set(TUTORIAL_STEPS.flatMap(value => [value.title, value.text]));
    const unavailable = 'This control is unavailable in the current view. You can continue the tutorial.';
    for (const [key, columns] of Object.entries(tutorialTranslations)) {
      expect(displayed.has(key) || key === unavailable, key).toBe(true); expect(columns).toHaveLength(7);
      expect(columns.every(value => value.trim().length > 0)).toBe(true);
    }
    expect(translate('Tutorial %u / %u', 'en', 1, 47)).toBe('Tutorial 1 / 47');
  });
});
