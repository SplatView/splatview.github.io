import { describe, expect, it, vi } from 'vitest';
import { createThemePreferences, effectiveTheme, isUiTheme, themeColorCss, themePalette, themeStyle,
  UI_THEMES, UI_THEME_KEY, type UiTheme } from '../src/app/themePreferences';

function memory(initial?: string) {
  const values = new Map<string, string>(initial === undefined ? [] : [[UI_THEME_KEY, initial]]), writes: [string, string][] = [];
  const backend = { blocked: false, getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (backend.blocked) throw new Error('Storage blocked'); writes.push([key, value]); values.set(key, value);
    } };
  return { backend, values, writes };
}
const rgb = (red: number, green = red, blue = red) => [Math.fround(red), Math.fround(green), Math.fround(blue), 1];

describe('captured desktop Theme preference', () => {
  it('uses the native display order, including System first and native Dark default', () => {
    expect(UI_THEMES).toEqual([
      { theme: 'system', name: 'System' }, { theme: 'dark', name: 'Dark' },
      { theme: 'bright', name: 'Bright' }, { theme: 'solar', name: 'Solar' },
      { theme: 'slate', name: 'Slate' }, { theme: 'midnight', name: 'Midnight' },
      { theme: 'forest', name: 'Forest' }, { theme: 'rose', name: 'Rose' },
    ]);
    expect(createThemePreferences(memory().backend).getState()).toMatchObject({ theme: 'dark', previewTheme: null, error: null });
  });
  it.each(['invalid', 'Dark', '{"theme":"forest"}', '', 'toString', '__proto__'])('ignores invalid stored theme %s', saved => {
    expect(createThemePreferences(memory(saved).backend).getState().theme).toBe('dark');
    expect(isUiTheme(saved)).toBe(false);
  });
  it.each(['system', 'dark', 'bright', 'solar', 'slate', 'midnight', 'forest', 'rose'] as const)('loads and retains the independent %s choice', theme => {
    const input = memory(theme), preference = createThemePreferences(input.backend);
    expect(preference.getState().theme).toBe(theme); expect(input.writes).toEqual([]);
  });
  it('previews multiple choices and cancels without writing or replacing the committed choice', () => {
    const input = memory('slate'), preference = createThemePreferences(input.backend);
    preference.getState().preview('rose'); preference.getState().preview('system');
    expect(preference.getState()).toMatchObject({ theme: 'slate', previewTheme: 'system', error: null });
    expect(input.writes).toEqual([]); preference.getState().cancelPreview();
    expect(preference.getState()).toMatchObject({ theme: 'slate', previewTheme: null });
    expect(input.values.get(UI_THEME_KEY)).toBe('slate'); expect(input.writes).toEqual([]);
  });
  it('commits one choice and reloads it without overwriting other preferences', () => {
    const input = memory('bright'), preference = createThemePreferences(input.backend);
    input.values.set('splatview.ui-size.v1', 'large'); input.values.set('splatview.tools-mode.v1', 'pro');
    preference.getState().preview('rose'); expect(preference.getState().commit('midnight')).toBe(true);
    expect(preference.getState()).toMatchObject({ theme: 'midnight', previewTheme: null, error: null });
    expect(createThemePreferences(input.backend).getState().theme).toBe('midnight');
    expect(preference.getState().commit('midnight')).toBe(true);
    expect(input.writes).toEqual([[UI_THEME_KEY, 'midnight']]);
    expect(input.values.get('splatview.ui-size.v1')).toBe('large'); expect(input.values.get('splatview.tools-mode.v1')).toBe('pro');
  });
  it('restores committed appearance after failed save, preserves an existing error on current-choice click, and retries', () => {
    const input = memory('forest'), preference = createThemePreferences(input.backend);
    input.backend.blocked = true; preference.getState().preview('rose');
    expect(preference.getState().commit('rose')).toBe(false);
    expect(preference.getState()).toMatchObject({ theme: 'forest', previewTheme: null });
    const error = preference.getState().error; expect(error).toContain('Could not save theme');
    expect(input.values.get(UI_THEME_KEY)).toBe('forest'); expect(input.writes).toEqual([]);
    expect(preference.getState().commit('forest')).toBe(true); expect(preference.getState().error).toBe(error);
    input.backend.blocked = false; expect(preference.getState().commit('rose')).toBe(true);
    expect(preference.getState()).toMatchObject({ theme: 'rose', previewTheme: null, error: null });
  });
  it('contains storage read failure while permitting a later save', () => {
    let written = '';
    const preference = createThemePreferences({ getItem: () => { throw new Error('Read denied'); }, setItem: (_key, value) => { written = value; } });
    expect(preference.getState().theme).toBe('dark'); expect(preference.getState().commit('solar')).toBe(true); expect(written).toBe('solar');
  });
  it('can retry when storage was initially unavailable', () => {
    try {
      vi.stubGlobal('localStorage', undefined); const preference = createThemePreferences();
      expect(preference.getState().commit('bright')).toBe(false); expect(preference.getState().theme).toBe('dark');
      const input = memory(); vi.stubGlobal('localStorage', input.backend);
      expect(preference.getState().commit('bright')).toBe(true); expect(input.writes).toEqual([[UI_THEME_KEY, 'bright']]);
      expect(preference.getState()).toMatchObject({ theme: 'bright', previewTheme: null, error: null });
    } finally { vi.unstubAllGlobals(); }
  });
  it('ignores malformed preview/commit values before storage or appearance changes', () => {
    const input = memory('solar'), preference = createThemePreferences(input.backend);
    preference.getState().preview('forest'); preference.getState().preview('Bright' as UiTheme);
    expect(preference.getState().commit('Bright' as UiTheme)).toBe(false);
    expect(preference.getState()).toMatchObject({ theme: 'solar', previewTheme: 'forest' }); expect(input.writes).toEqual([]);
  });
  it('resolves System live at the browser boundary without replacing the saved choice', () => {
    expect(effectiveTheme('system', true)).toBe('dark'); expect(effectiveTheme('system', false)).toBe('bright');
    for (const theme of ['dark', 'bright', 'solar', 'slate', 'midnight', 'forest', 'rose'] as const) {
      expect(effectiveTheme(theme, true)).toBe(theme); expect(effectiveTheme(theme, false)).toBe(theme);
    }
    const preference = createThemePreferences(memory('system').backend);
    expect(themePalette(preference.getState().theme, true)).toBe(themePalette('dark'));
    expect(themePalette(preference.getState().theme, false)).toBe(themePalette('bright'));
    expect(preference.getState().theme).toBe('system');
  });
});

