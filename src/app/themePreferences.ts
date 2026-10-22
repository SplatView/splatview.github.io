import { create } from 'zustand';
import type { CSSProperties } from 'react';

export type UiTheme = 'system' | 'dark' | 'bright' | 'solar' | 'slate' | 'midnight' | 'forest' | 'rose';
export type EffectiveUiTheme = Exclude<UiTheme, 'system'>;
// Captured desktop ui_theme.hpp:9-14. Display order differs from the C++ enum.
export const UI_THEMES = Object.freeze([
  { theme: 'system', name: 'System' }, { theme: 'dark', name: 'Dark' },
  { theme: 'bright', name: 'Bright' }, { theme: 'solar', name: 'Solar' },
  { theme: 'slate', name: 'Slate' }, { theme: 'midnight', name: 'Midnight' },
  { theme: 'forest', name: 'Forest' }, { theme: 'rose', name: 'Rose' },
] as const);
export const UI_THEME_KEY = 'splatview.ui-theme.v1';
type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;
type ThemePreferences = {
  theme: UiTheme; previewTheme: UiTheme | null; error: string | null;
  preview: (theme: UiTheme) => void;
  cancelPreview: () => void;
  commit: (theme: UiTheme) => boolean;
};
function storage(): PreferenceStorage | undefined {
  try { return globalThis.localStorage; } catch { return undefined; }
}
export function isUiTheme(value: unknown): value is UiTheme {
  return UI_THEMES.some(info => info.theme === value);
}
export function createThemePreferences(preferences = storage()) {
  // tools_preferences.cpp:50-60 defaults to Dark, independently of the OS.
  let initial: UiTheme = 'dark';
  try { const saved = preferences?.getItem(UI_THEME_KEY); if (isUiTheme(saved)) initial = saved; } catch { /* Use Dark. */ }
  return create<ThemePreferences>((set, get) => ({
    theme: initial, previewTheme: null, error: null,
    preview: theme => { if (isUiTheme(theme) && get().previewTheme !== theme) set({ previewTheme: theme }); },
    cancelPreview: () => { if (get().previewTheme !== null) set({ previewTheme: null }); },
    commit: theme => {
      if (!isUiTheme(theme)) return false;
      // Clicking the current native choice cancels preview without saving or
      // clearing an earlier Settings save error (app_ui_settings.cpp:153-163).
      if (get().theme === theme) { set({ previewTheme: null }); return true; }
      try {
        const target = preferences ?? storage();
        if (!target) throw new Error('Local preferences are unavailable.');
        target.setItem(UI_THEME_KEY, theme);
        set({ theme, previewTheme: null, error: null });
        return true;
      } catch {
        set({ previewTheme: null, error: 'Could not save theme. Your previous theme is unchanged. Try again when local storage is available.' });
        return false;
      }
    },
  }));
}
export const useThemePreferences = createThemePreferences();

/** Browser OS detection is owned by App; this module has no media listeners. */
export function effectiveTheme(theme: UiTheme, systemDark: boolean): EffectiveUiTheme {
  return theme === 'system' ? systemDark ? 'dark' : 'bright' : theme;
}
export type ThemeColor = readonly [number, number, number, number];
export type ThemePalette = Readonly<{
  text: ThemeColor; muted: ThemeColor; accent: ThemeColor; panel: ThemeColor;
  window: ThemeColor; border: ThemeColor; separator: ThemeColor; field: ThemeColor;
  hover: ThemeColor; active: ThemeColor; button: ThemeColor; selectedHover: ThemeColor;
  selectedPressed: ThemeColor; scrollbar: ThemeColor; activeBorder: ThemeColor; accentHover: ThemeColor;
}>;
const f = Math.fround;
function color(red: number, green = red, blue = red, alpha = 1): ThemeColor {
  return Object.freeze([f(red), f(green), f(blue), f(alpha)]);
}
// ui_design.hpp:47-50: float subtraction, multiplication and addition. Keep
// the captured float channels through CSS conversion rather than rounding hex.
function mix(a: ThemeColor, b: ThemeColor, amount: number): ThemeColor {
  const t = f(amount);
  return Object.freeze(a.map((value, index) => f(value + f(f(b[index] - value) * t)))) as ThemeColor;
}
function luminance(value: ThemeColor): number {
  const linear = (channel: number) => channel <= f(.04045) ? f(channel / f(12.92)) :
    f(Math.pow(f(f(channel + f(.055)) / f(1.055)), f(2.4)));
  return f(f(f(f(.2126) * linear(value[0])) + f(f(.7152) * linear(value[1]))) + f(f(.0722) * linear(value[2])));
}
const PALETTE_FIELDS = ['text', 'muted', 'accent', 'panel', 'window', 'border', 'separator', 'field',
  'hover', 'active', 'button', 'selectedHover', 'selectedPressed', 'scrollbar', 'activeBorder', 'accentHover'] as const;
