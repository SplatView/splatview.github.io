import { expect, test, type Page } from '@playwright/test';
import type {} from './opacity-harness';

// Pin browser preferences independently of the host OS and the product catalog.
test.use({ locale: 'en-US' });

const LANGUAGE_KEY = 'splatview.ui-language.v1';
const SOURCE_NAME = 'literal-%u-設定-brightness.ply';
const ORDER = [
  ['system', 'System default'], ['en', 'English'], ['es', 'Español'], ['fr', 'Français'],
  ['de', 'Deutsch'], ['pt', 'Português'], ['zh-Hans', '简体中文'], ['ja', '日本語'], ['ko', '한국어'],
] as const;
// Literal expectations checked against the captured translations.inc. Do not
// import the production translator/catalog to calculate expected UI wording.
const COPIES = [
  { code: 'en', settings: 'Settings', language: 'Language', theme: 'Theme', font: 'Font size', tools: 'Tools', basic: 'Basic', pro: 'Pro', selection: 'Selection', color: 'Color', brightness: 'Brightness', save: 'Save scene', cancel: 'Cancel', auto: 'Auto', translation: 'Translation', format: 'Export format', stats: '1/5 splats | SH3', progress: 'Applying edit',
    presets: ['neutral', 'warm', 'cool', 'vibrant', 'muted', 'cinematic', 'grayscale'] },
  { code: 'es', settings: 'Configuración', language: 'Idioma', theme: 'Tema', font: 'Tamaño de fuente', tools: 'Herramientas', basic: 'Básico', pro: 'Pro', selection: 'Selección', color: 'Color', brightness: 'Brillo', save: 'Guardar escena', cancel: 'Cancelar', auto: 'Automático', translation: 'Traslación', format: 'Formato de exportación', stats: '1/5 splats | SH3', progress: 'Aplicando edición',
    presets: ['Neutro', 'Cálido', 'Frío', 'Vivo', 'Apagado', 'Cinematográfico', 'Escala de grises'] },
  { code: 'fr', settings: 'Paramètres', language: 'Langue', theme: 'Thème', font: 'Taille du texte', tools: 'Outils', basic: 'Basique', pro: 'Pro', selection: 'Sélection', color: 'Couleur', brightness: 'Luminosité', save: 'Enregistrer la scène', cancel: 'Annuler', auto: 'Auto', translation: 'Translation', format: 'Format d’exportation', stats: '1/5 splats | SH3', progress: 'Application de la modification',
    presets: ['Neutre', 'Chaud', 'Froid', 'Vif', 'Atténué', 'Cinéma', 'Niveaux de gris'] },
  { code: 'de', settings: 'Einstellungen', language: 'Sprache', theme: 'Design', font: 'Schriftgröße', tools: 'Werkzeuge', basic: 'Basis', pro: 'Pro', selection: 'Auswahl', color: 'Farbe', brightness: 'Helligkeit', save: 'Szene speichern', cancel: 'Abbrechen', auto: 'Automatisch', translation: 'Verschiebung', format: 'Exportformat', stats: '1/5 Splats | SH3', progress: 'Änderung wird angewendet',
    presets: ['Neutral', 'Warm', 'Kühl', 'Lebhaft', 'Gedämpft', 'Filmisch', 'Graustufen'] },
  { code: 'pt', settings: 'Configurações', language: 'Idioma', theme: 'Tema', font: 'Tamanho da fonte', tools: 'Ferramentas', basic: 'Básico', pro: 'Pro', selection: 'Seleção', color: 'Cor', brightness: 'Brilho', save: 'Salvar cena', cancel: 'Cancelar', auto: 'Automático', translation: 'Translação', format: 'Formato de exportação', stats: '1/5 splats | SH3', progress: 'Aplicando edição',
    presets: ['Neutro', 'Quente', 'Frio', 'Vibrante', 'Suave', 'Cinematográfico', 'Escala de cinza'] },
  { code: 'zh-Hans', settings: '设置', language: '语言', theme: '主题', font: '字体大小', tools: '工具', basic: '基础', pro: '专业', selection: '选择', color: '颜色', brightness: '亮度', save: '保存场景', cancel: '取消', auto: '自动', translation: '平移', format: '导出格式', stats: '1/5 高斯点 | SH3', progress: '正在应用编辑',
    presets: ['中性', '暖色', '冷色', '鲜艳', '柔和', '电影感', '灰度'] },
  { code: 'ja', settings: '設定', language: '言語', theme: 'テーマ', font: '文字サイズ', tools: 'ツール', basic: '基本', pro: 'プロ', selection: '選択', color: 'カラー', brightness: '明るさ', save: 'シーンを保存', cancel: 'キャンセル', auto: '自動', translation: '移動', format: '書き出し形式', stats: '1/5 スプラット | SH3', progress: '編集を適用中',
    presets: ['ニュートラル', '暖色', '寒色', '鮮やか', '落ち着いた色', 'シネマ', 'グレースケール'] },
  { code: 'ko', settings: '설정', language: '언어', theme: '테마', font: '글꼴 크기', tools: '도구', basic: '기본', pro: '프로', selection: '선택', color: '색상', brightness: '밝기', save: '장면 저장', cancel: '취소', auto: '자동', translation: '이동', format: '내보내기 형식', stats: '1/5 스플랫 | SH3', progress: '편집 적용 중',
    presets: ['중립', '따뜻하게', '차갑게', '선명하게', '차분하게', '시네마틱', '회색조'] },
] as const;
const EXPORT_FORMATS = [
  ['0', 'Gaussian PLY (*.ply)'], ['8', 'SPZ v4 (*.spz)'], ['1', 'Legacy SPZ v3 (*.spz)'],
  ['2', 'SPLAT - DC colors (*.splat)'], ['3', 'SuperSplat compressed PLY (*.compressed.ply)'],
  ['4', 'KSPLAT - float geometry, byte DC colors (*.ksplat)'], ['5', 'Gaussian attributes CSV (*.csv)'],
  ['6', 'SOG v2 bundle (*.sog)'], ['7', 'Legacy SOGS v1 bundle (*.sogs)'],
];

