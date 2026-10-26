import { expect, test, type Page } from '@playwright/test';
import { NEUTRAL_COLOR } from '../src/renderer/defaults';

const tools = (page: Page) => page.getByRole('complementary', { name: 'Tools', exact: true });
const auto = (page: Page) => tools(page).getByRole('button', { name: 'Auto color', exact: true });
const presets = (page: Page) => tools(page).getByRole('button', { name: 'Color preset', exact: true });
const autoMenu = (page: Page) => page.getByRole('menu', { name: 'Auto color actions', exact: true });
const presetMenu = (page: Page) => page.getByRole('menu', { name: 'Color presets', exact: true });
const scene = (page: Page) => page.getByLabel('SplatView scene', { exact: true });
const snapshot = (page: Page) => page.evaluate(() => window.autoColorHarness.snapshot());
async function settled(page: Page) {
  await expect.poll(() => page.evaluate(() => window.autoColorHarness.state())).toMatchObject({ busy: false, controlsEnabled: true });
}
async function boot(page: Page, mode: 'basic' | 'pro' = 'basic') {
  await page.addInitScript(value => localStorage.setItem('splatview.tools-mode.v1', value), mode);
  await page.goto('/e2e/auto-color-harness.html');
  await expect.poll(() => page.evaluate(() => window.autoColorHarness?.ready() ?? false)).toBe(true);
  await page.evaluate(() => window.autoColorHarness.load()); await settled(page);
  await auto(page).scrollIntoViewIfNeeded();
  await tools(page).getByRole('heading', { name: 'Tools', exact: true }).hover();
}
async function start(page: Page) {
  const color = await snapshot(page), gpu = await page.evaluate(() => window.geometryViewer.keyboardStart());
  return { color, gpu };
}
function retained(actual: Awaited<ReturnType<typeof snapshot>>, expected: Awaited<ReturnType<typeof snapshot>>) {
  for (const key of ['exported', 'records', 'grade', 'appliedGrade', 'colorSession', 'colorSelectedOnly', 'colorPending',
    'sourceFingerprint', 'camera', 'background', 'dirty'] as const) expect(actual[key], key).toEqual(expected[key]);
  expect(actual.summary).toEqual(expected.summary); expect(actual.workBytes).toBe(0);
  expect(actual.capture.hash).toBe(expected.capture.hash);
}
async function finish(page: Page, before: Awaited<ReturnType<typeof start>>) {
  const observed = await page.evaluate(() => window.geometryViewer.keyboardFinish());
  // The observer forwards the actual CoreClient calls. Passive menu interaction
  // can request summary observations, but must never dispatch a native edit.
  expect(observed.calls.filter(command => command !== 'summary')).toEqual([]);
  expect(observed.after.gpuMasks).toEqual(before.gpu.gpuMasks);
  expect(observed.after.exported).toBe(before.gpu.exported);
  expect(observed.after.deviceEpoch).toBe(before.gpu.deviceEpoch);
  retained(await snapshot(page), before.color);
  await expect(page.getByRole('alert')).toHaveCount(0);
}

// web-lite has no Pro mode; the timed hover contract is exercised in Basic.
for (const mode of ['basic'] as const) test(`${mode} timed color hover keeps canvas focus, native bytes, GPU output and executable Redo`, async ({ page }, testInfo) => {
  await boot(page, mode);
  const values = [...NEUTRAL_COLOR]; values[0] = 1.2;
  await page.evaluate(values => window.autoColorHarness.preview(values), values);
  await tools(page).getByRole('button', { name: 'Apply color', exact: true }).click(); await settled(page);
  const baked = await snapshot(page);
  await tools(page).getByRole('button', { name: 'Undo', exact: true }).click(); await settled(page);
  const before = await start(page); expect(before.color.summary.canRedo).toBe(true);
  await scene(page).focus(); await auto(page).hover();
  await page.waitForTimeout(160); await expect(autoMenu(page)).toHaveCount(0); await expect(scene(page)).toBeFocused();
  await expect(autoMenu(page)).toBeVisible(); await expect(scene(page)).toBeFocused();
  await autoMenu(page).getByRole('menuitem', { name: 'Exposure', exact: true }).hover();
  await expect(scene(page)).toBeFocused(); await page.waitForTimeout(360);
  await expect(autoMenu(page)).toBeVisible();
  await tools(page).getByRole('heading', { name: 'Tools', exact: true }).hover();
  await page.waitForTimeout(160); await expect(autoMenu(page)).toBeVisible();
  await expect(autoMenu(page)).toHaveCount(0); await expect(scene(page)).toBeFocused();
  await finish(page, before);
  await tools(page).getByRole('button', { name: 'Redo', exact: true }).click(); await settled(page);
  expect((await snapshot(page)).exported).toBe(baked.exported);
  await tools(page).getByRole('button', { name: 'Undo', exact: true }).click(); await settled(page);
  // Native history's monotonic revision advances once for each deliberate
  // replay. Content revision, bytes, fields and history flags return exactly.
  retained(await snapshot(page), { ...before.color, summary: { ...before.color.summary, revision: before.color.summary.revision + 2 } });
  await testInfo.attach('passive-color-hover-native-gpu-retained', { contentType: 'application/json', body: JSON.stringify({ before, baked }) });
});

