import { expect, type Locator, type Page } from '@playwright/test';

/** Both desktop modes expose the same armed tool through the Tool menu. */
export async function selectionToolTrigger(page: Page, label: string): Promise<Locator> {
  const selector = page.getByRole('button', { name: 'Selection tool', exact: true });
  return await selector.count() ? selector : page.getByRole('button', { name: label, exact: true });
}

export async function chooseSelectionTool(page: Page, label: string, options: { dispatch?: boolean } = {}): Promise<void> {
  const selector = page.getByRole('button', { name: 'Selection tool', exact: true });
  if (await selector.count()) {
    if (options.dispatch) await selector.dispatchEvent('click'); else await selector.click();
    const menu = page.getByRole('menu', { name: 'Selection tools', exact: true });
    const choice = menu.getByRole('menuitemradio', { name: label, exact: true });
    if (options.dispatch) await choice.dispatchEvent('click'); else await choice.click();
    await expect(menu).toHaveCount(0);
    await expect(selector.getByText(label, { exact: true })).toBeVisible();
  } else {
    const button = page.getByRole('button', { name: label, exact: true });
    if (options.dispatch) await button.dispatchEvent('click'); else await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
  }
}