const settings = (page: Page) => page.locator('.settings-dialog[role="dialog"]');
const language = (page: Page) => settings(page).locator('.language-trigger');
const menu = (page: Page) => page.locator('.ui-language-menu[role="listbox"]');
const option = (page: Page, code: string) => menu(page).locator(`[data-language="${code}"]`);
const root = (page: Page) => page.locator('html');
const saved = (page: Page) => page.evaluate(key => localStorage.getItem(key), LANGUAGE_KEY);
const snapshot = (page: Page) => page.evaluate(() => window.opacityHarness.snapshot());
const bakes = (commands: string[]) => commands.filter(command =>
  ['grade', 'autoColor', 'applyOpacity', 'resetOpacity', 'applyTransform', 'transform'].includes(command));
async function displayed(page: Page, code: string) {
  await expect(root(page)).toHaveAttribute('lang', code);
  await expect(root(page)).toHaveAttribute('data-ui-language', code);
}
async function settled(page: Page) {
  await expect.poll(() => page.evaluate(() => {
    const state = window.opacityHarness.state();
    return { busy: state.busy, ready: state.rendererState, error: state.error };
  })).toEqual({ busy: false, ready: 'ready', error: null });
}
async function choose(page: Page, code: string) {
  await language(page).click(); await option(page, code).click();
  await expect(menu(page)).toHaveCount(0);
}
async function closeSettings(page: Page) {
  await settings(page).locator('.panel-heading button').click();
  await expect(settings(page)).toHaveCount(0);
}
async function openSettings(page: Page, name = 'Settings') {
  await page.locator('.tools-panel').getByRole('button', { name, exact: true }).click();
  await expect(settings(page)).toBeVisible();
}
async function browserLanguages(page: Page, languages: string[], fallback = languages[0] ?? 'xx') {
  await page.evaluate(({ languages, fallback }) => {
    Object.defineProperty(navigator, 'languages', { configurable: true, value: languages });
    Object.defineProperty(navigator, 'language', { configurable: true, value: fallback });
    window.dispatchEvent(new Event('languagechange'));
  }, { languages, fallback });
}
function unchanged(after: Awaited<ReturnType<typeof snapshot>>, before: Awaited<ReturnType<typeof snapshot>>) {
  for (const key of ['records', 'gpuRecords', 'masks', 'gpuMasks', 'grade', 'appliedGrade', 'colorSession',
    'sourceName', 'sourceFingerprint', 'camera', 'tool', 'fly', 'autoOrbit', 'scale', 'document', 'deviceEpoch'] as const)
    expect(after[key], key).toEqual(before[key]);
  for (const key of ['contentRevision', 'selected', 'visible', 'canUndo', 'canRedo'] as const)
    expect(after.summary[key], key).toEqual(before.summary[key]);
}
async function rawFrame(page: Page) {
  // Read every rendered RGBA byte, not a page screenshot containing translated
  // chrome and not an export that could settle the pending grading owner.
  return page.evaluate(async () => {
    const app = window.geometryViewer.controllerForSourceNavigation(), state = window.opacityHarness.state();
    if (!app.scene || app.scene.kind !== 'gaussian' || !app.renderer || !app.camera) throw new Error('Actual Gaussian GPU scene required.');
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const blob = await app.renderer.capture(app.scene, app.camera, 'image/png', state.grade, identity,
      state.colorSession?.selectedOnly ?? false, false, 1, false);
    const bitmap = await createImageBitmap(blob);
    try {
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), context = canvas.getContext('2d')!;
      context.drawImage(bitmap, 0, 0);
      const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
      const digest = await crypto.subtle.digest('SHA-256', pixels);
      return { width: bitmap.width, height: bitmap.height,
        sha256: [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('') };
    } finally { bitmap.close(); }
  });
}

