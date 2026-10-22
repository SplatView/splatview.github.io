import { describe, expect, it } from 'vitest';
import { formatMessage, translate } from '../src/app/i18n';
import { appearanceTranslations } from '../src/app/translations/appearance';

describe('strict native translation format shapes', () => {
  it.each([
    ['%s / %s', ['left', 'right'], 'left / right'],
    ['%u filters', [3], '3 filters'], ['%zu points', [9007199254740991], '9007199254740991 points'],
    ['%.1f%% inliers | RMS %.4g', [42.26, .00123456], '42.3% inliers | RMS 0.001235'],
    ['Distance %.5g %s', [123.456, 'mm'], 'Distance 123.46 mm'],
    ['%.0f', [1.6], '2'], ['%.20f', [1.5], '1.50000000000000000000'],
    ['%.4g', [12.3], '12.3'], ['%.4g', [.0001], '0.0001'], ['%.4g', [.00009999999], '0.0001'],
    ['%.4g', [.000099994], '9.999e-05'], ['%.4g', [9999], '9999'], ['%.4g', [9999.9], '1e+04'],
    ['%.5g', [.0000001234567], '1.2346e-07'], ['%.4g', [-.00001], '-1e-05'],
    ['%.4g', [1e20], '1e+20'], ['%.1g', [0], '0'],
    ['%.0f', [-0], '-0'], ['%.1f', [-0], '-0.0'], ['%.4g', [-0], '-0'],
  ] as [string, (string | number)[], string][])('case %#: formats %s with ordered native arguments', (format, args, expected) => {
    expect(formatMessage(format, ...args)).toBe(expected);
  });
  it('handles literal percent tokens without interpreting inserted filenames or percent sequences', () => {
    expect(formatMessage('100%%: %s | %s', 'opaque%u.ply', '50% <mesh>')).toBe('100%: opaque%u.ply | 50% <mesh>');
    expect(formatMessage('%% %s %%', '%n')).toBe('% %n %');
  });
  it.each([
    ['%s', [4]], ['%u', ['4']], ['%zu', [-1]], ['%u', [1.1]], ['%zu', [Number.MAX_SAFE_INTEGER + 1]],
    ['%.1f', [Infinity]], ['%.4g', [NaN]], ['%u', []], ['%s %u', ['one']], ['literal', [1]],
    ['%s', ['one', 'two']], ['%d', [1]], ['%n', [1]], ['%08u', [1]], ['%.2e', [1]],
    ['%.21f', [1]], ['%.21g', [1]], ['%.0g', [1]],
  ] as [string, (string | number)[]][])('case %#: rejects mismatched or unsupported format %s', (format, args) => {
    expect(() => formatMessage(format, ...args)).toThrow();
  });
});

describe('exact captured translation lookup and formatted display', () => {
  it.each([
    ['en', '3 filters'], ['es', '3 filtros'], ['fr', '3 filtres'], ['de', '3 Filter'],
    ['pt', '3 filtros'], ['zh-Hans', '3 个过滤器'], ['ja', '3 フィルター'], ['ko', '필터 3개'],
  ] as const)('keeps %s count placement and literal native wording', (locale, expected) => {
    expect(translate('%u filters', locale, 3)).toBe(expected);
  });
  it('preserves mixed numeric precision, ordered text and literal percent in translated native keys', () => {
    expect(translate('%.1f%% inliers | RMS %.4g', 'fr', 42.26, .00123456)).toBe('42.3% points retenus | RMS 0.001235');
    expect(translate('Distance %.5g %s', 'de', .0000001234567, 'm')).toBe('Abstand 1.2346e-07 m');
    expect(translate('%s/%s splats | SH%u', 'ko', '20%', 'opaque%s', 3)).toBe('20%/opaque%s 스플랫 | SH3');
  });
  it('keeps unformatted keys raw and unknown technical details exact when no arguments were requested', () => {
    expect(translate('%u filters', 'zh-Hans')).toBe('%u 个过滤器');
    expect(translate('%.1f%% inliers | RMS %.4g', 'en')).toBe('%.1f%% inliers | RMS %.4g');
    const unknown = 'GPUValidationError: opaque%n buffer 50% <scene.ply>';
    expect(translate(unknown, 'ja')).toBe(unknown);expect(translate('LANGUAGE', 'es')).toBe('LANGUAGE');
    expect(translate('Unknown %s: %u', 'es', 'scene%zu.ply', 9)).toBe('Unknown scene%zu.ply: 9');
  });
  it('provides seven explicit browser appearance copies with matching native format arguments', () => {
    expect(Object.keys(appearanceTranslations).length).toBeGreaterThan(0);
    for (const [key, row] of Object.entries(appearanceTranslations)) {
      expect(row).toHaveLength(7);
      for (const text of row) {
        expect(typeof text).toBe('string');expect(text.length).toBeGreaterThan(0);
        expect(text.match(/%s/g) ?? []).toHaveLength(key.match(/%s/g)?.length ?? 0);
      }
    }
    expect(translate('Current language: %s', 'es', '日本語')).toBe('Idioma actual: 日本語');
    expect(translate('Current theme: %s', 'de', 'Dunkel')).toBe('Aktuelles Design: Dunkel');
    expect(translate('Current size: %s', 'ja', '大')).toBe('現在のサイズ: 大');
  });
});
