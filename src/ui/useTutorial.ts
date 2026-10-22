import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { TUTORIAL_COURSES, type TutorialCourseId } from '../app/tutorialCourse';
import { useTutorialPreferences } from '../app/tutorialPreferences';

type TutorialPhase = 'closed' | 'offer' | 'tour';
type PreparedTutorialScene = Readonly<{ isCurrent(): boolean }>;

/** The tour owns presentation and preparation state, never a document or native session. */
export function useTutorial({ canOffer, canReplay, preparationSuspended = false, interactionIdle, prepareScene, fallbackFocus, replayFallbackFocus }: {
  canOffer: boolean; canReplay: boolean; interactionIdle(): boolean;
  preparationSuspended?: boolean;
  prepareScene(): Promise<false | PreparedTutorialScene>;
  fallbackFocus: RefObject<HTMLElement | null>;
  replayFallbackFocus?: RefObject<HTMLElement | null>;
}) {
  const preferences = useTutorialPreferences();
  const [phase, setPhase] = useState<TutorialPhase>('closed'), [index, setIndex] = useState(0);
  const [courseId, setCourseId] = useState<TutorialCourseId>('essentials');
  const steps = TUTORIAL_COURSES[courseId].steps;
  const [idleRevision, setIdleRevision] = useState(0);
  const [preparing, setPreparing] = useState(false);
  const preparation = useRef<{ version: number; pending: boolean; scene?: PreparedTutorialScene }>({ version: 0, pending: false });
  const notifyIdle = useCallback(() => setIdleRevision(value => value + 1), []);
  const active = phase !== 'closed' && !(preparation.current.pending && preparationSuspended);
  const current = useRef({ canOffer, canReplay, preparationSuspended, interactionIdle, prepareScene, active, phase, index, steps, fallbackFocus, replayFallbackFocus });
  current.current = { canOffer, canReplay, preparationSuspended, interactionIdle, prepareScene, active, phase, index, steps, fallbackFocus, replayFallbackFocus };
  const pointers = useRef(new Set<number>()), keys = useRef(new Set<string>()), composing = useRef(false);
  const consumed = useRef(new WeakSet<Event>());
  const ownedKeys = useRef(new Set<string>());
  const returnFocus = useRef<HTMLElement | null>(null);
  const rememberFocus = (replay = false) => {
    const previous = document.activeElement;
    // Replay can start after this hook first mounted with an empty viewer.
    // Read the current scene-specific ref rather than the initial callback's.
    const fallback = replay ? current.current.replayFallbackFocus ?? current.current.fallbackFocus : current.current.fallbackFocus;
    returnFocus.current = previous instanceof HTMLElement && previous !== document.body && !previous.closest('.settings-dialog, .tutorial-layer') ? previous : fallback.current;
  };
  const idle = (activation = false) => !pointers.current.size &&
    (!keys.current.size || activation && [...keys.current].every(key => key === 'Enter' || key === 'NumpadEnter' || key === 'Space')) &&
    !composing.current && current.current.interactionIdle();

  useEffect(() => {
    const wake = () => setIdleRevision(value => value + 1);
    const pointerDown = (event: PointerEvent) => { pointers.current.add(event.pointerId); };
    const pointerUp = (event: PointerEvent) => { pointers.current.delete(event.pointerId); if (!pointers.current.size) wake(); };
    const keyDown = (event: KeyboardEvent) => {
      const code = event.code || event.key;
      if (current.current.active || ownedKeys.current.has(code)) { consumed.current.add(event); ownedKeys.current.add(code); }
      keys.current.add(code);
    };
    const keyUp = (event: KeyboardEvent) => {
      // Remember ownership before React may close/unmount the card on this key.
      const code = event.code || event.key;
      if (current.current.active || ownedKeys.current.has(code)) consumed.current.add(event);
      ownedKeys.current.delete(code); keys.current.delete(code); if (!keys.current.size) wake();
    };
    const compositionStart = () => { composing.current = true; };
    const compositionEnd = () => { composing.current = false; wake(); };
    const blur = () => { pointers.current.clear(); keys.current.clear(); ownedKeys.current.clear(); composing.current = false; };
    const visibility = () => { if (document.hidden) blur(); };
    const refresh = () => { useTutorialPreferences.getState().refresh(); wake(); };
    window.addEventListener('pointerdown', pointerDown, true);
    window.addEventListener('pointerup', pointerUp, true); window.addEventListener('pointercancel', pointerUp, true);
    window.addEventListener('keydown', keyDown, true); window.addEventListener('keyup', keyUp, true);
    window.addEventListener('compositionstart', compositionStart, true); window.addEventListener('compositionend', compositionEnd, true);
    window.addEventListener('blur', blur); window.addEventListener('focus', refresh); window.addEventListener('storage', refresh);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      preparation.current.version++; preparation.current.pending = false; preparation.current.scene = undefined;
      window.removeEventListener('pointerdown', pointerDown, true);
      window.removeEventListener('pointerup', pointerUp, true); window.removeEventListener('pointercancel', pointerUp, true);
      window.removeEventListener('keydown', keyDown, true); window.removeEventListener('keyup', keyUp, true);
      window.removeEventListener('compositionstart', compositionStart, true); window.removeEventListener('compositionend', compositionEnd, true);
      window.removeEventListener('blur', blur); window.removeEventListener('focus', refresh); window.removeEventListener('storage', refresh);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, []);

  useEffect(() => {
    if (phase !== 'closed' || !canOffer || preferences.promptHandled) return;
    // Wait for the opening pointer, focus and native initialization to settle.
    const timer = window.setTimeout(() => {
      const saved = useTutorialPreferences.getState(); saved.refresh();
      if (current.current.phase !== 'closed' || !current.current.canOffer || !idle() || useTutorialPreferences.getState().promptHandled) return;
      rememberFocus(); saved.markOffered(); setPhase('offer');
    }, 200);
    return () => window.clearTimeout(timer);
  }, [phase, canOffer, preferences.promptHandled, idleRevision]);

  const begin = useCallback(() => {
    if (preparation.current.pending) return;
    const version = ++preparation.current.version;
    preparation.current.pending = true; preparation.current.scene = undefined; setPreparing(true); setPhase('offer');
    void (async () => {
      let ready: false | PreparedTutorialScene = false;
      try { ready = await current.current.prepareScene(); }
      catch { /* The application preparation callback owns error reporting. */ }
      finally {
        if (preparation.current.version === version) {
          if (ready) {
            preparation.current.scene = ready; notifyIdle();
          } else {
            preparation.current.pending = false; setPreparing(false); setPhase('closed');
          }
        }
      }
    })();
  }, [notifyIdle]);
  // Preparation can publish an ordinary saved-view chooser. Yield presentation
  // and input to it, then admit this same attempt after its choice settles.
  // Every render checks currentness so replacement/loss cannot revive the tour
  // even when readiness flags remain unchanged across a publication.
  useEffect(() => {
    const pending = preparation.current;
    if (!pending.pending || !pending.scene) return;
    if (!pending.scene.isCurrent()) {
      pending.version++; pending.pending = false; pending.scene = undefined;
      setPreparing(false); setPhase('closed'); return;
    }
    if (current.current.preparationSuspended || !current.current.canReplay || !idle()) return;
    pending.pending = false; pending.scene = undefined;
    setPreparing(false); setCourseId('essentials'); setIndex(0); setPhase('tour');
  });
  const replay = useCallback(() => {
    if (preparation.current.pending || !current.current.canReplay || !idle(true)) return false;
    rememberFocus(true); useTutorialPreferences.getState().markOffered(); begin(); return true;
  }, [begin]);
  const start = useCallback(() => {
    // The card's click has already released its pointer. Keyboard activation
    // may retain Enter/Space until keyup and is owned by the offer itself.
    if (!current.current.canReplay || !current.current.interactionIdle()) return;
    begin();
  }, [begin]);
  const dismiss = useCallback(() => {
    // Dismiss only this presentation attempt. The application retains file
    // intake/cancellation ownership, including supersession by a newer open.
    preparation.current.version++; preparation.current.pending = false; preparation.current.scene = undefined;
    setPreparing(false); setPhase('closed');
  }, []);
  const skip = dismiss;
  const close = useCallback(() => {
    useTutorialPreferences.getState().finish(); dismiss();
  }, [dismiss]);
  const next = useCallback(() => {
    if (current.current.index === current.current.steps.length - 1) close();
    else setIndex(previous => Math.min(current.current.steps.length - 1, previous + 1));
  }, [close]);
  const back = useCallback(() => { setIndex(previous => Math.max(0, previous - 1)); }, []);
  const selectTopic = useCallback((course: TutorialCourseId, topicIndex: number) => {
    if (current.current.phase !== 'tour' || preparation.current.pending || !Number.isInteger(topicIndex) ||
        topicIndex < 0 || topicIndex >= TUTORIAL_COURSES[course].steps.length) return;
    setCourseId(course); setIndex(topicIndex);
  }, []);
  const blocksInput = useCallback((event?: Event) => current.current.active || !!event && consumed.current.has(event) ||
    event?.target instanceof Element && !!event.target.closest('.tutorial-layer'), []);
  return { phase, index, courseId, totalSteps: steps.length, selectTopic, step: phase === 'tour' ? steps[index] : null,
    active, preparing, error: preferences.error, returnFocus, replay, start, skip, close, next, back, blocksInput, notifyIdle };
}