declare global {
  interface Window {
    restoreLanguageStorage?: () => void;
    languageNativeGate?: { entered: boolean; release(): void; restore(): void; finished: Promise<boolean> };
  }
}

test.beforeEach(async ({ page }) => {
  await page.goto('/e2e/opacity-harness.html');
  await page.waitForFunction(() => window.geometryViewerError || window.opacityHarness?.ready());
  expect(await page.evaluate(() => window.geometryViewerError)).toBeUndefined();
  await displayed(page, 'en');
  await page.evaluate(async name => {
    await window.opacityHarness.load(name); await window.opacityHarness.selectedFixture();
    await window.opacityHarness.command({ command: 'invert' });
    await window.opacityHarness.command({ command: 'undo' });
  }, SOURCE_NAME);
  await settled(page); await page.mouse.move(640, 400);
  if (!(await page.evaluate(() => window.opacityHarness.state())).toolsOpen)
    await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const brightness = page.locator('.tools-panel').getByRole('slider', { name: 'Brightness', exact: true });
  await brightness.press('Enter');
  await page.getByRole('textbox', { name: 'Brightness value', exact: true }).fill('1.25');
  await page.getByRole('textbox', { name: 'Brightness value', exact: true }).press('Enter');
  await openSettings(page);
});
test.afterEach(async ({ page }) => {
  await page.evaluate(async () => {
    const held = window.languageNativeGate;
    if (held) { held.release(); try { await held.finished; } finally { held.restore(); } }
    window.restoreLanguageStorage?.(); window.opacityHarness?.stop();
  });
});

