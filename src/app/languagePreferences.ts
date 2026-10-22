import { create } from 'zustand';

export type UiLocale = 'en' | 'es' | 'fr' | 'de' | 'pt' | 'zh-Hans' | 'ja' | 'ko';
export type UiLanguage = 'system' | UiLocale;
// Captured language.cpp:12-21 and language.hpp:11-21. Explicit names are autonyms.
export const UI_LANGUAGES = Object.freeze([
  { language: 'system', name: 'System default' }, { language: 'en', name: 'English' },
  { language: 'es', name: 'Español' }, { language: 'fr', name: 'Français' },
  { language: 'de', name: 'Deutsch' }, { language: 'pt', name: 'Português' },
  { language: 'zh-Hans', name: '简体中文' }, { language: 'ja', name: '日本語' },
  { language: 'ko', name: '한국어' },
] as const);
export const UI_LANGUAGE_KEY = 'splatview.ui-language.v1';
export const LANGUAGE_SAVE_ERROR = 'Could not save language. Your previous language is unchanged. Try again when local storage is available.';
type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;
type LanguagePreferences = {
  language: UiLanguage; previewLanguage: UiLanguage | null; systemLocale: UiLocale; error: string | null;
  preview: (language: UiLanguage) => void;
  cancelPreview: () => void;
  commit: (language: UiLanguage) => boolean;
  refreshSystemLanguage: () => void;
};
function storage(): PreferenceStorage | undefined {
  try { return globalThis.localStorage; } catch { return undefined; }
}
export function isUiLanguage(value: unknown): value is UiLanguage {
  return UI_LANGUAGES.some(info => info.language === value);
}
/** Native languageFromTag accepts a two-letter prefix and '-' or '_' suffixes. */
export function languageFromTag(tag: unknown): UiLanguage {
  if (typeof tag !== 'string' || tag.length < 2 || tag.length > 2 && tag[2] !== '-' && tag[2] !== '_') return 'system';
  const prefix = tag.slice(0, 2).toLowerCase();
  return UI_LANGUAGES.find(info => info.language !== 'system' && info.language.slice(0, 2) === prefix)?.language ?? 'system';
}
/** First supported browser preference wins; a supported fallback precedes English. */
export function preferredLanguage(tags: readonly unknown[], fallback?: unknown): UiLocale {
  if (Array.isArray(tags)) for (const tag of tags) {
    const locale = languageFromTag(tag);if (locale !== 'system') return locale;
  }
  const locale = languageFromTag(fallback);return locale === 'system' ? 'en' : locale;
}
export function browserLocale(): UiLocale {
  let tags: readonly unknown[] = [], fallback: unknown;
  // Browser preference getters can be unavailable independently.
  try { const value = globalThis.navigator?.languages;if (Array.isArray(value)) tags = value; } catch { /* Try navigator.language. */ }
  try { fallback = globalThis.navigator?.language; } catch { /* English remains available. */ }
  return preferredLanguage(tags, fallback);
}
export function effectiveLanguage(language: UiLanguage, systemLocale: UiLocale): UiLocale {
  const locale: unknown = language === 'system' ? systemLocale : language;
  return isUiLanguage(locale) && locale !== 'system' ? locale : 'en';
}
export function createLanguagePreferences(preferences = storage(), detect: () => UiLocale = browserLocale) {
  let initial: UiLanguage = 'system';
  try { const saved = preferences?.getItem(UI_LANGUAGE_KEY);if (isUiLanguage(saved)) initial = saved; } catch { /* Follow System. */ }
  const detected = (): UiLocale => {
    try { const locale: unknown = detect();if (isUiLanguage(locale) && locale !== 'system') return locale; } catch { /* Use English. */ }
    return 'en';
  };
  return create<LanguagePreferences>((set, get) => ({
    language: initial, previewLanguage: null, systemLocale: detected(), error: null,
    preview: language => { if (isUiLanguage(language) && get().previewLanguage !== language) set({ previewLanguage: language }); },
    cancelPreview: () => { if (get().previewLanguage !== null) set({ previewLanguage: null }); },
    refreshSystemLanguage: () => { const systemLocale = detected();if (get().systemLocale !== systemLocale) set({ systemLocale }); },
    commit: language => {
      if (!isUiLanguage(language)) return false;
      // Native LanguagePreferences::set always attempts a write, even when the
      // selected choice is unchanged; a retry clears the previous save error.
      try {
        const target = preferences ?? storage();if (!target) throw new Error('Local preferences are unavailable.');
        target.setItem(UI_LANGUAGE_KEY, language);
        set({ language, previewLanguage: null, systemLocale: detected(), error: null });return true;
      } catch {
        set({ previewLanguage: null, error: LANGUAGE_SAVE_ERROR });return false;
      }
    },
  }));
}
export const useLanguagePreferences = createLanguagePreferences();
