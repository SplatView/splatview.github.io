import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserLocale, createLanguagePreferences, effectiveLanguage, isUiLanguage, languageFromTag, preferredLanguage,
  LANGUAGE_SAVE_ERROR, UI_LANGUAGES, UI_LANGUAGE_KEY, type UiLanguage, type UiLocale } from '../src/app/languagePreferences';

function memory(initial?: string) {
  const values = new Map<string, string>(initial === undefined ? [] : [[UI_LANGUAGE_KEY, initial]]);
  const writes: [string, string][] = [];
  const backend = { blocked: false,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (backend.blocked) throw new Error('Storage is blocked.');
      writes.push([key, value]);values.set(key, value);
    },
  };
  return {backend, values, writes};
}
afterEach(() => vi.unstubAllGlobals());

describe('captured native language preference with browser System resolution', () => {
  it('retains all nine native choices in enum order with exact UTF-8 autonyms', () => {
    expect(UI_LANGUAGES).toEqual([
      {language: 'system', name: 'System default'}, {language: 'en', name: 'English'},
      {language: 'es', name: 'Español'}, {language: 'fr', name: 'Français'}, {language: 'de', name: 'Deutsch'},
      {language: 'pt', name: 'Português'}, {language: 'zh-Hans', name: '简体中文'},
      {language: 'ja', name: '日本語'}, {language: 'ko', name: '한국어'},
    ]);
    expect(UI_LANGUAGE_KEY).toBe('splatview.ui-language.v1');
  });
  it.each([undefined, 'unknown', 'EN', 'zh', ' english ', '{"language":"es"}'])(
    'defaults missing or invalid saved preference %s to System without rewriting storage', saved => {
      const input = memory(saved), preference = createLanguagePreferences(input.backend, () => 'fr');
      expect(preference.getState()).toMatchObject({language: 'system', previewLanguage: null, systemLocale: 'fr', error: null});
      expect(input.writes).toEqual([]);
    });
  it.each(['system', 'en', 'es', 'fr', 'de', 'pt', 'zh-Hans', 'ja', 'ko'] as const)('loads saved native code %s exactly', language => {
    expect(createLanguagePreferences(memory(language).backend, () => 'ja').getState().language).toBe(language);
    expect(isUiLanguage(language)).toBe(true);
  });
  it.each([
    ['EN-us', 'en'], ['es_MX', 'es'], ['FR', 'fr'], ['de-DE', 'de'], ['PT-BR', 'pt'],
    ['zh-Hant-TW', 'zh-Hans'], ['zh_CN', 'zh-Hans'], ['ja-JP', 'ja'], ['ko_KR', 'ko'], ['en-', 'en'],
  ])('resolves native prefix %s to %s', (tag, expected) => expect(languageFromTag(tag)).toBe(expected));
  it.each(['e', 'english', 'français', ' en', 'x-en', 'system', '', null, 42])('ignores unsupported browser tag %s', tag => {
    expect(languageFromTag(tag)).toBe('system');
  });
  it('uses the first supported browser list entry, then navigator.language, then English', () => {
    expect(preferredLanguage(['it-IT', 'DE-de', 'es-MX'], 'ja-JP')).toBe('de');
    expect(preferredLanguage(['en-GB', 'es-MX'], 'ja-JP')).toBe('en');
    expect(preferredLanguage(['it-IT', 'ru-RU'], 'pt-BR')).toBe('pt');
    expect(preferredLanguage([], 'ko-KR')).toBe('ko');expect(preferredLanguage(['ar'], 'it')).toBe('en');
  });
  it('reads live browser values and contains independently unavailable preference getters', () => {
    vi.stubGlobal('navigator', {languages: ['it', 'es-MX'], language: 'de'});expect(browserLocale()).toBe('es');
    vi.stubGlobal('navigator', {get languages() {throw new Error('Denied');}, language: 'pt-BR'});expect(browserLocale()).toBe('pt');
    vi.stubGlobal('navigator', {languages: ['ja'], get language() {throw new Error('Denied');}});expect(browserLocale()).toBe('ja');
    vi.stubGlobal('navigator', undefined);expect(browserLocale()).toBe('en');
  });
  it('broadcasts previews and cancellation to every locale subscriber without saving', () => {
    const input = memory(), preference = createLanguagePreferences(input.backend, () => 'ko'), observed: UiLocale[] = [];
    const off = preference.subscribe(state => observed.push(effectiveLanguage(state.previewLanguage ?? state.language, state.systemLocale)));
    preference.getState().preview('es');preference.getState().cancelPreview();off();
    expect(observed).toEqual(['es', 'ko']);expect(input.writes).toEqual([]);
    expect(preference.getState()).toMatchObject({language: 'system', previewLanguage: null});
  });
  it('commits and reloads one choice while preserving unrelated browser preferences', () => {
    const input = memory('fr'), preference = createLanguagePreferences(input.backend, () => 'en');
    input.values.set('splatview.ui-theme.v1', 'forest');input.values.set('splatview.ui-size.v1', 'large');
    preference.getState().preview('ja');expect(preference.getState().commit('pt')).toBe(true);
    expect(preference.getState()).toMatchObject({language: 'pt', previewLanguage: null, error: null});
    expect(createLanguagePreferences(input.backend).getState().language).toBe('pt');
    expect(input.writes).toEqual([[UI_LANGUAGE_KEY, 'pt']]);
    expect(input.values.get('splatview.ui-theme.v1')).toBe('forest');expect(input.values.get('splatview.ui-size.v1')).toBe('large');
  });
  it('cancels failed preview, retains the committed choice, and retries saving that same choice', () => {
    const input = memory('es'), preference = createLanguagePreferences(input.backend, () => 'en');
    input.backend.blocked = true;preference.getState().preview('ja');
    expect(preference.getState().commit('ja')).toBe(false);
    expect(preference.getState()).toMatchObject({language: 'es', previewLanguage: null, error: LANGUAGE_SAVE_ERROR});
    expect(input.values.get(UI_LANGUAGE_KEY)).toBe('es');expect(input.writes).toEqual([]);
    expect(preference.getState().commit('es')).toBe(false);expect(preference.getState().error).toBe(LANGUAGE_SAVE_ERROR);
    input.backend.blocked = false;expect(preference.getState().commit('es')).toBe(true);
    expect(preference.getState()).toMatchObject({language: 'es', previewLanguage: null, error: null});
    expect(input.writes).toEqual([[UI_LANGUAGE_KEY, 'es']]);
    expect(preference.getState().commit('es')).toBe(true);expect(input.writes).toHaveLength(2);
  });
  it('contains storage read failure and recovers when initially unavailable storage becomes writable', () => {
    let written = '';
    const readableLater = createLanguagePreferences({getItem: () => {throw new Error('Denied');}, setItem: (_key, value) => {written = value;}}, () => 'de');
    expect(readableLater.getState().language).toBe('system');expect(readableLater.getState().commit('ja')).toBe(true);expect(written).toBe('ja');
    vi.stubGlobal('localStorage', undefined);const preference = createLanguagePreferences(undefined, () => 'de');
    expect(preference.getState().commit('system')).toBe(false);
    const input = memory();vi.stubGlobal('localStorage', input.backend);
    expect(preference.getState().commit('system')).toBe(true);expect(input.writes).toEqual([[UI_LANGUAGE_KEY, 'system']]);
    expect(preference.getState().error).toBeNull();
  });
  it('refreshes System live without overwriting the preference or overriding explicit preview/commit', () => {
    let detected: UiLocale = 'fr';const input = memory(), preference = createLanguagePreferences(input.backend, () => detected);
    const locale = () => {const state = preference.getState();return effectiveLanguage(state.previewLanguage ?? state.language, state.systemLocale);};
    expect(locale()).toBe('fr');detected = 'ja';preference.getState().refreshSystemLanguage();expect(locale()).toBe('ja');
    preference.getState().preview('es');detected = 'ko';preference.getState().refreshSystemLanguage();expect(locale()).toBe('es');
    preference.getState().cancelPreview();expect(locale()).toBe('ko');expect(input.writes).toEqual([]);
    expect(preference.getState().commit('pt')).toBe(true);detected = 'de';preference.getState().refreshSystemLanguage();expect(locale()).toBe('pt');
    expect(preference.getState().language).toBe('pt');
  });
  it('falls back to English when system detection throws or returns an invalid result', () => {
    const failed = createLanguagePreferences(memory().backend, () => {throw new Error('Unavailable');});
    expect(failed.getState().systemLocale).toBe('en');expect(failed.getState().commit('system')).toBe(true);
    expect(createLanguagePreferences(memory().backend, () => 'system' as UiLocale).getState().systemLocale).toBe('en');
    expect(effectiveLanguage('invalid' as UiLanguage, 'ja')).toBe('en');
  });
  it('ignores invalid actions before changing preview or storage', () => {
    const input = memory('fr'), preference = createLanguagePreferences(input.backend, () => 'en');
    preference.getState().preview('ja');preference.getState().preview('Japanese' as UiLanguage);
    expect(preference.getState().commit('EN' as UiLanguage)).toBe(false);
    expect(preference.getState()).toMatchObject({language: 'fr', previewLanguage: 'ja', error: null});expect(input.writes).toEqual([]);
  });
});
