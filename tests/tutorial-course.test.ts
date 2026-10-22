import { describe, expect, it, vi } from 'vitest';
import { createTutorialCourses, TUTORIAL_COURSES, TUTORIAL_OFFER_TEXT } from '../src/app/tutorialCourse';
import { TUTORIAL_ALL_STEPS, TUTORIAL_STEPS, TUTORIAL_VERSION } from '../src/app/tutorialCatalog';
import { tutorialTargetAllowed } from '../src/app/productPolicy';
import { browserTranslations, translationAliases, TRANSLATED_LOCALES, translate } from '../src/app/i18n';
import native from '../src/generated/native-translations.json';

// Compose the complete browser course without inventing DOM/storage support in
// Node. The real sealed adapter still decides which Basic targets are allowed.
vi.mock('../src/app/productPolicy', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/app/productPolicy')>();
  const { registeredAllowed } = await import('../src/generated/product-adapter');
  return { ...actual, tutorialTargetAllowed: (target: string) =>
    registeredAllowed(`TutorialTarget.${target}`, 'ui', ['local_storage', 'fullscreen', 'clipboard']) };
});

const essentialsIds = ['open', 'save', 'capture', 'navigation', 'tools', 'undo-redo', 'settings', 'thumbnail', 'scope', 'histogram',
  'brushes', 'area', 'combine', 'selection-edits', 'selection-finish', 'gizmo', 'color-reset', 'auto-color', 'presets', 'color-slider'];
const courses = Object.values(TUTORIAL_COURSES);
const all = TUTORIAL_COURSES.all.steps, essentials = TUTORIAL_COURSES.essentials.steps;