test('color selector bridge, click pin, second-click suppression and direct Auto/Presets switching are passive', async ({ page }) => {
  await boot(page); const before = await start(page); await scene(page).focus();
  await auto(page).hover(); await expect(autoMenu(page)).toBeVisible();
  const trigger = (await auto(page).boundingBox())!, menu = (await autoMenu(page).boundingBox())!;
  expect(menu.x + menu.width).toBeLessThan(trigger.x);
  const edge = menu.x + menu.width, gap = trigger.x - edge;
  const y = Math.max(menu.y + 6, Math.min(trigger.y + trigger.height / 2, menu.y + menu.height - 6));
  // Spend longer than one away-close interval crossing the gap, while each
  // fresh movement toward the menu renews its native directional bridge.
  for (const fraction of [.7, .3]) {
    await page.mouse.move(edge + gap * fraction, y, { steps: 6 }); await page.waitForTimeout(180);
    await expect(autoMenu(page)).toBeVisible();
  }
  await page.mouse.move(menu.x + menu.width - 8, y, { steps: 8 });
  await page.waitForTimeout(360); await expect(autoMenu(page)).toBeVisible(); await expect(scene(page)).toBeFocused();
  await auto(page).click(); // Pins an already hover-open selector; no action is chosen.
  await tools(page).getByRole('heading', { name: 'Tools', exact: true }).hover();
  await page.waitForTimeout(420); await expect(autoMenu(page)).toBeVisible();
  await presets(page).hover(); await expect(presetMenu(page)).toBeVisible(); await expect(autoMenu(page)).toHaveCount(0);
  await expect(presetMenu(page).getByRole('menuitemradio')).toHaveCount(7);
  await auto(page).hover(); await expect(autoMenu(page)).toBeVisible(); await expect(presetMenu(page)).toHaveCount(0);
  await auto(page).click(); await expect(autoMenu(page)).toBeVisible(); // Hover-open -> pinned.
  await auto(page).click(); await expect(autoMenu(page)).toHaveCount(0);
  await page.waitForTimeout(420); await expect(autoMenu(page)).toHaveCount(0);
  await tools(page).getByRole('heading', { name: 'Tools', exact: true }).hover(); await auto(page).hover();
  await expect(autoMenu(page)).toBeVisible(); await page.keyboard.press('Escape');
  await expect(auto(page)).toBeFocused(); await finish(page, before);
});

test('holding a pointer button prevents delayed color hover opening until release', async ({ page }) => {
  await boot(page); const before = await start(page);
  await tools(page).getByRole('heading', { name: 'Tools', exact: true }).hover(); await page.mouse.down();
  try {
    await auto(page).hover(); await page.waitForTimeout(420); await expect(autoMenu(page)).toHaveCount(0);
  } finally { await page.mouse.up(); }
  await expect(autoMenu(page)).toBeVisible(); await page.keyboard.press('Escape'); await finish(page, before);
});

test('color menus retire on Escape, Tab, consumed outside press, resize, actual anchor scroll and Tools unmount', async ({ page }) => {
  await boot(page); const before = await start(page);
  await auto(page).click(); await expect(autoMenu(page)).toBeVisible(); await page.keyboard.press('Escape');
  await expect(autoMenu(page)).toHaveCount(0); await expect(auto(page)).toBeFocused();
  await auto(page).press('ArrowDown'); await expect(autoMenu(page)).toBeVisible(); await page.keyboard.press('Tab');
  await expect(autoMenu(page)).toHaveCount(0); await expect(presets(page)).toBeFocused();
  await auto(page).click(); await expect(autoMenu(page)).toBeVisible();
  const heading = tools(page).getByRole('heading', { name: 'Tools', exact: true }); await heading.click();
  await expect(autoMenu(page)).toHaveCount(0);
  await auto(page).click(); await expect(autoMenu(page)).toBeVisible();
  // The native-density Basic panel fits a 790px viewport. Use a genuinely
  // overflowing body, above the separate <=480px whole-panel scroll layout.
  await page.setViewportSize({ width: 1270, height: 500 }); await expect(autoMenu(page)).toHaveCount(0);
  await expect.poll(() => tools(page).locator('.tools-body').evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  await auto(page).click(); await expect(autoMenu(page)).toBeVisible();
  const changed = await tools(page).locator('.tools-body').evaluate(element => {
    const before = element.scrollTop; element.scrollTop = before > 0 ? before - 1 : 1; return element.scrollTop !== before;
  });
  expect(changed).toBe(true); await expect(autoMenu(page)).toHaveCount(0);
  await auto(page).click(); await expect(autoMenu(page)).toBeVisible();
  // A real outside press is consumed, so the second activation closes Tools.
  const toggle = page.getByRole('button', { name: 'Tools', exact: true });
  await toggle.click(); await expect(autoMenu(page)).toHaveCount(0); await expect(tools(page)).toBeVisible();
  await toggle.click(); await expect(tools(page)).toHaveCount(0); await page.waitForTimeout(420); await expect(autoMenu(page)).toHaveCount(0);
  await toggle.click(); await expect(tools(page)).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 800 }); await finish(page, before);
});

