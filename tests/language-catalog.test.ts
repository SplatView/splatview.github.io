import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import native from '../src/generated/native-translations.json';
import { browserTranslations, formatMessage, TRANSLATED_LOCALES, translate, translationAliases } from '../src/app/i18n';
import { UI_LANGUAGES, type UiLocale } from '../src/app/languagePreferences';
import { UI_THEMES } from '../src/app/themePreferences';
import { UI_SIZES } from '../src/app/uiPreferences';
import { SCENE_EXPORT_FORMATS } from '../src/document/exportFormats';
import { colorFields, colorPresets } from '../src/generated/desktop';
import { ALIGNMENT_ACTIONS } from '../src/ui/AlignmentControls';
import { AUTO_COLOR_ACTIONS } from '../src/ui/AutoColorActions';
import { FILTER_CHOICES } from '../src/ui/SelectionMenus';
import { TRANSFORM_MODES } from '../src/ui/TransformModeMenu';

const nativeEnglish = native.catalogs.en as Record<string, string>;
const covered = (key: string) => Object.hasOwn(browserTranslations, key) || Object.hasOwn(translationAliases, key) || Object.hasOwn(nativeEnglish, key);
const locales: readonly UiLocale[] = ['en', ...TRANSLATED_LOCALES];

function orderedFormats(value: string): string[] {
  const tokens: string[] = [], matcher = /%(?:%|zu|s|u|\.\d+[fg])/g;
  let previous = 0;
  for (const match of value.matchAll(matcher)) {
    if (value.slice(previous, match.index).includes('%')) throw new Error(`Unsupported printf token in ${JSON.stringify(value)}`);
    tokens.push(match[0]); previous = match.index! + match[0].length;
  }
  if (value.slice(previous).includes('%')) throw new Error(`Unsupported printf token in ${JSON.stringify(value)}`);
  return tokens;
}

const sourceFiles = [...readdirSync(resolve('src/ui')).filter(file => file.endsWith('.tsx')).map(file => `src/ui/${file}`), 'src/main.tsx'];
function literalTranslationCalls(file: string): { key: string; line: number }[] {
  const source = readFileSync(resolve(file), 'utf8');
  const calls: { key: string; line: number }[] = [];
  const call = /\b(?:t|translate)\s*\(/g;
  const direct = /^\s*(["'])((?:\\.|(?!\1)[^\\\r\n])*)\1\s*$/;
  const branch = /(?:\?\?|\?|:|\|\|)\s*(["'])((?:\\.|(?!\1)[^\\\r\n])*)\1/g;
  const add = (key: string, index: number) => {
    const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t', '\\': '\\', "'": "'", '"': '"' };
    calls.push({ key: key.replace(/\\([nrt\\'"])/g, (_, escaped: string) => escapes[escaped]), line: source.slice(0, index).split('\n').length });
  };
  for (const match of source.matchAll(call)) {
    const start = match.index + match[0].length;
    const nested: string[] = [];
    let quote = '', escaped = false, end = start;
    for (; end < source.length; end++) {
      const character = source[end];
      if (quote) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === quote) quote = '';
      } else if (character === '"' || character === "'" || character === '`') quote = character;
      else if (character === '(' || character === '[' || character === '{') nested.push(character);
      else if (character === ')' || character === ']' || character === '}') {
        if (!nested.length && character === ')') break;
        nested.pop();
      } else if (character === ',' && !nested.length) break;
    }
    const argument = source.slice(start, end);
    const literal = argument.match(direct);
    if (literal) add(literal[2], match.index);
    else for (const candidate of argument.matchAll(branch)) add(candidate[2], match.index);
  }
  return calls;
}

describe('browser language catalog', () => {
  it('supplies intact seven-column copy and preserves each ordered printf contract', () => {
    expect(TRANSLATED_LOCALES).toEqual(['es', 'fr', 'de', 'pt', 'zh-Hans', 'ja', 'ko']);
    for (const [english, row] of Object.entries(browserTranslations)) {
      expect(row, english).toHaveLength(7);
      const format = orderedFormats(english);
      for (const [index, translated] of row.entries()) {
        expect(typeof translated, `${english} ${TRANSLATED_LOCALES[index]}`).toBe('string');
        expect(translated.trim(), `${english} ${TRANSLATED_LOCALES[index]}`).not.toBe('');
        expect(translated, `${english} ${TRANSLATED_LOCALES[index]}`).not.toContain('\uFFFD');
        expect(new TextDecoder().decode(new TextEncoder().encode(translated)), `${english} ${TRANSLATED_LOCALES[index]}`).toBe(translated);
        expect(orderedFormats(translated), `${english} ${TRANSLATED_LOCALES[index]}`).toEqual(format);
      }
    }
    expect(formatMessage('%s: %u/%zu, %.2f, %.3g, %%', 'S', 2, 3, 1.2, 0.001234)).toBe('S: 2/3, 1.20, 0.00123, %');
    expect(() => formatMessage('%d', 1)).toThrow();
  });

  it('resolves aliases only to captured native keys and preserves unknown technical text', () => {
    for (const [key, target] of Object.entries(translationAliases)) {
      expect(Object.hasOwn(nativeEnglish, target), `${key} → ${target}`).toBe(true);
      expect(Object.hasOwn(browserTranslations, key), key).toBe(false);
    }
    expect(Object.getPrototypeOf(browserTranslations)).toBe(null);
    const technical = 'GPU adapter 0xBEEF: C:\\scene\\unknown.ply';
    for (const locale of locales) {
      expect(translate(technical, locale)).toBe(technical);
      expect(translate('__proto__', locale)).toBe('__proto__');
      expect(translate('constructor', locale)).toBe('constructor');
    }
  });

  it('covers literal translation calls in the current browser chrome', () => {
    const missing = sourceFiles.flatMap(file => literalTranslationCalls(file)
      .filter(({ key }) => !covered(key)).map(({ key, line }) => `${file}:${line} ${JSON.stringify(key)}`));
    expect(missing).toEqual([]);
  });

  it('covers labels supplied indirectly by native-derived menus, generated fields and export choices', () => {
    const labels = [
      ...AUTO_COLOR_ACTIONS.map(action => action.label),
      ...FILTER_CHOICES.flatMap(choice => [choice.label, choice.display, choice.title]),
      ...ALIGNMENT_ACTIONS.flatMap(action => [action.label, action.hint]),
      ...TRANSFORM_MODES.map(mode => mode.label),
      ...UI_THEMES.map(theme => theme.name), ...UI_SIZES.map(size => size.name),
      UI_LANGUAGES[0].name,
      ...colorFields.map(field => field.label), ...Object.keys(colorPresets),
      ...SCENE_EXPORT_FORMATS.map(format => format.label),
    ];
    expect(labels.filter(label => !covered(label))).toEqual([]);
  });

});
