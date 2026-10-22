// Values follow the portable core's NavigationKey enum. Keep input translation
// here; acceleration, normalized velocity and integration live in native WASM.
const keys: Readonly<Record<string, number>> = {
  KeyW: 0, KeyS: 1, KeyA: 2, KeyD: 3, KeyQ: 4, KeyE: 5, Space: 6,
  ArrowLeft: 7, ArrowRight: 8, ArrowUp: 9, ArrowDown: 10,
};
export function navigationKey(code: string) { return keys[code]; }
export function translationKey(code: string) {
  const key = navigationKey(code); return key !== undefined && key < 7;
}
export function wheelTicks(deltaY: number, deltaMode: number) {
  // Browsers normalize a wheel notch to roughly 100 CSS pixels or 3 lines.
  // Trackpad fractions pass through continuously; a page is one notch.
  return Number.isFinite(deltaY) ? -deltaY / (deltaMode === 1 ? 3 : deltaMode === 2 ? 1 : 100) : 0;
}