test('native nine-choice order, autonyms and compact Language selector precede Theme and Font size', async ({ page }) => {
  const before = await snapshot(page); expect(before.summary.canRedo).toBe(true); expect(before.grade[0]).toBe(1.25);
  expect(await saved(page)).toBeNull();
  await expect(language(page)).toHaveAccessibleName('Language');
  await expect(language(page)).toHaveAttribute('aria-description', 'Current language: System default');
  await expect(language(page)).toHaveAttribute('title', 'Uses your browser display language. English is used when no supported language matches.');
  const languageBounds = (await language(page).boundingBox())!, themeBounds = (await settings(page).locator('.theme-trigger').boundingBox())!;
  expect(languageBounds.height).toBe(21); expect(languageBounds.y).toBeLessThan(themeBounds.y);
  expect(themeBounds.y).toBeLessThan((await settings(page).locator('.font-size-trigger').boundingBox())!.y);
  await language(page).click(); await expect(menu(page).getByRole('option')).toHaveCount(9);
  expect(await menu(page).getByRole('option').evaluateAll(items => items.map(item => (item as HTMLElement).dataset.language))).toEqual(ORDER.map(([code]) => code));
  for (const [index, [code, name]] of ORDER.entries()) {
    await expect(menu(page).getByRole('option').nth(index)).toHaveAccessibleName(name);
    expect((await option(page, code).boundingBox())!.height).toBe(28);
    await expect(option(page, code).locator('.icon svg')).toHaveCount(1);
  }
  await expect(option(page, 'system')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Escape'); unchanged(await snapshot(page), before);
});

test('real pointer preview translates chrome without saving or moving the committed selected dot', async ({ page }) => {
  const before = await snapshot(page); await language(page).click(); await option(page, 'es').hover();
  await displayed(page, 'es'); await expect(settings(page)).toHaveAccessibleName('Configuración');
  await expect(settings(page).getByRole('heading', { name: 'Configuración', exact: true })).toBeVisible();
  await expect(language(page)).toHaveAttribute('aria-description', 'Idioma actual: Español');
  await expect(page.locator('.tools-panel')).toHaveAccessibleName('Herramientas');
  await expect(option(page, 'system')).toHaveAttribute('aria-selected', 'true');
  await expect(option(page, 'es')).toHaveAttribute('aria-selected', 'false'); expect(await saved(page)).toBeNull();
  for (const [code, name] of ORDER.slice(1)) await expect(option(page, code)).toHaveAccessibleName(name);
  await option(page, 'ja').hover(); await displayed(page, 'ja');
  await expect(settings(page)).toHaveAccessibleName('設定');
  await page.mouse.move(20, 20); await displayed(page, 'en'); await expect(menu(page)).toBeVisible();
  await option(page, 'de').hover(); await displayed(page, 'de'); await page.keyboard.press('Escape');
  await displayed(page, 'en'); await expect(language(page)).toBeFocused(); expect(await saved(page)).toBeNull();
  unchanged(await snapshot(page), before);
});

test('keyboard visits all nine choices, wraps both ways, commits with Space and Tabs to Theme', async ({ page }) => {
  await settings(page).locator('.panel-heading button').focus();
  await page.keyboard.press('Tab'); await expect(settings(page).getByRole('tab', { name: 'General', exact: true })).toBeFocused();
  await page.keyboard.press('Tab'); await expect(language(page)).toBeFocused(); await page.keyboard.press('ArrowDown');
  for (const [index, [code, name]] of ORDER.entries()) {
    if (index) await page.keyboard.press('ArrowDown');
    await expect(option(page, code)).toBeFocused();
    await displayed(page, code === 'system' ? 'en' : code);
    if (code !== 'system') await expect(option(page, code)).toHaveAccessibleName(name);
    expect(await saved(page)).toBeNull();
  }
  await page.keyboard.press('ArrowDown'); await expect(option(page, 'system')).toBeFocused(); await displayed(page, 'en');
  await page.keyboard.press('ArrowUp'); await expect(option(page, 'ko')).toBeFocused();
  await page.keyboard.press('Home'); await expect(option(page, 'system')).toBeFocused();
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Space');
  await displayed(page, 'es'); expect(await saved(page)).toBe('es'); await expect(language(page)).toBeFocused();
  await language(page).press('ArrowDown'); await page.keyboard.press('End'); await displayed(page, 'ko');
  await page.keyboard.press('Tab'); await expect(menu(page)).toHaveCount(0); await displayed(page, 'es');
  await expect(settings(page).locator('.theme-trigger')).toBeFocused();
});

test('System follows ordered browser preferences and live languagechange while an explicit language stays fixed', async ({ page }) => {
  const before = await snapshot(page);
  await browserLanguages(page, ['xx-ZZ', 'PT_br', 'fr-FR']); await displayed(page, 'pt');
  await expect(settings(page)).toHaveAccessibleName('Configurações');
  await expect(language(page)).toHaveAttribute('aria-description', 'Idioma atual: Idioma do sistema'); expect(await saved(page)).toBeNull();
  await browserLanguages(page, ['xx', 'ar'], 'ja-JP'); await displayed(page, 'ja');
  await choose(page, 'en'); await browserLanguages(page, ['es-MX'], 'es-MX'); await displayed(page, 'en'); expect(await saved(page)).toBe('en');
  await choose(page, 'system'); await displayed(page, 'es'); expect(await saved(page)).toBe('system');
  await browserLanguages(page, ['english', 'xx-ZZ', 'ar'], 'xx'); await displayed(page, 'en');
  unchanged(await snapshot(page), before);
});

test('saved language reloads and invalid stored choices safely follow the pinned English browser preference', async ({ page }) => {
  await choose(page, 'fr'); await page.reload();
  await page.waitForFunction(() => window.geometryViewerError || window.opacityHarness?.ready());
  await displayed(page, 'fr'); expect(await saved(page)).toBe('fr');
  for (const invalid of ['future-language', 'ES-mx', '"ja"']) {
    await page.evaluate(({ key, invalid }) => localStorage.setItem(key, invalid), { key: LANGUAGE_KEY, invalid });
    await page.reload(); await page.waitForFunction(() => window.geometryViewerError || window.opacityHarness?.ready());
    await displayed(page, 'en'); expect(await saved(page)).toBe(invalid);
  }
  expect(await page.evaluate(() => window.geometryViewerError)).toBeUndefined();
});

test('a refused save rolls back preview and retrying the same committed language clears the error', async ({ page }) => {
  await choose(page, 'fr'); const before = await snapshot(page); await page.evaluate(() => window.opacityHarness.observe());
  await page.evaluate(key => {
    const original = Storage.prototype.setItem;
    window.restoreLanguageStorage = () => { Storage.prototype.setItem = original; delete window.restoreLanguageStorage; };
    Storage.prototype.setItem = function(name, value) {
      if (name === key) throw new DOMException('Test refusal', 'QuotaExceededError');
      original.call(this, name, value);
    };
  }, LANGUAGE_KEY);
  await language(page).click(); await option(page, 'ja').hover(); await displayed(page, 'ja'); await option(page, 'ja').click();
  await displayed(page, 'fr'); expect(await saved(page)).toBe('fr'); await expect(language(page)).toBeFocused();
  await expect(settings(page).getByRole('alert')).toHaveText('Impossible d’enregistrer la langue. La langue précédente est conservée. Réessayez lorsque le stockage local sera disponible.');
  unchanged(await snapshot(page), before); expect(bakes(await page.evaluate(() => window.opacityHarness.commands()))).toEqual([]);
  await page.evaluate(() => window.restoreLanguageStorage!());
  await choose(page, 'fr'); await expect(settings(page).getByRole('alert')).toHaveCount(0);
  await displayed(page, 'fr'); expect(await saved(page)).toBe('fr'); unchanged(await snapshot(page), before);
});

test('outside, blur, Tab, resize, ancestor scroll and Settings unmount cancel transient previews', async ({ page }) => {
  const before = await snapshot(page);
  for (const boundary of ['outside', 'blur', 'tab', 'resize', 'scroll', 'unmount'] as const) {
    const panel = settings(page).getByRole('tabpanel', { name: 'General', exact: true });
    if (boundary === 'scroll') await panel.evaluate(element => { (element as HTMLElement).style.maxHeight = '160px'; element.scrollTop = 0; });
    await language(page).click(); await option(page, 'es').hover(); await displayed(page, 'es');
    if (boundary === 'outside') await settings(page).locator('h1').click();
    else if (boundary === 'tab') await page.keyboard.press('Tab');
    else if (boundary === 'scroll') {
      expect(await panel.evaluate(element => { const previous = element.scrollTop; element.scrollTop += 16; return element.scrollTop > previous; })).toBe(true);
    } else if (boundary === 'unmount') await settings(page).getByRole('tab').nth(2).click();
    else await page.evaluate(boundary => window.dispatchEvent(new Event(boundary)), boundary);
    await expect(menu(page)).toHaveCount(0); await displayed(page, 'en'); expect(await saved(page)).toBeNull();
    if (boundary === 'tab') await expect(settings(page).locator('.theme-trigger')).toBeFocused();
    if (boundary === 'unmount') await settings(page).getByRole('tab', { name: 'General', exact: true }).click();
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await language(page).scrollIntoViewIfNeeded();
  }
  unchanged(await snapshot(page), before);
});

test('all eight languages preserve pending grade, exact native/GPU bytes, full raw capture and executable Undo/Redo', async ({ page }, info) => {
  const before = await snapshot(page), image = await rawFrame(page);
  expect(before.grade[0]).toBe(1.25); expect(before.appliedGrade[0]).toBe(1); expect(before.summary.canRedo).toBe(true);
  expect(before.masks).toEqual([0, 0, 1, 0, 0, 2]); await page.evaluate(() => window.opacityHarness.observe());
  await language(page).press('ArrowDown');
  for (const key of ['g', 'b', 'c', 'x', 'i', 'p', 'r', 'o', 'PageDown', 'Control+z', 'Meta+z']) await page.keyboard.press(key);
  await expect(menu(page)).toBeVisible(); await page.keyboard.press('Escape'); unchanged(await snapshot(page), before);
  const observations = [];
  for (const copy of COPIES) {
    await choose(page, copy.code); await displayed(page, copy.code);
    const current = await snapshot(page), capture = await rawFrame(page); unchanged(current, before); expect(capture).toEqual(image);
    expect(await saved(page)).toBe(copy.code); observations.push({ locale: copy.code, current, capture });
  }
  expect(bakes(await page.evaluate(() => window.opacityHarness.commands()))).toEqual([]);
  await choose(page, 'en'); await closeSettings(page);
  // History first cancels an unapplied grade; cancel it explicitly so the real
  // native Redo endpoint and its GPU mask publication are actually exercised.
  await page.getByRole('button', { name: 'Reset color preview', exact: true }).click(); await settled(page);
  const readyForRedo = await snapshot(page); expect(readyForRedo.masks).toEqual(before.masks); expect(readyForRedo.summary.canRedo).toBe(true);
  await page.locator('.tools-panel').getByRole('button', { name: 'Redo', exact: true }).click(); await settled(page);
  const redone = await snapshot(page); expect(redone.masks).toEqual([1, 1, 0, 1, 1, 2]); expect(redone.gpuMasks).toEqual(redone.masks);
  await page.locator('.tools-panel').getByRole('button', { name: 'Undo', exact: true }).click(); await settled(page);
  const undone = await snapshot(page); expect(undone.masks).toEqual(before.masks); expect(undone.gpuMasks).toEqual(undone.masks); expect(undone.summary.canRedo).toBe(true);
  await info.attach('language-native-gpu-rgba-history-preservation', { body: JSON.stringify({ before, image, observations, readyForRedo, redone, undone }), contentType: 'application/json' });
});

test('all eight literal catalogs cover toolbar, Settings, Basic Tools, menus, dialogs and composite field labels', async ({ page }, info) => {
  test.setTimeout(120_000);
  for (const copy of COPIES) {
    await choose(page, copy.code); await displayed(page, copy.code);
    await expect(settings(page)).toHaveAccessibleName(copy.settings); await expect(language(page)).toHaveAccessibleName(copy.language);
    await expect(settings(page).locator('.theme-trigger')).toHaveAccessibleName(copy.theme);
    await expect(settings(page).locator('.font-size-trigger')).toHaveAccessibleName(copy.font);
    await closeSettings(page);
    const tools = page.locator('.tools-panel'); await expect(tools).toHaveAccessibleName(copy.tools);
    await expect(tools.locator('.model-info')).toHaveText(SOURCE_NAME);
    await expect(tools.locator('.model-info')).toHaveAttribute('title', SOURCE_NAME);
    await expect(tools.locator('.model-stats')).toHaveText(copy.stats);
    await expect(tools.getByRole('heading', { name: copy.selection, exact: true })).toBeVisible();
    await expect(tools.getByRole('heading', { name: copy.color, exact: true })).toBeVisible();
    // web-lite hides the Basic/Pro toggle and excludes numeric transforms (transform.numeric).
    await expect(tools.locator('.mode-button')).toBeHidden();
    await expect(tools.getByRole('spinbutton', { name: `${copy.translation} X`, exact: true })).toHaveCount(0);
    await tools.getByRole('slider', { name: copy.brightness, exact: true }).press('Enter');
    const valueName = ({ en: 'Brightness value', es: 'Valor de Brillo', fr: 'Valeur de Luminosité', de: 'Wert für Helligkeit', pt: 'Valor de Brilho', 'zh-Hans': '亮度值', ja: '明るさの値', ko: '밝기 값' } as const)[copy.code];
    await expect(tools.getByRole('textbox', { name: valueName, exact: true })).toBeVisible();
    await tools.getByRole('textbox', { name: valueName, exact: true }).press('Enter');
    await tools.locator('.color-actions .color-selector').first().click();
    await expect(page.locator('.color-actions-menu').getByRole('menuitem', { name: copy.auto, exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await tools.locator('.color-actions .color-selector').nth(1).click();
    const presets = page.locator('.color-actions-menu').getByRole('menuitemradio');
    expect((await presets.allTextContents()).map(text => text.trim())).toEqual([...copy.presets]);
    expect(await presets.evaluateAll(items => items.map(item => (item as HTMLElement).dataset.choice))).toEqual(['0', '1', '2', '3', '4', '5', '6']);
    await presets.nth(1).click();
    await expect.poll(() => page.evaluate(() => window.opacityHarness.state().grade[5])).toBeCloseTo(11 / 15, 6);
    const grade = await page.evaluate(() => window.opacityHarness.state().grade);
    expect(grade.filter((_, index) => index !== 5)).toEqual([1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    await expect(tools.locator('.color-actions .color-selector').nth(1)).toContainText(copy.presets[1]);
    await page.getByRole('toolbar').getByRole('button', { name: copy.save, exact: true }).click();
    const dialog = page.locator('.dialog[role="dialog"]'); await expect(dialog).toHaveAccessibleName(copy.save);
    const format = dialog.getByRole('combobox').first(); await expect(format).toHaveAccessibleName(copy.format);
    await expect(format).toHaveValue('0');
    const formats = await format.locator('option').evaluateAll(items => items.map(item => [(item as HTMLOptionElement).value, item.textContent ?? '']));
    expect(formats.map(([value]) => value)).toEqual(['0', '8', '1', '2', '3', '4', '5', '6', '7']);
    expect(formats.map(([, label]) => label.match(/\(\*([.a-z]+)\)$/)?.[1])).toEqual(['.ply', '.spz', '.spz', '.splat', '.compressed.ply', '.ksplat', '.csv', '.sog', '.sogs']);
    expect(formats[1][1]).toBe('SPZ v4 (*.spz)');
    if (copy.code === 'en') expect(formats).toEqual(EXPORT_FORMATS);
    else expect(formats[0][1]).not.toBe('Gaussian PLY (*.ply)');
    await format.selectOption('8'); await expect(format).toHaveValue('8');
    await dialog.getByRole('button', { name: copy.cancel, exact: true }).click();
    await expect(tools.locator('.model-info')).toHaveText(SOURCE_NAME);
    await openSettings(page, copy.settings);
  }
  await info.attach('language-literal-catalog-coverage', { body: JSON.stringify(COPIES.map(copy => ({ locale: copy.code, settings: copy.settings, presets: copy.presets }))), contentType: 'application/json' });
});

test('real pending native work translates progress and Cancel across all eight catalogs', async ({ page }) => {
  await closeSettings(page); await page.getByRole('button', { name: 'Reset color preview', exact: true }).click(); await settled(page);
  await page.evaluate(() => {
    const app = window.geometryViewer.controllerForSourceNavigation(), client = app.client!, original = client.command;
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    const gate = { entered: false, release,
      restore: () => { client.command = original; delete window.languageNativeGate; }, finished: Promise.resolve(false) };
    window.languageNativeGate = gate;
    client.command = async function(...args) {
      const result = await original.apply(this, args);
      if (args[0].command === 'invert') { gate.entered = true; await held; }
      return result;
    };
    gate.finished = app.command({ command: 'invert' });
  });
  try {
    await expect.poll(() => page.evaluate(() => window.languageNativeGate!.entered)).toBe(true);
    await expect(page.locator('.status.panel').getByRole('progressbar')).toBeVisible();
    await openSettings(page); const before = await page.evaluate(() => window.opacityHarness.state());
    for (const copy of COPIES) {
      await choose(page, copy.code); await displayed(page, copy.code);
      const status = page.locator('.status.panel'); await expect(status.locator('span')).toHaveText(copy.progress);
      await expect(status.getByRole('progressbar', { name: copy.progress, exact: true })).toBeVisible();
      await expect(status.getByRole('button')).toHaveAccessibleName(copy.cancel);
      const during = await page.evaluate(() => window.opacityHarness.state());
      expect(during.camera).toEqual(before.camera); expect(during.sourceFingerprint).toEqual(before.sourceFingerprint);
      expect(during.deviceEpoch).toBe(before.deviceEpoch); expect(during.busy).toBe(true);
    }
  } finally {
    await page.evaluate(async () => {
      const gate = window.languageNativeGate!; gate.release();
      try { if (!await gate.finished) throw new Error('Actual native invert did not complete.'); } finally { gate.restore(); }
    });
  }
  await settled(page); await expect(page.locator('.status.panel')).toHaveCount(0);
});

test('saved language owns html lang on an empty page and unavailable preference reads fall back safely', async ({ page }) => {
  await page.evaluate(key => localStorage.setItem(key, 'ja'), LANGUAGE_KEY); await page.goto('/');
  await displayed(page, 'ja'); await expect(page.locator('main')).toHaveAttribute('data-scene-ready', 'false');
  await expect(page.getByRole('button', { name: 'シーンファイルを選択', exact: true })).toBeEnabled();
  await expect(page.locator('canvas')).toHaveCSS('visibility', 'hidden');
  await page.addInitScript(key => {
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = function(name) { if (name === key) throw new DOMException('Read refused', 'SecurityError'); return original.call(this, name); };
  }, LANGUAGE_KEY);
  await page.reload(); await displayed(page, 'en');
  await expect(page.getByRole('button', { name: 'Choose a scene file', exact: true })).toBeEnabled();
});

for (const size of ['small', 'large']) test(`${size} compact Language scroll reveals all choices and a stationary pointer cannot steal keyboard preview`, async ({ page }, info) => {
  await page.setViewportSize({ width: 420, height: 240 });
  await settings(page).locator('.font-size-trigger').click();
  await page.locator('.ui-size-menu [data-size="large"]').hover();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.locator('.ui-size-menu')).toBeVisible();
  await expect(page.locator('main')).toHaveAttribute('data-ui-size', 'large');
  await page.locator(`.ui-size-menu [data-size="${size}"]`).click();
  await language(page).scrollIntoViewIfNeeded(); const before = await snapshot(page);
  const panel = settings(page).locator('.settings-content[role="tabpanel"]:not([hidden])'), ancestorScroll = await panel.evaluate(element => element.scrollTop);
  await language(page).press('ArrowDown'); await option(page, 'es').hover(); await displayed(page, 'es');
  for (const [key, code] of [['End', 'ko'], ['Home', 'system'], ['End', 'ko']] as const) {
    await page.keyboard.press(key); await expect(option(page, code)).toBeFocused(); await displayed(page, code === 'system' ? 'en' : code);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await displayed(page, code === 'system' ? 'en' : code); await expect(option(page, code)).toBeInViewport({ ratio: 1 });
    const visible = await menu(page).evaluate((element, language) => {
      const item = element.querySelector<HTMLElement>(`[data-language="${language}"]`)!, row = item.getBoundingClientRect(), popup = element.getBoundingClientRect();
      const top = popup.top + element.clientTop, bottom = top + element.clientHeight;
      return { contained: row.top >= top - .25 && row.bottom <= bottom + .25, scroll: element.scrollTop };
    }, code);
    expect(visible.contained).toBe(true); if (code === 'ko') expect(visible.scroll).toBeGreaterThan(0);
    expect(await panel.evaluate(element => element.scrollTop)).toBe(ancestorScroll);
  }
  const bounds = (await menu(page).boundingBox())!; expect(bounds.x).toBeGreaterThanOrEqual(12); expect(bounds.y).toBeGreaterThanOrEqual(12);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(408); expect(bounds.y + bounds.height).toBeLessThanOrEqual(228);
  await page.keyboard.press('Enter'); await displayed(page, 'ko'); expect(await saved(page)).toBe('ko');
  expect((await language(page).boundingBox())!.height).toBe(size === 'small' ? 21 : 25); unchanged(await snapshot(page), before);
  await page.screenshot({ path: info.outputPath(`actual-language-ko-${size}-420x240.png`) });
});
