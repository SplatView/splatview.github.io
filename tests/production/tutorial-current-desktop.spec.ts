import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { test as zoomTest } from '../../e2e/browser-zoom-fixture';
import { queuePly } from '../../e2e/queue-fixture';
import { exportBytes } from './initialization-helpers';
import { TUTORIAL_VERSION, type TutorialStep } from '../../src/app/tutorialCatalog';
import { BROWSER_TUTORIAL_COURSES } from '../../e2e/tutorial-courses';
import { tutorialTranslations } from '../../src/app/translations/tutorial';
import { tutorialCourseTranslations } from '../../src/app/translations/tutorialCourse';
import { webTranslations } from '../../src/app/translations/web';
import { selectionTranslations } from '../../src/app/translations/selection';
import { editingTranslations } from '../../src/app/translations/editing';
import type { UiLocale } from '../../src/app/languagePreferences';
import type { NativeSummary, Revision, SceneCommand } from '../../src/document/types';

type Observation = {
  commands: SceneCommand[]; summary?: NativeSummary; base?: Revision; fingerprint?: unknown;
  masks?: number[]; packed?: number[]; workers: number; sourceLoads: number; overflow: boolean;
};
declare global { interface Window { tutorialShippingObservation: { snapshot(): Observation } } }
const KEY = 'splatview.tutorial.v1';
const layer = (page: Page) => page.locator('.tutorial-layer');
const card = (page: Page) => layer(page).locator('.tutorial-card[role="dialog"]');
const tools = (page: Page) => page.locator('.tools-panel');
const NEW_TARGETS = ['range', 'current-view', 'selection-edits', 'duplicate', 'selection-finish',
  'transform-mode', 'coordinates', 'snap-flips', 'pivot'] as const;
const THEMES = ['dark', 'bright', 'solar', 'slate', 'midnight', 'forest', 'rose'] as const;
const LOCALES: readonly UiLocale[] = ['en', 'es', 'fr', 'de', 'pt', 'zh-Hans', 'ja', 'ko'];
// Start and Help replay present the Essentials course of the shipping build.
const COURSE: readonly TutorialStep[] = BROWSER_TUTORIAL_COURSES.essentials.steps;

// Node consumes exact tracked JSON bytes explicitly. Importing browser i18n
// would load its Vite JSON module through Node ESM during Playwright discovery.
// The captured desktop rows and browser adaptation data are the independent
// expected values; the rendered app still uses its actual translation pipeline.
const captured = JSON.parse(readFileSync(new URL('../fixtures/tutorial-v7-translations.json', import.meta.url), 'utf8')) as {
  locales: UiLocale[]; rows: {values: string[]}[];
};
const nativeRows = new Map(captured.rows.map(row => [row.values[0], row.values]));
const sharedTitles: Readonly<Record<string, readonly string[]>> = {
  'Current view only': selectionTranslations['Current view only'],
  'Duplicate selection': editingTranslations['Duplicate selection'],
};
const counterCatalogs = (JSON.parse(readFileSync(new URL('../../src/generated/native-translations.json', import.meta.url), 'utf8')) as {
  catalogs: Record<UiLocale, Record<string, string>>;
}).catalogs;
function expectedCopy(item: TutorialStep, field: 'title' | 'text', locale: UiLocale): string {
  const key = item[field];
  if (locale === 'en') return key;
  const column = captured.locales.indexOf(locale);
  if (column < 1) throw new Error(`Missing captured locale ${locale}`);
  const nativeKey = field === 'title' ? item.nativeTitle : item.nativeText;
  // Browser course tables may legitimately translate a word to itself (fr "Rectangle").
  const course = key !== nativeKey ? tutorialCourseTranslations[key]?.[column - 1] : undefined;
  const result = key !== nativeKey
    // Course copy may reuse an existing native catalog string (for example the welcome title).
    ? (tutorialTranslations[key] ?? webTranslations[key] ?? selectionTranslations[key])?.[column - 1] ?? course ??
      counterCatalogs[locale]?.[key]
    : sharedTitles[key]?.[column - 1] ?? nativeRows.get(nativeKey)?.[column];
  if (typeof result !== 'string' || !result.trim() || result === key && result !== course)
    throw new Error(`Missing explicit expected ${locale} tutorial ${item.id} ${field}`);
  return result;
}
function expectedCounter(locale: UiLocale, index: number): string {
  const template = counterCatalogs[locale]['Tutorial %u / %u'];
  if (typeof template !== 'string' || template.match(/%u/g)?.length !== 2 ||
      template.replace(/%u/g, '').includes('%') || !Number.isSafeInteger(index) || index < 1 || index > COURSE.length)
    throw new Error(`Invalid captured ${locale} tutorial counter or arguments`);
  return template.replace('%u', String(index)).replace('%u', String(COURSE.length));
}

