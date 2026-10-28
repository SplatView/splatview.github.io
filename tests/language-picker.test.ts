import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LANGUAGE_SAVE_ERROR, useLanguagePreferences } from '../src/app/languagePreferences';
import { LanguagePicker } from '../src/ui/settings/LanguagePicker';

// Static chrome only; actual preview/focus/keyboard/observer behavior belongs to
// root's browser cohorts. This suite does not emulate a document or GPU.
vi.mock('../src/app/languagePreferences', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/app/languagePreferences')>();
  type State = ReturnType<typeof actual.useLanguagePreferences.getState>;
  return {...actual, useLanguagePreferences: Object.assign((selector?: (state: State) => unknown) =>
    selector ? selector(actual.useLanguagePreferences.getState()) : actual.useLanguagePreferences.getState(), actual.useLanguagePreferences)};
});
const initial = useLanguagePreferences.getState();
afterEach(() => useLanguagePreferences.setState(initial, true));

describe('native Language selector translated static chrome', () => {
  it.each([
    ['system', 'System default', 'Language', 'Current language: System default'],
    ['en', 'English', 'Language', 'Current language: English'],
    ['es', 'Español', 'Idioma', 'Idioma actual: Español'],
    ['fr', 'Français', 'Langue', 'Langue actuelle : Français'],
    ['de', 'Deutsch', 'Sprache', 'Aktuelle Sprache: Deutsch'],
    ['pt', 'Português', 'Idioma', 'Idioma atual: Português'],
    ['zh-Hans', '简体中文', '语言', '当前语言：简体中文'],
    ['ja', '日本語', '言語', '現在の言語: 日本語'],
    ['ko', '한국어', '언어', '현재 언어: 한국어'],
  ] as const)('keeps the %s autonym and translates its caption and description', (language, name, caption, description) => {
    useLanguagePreferences.setState({language, previewLanguage: null, systemLocale: 'en'});
    const markup = renderToStaticMarkup(createElement(LanguagePicker));
    expect(markup).toContain('class="language-trigger"');expect(markup).toContain(`aria-label="${caption}"`);
    expect(markup).toContain(`aria-description="${description}"`);expect(markup).toContain(`<span class="language-value">${name}</span>`);
    expect(markup).toContain(`<span class="language-caption" title="${caption}">${caption}</span><button`);
    expect(markup).toContain('aria-haspopup="listbox"');expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('<svg class="desktop-chevron" data-direction="down"');
    expect(markup).not.toContain('role="listbox"');expect(markup).not.toContain('disabled');
  });
  it('uses System effective locale for captions and the native System default display name', () => {
    useLanguagePreferences.setState({language: 'system', previewLanguage: null, systemLocale: 'ja'});
    const markup = renderToStaticMarkup(createElement(LanguagePicker));
    expect(markup).toContain('aria-label="言語"');expect(markup).toContain('現在の言語: システムの言語');
    expect(useLanguagePreferences.getState().language).toBe('system');
  });
  it('displays a translated preview without replacing the saved language choice', () => {
    useLanguagePreferences.setState({language: 'en', previewLanguage: 'es', systemLocale: 'en'});
    const markup = renderToStaticMarkup(createElement(LanguagePicker));
    expect(markup).toContain('Idioma actual: Español');expect(useLanguagePreferences.getState().language).toBe('en');
  });
  it('translates a save refusal in the retained committed locale and leaves the selector usable', () => {
    useLanguagePreferences.setState({language: 'es', previewLanguage: null, error: LANGUAGE_SAVE_ERROR});
    const markup = renderToStaticMarkup(createElement(LanguagePicker));
    expect(markup).toContain('role="alert"');expect(markup).toContain('No se pudo guardar el idioma.');
    expect(markup).toContain('Idioma actual: Español');expect(markup).not.toContain(LANGUAGE_SAVE_ERROR);expect(markup).not.toContain('disabled');
  });
});
