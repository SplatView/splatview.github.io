import { create } from 'zustand';
import { TUTORIAL_VERSION } from './tutorialCatalog';

// Pinned SplatView v1.0.2 tutorialVersion7 offer/close policy. An offer is handled when shown;
// any positive prior version suppresses first-run onboarding. Closing early
// also completes v7. Browser storage is separate from document/editor state.
export const TUTORIAL_PREFERENCE_KEY = 'splatview.tutorial.v1';
export const TUTORIAL_SAVE_ERROR = 'Could not save tool preferences. This window keeps your choice.';
export type TutorialPreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;
export type TutorialPreferences = {
  promptHandled: boolean; seenVersion: number; error: string | null;
  refresh(): void;
  /** Reports persistence success; the offer remains handled in memory on failure. */
  markOffered(): boolean;
  /** Reports persistence success; closing must proceed even when saving fails. */
  finish(): boolean;
};
type Saved = { record: Record<string, unknown>; promptHandled: boolean; seenVersion: number };
const MAX_PREFERENCE_BYTES = 64 * 1024;
function storage(): TutorialPreferenceStorage | undefined {
  try { return globalThis.localStorage; } catch { return undefined; }
}
function read(preferences: TutorialPreferenceStorage | undefined): Saved {
  try {
    const raw = preferences?.getItem(TUTORIAL_PREFERENCE_KEY);
    if (typeof raw === 'string' && raw.length <= MAX_PREFERENCE_BYTES && new TextEncoder().encode(raw).length <= MAX_PREFERENCE_BYTES) {
      const value: unknown = JSON.parse(raw);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const record = value as Record<string, unknown>, version = record.tutorial_version;
        const seenVersion = typeof version === 'number' && Number.isSafeInteger(version) && version > 0 ? version : 0;
        return { record, seenVersion, promptHandled: record.tutorial_prompt_handled === 'handled' || seenVersion > 0 };
      }
    }
  } catch { /* Missing, unavailable, malformed or oversized preferences start fresh. */ }
  return { record: {}, promptHandled: false, seenVersion: 0 };
}
export function createTutorialPreferences(preferences = storage()) {
  const initial = read(preferences);
  return create<TutorialPreferences>((set, get) => {
    const persist = (completed: boolean): boolean => {
      try {
        const target = preferences ?? storage();if (!target) throw new Error('Local preferences are unavailable.');
        const saved = { ...read(target).record, tutorial_prompt_handled: 'handled', ...(completed ? { tutorial_version: TUTORIAL_VERSION } : {}) };
        target.setItem(TUTORIAL_PREFERENCE_KEY, JSON.stringify(saved));set({ error: null });return true;
      } catch {
        set({ error: TUTORIAL_SAVE_ERROR });return false;
      }
    };
    return {
      promptHandled: initial.promptHandled, seenVersion: initial.seenVersion, error: null,
      refresh: () => {
        const saved = read(preferences ?? storage()), current = get();
        const promptHandled = current.promptHandled || saved.promptHandled, seenVersion = Math.max(current.seenVersion, saved.seenVersion);
        if (promptHandled !== current.promptHandled || seenVersion !== current.seenVersion) set({ promptHandled, seenVersion });
      },
      markOffered: () => {
        if (get().promptHandled) return get().error === null;
        // Keep the in-window choice before attempting storage. A refused save
        // must not turn a shown/dismissed prompt into a recurring offer.
        set({ promptHandled: true });return persist(false);
      },
      finish: () => {
        // Replay and same-version close retry the write and can clear an error.
        set({ promptHandled: true, seenVersion: TUTORIAL_VERSION });return persist(true);
      },
    };
  });
}
export const useTutorialPreferences = createTutorialPreferences();