describe('current desktop tutorial courses projected onto Basic web', () => {
  it('omits unavailable optional topics without blocking either course', () => {
    const available = TUTORIAL_STEPS.filter(step => step.id !== 'thumbnail');
    const courses = createTutorialCourses(available);
    expect(courses.essentials.steps).toHaveLength(19); expect(courses.all.steps).toHaveLength(33);
    for (const course of Object.values(courses)) {
      expect(course.steps.some(step => step.id === 'thumbnail')).toBe(false);
      expect(course.steps.map(step => step.index)).toEqual(course.steps.map((_, index) => index + 1));
    }
  });
  it('follows the reviewed 20-step spatial order and retains every supported All topic', () => {
    expect(essentials.map(step => step.id)).toEqual(essentialsIds);
    expect(all).toHaveLength(34);
    expect(new Set(all.map(step => step.id))).toEqual(new Set(TUTORIAL_STEPS.map(step => step.id)));
    expect(all.filter(step => essentialsIds.includes(step.id)).map(step => step.id)).toEqual(essentialsIds);
    expect(TUTORIAL_COURSES.essentials).toMatchObject({ id: 'essentials', label: 'Essentials' });
    expect(TUTORIAL_COURSES.all).toMatchObject({ id: 'all', label: 'All topics' });
    for (const course of courses) expect(course.steps.map(step => step.index)).toEqual(course.steps.map((_, index) => index + 1));
  });
  it('copies immutable presentation metadata and preserves all frozen native provenance', () => {
    expect(Object.isFrozen(TUTORIAL_COURSES)).toBe(true);
    for (const course of courses) {
      expect(Object.isFrozen(course)).toBe(true); expect(Object.isFrozen(course.steps)).toBe(true);
      for (const step of course.steps) {
        const source = TUTORIAL_STEPS.find(value => value.id === step.id)!;
        expect(step).not.toBe(source); expect(Object.isFrozen(step)).toBe(true);
        for (const field of ['nativeTarget', 'nativeTitle', 'nativeText', 'nativeSourceLine', 'target', 'section', 'tools'] as const)
          expect(step[field]).toBe(source[field]);
      }
    }
    expect(TUTORIAL_VERSION).toBe(7); expect(TUTORIAL_ALL_STEPS).toHaveLength(47);
    expect(TUTORIAL_STEPS.find(step => step.id === 'selection-finish')!.text).toContain('X clears.');
  });
  it('assigns the desktop chapters without adding advanced or unsupported web targets', () => {
    const excluded = ['filter', 'refine', 'duplicate', 'current-view', 'range', 'pro-color', 'floor', 'coordinates', 'pivot', 'modes'];
    for (const step of all) {
      expect(tutorialTargetAllowed(step.target)).toBe(true); expect(excluded).not.toContain(step.target);
      expect(step.displayMode).toBe('basic'); expect(step.title + ' ' + step.text).not.toMatch(/\bPro\b|agent access/i);
      expect(['Tools overview', 'Selection', 'Transform', 'Color', 'View and save']).toContain(step.chapter);
    }
    expect(new Set(essentials.map(step => step.chapter))).toEqual(new Set(['View and save', 'Tools overview', 'Selection', 'Transform', 'Color']));
  });
  it('follows toolbar reading order, then each panel section from its heading down, without chapter backtracking', () => {
    for (const course of courses) {
      const ids = course.steps.map(step => step.id);
      const chapters = [...new Set(course.steps.map(step => step.chapter))];
      expect(chapters).toEqual(['View and save', 'Tools overview', 'Selection', 'Transform', 'Color']);
      expect(chapters.flatMap(chapter => course.steps.filter(step => step.chapter === chapter).map(step => step.id))).toEqual(ids);
      for (const [before, after] of [['open', 'save'], ['save', 'capture'], ['capture', 'navigation'], ['navigation', 'tools'],
        ['tools', 'undo-redo'], ['undo-redo', 'settings'], ['settings', 'thumbnail'], ['thumbnail', 'scope'], ['scope', 'histogram'],
        ['histogram', 'brushes'], ['brushes', 'area'], ['area', 'combine'], ['combine', 'selection-edits'],
        ['selection-edits', 'selection-finish'], ['selection-finish', 'gizmo'], ['gizmo', 'color-reset'],
        ['color-reset', 'auto-color'], ['auto-color', 'presets'], ['presets', 'color-slider']])
        expect(ids.indexOf(before as typeof ids[number])).toBeLessThan(ids.indexOf(after as typeof ids[number]));
      expect(ids.slice(-4)).toEqual(['color-reset', 'auto-color', 'presets', 'color-slider']);
    }
    expect(all.filter(step => step.chapter === 'View and save').map(step => step.id)).toEqual([
      'open', 'save', 'capture', 'navigation', 'auto-rotate', 'guides', 'lens', 'tools',
    ]);
    expect(all.filter(step => step.chapter === 'Selection').map(step => step.id)).toEqual([
      'cleanup-reset', 'single', 'brushes', 'area', 'color-select', 'fill', 'combine', 'options', 'actions', 'selection-edits', 'selection-finish',
    ]);
    expect(all.filter(step => step.chapter === 'Transform').map(step => step.id)).toEqual([
      'transform-reset', 'pick-center', 'scale-align', 'plane-align', 'gizmo', 'snap-flips',
    ]);
  });
  it('corrects current shortcuts and describes download, color commit and replay semantics in both courses', () => {
    for (const course of courses) {
      const text = (id: string) => course.steps.find(step => step.id === id)!.text;
      expect(text('selection-finish')).toContain('C clears the selection.'); expect(text('selection-finish')).not.toContain('X clears');
      expect(text('gizmo')).toContain('Esc cancels the session.'); expect(text('gizmo')).not.toContain('X cancels');
      expect(text('save')).toContain('download a new copy'); expect(text('save')).toContain('source file stays unchanged');
      expect(text('color-reset')).toContain('preview to neutral colors'); expect(text('color-reset')).toContain('Apply color commits');
      expect(text('auto-color')).toContain('commits immediately'); expect(text('auto-color')).toContain('Undo reverses');
      expect(text('presets')).toContain('Apply color to commit the preview');
      expect(text('settings')).toContain('Settings > Help');
    }
  });
  it('explains practice and actual Ctrl snapping without changing captured catalog copy', () => {
    const introduction = all.find(step => step.id === 'open')!;
    expect(introduction.text).toContain('from left to right, then down the Tools panel');
    expect(introduction.text).toContain('Use Topics to choose a lesson');
    expect(introduction.text).toContain('Close the tour or press Esc to try the tools');
    expect(essentials[0].text).toContain('Close the text tour to try the tools');
    const snap = all.find(step => step.id === 'snap-flips')!;
    expect(snap.text).toContain('hold Ctrl while dragging'); expect(snap.text).not.toContain('Command');
    expect(TUTORIAL_STEPS.find(step => step.id === 'snap-flips')!.text).toContain('Command on Mac');
    expect(introduction.nativeText).toBe('Open a splat to edit, or another PLY to view.');
    expect(snap.nativeText).toBe('Use the magnet or hold Ctrl to snap. Flip X/Y/Z changes orientation. Available in Basic and Pro.');
  });
  it('limits the shorter introductory copy to Essentials', () => {
    expect(essentials[0]).toMatchObject({ title: 'Welcome to SplatView', text: expect.stringContaining('it stays in place') });
    for (const [id, title] of [['area', 'Rectangle'], ['selection-edits', 'Delete and Undo']]) {
      expect(essentials.find(step => step.id === id)!.title).toBe(title);
      expect(all.find(step => step.id === id)!.title).toBe(TUTORIAL_STEPS.find(step => step.id === id)!.title);
    }
    for (const course of courses) expect(course.steps.find(step => step.id === 'gizmo')!.title).toBe('Move, rotate and scale');
  });
  it('translates every currently displayed course key into all eight locales', () => {
    const keys = new Set([TUTORIAL_OFFER_TEXT, 'Topics', 'Text tour', ...courses.flatMap(course => [course.label,
      ...course.steps.flatMap(step => [step.title, step.text, step.chapter])])]);
    expect(TRANSLATED_LOCALES).toHaveLength(7);
    for (const key of keys) {
      expect(translate(key, 'en')).toBe(key);
      for (const [index, locale] of TRANSLATED_LOCALES.entries()) {
        const catalog = native.catalogs[locale] as Readonly<Record<string, string>>;
        const expected = browserTranslations[key]?.[index] ?? catalog[translationAliases[key] ?? key];
        expect(expected?.trim().length, `${locale}: ${key}`).toBeGreaterThan(0);
        expect(translate(key, locale), `${locale}: ${key}`).toBe(expected);
      }
    }
  });
});
