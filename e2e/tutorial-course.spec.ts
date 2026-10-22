import { expect, test, type Page } from '@playwright/test';

const layer = (page: Page) => page.locator('.tutorial-layer');
const card = (page: Page) => layer(page).locator('.tutorial-card[role="dialog"]');
const chooser = (page: Page) => card(page).locator('.tutorial-topics');
const topic = (page: Page, course: 'essentials' | 'all', id: string) =>
  chooser(page).locator(`[data-tutorial-topic-course="${course}"][data-tutorial-topic-id="${id}"]`);
const essentials = ['open', 'save', 'capture', 'navigation', 'tools', 'undo-redo', 'settings', 'thumbnail', 'scope',
  'histogram', 'brushes', 'area', 'combine', 'selection-edits', 'selection-finish', 'gizmo', 'color-reset',
  'auto-color', 'presets', 'color-slider'];
const excluded = ['modes', 'filter-choice', 'filter-confirm', 'refine', 'range', 'current-view', 'duplicate',
  'floor', 'transform-mode', 'coordinates', 'pivot', 'transform-values', 'pro-color', 'agent-access', 'measure'];

// Every case starts with the real first-run offer and a real sample intake.
test.use({ locale: 'en-US', storageState: { cookies: [], origins: [] } });

async function start(page: Page, locale = 'en') {
  await page.addInitScript(locale => {
    localStorage.setItem('splatview.ui-language.v1', locale);
    localStorage.removeItem('splatview.tutorial.v1');
  }, locale);
  await page.goto('/');
  await expect(layer(page)).toHaveAttribute('data-tutorial-phase', 'offer');
  await card(page).locator('.tutorial-start').click();
  await expect(layer(page)).toHaveAttribute('data-tutorial-phase', 'tour');
  await expect(page).toHaveTitle(/Bench example\.sog.*SplatView/);
  await expect(page.locator('.empty-state')).toHaveCount(0);
}

async function openTopics(page: Page) {
  const button = card(page).getByRole('button', { name: 'Topics', exact: true });
  await button.click();
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  await expect(chooser(page)).toBeVisible();
}

async function assertStep(page: Page, course: 'essentials' | 'all', id: string, total: number) {
  await expect(layer(page)).toHaveAttribute('data-tutorial-course', course);
  await expect(layer(page)).toHaveAttribute('data-tutorial-step-id', id);
  await expect(layer(page)).toHaveAttribute('data-tutorial-target-status', 'visible');
  const current = Number(await layer(page).getAttribute('data-tutorial-step'));
  await expect(card(page).getByRole('progressbar')).toHaveAttribute('aria-valuemin', '0');
  await expect(card(page).getByRole('progressbar')).toHaveAttribute('aria-valuemax', String(total));
  await expect(card(page).getByRole('progressbar')).toHaveAttribute('aria-valuenow', String(current));
  await expect(card(page).locator('.tutorial-counter')).toHaveText(`Tutorial ${current} / ${total}`);
}

type SpatialTarget = {
  id: string; target: string; frame: 'toolbar' | 'tools-panel';
  left: number; top: number; width: number; height: number;
  scrolls: { owner: string; left: number; top: number }[];
};
type ScreenRect = { left: number; top: number; right: number; bottom: number; width: number; height: number };
type CardPosition = {
  card: ScreenRect; body: ScreenRect; footer: ScreenRect; next: ScreenRect; nextFocused: boolean;
  cardZIndex: string;
  outlines: (ScreenRect & { zIndex: string; pointerEvents: string; inline: boolean })[];
  demo: null | { rect: ScreenRect; inline: boolean; insideBody: boolean; insideCard: boolean;
    inert: boolean; ariaHidden: string | null; buttons: number; disabledButtons: number };
};

