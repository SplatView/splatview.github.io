import { create } from 'zustand';
import type { CSSProperties } from 'react';

export type UiSize = 'small' | 'medium' | 'large';
// capture02/src/ui_size.hpp:13 and ui_design.hpp:10. These are logical
// increments, independent of canvas resolution and devicePixelRatio.
export const UI_SIZES = [
  { size: 'small', name: 'Small', fontIncrease: 0, captionIncrease: 0, panelScale: 1 },
  { size: 'medium', name: 'Medium', fontIncrease: 2, captionIncrease: 1, panelScale: 1.12 },
  { size: 'large', name: 'Large', fontIncrease: 4, captionIncrease: 2, panelScale: 1.25 },
] as const;
export const UI_SIZE_KEY = 'splatview.ui-size.v1';
type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;
type UiPreferences = {
  size: UiSize; previewSize: UiSize | null; error: string | null;
  preview: (size: UiSize) => void;
  cancelPreview: () => void;
  commit: (size: UiSize) => boolean;
};
function storage(): PreferenceStorage | undefined {
  try { return globalThis.localStorage; } catch { return undefined; }
}
function isSize(value: unknown): value is UiSize {
  return UI_SIZES.some(info => info.size === value);
}
export function createUiPreferences(preferences = storage()) {
  let initial: UiSize = 'small';
  try { const saved = preferences?.getItem(UI_SIZE_KEY); if (isSize(saved)) initial = saved; } catch { /* Use Small. */ }
  return create<UiPreferences>((set, get) => ({
    size: initial, previewSize: null, error: null,
    preview: size => { if (isSize(size) && get().previewSize !== size) set({ previewSize: size }); },
    cancelPreview: () => { if (get().previewSize !== null) set({ previewSize: null }); },
    commit: size => {
      if (!isSize(size)) return false;
      if (get().size === size) { set({ previewSize: null }); return true; }
      try {
        const target = preferences ?? storage();
        if (!target) throw new Error('Local preferences are unavailable.');
        target.setItem(UI_SIZE_KEY, size);
        set({ size, previewSize: null, error: null });
        return true;
      } catch {
        // Like native Settings, a failed save restores the committed appearance.
        set({ previewSize: null, error: 'Could not save font size. Your previous size is unchanged. Try again when local storage is available.' });
        return false;
      }
    },
  }));
}
export const useUiPreferences = createUiPreferences();
export function uiSizeStyle(size: UiSize): CSSProperties {
  const info = UI_SIZES.find(info => info.size === size)!;
  return { '--ui-font-increase': `${info.fontIncrease}px`, '--ui-caption-increase': `${info.captionIncrease}px`,
    '--ui-panel-scale': info.panelScale } as CSSProperties;
}
