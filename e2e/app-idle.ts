import { expect, type Page } from '@playwright/test';

// A selection change refreshes the automatic pivot in the background. Wait on
// the page's own store instance before comparing transform state.
export async function appIdle(page: Page) {
  await expect.poll(() => page.evaluate(async () => {
    const url = performance.getEntriesByType('resource').find(entry => new URL(entry.name).pathname === '/src/app/store.ts')?.name;
    if (!url) throw new Error('The actual app store module was not loaded.');
    const { useApp } = await import(/* @vite-ignore */ url) as typeof import('../src/app/store');
    const state = useApp.getState();
    return !state.busy && !state.transformPivotPending;
  })).toBe(true);
}