test('compact keyboard rows reveal in their own scroll area and stationary pointer cannot replace focus after scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 500 }); await boot(page); const before = await start(page);
  await presets(page).press('ArrowDown'); const menu = presetMenu(page); await expect(menu).toBeVisible();
  // Basic offers seven presets; only an overflowing menu owns a nonzero scroll.
  await expect(menu.getByRole('menuitemradio')).toHaveCount(7);
  const scrolls = await menu.evaluate(element => element.scrollHeight > element.clientHeight);
  const positions = () => tools(page).locator('.tools-body').evaluate(element => ({ top: element.scrollTop, page: window.scrollY }));
  const anchor = await positions();
  await page.keyboard.press('End'); const last = menu.getByRole('menuitemradio', { name: 'grayscale', exact: true });
  await expect(last).toBeFocused();
  const visible = async () => {
    const bounds = (await menu.boundingBox())!, row = (await last.boundingBox())!;
    expect(row.y).toBeGreaterThanOrEqual(bounds.y); expect(row.y + row.height).toBeLessThanOrEqual(bounds.y + bounds.height);
  };
  await visible(); if (scrolls) expect(await menu.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  // Leave the real pointer inside the portal, then use keyboard scrolling.
  const bounds = (await menu.boundingBox())!; await page.mouse.move(bounds.x + 25, bounds.y + 25);
  await page.keyboard.press('Home'); const first = menu.getByRole('menuitemradio', { name: 'neutral', exact: true });
  await expect(first).toBeFocused(); await page.waitForTimeout(180); await expect(first).toHaveAttribute('tabindex', '0');
  expect(await menu.evaluate(element => element.scrollTop)).toBe(0);
  await page.keyboard.press('End'); await expect(last).toBeFocused(); await page.waitForTimeout(180);
  await expect(last).toHaveAttribute('tabindex', '0'); await visible(); expect(await positions()).toEqual(anchor);
  await page.keyboard.press('Escape'); await expect(presets(page)).toBeFocused(); await expect(menu).toHaveCount(0);
  await finish(page, before);
});

test('other menus and modal ownership prevent color hover admission without edits', async ({ page }) => {
  await boot(page); const before = await start(page);
  const selection = tools(page).getByRole('button', { name: 'Selection tool', exact: true });
  await selection.click(); const menu = page.getByRole('menu', { name: 'Selection tools', exact: true }); await expect(menu).toBeVisible();
  await auto(page).hover(); await page.waitForTimeout(420); await expect(menu).toBeVisible(); await expect(autoMenu(page)).toHaveCount(0);
  await page.keyboard.press('Escape'); await expect(menu).toHaveCount(0);
  await tools(page).getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true }); await expect(settings).toBeVisible();
  const bounds = (await auto(page).boundingBox())!; await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.waitForTimeout(420); await expect(autoMenu(page)).toHaveCount(0); await expect(settings).toBeVisible();
  await page.keyboard.press('Escape'); await expect(settings).toHaveCount(0); await finish(page, before);
});

test('real window blur retires an open color menu and a pending hover without delayed reopen', async ({ page, context }) => {
  await boot(page); const before = await start(page), outside = await context.newPage();
  const session = await context.newCDPSession(page), outsideSession = await context.newCDPSession(outside);
  try {
    await session.send('Emulation.setFocusEmulationEnabled', { enabled: false });
    await outsideSession.send('Emulation.setFocusEmulationEnabled', { enabled: false });
    await outside.goto('about:blank'); await page.bringToFront();
    await auto(page).click(); await expect(autoMenu(page)).toBeVisible(); await outside.bringToFront();
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false); await expect(autoMenu(page)).toHaveCount(0);
    await page.bringToFront(); await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
    await page.waitForTimeout(420); await expect(autoMenu(page)).toHaveCount(0);
    await tools(page).getByRole('heading', { name: 'Tools', exact: true }).hover(); await presets(page).hover();
    await page.waitForTimeout(100); await expect(presetMenu(page)).toHaveCount(0); await outside.bringToFront();
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false); await page.waitForTimeout(420);
    await expect(presetMenu(page)).toHaveCount(0); await page.bringToFront();
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true); await page.waitForTimeout(420);
    await expect(presetMenu(page)).toHaveCount(0); await finish(page, before);
  } finally {
    await Promise.all([session.send('Emulation.setFocusEmulationEnabled', { enabled: true }), outsideSession.send('Emulation.setFocusEmulationEnabled', { enabled: true })]);
    await Promise.all([session.detach(), outsideSession.detach()]); await outside.close();
  }
});