async function cardPosition(page: Page): Promise<CardPosition> {
  // Let ResizeObserver-driven placement and its follow-up frame settle before
  // comparing successive lessons; no application measurement hook is added.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  return card(page).evaluate((panel): CardPosition => {
    const bounds = (element: Element): ScreenRect => {
      const { left, top, right, bottom, width, height } = element.getBoundingClientRect();
      return { left, top, right, bottom, width, height };
    };
    const body = panel.querySelector('.tutorial-card-body')!, footer = panel.querySelector('.tutorial-card-actions')!;
    const next = footer.querySelector('button:last-child')!;
    const root = panel.closest('.tutorial-layer')!;
    const demo = root.querySelector<HTMLElement>('[data-tutorial-demo="selection-finish"]');
    return { card: bounds(panel), body: bounds(body), footer: bounds(footer), next: bounds(next),
      nextFocused: document.activeElement === next, cardZIndex: getComputedStyle(panel).zIndex,
      outlines: Array.from(root.querySelectorAll('.tutorial-highlight'), outline => {
        const style = getComputedStyle(outline);
        return { ...bounds(outline), zIndex: style.zIndex, pointerEvents: style.pointerEvents,
          inline: outline.classList.contains('tutorial-highlight-inline') };
      }),
      demo: demo ? { rect: bounds(demo), inline: demo.dataset.tutorialInline === 'true',
        insideBody: body.contains(demo), insideCard: panel.contains(demo), inert: demo.inert,
        ariaHidden: demo.getAttribute('aria-hidden'), buttons: demo.querySelectorAll('button').length,
        disabledButtons: demo.querySelectorAll('button:disabled').length } : null };
  });
}

function overlapArea(a: ScreenRect, b: ScreenRect) {
  return Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
    Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
}

function nextDisplacement(before: CardPosition, after: CardPosition) {
  return Math.hypot(after.next.left + after.next.width / 2 - before.next.left - before.next.width / 2,
    after.next.top + after.next.height / 2 - before.next.top - before.next.height / 2);
}

async function targetPosition(page: Page, id: string, target: string): Promise<SpatialTarget> {
  return page.evaluate(({ id, target }): SpatialTarget => {
    // The first rendered control defines a topic's reading start. A topic can
    // span several buttons or rows; its trailing edge is not the next start.
    const element = Array.from(document.querySelectorAll<HTMLElement>(`[data-tutorial-target~="${CSS.escape(target)}"]`))
      .find(node => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden');
    if (!element) throw new Error(`Missing rendered tutorial target: ${id}`);
    const frame = element.closest<HTMLElement>('.toolbar, .tools-panel');
    if (!frame) throw new Error(`Missing spatial tutorial frame: ${id}`);
    const rect = element.getBoundingClientRect(), origin = frame.getBoundingClientRect();
    const scrolls: SpatialTarget['scrolls'] = [];
    let left = rect.left - origin.left, top = rect.top - origin.top;
    for (let owner = element.parentElement; owner; owner = owner.parentElement) {
      left += owner.scrollLeft; top += owner.scrollTop;
      if (owner.scrollLeft || owner.scrollTop)
        scrolls.push({ owner: owner.className, left: owner.scrollLeft, top: owner.scrollTop });
      if (owner === frame) break;
    }
    return { id, target, frame: frame.classList.contains('toolbar') ? 'toolbar' : 'tools-panel',
      left, top, width: rect.width, height: rect.height, scrolls };
  }, { id, target });
}

function expectReadingOrder(positions: Record<string, SpatialTarget>, ids: readonly string[]) {
  for (let index = 1; index < ids.length; index++) {
    const before = positions[ids[index - 1]], after = positions[ids[index]];
    expect(after.frame, `${before.id} and ${after.id} share their coordinate owner`).toBe(before.frame);
    if (Math.abs(after.top - before.top) <= 2)
      expect(after.left, `${before.id} precedes ${after.id} from left to right`).toBeGreaterThan(before.left + 1);
    else expect(after.top, `${before.id} precedes ${after.id} from top to bottom`).toBeGreaterThan(before.top + 2);
  }
}

function expectSameControl(before: SpatialTarget, after: SpatialTarget) {
  expect(after.frame).toBe(before.frame);
  for (const field of ['left', 'top', 'width', 'height'] as const)
    expect(Math.abs(after[field] - before[field]), `${before.id} and ${after.id} retain the shared ${field}`).toBeLessThan(1);
}

test.afterEach(async ({ page, browser }, info) => {
  const environment = await page.evaluate(async () => {
    const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
    return { userAgent: navigator.userAgent, platform: navigator.platform, origin: location.origin,
      secureContext: isSecureContext, webGpu: !!navigator.gpu, devicePixelRatio,
      viewport: { width: innerWidth, height: innerHeight },
      adapterProbe: adapter ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture,
        device: adapter.info.device, description: adapter.info.description, fallback: adapter.info.isFallbackAdapter } : null };
  });
  await info.attach('browser-environment.json', {
    body: JSON.stringify({ ...environment, browserVersion: browser.version() }), contentType: 'application/json',
  });
});

