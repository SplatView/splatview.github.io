import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useThemePreferences } from '../src/app/themePreferences';
import { ThemePicker } from '../src/ui/settings/ThemePicker';

// Static markup scope only. Mounted preview, focus and listener cleanup are
// qualified by root's actual browser runs; these tests do not emulate a DOM.
vi.mock('../src/app/themePreferences', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/app/themePreferences')>();
  return { ...actual, useThemePreferences: Object.assign(() => actual.useThemePreferences.getState(), actual.useThemePreferences) };
});
const initial = useThemePreferences.getState();
afterEach(() => { useThemePreferences.setState(initial, true); });

describe('desktop Theme selector static chrome', () => {
  it.each([
    ['system', 'System'], ['dark', 'Dark'], ['bright', 'Bright'], ['solar', 'Solar'],
    ['slate', 'Slate'], ['midnight', 'Midnight'], ['forest', 'Forest'], ['rose', 'Rose'],
  ] as const)('shows the committed %s value, compact property label and listbox ownership', (theme, name) => {
    useThemePreferences.setState({ theme, previewTheme: null });
    const markup = renderToStaticMarkup(createElement(ThemePicker));
    expect(markup).toContain('class="theme-trigger"'); expect(markup).toContain('aria-label="Theme"');
    expect(markup).toContain(`aria-description="Current theme: ${name}"`);
    expect(markup).toContain('aria-haspopup="listbox"'); expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('<span class="theme-caption" title="Theme">Theme</span><button');
    expect(markup).toContain(`<span class="theme-value">${name}</span>`);
    expect(markup).toContain('<svg class="desktop-chevron" data-direction="down"');
    expect(markup).not.toContain('role="listbox"'); expect(markup).not.toContain('disabled');
  });
  it('displays the preview label while retaining the committed preference', () => {
    useThemePreferences.setState({ theme: 'forest', previewTheme: 'rose' });
    const markup = renderToStaticMarkup(createElement(ThemePicker));
    expect(markup).toContain('Current theme: Rose'); expect(useThemePreferences.getState().theme).toBe('forest');
  });
  it('presents a save failure as an alert without hiding the usable committed selector', () => {
    useThemePreferences.setState({ theme: 'solar', previewTheme: null, error: 'Could not save theme. Your previous theme is unchanged.' });
    const markup = renderToStaticMarkup(createElement(ThemePicker));
    expect(markup).toContain('role="alert"'); expect(markup).toContain('Could not save theme. Your previous theme is unchanged.');
    expect(markup).toContain('Current theme: Solar'); expect(markup).not.toContain('disabled');
  });
});
