import { useCallback, useEffect, useLayoutEffect } from 'react';
import { effectiveLanguage, useLanguagePreferences, type UiLocale } from './languagePreferences';
import { translate } from './i18n';

function useDisplayedLocale(): UiLocale {
  return useLanguagePreferences(state => effectiveLanguage(state.previewLanguage ?? state.language, state.systemLocale));
}
/** Mount once at App: all translated components share this preference observer. */
export function useLanguageAppearance(): UiLocale {
  const locale = useDisplayedLocale();
  useEffect(() => {
    const changed = () => useLanguagePreferences.getState().refreshSystemLanguage();
    changed();window.addEventListener('languagechange', changed);
    return () => window.removeEventListener('languagechange', changed);
  }, []);
  useLayoutEffect(() => {
    const root = document.documentElement, previousLanguage = root.getAttribute('lang'), previousUiLanguage = root.getAttribute('data-ui-language');
    root.setAttribute('lang', locale);root.setAttribute('data-ui-language', locale);
    return () => {
      if (previousLanguage === null) root.removeAttribute('lang');else root.setAttribute('lang', previousLanguage);
      if (previousUiLanguage === null) root.removeAttribute('data-ui-language');else root.setAttribute('data-ui-language', previousUiLanguage);
    };
  }, [locale]);
  return locale;
}
export function useTranslation(): { t: (key: string, ...args: (string | number)[]) => string; locale: UiLocale } {
  const locale = useDisplayedLocale();
  const t = useCallback((key: string, ...args: (string | number)[]) => translate(key, locale, ...args), [locale]);
  return { t, locale };
}