describe('native UI palettes and semantic chrome tokens', () => {
  it('retains all sixteen Dark channels from ui_design.hpp without byte/hex rounding', () => {
    expect(themePalette('dark')).toEqual({
      text: rgb(.91), muted: rgb(.52), accent: rgb(.72), panel: rgb(.086), window: rgb(.059), border: rgb(.165),
      separator: rgb(.133), field: rgb(.102), hover: rgb(.149), active: rgb(.188), button: rgb(.118),
      selectedHover: rgb(.22), selectedPressed: rgb(.25), scrollbar: rgb(.23), activeBorder: rgb(.467), accentHover: rgb(.816),
    });
    expect(themePalette('dark').panel[0]).not.toBe(22 / 255);
  });
  it.each([
    ['bright', [[.12, .13, .15], [.38, .4, .43], [.28, .3, .34], [.97, .975, .985], [.93, .94, .955], [.77, .79, .82], [.85, .87, .89], [1, 1, 1],
      [.89, .91, .94], [.82, .85, .89], [.94, .95, .97], [.77, .81, .86], [.72, .77, .83], [.65, .68, .73], [.42, .46, .51], [.19, .22, .27]]],
    ['solar', [[.24, .22, .18], [.44, .39, .31], [.46, .34, .16], [.985, .96, .88], [.94, .90, .80], [.79, .74, .63], [.86, .82, .72], [1, .985, .935],
      [.94, .90, .79], [.89, .83, .69], [.965, .935, .85], [.86, .79, .63], [.82, .73, .56], [.7, .63, .5], [.55, .46, .31], [.35, .25, .10]]],
  ] as const)('retains every literal source channel of the %s palette', (theme, expected) => {
    expect(Object.values(themePalette(theme))).toEqual(expected.map(([red, green, blue]) => rgb(red, green, blue)));
  });
  it('uses the analytical dark-shade Forest mix for all sixteen fields', () => {
    // Native mix weights applied analytically to the four captured Forest
    // literals; these expected decimal colors are independent of mix().
    const expected = [[.9, .96, .92], [.58, .72, .63], [.53, .83, .66], [.075, .14, .115],
      [.0615, .1148, .0943], [.24, .304, .276], [.1575, .222, .1955], [.0525, .098, .0805],
      [.14925, .2138, .18745], [.19875, .263, .23575], [.103875, .1687, .143175], [.166, .278, .224],
      [.2024, .3332, .2676], [.339, .4024, .3726], [.4875, .55, .5175], [.604, .856, .712]];
    Object.values(themePalette('forest')).forEach((value, index) => {
      value.slice(0, 3).forEach((channel, component) => expect(channel).toBeCloseTo(expected[index][component], 7)); expect(value[3]).toBe(1);
    });
  });
  it('uses a white shade for Rose and preserves the distinct Slate/Midnight inputs', () => {
    expect(themePalette('rose').panel).toEqual(rgb(.985, .95, .96));
    themePalette('rose').window.slice(0, 3).forEach((value, index) => expect(value).toBeCloseTo([.9877, .959, .9672][index], 7));
    themePalette('rose').field.slice(0, 3).forEach((value, index) => expect(value).toBeCloseTo([.9895, .965, .972][index], 7));
    expect(themePalette('slate').accent).toEqual(rgb(.65, .77, .9)); expect(themePalette('slate').panel).toEqual(rgb(.14, .17, .21));
    expect(themePalette('midnight').accent).toEqual(rgb(.72, .67, 1)); expect(themePalette('midnight').panel).toEqual(rgb(.07, .085, .16));
  });
  it.each(['dark', 'bright', 'solar', 'slate', 'midnight', 'forest', 'rose'] as const)('publishes immutable %s chrome tokens with matching contrast mode and no scene color', theme => {
    const palette = themePalette(theme), style = themeStyle(theme) as Record<string, string>;
    expect(Object.isFrozen(palette)).toBe(true); expect(Object.values(palette).every(Object.isFrozen)).toBe(true);
    expect(style['--ui-panel']).toBe(themeColorCss(palette.panel)); expect(style['--ui-text']).toBe(themeColorCss(palette.text));
    expect(style['--ui-accent-hover']).toBe(themeColorCss(palette.accentHover));
    expect(style.colorScheme).toBe(['bright', 'solar', 'rose'].includes(theme) ? 'light' : 'dark');
    expect(style['--ui-selection'].endsWith('/ 0.25)')).toBe(true); expect(style['--ui-modal-dim'].endsWith('/ 0.75)')).toBe(true);
    expect(Object.keys(style)).not.toContain('--scene-background'); expect(Object.keys(style)).not.toContain('background');
    expect(Object.keys(style)).toHaveLength(24);
  });
  it('keeps error text readable on light chrome and contrasting primary action text in both modes', () => {
    expect((themeStyle('bright') as Record<string, string>)['--ui-error']).toBe(themeColorCss(themePalette('bright').text));
    expect((themeStyle('solar') as Record<string, string>)['--ui-error']).toBe(themeColorCss(themePalette('solar').text));
    expect((themeStyle('dark') as Record<string, string>)['--ui-error']).toBe(themeColorCss([Math.fround(.95), .5, Math.fround(.45), 1]));
    expect((themeStyle('dark') as Record<string, string>)['--ui-on-accent']).toBe('rgb(0 0 0 / 1)');
    expect((themeStyle('dark') as Record<string, string>)['--ui-icon']).toBe('rgb(168 168 168 / 1)');
    expect((themeStyle('bright') as Record<string, string>)['--ui-on-accent']).toBe('rgb(255 255 255 / 1)');
  });
});