/** Observe bounded genuine shipping requests/replies only. No development
 * exports, substitute workers, generated summaries, or scene mutations supply
 * an oracle. Geometry rendering is covered by the existing gizmo GPU cases. */
async function observe(page: Page) {
  await page.addInitScript(() => {
    const commands: SceneCommand[] = [];
    let summary: NativeSummary | undefined, base: Revision | undefined, fingerprint: unknown;
    let masks: number[] | undefined, packed: number[] | undefined, workers = 0, sourceLoads = 0, overflow = false;
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      private requests = new Map<number, { type?: string; channel?: string }>();
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options); workers++;
        this.addEventListener('message', event => {
          const value = event.data, request = this.requests.get(value?.requestId);
          if (value?.summary) { summary = structuredClone(value.summary); base = structuredClone(value.base); }
          if (value?.type === 'source-load-result') fingerprint = structuredClone(value.fingerprint);
          if (value?.type === 'masks' && value.bytes instanceof ArrayBuffer &&
              (request?.type === 'stream' || request?.type === 'masks') && (!request.channel || request.channel === 'document')) {
            if (value.bytes.byteLength === 5) masks = Array.from(new Uint8Array(value.bytes)); else overflow = true;
          }
          if (value?.type === 'chunk' && value.bytes instanceof ArrayBuffer && request?.type === 'stream' &&
              (!request.channel || request.channel === 'document')) {
            if (value.first === 0 && value.count === 5 && value.bytes.byteLength === 240) packed = Array.from(new Uint8Array(value.bytes));
            else overflow = true;
          }
        });
      }
      override postMessage(value: unknown, options?: Transferable[] | StructuredSerializeOptions) {
        const request = value as { requestId?: number; type?: string; channel?: string; command?: SceneCommand };
        if (request.type === 'source-load' || request.type === 'source-group-load') sourceLoads++;
        if (request.requestId !== undefined && request.type !== 'ack') {
          if (this.requests.size < 1024) this.requests.set(request.requestId, { type: request.type, channel: request.channel });
          else overflow = true;
        }
        if (request.command) { if (commands.length < 512) commands.push(structuredClone(request.command)); else overflow = true; }
        if (Array.isArray(options)) super.postMessage(value, options); else super.postMessage(value, options);
      }
    };
    window.tutorialShippingObservation = { snapshot: () => structuredClone({ commands, summary, base, fingerprint, masks, packed,
      workers, sourceLoads, overflow }) };
  });
}
async function preferences(page: Page, values: { locale?: UiLocale; mode?: 'basic' | 'pro'; size?: 'small' | 'medium' | 'large';
  theme?: typeof THEMES[number]; offer?: boolean } = {}) {
  await page.addInitScript(({key, values}) => {
    localStorage.setItem('splatview.ui-language.v1', values.locale ?? 'en');
    localStorage.setItem('splatview.tools-mode.v1', values.mode ?? 'basic');
    localStorage.setItem('splatview.ui-size.v1', values.size ?? 'medium');
    localStorage.setItem('splatview.ui-theme.v1', values.theme ?? 'dark');
    if (values.offer) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify({tutorial_prompt_handled: 'handled', tutorial_version: 2}));
  }, {key: KEY, values});
}
async function savedPreferences(page: Page) {
  return page.evaluate(key => Object.fromEntries(Object.entries(localStorage).filter(([name]) => name !== key)), KEY);
}
async function open(page: Page) {
  await preferences(page); await observe(page); await page.goto('/');
  await expect(page.getByRole('button', {name: 'Open scene', exact: true})).toBeEnabled();
  await page.getByLabel('Open scene files').setInputFiles({name: 'tutorial-current.ply', mimeType: 'application/octet-stream', buffer: Buffer.from(queuePly())});
  if (!await tools(page).isVisible()) await page.getByRole('button', {name: 'Tools', exact: true}).click();
  await expect(tools(page).locator('.model-stats')).toHaveText('0/5 splats | SH0');
  return {all: tools(page).getByRole('button', {name: 'Select all', exact: true}),
    clear: tools(page).getByRole('button', {name: 'Clear selection', exact: true}),
    undo: tools(page).getByRole('button', {name: 'Undo', exact: true}),
    redo: tools(page).getByRole('button', {name: 'Redo', exact: true})};
}
async function snapshot(page: Page, expectedMasks?: number[]) {
  await expect(page.locator('.status.panel')).toHaveCount(0);
  if (expectedMasks) await expect.poll(() => page.evaluate(() => window.tutorialShippingObservation.snapshot().masks)).toEqual(expectedMasks);
  const value = await page.evaluate(() => window.tutorialShippingObservation.snapshot());
  expect(value.overflow).toBe(false); expect(value.workers).toBe(1); expect(value.sourceLoads).toBe(1);
  expect(value.summary).toMatchObject({ok: true, loaded: true, count: 5, sourceCount: 5, pending: false, transaction: false});
  expect(value.packed).toHaveLength(240); expect(value.fingerprint).toBeDefined(); expect(value.base?.documentId).toBeTruthy();
  return value;
}
function retained(after: Observation, before: Observation) {
  // Allocation telemetry can vary with a read-only reply; all persistent and
  // native-owner fields, including runtime history stamps, must remain exact.
  const state = (value: NativeSummary) => {
    const {memoryBytes: _memory, exportBytes: _export, exportOutputBytes: _output, ...persistent} = value;
    return persistent;
  };
  expect(state(after.summary!)).toEqual(state(before.summary!));
  // Reply base is the request's pre-command envelope, not an accepted revision.
  // Persistent revision clocks are authenticated by the native summary above.
  expect(after.base?.documentId).toBe(before.base?.documentId);
  expect(after.base?.sourceGeneration).toBe(before.base?.sourceGeneration); expect(after.fingerprint).toEqual(before.fingerprint);
  expect(after.masks).toEqual(before.masks); expect(after.packed).toEqual(before.packed);
  expect(after.workers).toBe(before.workers); expect(after.sourceLoads).toBe(before.sourceLoads);
  expect(after.commands.slice(before.commands.length).filter(command => command.command !== 'summary')).toEqual([]);
}
async function replay(page: Page) {
  if (!await tools(page).isVisible()) await page.getByRole('button', {name: 'Tools', exact: true}).click();
  await tools(page).getByRole('button', {name: 'Settings', exact: true}).click();
  const settings = page.locator('.settings-dialog[role="dialog"]');
  await settings.getByRole('tab', {name: 'Help', exact: true}).click();
  await expect(settings.locator('[data-tutorial-replay]')).toBeEnabled();
  await settings.locator('[data-tutorial-replay]').click();
  await expect(settings).toHaveCount(0); await expect(layer(page)).toHaveAttribute('data-tutorial-step', '1');
}
async function fit(page: Page) {
  await expect.poll(() => card(page).evaluate(element => {
    const inside = (rect: DOMRect) => rect.left >= -.5 && rect.top >= -.5 && rect.right <= innerWidth + .5 && rect.bottom <= innerHeight + .5;
    const body = element.querySelector('.tutorial-card-body')!.getBoundingClientRect();
    const footer = element.querySelector('.tutorial-card-actions')!.getBoundingClientRect();
    return {card: inside(element.getBoundingClientRect()), body: inside(body), footer: inside(footer),
      actions: [...element.querySelectorAll('.tutorial-card-actions button')].every(node => inside(node.getBoundingClientRect())),
      ordered: body.bottom <= footer.top + .5, page: document.documentElement.scrollWidth <= innerWidth && scrollX === 0 && scrollY === 0};
  })).toEqual({card: true, body: true, footer: true, actions: true, ordered: true, page: true});
}
async function step(page: Page, item: TutorialStep, locale: UiLocale = 'en') {
  await expect(layer(page)).toHaveAttribute('data-tutorial-step', String(item.index));
  await expect(layer(page)).toHaveAttribute('data-tutorial-active-target', item.target);
  await expect(card(page).locator('h1')).toHaveText(expectedCopy(item, 'title', locale));
  await expect(card(page).locator('.tutorial-card-body > p:not([class])').first()).toHaveText(expectedCopy(item, 'text', locale));
  await expect(card(page).locator('.tutorial-counter')).toHaveText(expectedCounter(locale, item.index));
  await expect(layer(page)).toHaveAttribute('data-tutorial-target-status', 'visible');
  expect(await layer(page).locator('.tutorial-highlight').count()).toBeGreaterThan(0);
  if (item.tools) await expect(tools(page)).toHaveAttribute('data-tutorial-display-mode', 'basic');
  if (item.target === 'selection-finish') {
    const demo = layer(page).locator('[data-tutorial-demo="selection-finish"]');
    await expect(demo).toHaveAttribute('aria-hidden', 'true'); await expect(demo).toHaveAttribute('inert', '');
    await expect(demo.locator('button')).toHaveCount(3);
    for (const button of await demo.locator('button').all()) await expect(button).toBeDisabled();
  }
  await fit(page);
}
async function walk(page: Page, locale: UiLocale = 'en', observeStep?: (item: TutorialStep) => Promise<void>) {
  expect(TUTORIAL_VERSION).toBe(7); expect(COURSE).toHaveLength(20);
  for (const item of COURSE) {
    await step(page, item, locale); await observeStep?.(item);
    if (item.index < COURSE.length) await card(page).locator('.tutorial-card-actions button').last().click();
  }
}
async function reachable(target: Locator) { await expect(target).toBeFocused(); await expect(target).toBeInViewport({ratio: 1}); }