test('Essentials opens with the sample, chapter and progress; Topics jumps to All Fill and B/N navigate', async ({ page }) => {
  await start(page);
  await assertStep(page, 'essentials', 'open', 20);
  await expect(card(page).getByRole('heading', { name: 'Welcome to SplatView', exact: true })).toBeVisible();
  await expect(card(page).locator('.tutorial-chapter')).toHaveText('View and save');
  await expect(card(page).locator('.tutorial-course-kind')).toHaveText('Text tour');
  await expect(card(page).getByRole('button', { name: 'Back', exact: true })).toBeDisabled();
  await expect(card(page).getByRole('button', { name: /play/i })).toHaveCount(0);

  await openTopics(page);
  const tabs = chooser(page).getByRole('tablist', { name: 'Tutorial', exact: true });
  await expect(tabs.getByRole('tab', { name: 'Essentials', exact: true })).toHaveAttribute('aria-selected', 'true');
  await tabs.getByRole('tab', { name: 'All topics', exact: true }).click();
  await expect(chooser(page).locator('[data-tutorial-topic-course="all"]')).toHaveCount(34);
  await topic(page, 'all', 'fill').click();
  await expect(chooser(page)).toHaveCount(0);
  await assertStep(page, 'all', 'fill', 34);
  await expect(card(page).getByRole('heading', { name: 'Fill select', exact: true })).toBeVisible();
  await expect(card(page).locator('.tutorial-chapter')).toHaveText('Selection');
  await expect(layer(page)).toHaveAttribute('data-tutorial-active-target', 'fill');
  const fillIndex = Number(await layer(page).getAttribute('data-tutorial-step'));
  await page.keyboard.press('n');
  await expect(layer(page)).toHaveAttribute('data-tutorial-step', String(fillIndex + 1));
  await page.keyboard.press('b');
  await assertStep(page, 'all', 'fill', 34);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('course switching offers the reviewed Basic topics and N finishes the final Essentials lesson', async ({ page }) => {
  await start(page);
  await openTopics(page);
  await expect(chooser(page).locator('[data-tutorial-topic-course="essentials"]')).toHaveCount(20);
  expect(await chooser(page).locator('[data-tutorial-topic-course="essentials"]').evaluateAll(nodes =>
    nodes.map(node => node.getAttribute('data-tutorial-topic-id')))).toEqual(essentials);
  await chooser(page).getByRole('tab', { name: 'All topics', exact: true }).click();
  const allIds = await chooser(page).locator('[data-tutorial-topic-course="all"]').evaluateAll(nodes =>
    nodes.map(node => node.getAttribute('data-tutorial-topic-id')));
  expect(allIds).toHaveLength(34);
  expect(new Set(allIds).size).toBe(34);
  expect(allIds.slice(0, 8)).toEqual(['open', 'save', 'capture', 'navigation', 'auto-rotate', 'guides', 'lens', 'tools']);
  expect(allIds.slice(-4)).toEqual(['color-reset', 'auto-color', 'presets', 'color-slider']);
  expect(allIds.indexOf('combine')).toBeLessThan(allIds.indexOf('options'));
  for (const id of excluded) expect(allIds).not.toContain(id);
  await topic(page, 'all', 'gizmo').click();
  await assertStep(page, 'all', 'gizmo', 34);
  await openTopics(page);
  await chooser(page).getByRole('tab', { name: 'Essentials', exact: true }).click();
  await topic(page, 'essentials', 'gizmo').click();
  await assertStep(page, 'essentials', 'gizmo', 20);
  await expect(card(page).getByRole('heading', { name: 'Move, rotate and scale', exact: true })).toBeVisible();
  await openTopics(page);
  await topic(page, 'essentials', 'color-slider').click();
  await assertStep(page, 'essentials', 'color-slider', 20);
  await expect(card(page).getByRole('button', { name: 'Finish', exact: true })).toBeFocused();
  await page.keyboard.press('n');
  await expect(layer(page)).toHaveCount(0);
  await expect(page).toHaveTitle(/Bench example\.sog.*SplatView/);
  await expect(page.getByRole('button', { name: 'Save scene', exact: true })).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('Topics contains keyboard navigation; Escape returns focus and typing/modifier keys do not change lessons', async ({ page }) => {
  await start(page);
  await page.keyboard.press('b');
  await assertStep(page, 'essentials', 'open', 20);
  await page.keyboard.press('n');
  await assertStep(page, 'essentials', 'save', 20);
  await openTopics(page);
  await page.keyboard.press('n'); await page.keyboard.press('b');
  await expect(layer(page)).toHaveAttribute('data-tutorial-step-id', 'save');
  await expect(chooser(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(chooser(page)).toHaveCount(0);
  const next = card(page).getByRole('button', { name: 'Next', exact: true });
  await expect(next).toBeFocused();
  for (const flags of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true },
    { repeat: true }, { isComposing: true }]) {
    // Synthetic flags exercise repeat/composition precisely; ordinary B/N and
    // editable text below use actual keyboard input through the real dialog.
    await next.dispatchEvent('keydown', { key: 'n', code: 'KeyN', bubbles: true, ...flags });
    await expect(layer(page)).toHaveAttribute('data-tutorial-step-id', 'save');
  }
  await card(page).locator('.tutorial-card-body').evaluate(body => {
    const input = document.createElement('input');
    input.setAttribute('aria-label', 'Test tutorial text entry'); body.append(input); input.focus();
  });
  const input = card(page).getByRole('textbox', { name: 'Test tutorial text entry', exact: true });
  await input.pressSequentially('bn');
  await expect(input).toHaveValue('bn');
  await expect(layer(page)).toHaveAttribute('data-tutorial-step-id', 'save');
  await input.evaluate(node => node.remove());
  await next.focus(); await page.keyboard.press('b');
  await assertStep(page, 'essentials', 'open', 20);
  await page.keyboard.press('Escape');
  await expect(layer(page)).toHaveCount(0);
  await expect(page).toHaveTitle(/Bench example\.sog.*SplatView/);
  await expect(page.getByRole('button', { name: 'Save scene', exact: true })).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('All topics traverses all 34 available targets and leaves the sample intact', async ({ page }, info) => {
  await start(page);
  await openTopics(page);
  await chooser(page).getByRole('tab', { name: 'All topics', exact: true }).click();
  await topic(page, 'all', 'open').click();
  const targets: string[] = [];
  for (let index = 1; index <= 34; index++) {
    await expect(layer(page)).toHaveAttribute('data-tutorial-course', 'all');
    await expect(layer(page)).toHaveAttribute('data-tutorial-step', String(index));
    await expect(layer(page)).toHaveAttribute('data-tutorial-target-status', 'visible');
    await expect(card(page).getByRole('progressbar')).toHaveAttribute('aria-valuenow', String(index));
    await expect(card(page).getByRole('progressbar')).toHaveAttribute('aria-valuemax', '34');
    const target = await layer(page).getAttribute('data-tutorial-active-target');
    expect(target).toBeTruthy(); targets.push(target!);
    await expect(page.locator(`[data-tutorial-target~="${target}"]:visible`).first()).toBeVisible();
    await expect(layer(page).locator('.tutorial-highlight').first()).toBeVisible();
    await card(page).getByRole('button', { name: index === 34 ? 'Finish' : 'Next', exact: true }).click();
  }
  await expect(layer(page)).toHaveCount(0);
  await expect(page).toHaveTitle(/Bench example\.sog.*SplatView/);
  await expect(page.getByRole('button', { name: 'Save scene', exact: true })).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await info.attach('all-topic-targets.json', { body: JSON.stringify({ total: 34, targets }), contentType: 'application/json' });
});

for (const width of [1280, 390]) test(`All topics follows rendered reading positions across rows and local scrolling at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 620 });
  await start(page);
  await openTopics(page);
  await chooser(page).getByRole('tab', { name: 'All topics', exact: true }).click();
  await topic(page, 'all', 'open').click();
  const positions: Record<string, SpatialTarget> = {};
  const cards: Record<string, CardPosition> = {};
  const visited: string[] = [];
  for (let index = 1; index <= 34; index++) {
    await expect(layer(page)).toHaveAttribute('data-tutorial-step', String(index));
    await expect(layer(page)).toHaveAttribute('data-tutorial-target-status', 'visible');
    const id = (await layer(page).getAttribute('data-tutorial-step-id'))!;
    const target = (await layer(page).getAttribute('data-tutorial-active-target'))!;
    visited.push(id);
    // Finish-selection is a contextual floating example, outside panel flow.
    if (id !== 'selection-finish') positions[id] = await targetPosition(page, id, target);
    cards[id] = await cardPosition(page);
    await card(page).getByRole('button', { name: index === 34 ? 'Finish' : 'Next', exact: true }).click();
  }
  const continuity = [['selection-edits', 'selection-finish'], ['selection-finish', 'transform-reset']].map(([before, after]) => ({
    before, after, leftDelta: cards[after].card.left - cards[before].card.left,
    topDelta: cards[after].card.top - cards[before].card.top,
    nextDisplacement: nextDisplacement(cards[before], cards[after]),
  }));
  // Keep the measured geometry available even when a continuity assertion fails.
  await info.attach('tutorial-spatial-positions.json', {
    body: JSON.stringify({ viewport: { width, height: 620 }, visited, positions, cards, continuity }), contentType: 'application/json',
  });
  await expect(layer(page)).toHaveCount(0);
  expect(new Set(visited).size).toBe(34);
  for (const position of Object.values(cards)) expect(position.outlines.length).toBeGreaterThan(0);
  for (const transition of continuity) {
    // Compact Reset transform follows its own visible target column. Finish
    // selection stays with Delete/Keep; the wide side column stays constant.
    if (transition.after === 'selection-finish' || width === 1280)
      expect(Math.abs(transition.leftDelta), `${transition.before} to ${transition.after} retains the card column`).toBeLessThan(1);
    expect(Math.abs(transition.topDelta), `${transition.before} to ${transition.after} stays near the panel row`).toBeLessThan(80);
    expect(transition.nextDisplacement, `${transition.before} to ${transition.after} avoids a Next-button detour`).toBeLessThan(100);
  }
  const finish = cards['selection-finish'], demo = finish.demo;
  expect(demo).not.toBeNull();
  expect(demo!.inline).toBe(width === 390);
  expect(demo!.insideBody).toBe(demo!.inline); expect(demo!.insideCard).toBe(demo!.inline);
  expect(demo!.inert).toBe(true); expect(demo!.ariaHidden).toBe('true');
  expect(demo!.buttons).toBe(3); expect(demo!.disabledButtons).toBe(3);
  expect(finish.nextFocused).toBe(true);
  expect(finish.footer.top).toBeGreaterThanOrEqual(finish.card.top);
  expect(finish.footer.bottom).toBeLessThanOrEqual(finish.card.bottom);
  expect(finish.next.top).toBeGreaterThanOrEqual(0); expect(finish.next.bottom).toBeLessThanOrEqual(620);
  expect(finish.outlines.some(outline => overlapArea(outline, demo!.rect) > 0)).toBe(true);
  const finishOutline = finish.outlines.find(outline => overlapArea(outline, demo!.rect) > 0)!;
  expect(finishOutline.pointerEvents).toBe('none');
  expect(finishOutline.inline).toBe(demo!.inline);
  expect(Number.isFinite(Number(finishOutline.zIndex))).toBe(true);
  expect(Number.isFinite(Number(finish.cardZIndex))).toBe(true);
  expect(Math.abs(finishOutline.left - (demo!.rect.left - 2))).toBeLessThan(1);
  expect(Math.abs(finishOutline.top - (demo!.rect.top - 2))).toBeLessThan(1);
  expect(Math.abs(finishOutline.right - (demo!.rect.right + 2))).toBeLessThan(1);
  expect(Math.abs(finishOutline.bottom - (demo!.rect.bottom + 2))).toBeLessThan(1);
  if (demo!.inline) {
    expect(Number(finishOutline.zIndex)).toBeGreaterThan(Number(finish.cardZIndex));
    expect(demo!.rect.left).toBeGreaterThanOrEqual(finish.body.left - 1);
    expect(demo!.rect.right).toBeLessThanOrEqual(finish.body.right + 1);
    expect(demo!.rect.top).toBeGreaterThanOrEqual(finish.body.top - 1);
    expect(demo!.rect.bottom).toBeLessThanOrEqual(finish.body.bottom + 1);
    expect(overlapArea(demo!.rect, finish.footer)).toBe(0);
  } else {
    expect(Number(finishOutline.zIndex)).toBeLessThan(Number(finish.cardZIndex));
    expect(overlapArea(demo!.rect, finish.card)).toBe(0);
  }
  expectReadingOrder(positions, ['open', 'save', 'capture', 'navigation', 'auto-rotate', 'guides', 'lens', 'tools']);
  expectReadingOrder(positions, ['undo-redo', 'settings', 'scope', 'histogram', 'cleanup-reset', 'single']);
  expectSameControl(positions.settings, positions.thumbnail);
  for (const id of ['brushes', 'area', 'color-select', 'fill']) expectSameControl(positions.single, positions[id]);
  expectReadingOrder(positions, ['fill', 'combine', 'options', 'actions', 'selection-edits']);
  expect(Math.abs(positions.options.top - positions.combine.top)).toBeLessThan(2);
  expectReadingOrder(positions, ['selection-edits', 'transform-reset', 'pick-center', 'gizmo', 'snap-flips', 'color-reset', 'auto-color', 'presets', 'color-slider']);
  for (const id of ['scale-align', 'plane-align']) expectSameControl(positions['pick-center'], positions[id]);
  expect(Object.values(positions).some(position => position.scrolls.some(scroll => scroll.top > 0))).toBe(true);
  await expect(page).toHaveTitle(/Bench example\.sog.*SplatView/);
  await expect(page.getByRole('button', { name: 'Save scene', exact: true })).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

for (const locale of [
  { id: 'de', width: 390, height: 620, textTour: 'Textführung', topics: 'Themen', all: 'Alle Themen',
    essentials: 'Grundlagen', chapter: 'Ansicht und Speichern' },
  { id: 'zh-Hans', width: 1280, height: 800, textTour: '文字教程', topics: '主题', all: '全部主题',
    essentials: '基础入门', chapter: '查看与保存' },
]) test(`${locale.id} localizes course chrome and keeps navigation and Exit visible at ${locale.width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width: locale.width, height: locale.height });
  await start(page, locale.id);
  await expect(card(page).locator('.tutorial-course-kind')).toHaveText(locale.textTour);
  await expect(card(page).locator('.tutorial-chapter')).toHaveText(locale.chapter);
  const topics = card(page).getByRole('button', { name: locale.topics, exact: true });
  await topics.click();
  await expect(topics).toHaveAttribute('aria-expanded', 'true');
  await expect(chooser(page).getByRole('tab', { name: locale.essentials, exact: true })).toHaveAttribute('aria-selected', 'true');
  await chooser(page).getByRole('tab', { name: locale.all, exact: true }).click();
  await expect(chooser(page).locator('[data-tutorial-topic-course="all"]')).toHaveCount(34);
  const footer = card(page).locator('.tutorial-card-actions');
  const before = await footer.boundingBox();
  expect(before).not.toBeNull();
  const scroll = await card(page).locator('.tutorial-card-body').evaluate(node => {
    node.scrollTop = node.scrollHeight; return { top: node.scrollTop, maximum: node.scrollHeight - node.clientHeight };
  });
  expect(scroll.maximum).toBeGreaterThan(0); expect(scroll.top).toBeGreaterThan(0);
  await expect(footer).toBeInViewport({ ratio: 1 });
  const after = await footer.boundingBox();
  expect(Math.abs(after!.y - before!.y)).toBeLessThan(1);
  const close = card(page).locator('.tutorial-step-heading .icon-button:not([aria-expanded])');
  await expect(close).toBeInViewport({ ratio: 1 });
  const bounds = await card(page).boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(locale.width + 1);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(locale.height + 1);
  await info.attach('localized-course-layout.json', { body: JSON.stringify({ locale, before, after, scroll, bounds }), contentType: 'application/json' });
  await close.click();
  await expect(layer(page)).toHaveCount(0);
  await expect(page).toHaveTitle(/Bench example\.sog.*SplatView/);
  await expect(page.getByRole('alert')).toHaveCount(0);
});
