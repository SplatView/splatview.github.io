// Frozen desktop BackgroundColor order and linear render-target shades.
export const BACKGROUND_COLORS = ['black', 'gray', 'white'] as const;
export type BackgroundColor = typeof BACKGROUND_COLORS[number];
export function backgroundShade(color: BackgroundColor): number {
  return color === 'white' ? 1 : color === 'gray' ? .5 : 0;
}
export function nextBackground(color: BackgroundColor): BackgroundColor {
  return BACKGROUND_COLORS[(BACKGROUND_COLORS.indexOf(color) + 1) % BACKGROUND_COLORS.length];
}