test('shipping v7 target walk preserves native masks, geometry, source, history and exact PLY output', async ({page}, info) => {
  test.setTimeout(120_000);
  const f = await open(page); await f.all.click(); await snapshot(page, [1, 1, 1, 1, 1]);
  await f.clear.click(); await snapshot(page, [0, 0, 0, 0, 0]);
  await f.undo.click(); await snapshot(page, [1, 1, 1, 1, 1]);
  const output = await exportBytes(page, 'tutorial-current'), before = await snapshot(page), prefs = await savedPreferences(page);
  expect(before.summary!.canRedo).toBe(true); expect(before.summary!.undoSelectionRevision).toBeGreaterThan(0);
  await replay(page);
  await walk(page, 'en', async item => {
    if (NEW_TARGETS.includes(item.target as typeof NEW_TARGETS[number])) retained(await snapshot(page), before);
    if (['selection-edits', 'selection-finish', 'gizmo'].includes(item.target))
      await info.attach(`shipping-v7-${item.id}.png`, {body: await page.screenshot(), contentType: 'image/png'});
  });
  await card(page).getByRole('button', {name: 'Finish', exact: true}).click(); await expect(layer(page)).toHaveCount(0);
  retained(await snapshot(page), before); expect(await savedPreferences(page)).toEqual(prefs);
  expect(JSON.parse((await page.evaluate(key => localStorage.getItem(key), KEY))!).tutorial_version).toBe(7);
  expect((await exportBytes(page, 'tutorial-current')).equals(output)).toBe(true);
  await f.redo.click(); const redone = await snapshot(page, [0, 0, 0, 0, 0]); expect(redone.packed).toEqual(before.packed);
  await f.undo.click(); const undone = await snapshot(page, [1, 1, 1, 1, 1]); expect(undone.packed).toEqual(before.packed);
  expect(undone.summary!.canRedo).toBe(true);
  await info.attach('shipping-v7-native-history-export', {body: JSON.stringify({before, redone, undone, outputBytes: output.length}), contentType: 'application/json'});
});

