import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTutorialPreferences, TUTORIAL_PREFERENCE_KEY, TUTORIAL_SAVE_ERROR } from '../src/app/tutorialPreferences';
import { TUTORIAL_VERSION } from '../src/app/tutorialCatalog';

function memory(initial?: string) {
  const values = new Map<string, string>(initial === undefined ? [] : [[TUTORIAL_PREFERENCE_KEY, initial]]);
  const writes: [string, string][] = [];
  const backend = { blocked: false, readsBlocked: false, attempts: 0,
    getItem: (key: string) => {if (backend.readsBlocked) throw new Error('Read denied.');return values.get(key) ?? null;},
    setItem: (key: string, value: string) => {
      backend.attempts++;if (backend.blocked) throw new Error('Write denied.');writes.push([key, value]);values.set(key, value);
    },
  };
  return { values, writes, backend };
}
afterEach(() => vi.unstubAllGlobals());

describe('native Tutorial offer/completion preferences with browser persistence', () => {
  it('starts unoffered and unseen without writing missing preferences', () => {
    const input = memory(), preference = createTutorialPreferences(input.backend);
    expect(TUTORIAL_PREFERENCE_KEY).toBe('splatview.tutorial.v1');
    expect(preference.getState()).toMatchObject({promptHandled: false, seenVersion: 0, error: null});expect(input.writes).toEqual([]);
  });
  it.each(['bad JSON', 'null', '[]', 'true', '3', '"handled"', '{"tutorial_version":"3"}',
    '{"tutorial_version":-1}', '{"tutorial_version":1.5}', '{"tutorial_version":9007199254740992}',
    '{"tutorial_prompt_handled":true}', '{"tutorial_prompt_handled":"yes"}'])(
    'contains malformed or invalid saved preference %s without rewriting it', saved => {
      const input = memory(saved), preference = createTutorialPreferences(input.backend);
      expect(preference.getState()).toMatchObject({promptHandled: false, seenVersion: 0, error: null});expect(input.writes).toEqual([]);
    });
  it('rejects oversized UTF-8 JSON, not only oversized character counts', () => {
    const input = memory(JSON.stringify({tutorial_version: 3, padding: '界'.repeat(22000)}));
    expect(createTutorialPreferences(input.backend).getState()).toMatchObject({promptHandled: false, seenVersion: 0});
    expect(input.writes).toEqual([]);
  });
  it.each([1, 2, 3, 4, 6, 7, 8, Number.MAX_SAFE_INTEGER])('suppresses first-run offers for any positive completed version %i', seenVersion => {
    const input = memory(JSON.stringify({tutorial_version: seenVersion})), preference = createTutorialPreferences(input.backend);
    expect(preference.getState()).toMatchObject({promptHandled: true, seenVersion, error: null});expect(input.writes).toEqual([]);
    expect(TUTORIAL_VERSION).toBe(7); expect(preference.getState().seenVersion >= TUTORIAL_VERSION).toBe(seenVersion >= TUTORIAL_VERSION);
    expect(preference.getState().markOffered()).toBe(true); expect(input.writes).toEqual([]);
  });
  it('marks a shown offer handled before user response without marking the tour complete', () => {
    const input = memory(), preference = createTutorialPreferences(input.backend), observed: boolean[] = [];
    const setItem = input.backend.setItem;
    input.backend.setItem = (key, value) => {observed.push(preference.getState().promptHandled);setItem(key, value);};
    expect(preference.getState().markOffered()).toBe(true);
    expect(observed).toEqual([true]);expect(preference.getState()).toMatchObject({promptHandled: true, seenVersion: 0, error: null});
    expect(JSON.parse(input.values.get(TUTORIAL_PREFERENCE_KEY)!)).toEqual({tutorial_prompt_handled: 'handled'});
    expect(createTutorialPreferences(input.backend).getState()).toMatchObject({promptHandled: true, seenVersion: 0});
    expect(preference.getState().markOffered()).toBe(true);expect(input.writes).toHaveLength(1);
  });
  it('persists version7 on closing, including early close and replay of an already-seen tour', () => {
    const input = memory(JSON.stringify({tutorial_version: 1})), preference = createTutorialPreferences(input.backend);
    expect(preference.getState().finish()).toBe(true);
    expect(preference.getState()).toMatchObject({promptHandled: true, seenVersion: 7, error: null});
    expect(createTutorialPreferences(input.backend).getState()).toMatchObject({promptHandled: true, seenVersion: 7});
    expect(preference.getState().finish()).toBe(true);expect(input.writes).toHaveLength(2);
    expect(input.writes.every(([key, value]) => key === TUTORIAL_PREFERENCE_KEY && JSON.parse(value).tutorial_version === 7)).toBe(true);
  });
  it('preserves unrelated record fields and other appearance preferences on each write', () => {
    const input = memory(JSON.stringify({note: 'retain', nested: {value: 2}})), preference = createTutorialPreferences(input.backend);
    input.values.set('splatview.ui-language.v1', 'ja');input.values.set('splatview.ui-theme.v1', 'forest');input.values.set('splatview.ui-size.v1', 'large');
    expect(preference.getState().markOffered()).toBe(true);expect(preference.getState().finish()).toBe(true);
    expect(JSON.parse(input.values.get(TUTORIAL_PREFERENCE_KEY)!)).toEqual({note: 'retain', nested: {value: 2}, tutorial_prompt_handled: 'handled', tutorial_version: 7});
    expect(input.values.get('splatview.ui-language.v1')).toBe('ja');expect(input.values.get('splatview.ui-theme.v1')).toBe('forest');
    expect(input.values.get('splatview.ui-size.v1')).toBe('large');
  });
  it('keeps a refused offer handled in this window, does not loop failed writes, and retries on completion', () => {
    const input = memory(), preference = createTutorialPreferences(input.backend);input.backend.blocked = true;
    expect(preference.getState().markOffered()).toBe(false);
    expect(preference.getState()).toMatchObject({promptHandled: true, seenVersion: 0, error: TUTORIAL_SAVE_ERROR});
    preference.getState().refresh();expect(preference.getState().markOffered()).toBe(false);expect(input.backend.attempts).toBe(1);
    input.backend.blocked = false;expect(preference.getState().finish()).toBe(true);
    expect(preference.getState()).toMatchObject({promptHandled: true, seenVersion: 7, error: null});expect(input.backend.attempts).toBe(2);
    expect(createTutorialPreferences(input.backend).getState()).toMatchObject({promptHandled: true, seenVersion: 7});
  });
  it('retains memory completion on save failure and retries the same completed version', () => {
    const input = memory(JSON.stringify({tutorial_version: 2})), preference = createTutorialPreferences(input.backend);input.backend.blocked = true;
    expect(preference.getState().finish()).toBe(false);preference.getState().refresh();
    expect(preference.getState()).toMatchObject({promptHandled: true, seenVersion: 7, error: TUTORIAL_SAVE_ERROR});
    expect(JSON.parse(input.values.get(TUTORIAL_PREFERENCE_KEY)!).tutorial_version).toBe(2);
    input.backend.blocked = false;expect(preference.getState().finish()).toBe(true);expect(preference.getState().error).toBeNull();
    expect(JSON.parse(input.values.get(TUTORIAL_PREFERENCE_KEY)!).tutorial_version).toBe(7);
  });
  it('rechecks another window before offering without losing this window fallback to failed persistence', () => {
    const input = memory(), preference = createTutorialPreferences(input.backend);
    input.values.set(TUTORIAL_PREFERENCE_KEY, JSON.stringify({tutorial_prompt_handled: 'handled'}));preference.getState().refresh();
    expect(preference.getState()).toMatchObject({promptHandled: true, seenVersion: 0});
    input.values.set(TUTORIAL_PREFERENCE_KEY, JSON.stringify({tutorial_version: 4}));preference.getState().refresh();
    expect(preference.getState()).toMatchObject({promptHandled: true, seenVersion: 4});
    input.values.delete(TUTORIAL_PREFERENCE_KEY);preference.getState().refresh();
    expect(preference.getState()).toMatchObject({promptHandled: true, seenVersion: 4});expect(input.writes).toEqual([]);
  });
  it('contains denied reads and still saves when writes are available', () => {
    const input = memory();input.backend.readsBlocked = true;const preference = createTutorialPreferences(input.backend);
    expect(preference.getState()).toMatchObject({promptHandled: false, seenVersion: 0, error: null});
    expect(preference.getState().finish()).toBe(true);expect(preference.getState()).toMatchObject({promptHandled: true, seenVersion: 7, error: null});
    input.backend.readsBlocked = false;expect(createTutorialPreferences(input.backend).getState().seenVersion).toBe(7);
  });
  it('contains unavailable global storage and acquires a writable fallback later', () => {
    vi.stubGlobal('localStorage', undefined);const preference = createTutorialPreferences();
    expect(preference.getState().markOffered()).toBe(false);expect(preference.getState().promptHandled).toBe(true);
    const input = memory();vi.stubGlobal('localStorage', input.backend);
    expect(preference.getState().finish()).toBe(true);expect(preference.getState().error).toBeNull();
    expect(JSON.parse(input.values.get(TUTORIAL_PREFERENCE_KEY)!)).toEqual({tutorial_prompt_handled: 'handled', tutorial_version: 7});
  });
  it('contains a throwing localStorage getter without changing preference API availability', () => {
    const input = {get localStorage() {throw new Error('Unavailable.');}};
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    try {
      Object.defineProperty(globalThis, 'localStorage', Object.getOwnPropertyDescriptor(input, 'localStorage')!);
      const preference = createTutorialPreferences();expect(preference.getState().finish()).toBe(false);
      expect(preference.getState()).toMatchObject({promptHandled: true, seenVersion: 7, error: TUTORIAL_SAVE_ERROR});
    } finally { if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);else Reflect.deleteProperty(globalThis, 'localStorage'); }
  });
});
