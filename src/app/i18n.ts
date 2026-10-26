import native from '../generated/native-translations.json';
import type { UiLocale } from './languagePreferences';
import { appearanceAliases, appearanceTranslations } from './translations/appearance';
import { editingAliases, editingTranslations } from './translations/editing';
import { selectionAliases, selectionTranslations } from './translations/selection';
import { webAliases, webTranslations } from './translations/web';
import { tutorialTranslations } from './translations/tutorial';
import { tutorialCourseTranslations } from './translations/tutorialCourse';
import { accessibilityTranslations } from './translations/accessibility';
import { operationTranslations } from './translations/operation';
import { offlineTranslations } from './translations/offline';
import { renderingTranslations } from './translations/rendering';

export const TRANSLATED_LOCALES = ['es', 'fr', 'de', 'pt', 'zh-Hans', 'ja', 'ko'] as const;
export type BrowserTranslations = Readonly<Record<string, readonly [string, string, string, string, string, string, string]>>;
const catalogs = native.catalogs as Readonly<Record<UiLocale, Readonly<Record<string, string>>>>;

function merge<T>(groups: readonly Readonly<Record<string, T>>[]): Readonly<Record<string, T>> {
  const result: Record<string, T> = Object.create(null);
  for (const group of groups) for (const [key, value] of Object.entries(group)) {
    if (Object.hasOwn(result, key) && JSON.stringify(result[key]) !== JSON.stringify(value))
      throw new Error(`Conflicting translation: ${key}`);
    result[key] = value;
  }
  return Object.freeze(result);
}
export const browserTranslations = merge<BrowserTranslations[string]>([
  appearanceTranslations, editingTranslations, selectionTranslations, webTranslations, tutorialTranslations, tutorialCourseTranslations, accessibilityTranslations, operationTranslations, offlineTranslations, renderingTranslations,
]);
export const translationAliases = merge<string>([appearanceAliases, editingAliases, selectionAliases, webAliases]);

/** The captured catalog uses only %s, %u, %zu, %.Nf, %.Ng and literal %%. */
export function formatMessage(text: string, ...args: (string | number)[]): string {
  let index = 0;
  const formatted = text.replace(/%(?:%|s|zu|u|\.(\d+)([fg])|[a-zA-Z0-9.]+)/g, (token: string, digits?: string, kind?: string) => {
    if (token === '%%') return '%';
    if (!/^%(?:s|u|zu|\.\d+[fg])$/.test(token)) throw new Error(`Unsupported message format: ${token}`);
    if (index >= args.length) throw new Error('Missing message argument.');
    const value = args[index++];
    if (token === '%s') {
      if (typeof value !== 'string') throw new Error('Expected a string message argument.');
      return value;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Expected a finite numeric message argument.');
    if (token === '%u' || token === '%zu') {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('Expected an unsigned integer message argument.');
      return String(value);
    }
    const precision = Number(digits);
    if (!Number.isInteger(precision) || precision < (kind === 'g' ? 1 : 0) || precision > 20)
      throw new Error('Unsupported message precision.');
    const sign = Object.is(value, -0) ? '-' : '';
    if (kind === 'f') return sign + value.toFixed(precision);
    // C printf %g uses fixed notation for exponents -4 through precision-1,
    // strips insignificant zeroes, and pads a signed exponent to two digits.
    const [mantissa, power] = value.toExponential(precision - 1).split('e');
    const exponent = Number(power);
    const strip = (part: string) => part.includes('.') ? part.replace(/0+$/, '').replace(/\.$/, '') : part;
    if (exponent < -4 || exponent >= precision)
      return `${strip(mantissa)}e${exponent < 0 ? '-' : '+'}${String(Math.abs(exponent)).padStart(2, '0')}`;
    return sign + strip(value.toFixed(Math.max(0, precision - exponent - 1)));
  });
  if (index !== args.length) throw new Error('Unexpected message argument.');
  return formatted;
}

/** Exact case-sensitive keys; unrecognized technical details remain readable. */
export function translate(key: string, locale: UiLocale, ...args: (string | number)[]): string {
  let text = key;
  if (locale !== 'en') {
    const row = Object.hasOwn(browserTranslations, key) ? browserTranslations[key] : undefined;
    const nativeKey = Object.hasOwn(translationAliases, key) ? translationAliases[key] : key;
    if (row) text = row[TRANSLATED_LOCALES.indexOf(locale)];
    else if (Object.hasOwn(catalogs[locale], nativeKey)) text = catalogs[locale][nativeKey];
  }
  return args.length ? formatMessage(text, ...args) : text;
}

// Translate only authored context; a browser/native exception suffix is opaque.
const STATUS_PREFIXES = [
  'Could not restore the saved view. ', 'Could not save the thumbnail and view. ',
  'Could not import the saved view. ', 'Could not export the saved view. ',
] as const;
export function translateStatus(message: string, locale: UiLocale): string {
  const prefix = STATUS_PREFIXES.find(value => message.startsWith(value));
  return prefix ? translate(`${prefix}%s`, locale, message.slice(prefix.length)) : translate(message, locale);
}