test('shipping retained idle gizmo survives tour replay and modal keyboard ownership without an edit', async ({page}, info) => {
  const f = await open(page); await f.all.click(); await snapshot(page, [1, 1, 1, 1, 1]);
  await tools(page).getByRole('group', {name: 'Transform gizmo', exact: true}).getByRole('button', {name: 'Move', exact: true}).click();
  const tray = page.locator('.transform-gizmo-finish'); await expect(tray).toBeVisible();
  const before = await snapshot(page), prefs = await savedPreferences(page);
  expect(before.summary!.transformSession).toMatchObject({kind: 'gizmo', gizmo: {cancelBaseId: null, canUndo: false, canRedo: false}});
  const status = page.getByRole('status', {name: 'Scene status', exact: true});
  await replay(page); await expect(status).toHaveText('');
  const next = card(page).getByRole('button', {name: 'Next', exact: true}); await reachable(next);
  for (let index = 0; index < 8; index++) { await page.keyboard.press(index % 2 ? 'Shift+Tab' : 'Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('.tutorial-card'))).toBe(true); }
  await card(page).locator('.tutorial-card-body').focus();
  const composingEscape = await card(page).locator('.tutorial-card-body').evaluate(element => {
    element.dispatchEvent(new CompositionEvent('compositionstart', {bubbles: true}));
    const escape = new KeyboardEvent('keydown', {key: 'Escape', code: 'Escape', bubbles: true, cancelable: true, isComposing: true});
    element.dispatchEvent(escape); element.dispatchEvent(new KeyboardEvent('keyup', {key: 'Escape', code: 'Escape', bubbles: true}));
    element.dispatchEvent(new CompositionEvent('compositionend', {bubbles: true})); return escape.defaultPrevented;
  });
  expect(composingEscape).toBe(false); await expect(layer(page)).toHaveAttribute('data-tutorial-step', '1');
  for (const key of ['g', 'b', 'Delete', 'ControlOrMeta+z', 'ControlOrMeta+Shift+z']) await page.keyboard.press(key);
  const browserFind = await card(page).locator('.tutorial-card-body').evaluate(element => ['Control', 'Meta'].map(modifier => {
    const key = new KeyboardEvent('keydown', {key: 'g', code: 'KeyG', ctrlKey: modifier === 'Control', metaKey: modifier === 'Meta', bubbles: true, cancelable: true});
    element.dispatchEvent(key); element.dispatchEvent(new KeyboardEvent('keyup', {key: 'g', code: 'KeyG', bubbles: true})); return key.defaultPrevented;
  }));
  expect(browserFind).toEqual([false, false]);
  await page.keyboard.down('g'); await page.keyboard.down('g'); await page.keyboard.press('Escape');
  await expect(layer(page)).toHaveCount(0); await page.keyboard.up('g');
  await expect(page.getByLabel('SplatView scene', {exact: true})).toBeFocused();
  await expect(status).toContainText('Transform.'); retained(await snapshot(page), before); expect(await savedPreferences(page)).toEqual(prefs);
  await expect(tray).toBeVisible(); await expect(tray.getByRole('button', {name: 'Undo transform', exact: true})).toBeDisabled();
  await tray.getByRole('button', {name: 'Finish transform tool (Enter)', exact: true}).focus();
  await page.keyboard.press('Enter'); await expect(tray).toBeHidden();
  const checked = await snapshot(page); expect(checked.summary!.transformSession).toBeNull();
  expect(checked.summary!.revision).toBe(before.summary!.revision); expect(checked.packed).toEqual(before.packed);
  await info.attach('shipping-v7-idle-owner-keyboard', {body: JSON.stringify({before, checked, browserFind}), contentType: 'application/json'});
});

test('shipping first-run tour opens the sample and resolves translated copy in every supported locale', async ({context}, info) => {
  test.setTimeout(240_000);
  for (const locale of LOCALES) {
    const current = await context.newPage();
    try {
      await preferences(current, {locale, offer: true}); await current.goto('/');
      await expect(current.locator('html')).toHaveAttribute('lang', locale);
      await expect(layer(current)).toHaveAttribute('data-tutorial-phase', 'offer');
      await card(current).locator('.tutorial-start').click();
      await walk(current, locale);
      // First-run Start opens the sample scene behind the tour.
      expect(await current.locator('main').getAttribute('data-scene-ready')).toBe('true');
      await info.attach(`shipping-v7-${locale}-last.png`, {body: await current.screenshot(), contentType: 'image/png'});
      await card(current).locator('.tutorial-card-actions button').last().click(); await expect(layer(current)).toHaveCount(0);
      expect(JSON.parse((await current.evaluate(key => localStorage.getItem(key), KEY))!).tutorial_version).toBe(7);
    } finally { await current.close(); }
  }
});

for (const factor of [2, 4] as const) zoomTest(`shipping v7 new targets reflow at actual ${factor * 100}% browser zoom across themes, font sizes and profiles`, async ({page, zoom}, info) => {
  zoomTest.setTimeout(240_000);
  // Each reload reads exactly one updated fixture object, avoiding accumulating
  // init scripts whose relative execution order could select the wrong locale.
  await page.addInitScript(() => {
    const values = JSON.parse(sessionStorage.getItem('tutorial-reflow-fixture') ?? '{}') as Record<string, string>;
    localStorage.setItem('splatview.ui-language.v1', 'de');
    localStorage.setItem('splatview.tools-mode.v1', values.mode ?? 'basic');
    localStorage.setItem('splatview.ui-size.v1', values.size ?? 'small');
    localStorage.setItem('splatview.ui-theme.v1', values.theme ?? 'dark');
    localStorage.setItem('splatview.tutorial.v1', '{}');
  });
  await page.goto('/');
  for (const [index, theme] of THEMES.entries()) {
    const mode = index % 2 ? 'pro' : 'basic', size = (['small', 'medium', 'large'] as const)[index % 3];
    await page.evaluate(values => sessionStorage.setItem('tutorial-reflow-fixture', JSON.stringify(values)), {theme, mode, size});
    await page.reload();
    // The extension uses actual automatic/per-tab zoom, which resets on
    // navigation. Reapply and observe it for every newly loaded theme variant.
    const actual = await zoom.set(factor);
    expect(actual.width).toBe(1280 / factor); expect(actual.height).toBe(800 / factor);
    expect(actual.dpr).toBeCloseTo(factor, 12);
    expect(await page.evaluate(() => ({width: innerWidth, height: innerHeight, dpr: devicePixelRatio})))
      .toEqual({width: actual.width, height: actual.height, dpr: actual.dpr});
    await expect(layer(page)).toHaveAttribute('data-tutorial-phase', 'offer');
    await expect(page.locator('main')).toHaveAttribute('data-ui-size', size);
    await expect(page.locator('html')).toHaveAttribute('data-ui-theme', theme);
    expect(await page.evaluate(() => localStorage.getItem('splatview.tools-mode.v1'))).toBe(mode);
    const prefs = await savedPreferences(page); await card(page).locator('.tutorial-start').click();
    for (const item of COURSE) {
      await expect(layer(page)).toHaveAttribute('data-tutorial-step', String(item.index));
      if (NEW_TARGETS.includes(item.target as typeof NEW_TARGETS[number])) {
        await step(page, item, 'de');
        await card(page).locator('.tutorial-card-body').focus(); await page.keyboard.press('Tab');
        await reachable(card(page).locator('.tutorial-card-actions button').first());
      }
      if (item.target === 'gizmo') break;
      await card(page).locator('.tutorial-card-actions button').last().click();
    }
    await info.attach(`shipping-v7-zoom-${factor}-${theme}-${size}-${mode}.png`, {body: await page.screenshot(), contentType: 'image/png'});
    await page.keyboard.press('Escape'); await expect(layer(page)).toHaveCount(0); expect(await savedPreferences(page)).toEqual(prefs);
    expect(await page.evaluate(() => ({width: innerWidth, height: innerHeight, dpr: devicePixelRatio})))
      .toEqual({width: actual.width, height: actual.height, dpr: actual.dpr});
  }
});