function palette(values: readonly ThemeColor[]): ThemePalette {
  return Object.freeze(Object.fromEntries(PALETTE_FIELDS.map((field, index) => [field, values[index]]))) as ThemePalette;
}
// ui_design.hpp:90-108. All source literals are float32 before interpolation.
function tintedPalette(panel: ThemeColor, text: ThemeColor, muted: ThemeColor, accent: ThemeColor): ThemePalette {
  const shade = luminance(panel) < f(.179) ? color(0) : color(1);
  return palette([text, muted, accent, panel, mix(panel, shade, .18), mix(panel, text, .2),
    mix(panel, text, .1), mix(panel, shade, .3), mix(panel, text, .09), mix(panel, text, .15),
    mix(panel, text, .035), mix(panel, accent, .2), mix(panel, accent, .28), mix(panel, text, .32),
    mix(panel, text, .5), mix(accent, text, .2)]);
}
// Direct palettes retain the sixteen-field native aggregate order exactly.
const PALETTES: Readonly<Record<EffectiveUiTheme, ThemePalette>> = Object.freeze({
  dark: palette([color(.91), color(.52), color(.72), color(.086), color(.059), color(.165), color(.133), color(.102),
    color(.149), color(.188), color(.118), color(.22), color(.25), color(.23), color(.467), color(.816)]),
  bright: palette([color(.12, .13, .15), color(.38, .4, .43), color(.28, .3, .34), color(.97, .975, .985),
    color(.93, .94, .955), color(.77, .79, .82), color(.85, .87, .89), color(1), color(.89, .91, .94),
    color(.82, .85, .89), color(.94, .95, .97), color(.77, .81, .86), color(.72, .77, .83),
    color(.65, .68, .73), color(.42, .46, .51), color(.19, .22, .27)]),
  solar: palette([color(.24, .22, .18), color(.44, .39, .31), color(.46, .34, .16), color(.985, .96, .88),
    color(.94, .90, .80), color(.79, .74, .63), color(.86, .82, .72), color(1, .985, .935),
    color(.94, .90, .79), color(.89, .83, .69), color(.965, .935, .85), color(.86, .79, .63),
    color(.82, .73, .56), color(.7, .63, .5), color(.55, .46, .31), color(.35, .25, .10)]),
  slate: tintedPalette(color(.14, .17, .21), color(.92, .94, .96), color(.63, .67, .73), color(.65, .77, .9)),
  midnight: tintedPalette(color(.07, .085, .16), color(.91, .93, 1), color(.62, .65, .8), color(.72, .67, 1)),
  forest: tintedPalette(color(.075, .14, .115), color(.9, .96, .92), color(.58, .72, .63), color(.53, .83, .66)),
  rose: tintedPalette(color(.985, .95, .96), color(.25, .17, .21), color(.46, .35, .4), color(.59, .28, .41)),
});
export function themePalette(theme: UiTheme, systemDark = true): ThemePalette {
  return PALETTES[effectiveTheme(theme, systemDark)];
}
export function themeColorCss(value: ThemeColor): string {
  return `rgb(${value[0] * 255} ${value[1] * 255} ${value[2] * 255} / ${value[3]})`;
}
/** Semantic UI chrome only; scene background and scene RGB overlays are separate. */
export function themeStyle(theme: UiTheme, systemDark = true): CSSProperties {
  const value = themePalette(theme, systemDark), properties: Record<string, string> = {};
  for (const field of PALETTE_FIELDS) properties[`--ui-${field.replace(/[A-Z]/g, char => `-${char.toLowerCase()}`)}`] = themeColorCss(value[field]);
  properties['--ui-hover-border'] = themeColorCss(mix(value.border, value.text, .0832));
  properties['--ui-selected-border'] = themeColorCss(mix(value.border, value.accent, .544));
  // app_ui.cpp:89 and ImGui ColorConvertFloat4ToU32: ordinary icon ink
  // reaches the native draw list as rounded UNORM8 channels.
  const icon = mix(value.muted, value.text, .355);
  properties['--ui-icon'] = `rgb(${icon.slice(0, 3).map(channel => Math.floor(f(f(channel * 255) + .5))).join(' ')} / 1)`;
  properties['--ui-on-accent'] = themeColorCss(luminance(value.accent) > f(.179) ? color(0) : color(1));
  properties['--ui-selection'] = themeColorCss(color(...value.accent.slice(0, 3) as [number, number, number], .25));
  properties['--ui-modal-dim'] = themeColorCss(color(...value.window.slice(0, 3) as [number, number, number], .75));
  const error = color(.95, .5, .45), a = luminance(error), b = luminance(value.panel);
  properties['--ui-error'] = themeColorCss(f(f(Math.max(a, b) + f(.05)) / f(Math.min(a, b) + f(.05))) >= f(4.5) ? error : value.text);
  return { ...properties, colorScheme: luminance(value.panel) < f(.179) ? 'dark' : 'light' } as CSSProperties;
}
