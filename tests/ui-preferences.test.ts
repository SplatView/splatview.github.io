import { describe, expect, it, vi } from 'vitest';
import { createUiPreferences, UI_SIZES, UI_SIZE_KEY, uiSizeStyle, type UiSize } from '../src/app/uiPreferences';

function memory(initial?: string) {
  const values = new Map<string, string>(initial === undefined ? [] : [[UI_SIZE_KEY, initial]]);
  const writes: [string, string][] = [];
  const backend = { blocked: false,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (backend.blocked) throw new Error('Storage is blocked.');
      writes.push([key, value]); values.set(key, value);
    },
  };
  return { backend, values, writes };
}

describe('native .116 UI-size preference', () => {
  it('retains the captured order, logical increments and panel scales', () => {
    expect(UI_SIZES).toEqual([
      { size: 'small', name: 'Small', fontIncrease: 0, captionIncrease: 0, panelScale: 1 },
      { size: 'medium', name: 'Medium', fontIncrease: 2, captionIncrease: 1, panelScale: 1.12 },
      { size: 'large', name: 'Large', fontIncrease: 4, captionIncrease: 2, panelScale: 1.25 },
    ]);
    expect(uiSizeStyle('large')).toEqual({ '--ui-font-increase': '4px', '--ui-caption-increase': '2px', '--ui-panel-scale': 1.25 });
  });
  it.each([undefined, 'invalid', 'LARGE', '{"size":"large"}'])('defaults to Small for missing/invalid storage: %s', saved => {
    expect(createUiPreferences(memory(saved).backend).getState().size).toBe('small');
  });
  it.each(['small', 'medium', 'large'] as const)('loads a committed %s choice', size => {
    expect(createUiPreferences(memory(size).backend).getState()).toMatchObject({ size, previewSize: null, error: null });
  });
  it('previews and cancels without writing or replacing the committed choice', () => {
    const input = memory('medium'), preference = createUiPreferences(input.backend);
    preference.getState().preview('large');
    expect(preference.getState()).toMatchObject({ size: 'medium', previewSize: 'large' });
    expect(input.writes).toEqual([]);
    preference.getState().cancelPreview();
    expect(preference.getState()).toMatchObject({ size: 'medium', previewSize: null });
    expect(input.values.get(UI_SIZE_KEY)).toBe('medium'); expect(input.writes).toEqual([]);
  });
  it('persists a changed choice for a new window and does not rewrite the selected choice', () => {
    const input = memory(), preference = createUiPreferences(input.backend);
    preference.getState().preview('large'); expect(preference.getState().commit('medium')).toBe(true);
    expect(preference.getState()).toMatchObject({ size: 'medium', previewSize: null, error: null });
    expect(createUiPreferences(input.backend).getState().size).toBe('medium');
    expect(preference.getState().commit('medium')).toBe(true);
    expect(input.writes).toEqual([[UI_SIZE_KEY, 'medium']]);
  });
  it('restores the committed appearance after failed persistence and allows a later retry', () => {
    const input = memory('medium'), preference = createUiPreferences(input.backend);
    input.backend.blocked = true; preference.getState().preview('large');
    expect(preference.getState().commit('large')).toBe(false);
    expect(preference.getState()).toMatchObject({ size: 'medium', previewSize: null });
    expect(preference.getState().error).toContain('Could not save font size');
    expect(input.values.get(UI_SIZE_KEY)).toBe('medium');
    input.backend.blocked = false; expect(preference.getState().commit('large')).toBe(true);
    expect(preference.getState()).toMatchObject({ size: 'large', previewSize: null, error: null });
  });
  it('contains storage read failures without preventing a subsequent successful save', () => {
    let written = '';
    const preference = createUiPreferences({ getItem: () => { throw new Error('Read denied'); }, setItem: (_key, value) => { written = value; } });
    expect(preference.getState().size).toBe('small'); expect(preference.getState().commit('large')).toBe(true); expect(written).toBe('large');
  });
  it('can retry when storage was unavailable at initial load', () => {
    try {
      vi.stubGlobal('localStorage', undefined);
      const preference = createUiPreferences();
      expect(preference.getState().commit('large')).toBe(false);
      expect(preference.getState()).toMatchObject({ size: 'small', previewSize: null });
      const input = memory(); vi.stubGlobal('localStorage', input.backend);
      expect(preference.getState().commit('large')).toBe(true);
      expect(preference.getState()).toMatchObject({ size: 'large', error: null });
      expect(input.writes).toEqual([[UI_SIZE_KEY, 'large']]);
    } finally { vi.unstubAllGlobals(); }
  });
  it('does not overwrite the independent tools-mode preference', () => {
    const input = memory(); input.values.set('splatview.tools-mode.v1', 'pro');
    const preference = createUiPreferences(input.backend); preference.getState().commit('large');
    expect(input.values.get('splatview.tools-mode.v1')).toBe('pro'); expect(input.writes).toEqual([[UI_SIZE_KEY, 'large']]);
  });
  it('rejects an invalid commit without writes', () => {
    const input = memory(), preference = createUiPreferences(input.backend);
    expect(preference.getState().commit('huge' as UiSize)).toBe(false);
    expect(preference.getState().size).toBe('small'); expect(input.writes).toEqual([]);
  });
});
