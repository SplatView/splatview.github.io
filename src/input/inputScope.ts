import { navigationKey } from './navigation';

export type FocusOwner = 'canvas' | 'neutral' | 'ui' | 'field';
export type ModalOwner = 'settings' | 'save' | 'unsaved' | 'chooser' | 'output' | 'other';
export type InputOwner =
  | 'browser' | 'tutorial' | 'modal' | 'menu' | 'field' | 'ui'
  | 'gesture' | 'app' | 'scene' | 'neutral';
export type InputAction =
  | 'none' | 'app.open' | 'app.save' | 'app.copy' | 'ui.focus-scene'
  | 'scene.key' | 'scene.modifier' | 'scene.release' | 'gesture.key' | 'gesture.release';

export interface KeyStroke {
  readonly key: string;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly repeat: boolean;
  readonly defaultPrevented: boolean;
  readonly isComposing: boolean;
}

export interface InputContext {
  /** Read overlay ownership from application state, even when focus is on body. */
  readonly tutorial: boolean;
  readonly modal: ModalOwner | null;
  readonly menu: boolean;
  /** Canvas requires both event target and active element to be the canvas. */
  readonly focus: FocusOwner;
  readonly capturedGesture: boolean;
  readonly sceneReady: boolean;
  readonly composing?: boolean;
  /** Stable identity distinguishes successive dialogs, menus, or gestures. */
  readonly ownerId?: string;
}

export interface ScopeTransition {
  readonly changed: boolean;
  readonly clearCamera: boolean;
  readonly resetSelectionModifiers: boolean;
  readonly quarantinedCodes: readonly string[];
}

export interface InputDecision {
  readonly owner: InputOwner;
  readonly action: InputAction;
  readonly preventDefault: boolean;
  readonly reason: string;
  /** Apply this reset plan before dispatching an admitted action. */
  readonly scopeTransition?: ScopeTransition;
}

const result = (owner: InputOwner, action: InputAction, preventDefault: boolean, reason: string): InputDecision =>
  ({ owner, action, preventDefault, reason });
const unchanged = (): ScopeTransition =>
  ({ changed: false, clearCamera: false, resetSelectionModifiers: false, quarantinedCodes: [] });
const primary = (key: KeyStroke): boolean => (key.ctrlKey || key.metaKey) && !key.altKey;
const letter = (key: KeyStroke): string => key.key.toLowerCase();
const fillKey = (key: KeyStroke): boolean => letter(key) === 'g' &&
  !key.ctrlKey && !key.metaKey && !key.shiftKey && !key.altKey;
const thumbnailKey = (key: KeyStroke): boolean => letter(key) === 't' &&
  !key.ctrlKey && !key.metaKey && !key.shiftKey && !key.altKey;
const physical = (key: KeyStroke): string => key.code || letter(key);
const composingContext = (key: KeyStroke, context: InputContext): InputContext =>
  key.isComposing && !context.composing ? { ...context, composing: true } : context;
const modifierCodes = new Set([
  'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight',
  'MetaLeft', 'MetaRight', 'AltLeft', 'AltRight',
]);
const modifier = (key: KeyStroke): boolean => modifierCodes.has(key.code) ||
  !key.code && ['Shift', 'Control', 'Meta', 'Alt'].includes(key.key);
const navigation = (key: KeyStroke): boolean => navigationKey(key.code) !== undefined;
const sceneLetters = new Set(['b', 'c', 'f', 'g', 'i', 'm', 'n', 'o', 'p', 'r', 't', 'v', 'x']);
const scenePrimary = new Set(['z', 'y', 'a', 'i', 'e']);
const oneShotLetters = new Set(['r', 'v', 'o', 'f', 'b', 'x', 'p', 'm', 'n', 'c', 'i', 't']);
const browserPrimary = new Set(['f', 'g', 'l', 'n', 'p', 'r', 't', 'w']);

export function isKnownBrowserKey(key: KeyStroke): boolean {
  if (['Tab', 'F5', 'F6'].includes(key.key)) return true;
  if (key.altKey && key.code === 'Space') return true;
  if (key.altKey && !key.ctrlKey && !key.metaKey && ['ArrowLeft', 'ArrowRight', 'Home', 'F4'].includes(key.key)) return true;
  if (!primary(key)) return false;
  const lower = letter(key);
  if (browserPrimary.has(lower)) return true;
  if (['0', '+', '-', '='].includes(key.key) || ['Digit0', 'NumpadAdd', 'NumpadSubtract'].includes(key.code)) return true;
  return key.shiftKey && ['c', 'i', 'j'].includes(lower);
}

export function scopeOwner(context: InputContext): InputOwner {
  if (context.tutorial) return 'tutorial';
  if (context.modal) return 'modal';
  if (context.menu) return 'menu';
  if (context.composing || context.focus === 'field') return 'field';
  if (context.focus === 'ui') return 'ui';
  if (context.capturedGesture) return 'gesture';
  if (context.focus === 'canvas') return 'scene';
  return 'neutral';
}

function isSceneKey(key: KeyStroke): boolean {
  const lower = letter(key);
  if (modifier(key)) return true;
  if (primary(key)) return scenePrimary.has(lower);
  if (key.ctrlKey || key.metaKey) return false;
  if (key.altKey) return navigation(key) || key.key === 'Escape';
  if (['g', 't'].includes(lower) && key.shiftKey) return false;
  return navigation(key) || sceneLetters.has(lower) ||
    ['Escape', 'Enter', 'Delete', 'Backspace', 'PageUp', 'PageDown'].includes(key.key) ||
    /^[1-4]$/.test(key.key) || /^Digit[1-4]$/.test(key.code) ||
    ['BracketLeft', 'BracketRight'].includes(key.code);
}

/** Gate existing App branches; command ordering and availability stay in App. */
export function admitKeyDown(key: KeyStroke, context: InputContext): InputDecision {
  if (key.defaultPrevented) return result('neutral', 'none', false, 'event target already handled this key');
  if (isKnownBrowserKey(key)) return result('browser', 'none', false, 'browser or focus navigation owns this key');
  const owner = scopeOwner(composingContext(key, context));
  if (owner === 'tutorial') return result(owner, 'none', false, 'tutorial owns its input and release ledger');
  // Committed AppUi::viewportMessage: Escape leaves plain control navigation
  // before a later scene-owned Escape can cancel a tool. F6 stays browser-owned.
  if (owner === 'ui' && key.key === 'Escape' && !key.repeat && !key.ctrlKey && !key.metaKey && !key.shiftKey && !key.altKey &&
      !context.capturedGesture)
    return result('ui', 'ui.focus-scene', true, 'plain controls return focus to the viewport without a scene command');
  if (['modal', 'menu', 'field', 'ui'].includes(owner)) {
    const protectOpenSave = primary(key) && ['o', 's'].includes(letter(key));
    return result(owner, 'none', protectOpenSave, `${owner} owns keyboard input`);
  }

  // Open/Save may start from body or canvas. Copy keeps page and UI text local.
  if (primary(key)) {
    const lower = letter(key);
    const action = lower === 'o' ? 'app.open' : lower === 's' ? 'app.save' : lower === 'c' ? 'app.copy' : undefined;
    if (action === 'app.copy' && context.focus !== 'canvas')
      return result('neutral', 'none', false, 'browser owns selected page text copy');
    if (action) return result('app', action, true, 'application shortcut');
  }
  if (owner !== 'gesture' && owner !== 'scene') return result('neutral', 'none', false, 'canvas is not focused');
  if (!isSceneKey(key)) return result(owner, 'none', false, 'no existing scene binding');
  // Updating the default view is a fresh, uncaptured scene command. Leave
  // consumption until App has checked the same availability as its button.
  if (thumbnailKey(key)) {
    if (owner === 'gesture' || !context.sceneReady || key.repeat)
      return result(owner, 'none', false, 'thumbnail shortcut requires an available scene and a fresh uncaptured press');
    return result(owner, 'scene.key', false, 'App validates thumbnail availability before consuming this key');
  }
  // Modifiers keep native speed and selection state compatible with an owned
  // scene even while scene commands are unavailable. Releases have their own gate.
  if (owner === 'scene' && !context.sceneReady && !modifier(key))
    return result(owner, 'none', !fillKey(key), 'scene command is unavailable');
  // App's dedicated G branch checks editing/recovery/busy availability before
  // consuming either a fresh press or a repeat. A repeat never rearms Fill.
  if (fillKey(key)) return result(owner, owner === 'gesture' ? 'gesture.key' : 'scene.key', false,
    'App validates Fill availability and decides whether to consume this key');
  if (key.repeat && (primary(key) && scenePrimary.has(letter(key)) ||
      !primary(key) && !navigation(key) && oneShotLetters.has(letter(key)) ||
      ['PageUp', 'PageDown'].includes(key.key)))
    return result(owner, 'none', true, 'existing one-shot shortcut does not repeat');
  if (owner === 'gesture') return result(owner, 'gesture.key', !modifier(key), 'captured gesture uses existing App command order');
  if (modifier(key)) return result(owner, 'scene.modifier', false, 'scene modifier state');
  return result(owner, 'scene.key', true, 'focused scene owns this key');
}

interface HeldKey {
  readonly owner: InputOwner;
  readonly epoch: number;
  readonly releasable: boolean;
  quarantined: boolean;
}
const admitsRelease = (action: InputAction): boolean =>
  action === 'scene.key' || action === 'scene.modifier' || action === 'gesture.key';
const sceneRegion = (owner: InputOwner): boolean => owner === 'scene' || owner === 'gesture';
const sameRegion = (left: InputOwner, right: InputOwner): boolean =>
  left === right || sceneRegion(left) && sceneRegion(right);

/** One ledger per App window listener lifetime. No DOM or controller effects. */
export class KeyOwnershipLedger {
  private epoch = 0;
  private token: string | null = null;
  private held = new Map<string, HeldKey>();

  private quarantine(clearCamera: boolean): ScopeTransition {
    this.epoch++;
    const quarantinedCodes: string[] = [];
    for (const [code, held] of this.held) {
      held.quarantined = true;
      quarantinedCodes.push(code);
    }
    return { changed: true, clearCamera, resetSelectionModifiers: true, quarantinedCodes };
  }

  /** Call on overlay, focus, composition and capture changes, before another key. */
  transition(context: InputContext): ScopeTransition {
    const owner = scopeOwner(context);
    // Pointer capture is inside the same scene keyboard region. Resetting held
    // modifiers here would change an Add/Intersect gesture while it starts.
    const token = sceneRegion(owner) ? 'scene:' : `${owner}:${context.modal ?? ''}:${context.ownerId ?? ''}`;
    if (this.token === null) { this.token = token; return unchanged(); }
    if (this.token === token) return unchanged();
    const prior = this.token;
    this.token = token;
    return this.quarantine(prior.startsWith('scene:') || prior.startsWith('gesture:') || owner === 'scene' || owner === 'gesture');
  }

  keyDown(key: KeyStroke, context: InputContext): InputDecision {
    const current = composingContext(key, context);
    const scopeTransition = this.transition(current);
    const decision = admitKeyDown(key, current);
    const code = physical(key);
    const held = this.held.get(code);
    // A genuine new press may recover a release lost outside the window or to
    // another owner. Autorepeat can never establish or recover that ownership.
    if (key.repeat && !fillKey(key) && admitsRelease(decision.action) &&
        (!held || held.quarantined || held.epoch !== this.epoch || !sameRegion(held.owner, decision.owner) || !held.releasable)) {
      return { ...result(decision.owner, 'none', decision.preventDefault, 'repeat has no current admitted keydown'), scopeTransition };
    }
    if (!key.repeat && held?.quarantined) this.held.delete(code);
    if (!key.repeat && !key.defaultPrevented && decision.owner !== 'browser') {
      this.held.set(code, { owner: decision.owner, epoch: this.epoch,
        releasable: admitsRelease(decision.action), quarantined: false });
    }
    return { ...decision, scopeTransition };
  }

  keyUp(key: KeyStroke, context: InputContext): InputDecision {
    const current = composingContext(key, context);
    let scopeTransition = this.transition(current);
    const withTransition = (decision: InputDecision): InputDecision => ({ ...decision, scopeTransition });
    const code = physical(key);
    const held = this.held.get(code);
    this.held.delete(code);
    if (!held) return withTransition(result('neutral', 'none', false, 'no admitted keydown owns this release'));
    const owner = scopeOwner(current);
    if (held.quarantined || held.epoch !== this.epoch || !sameRegion(held.owner, owner))
      return withTransition(result(held.owner, 'none', false, 'release belongs to an earlier scope'));
    if (!held.releasable) return withTransition(result(held.owner, 'none', false, 'keydown did not admit a release action'));
    if (key.defaultPrevented) {
      // The target owns this release, but an admitted native down still needs
      // clearing. Reset all held input rather than dispatching through its owner.
      scopeTransition = this.quarantine(true);
      return withTransition(result(held.owner, 'none', false, 'handled release clears prior native input'));
    }
    if (owner === 'scene') return withTransition(result('scene', 'scene.release', false, 'scene-owned release'));
    if (owner === 'gesture') return withTransition(result('gesture', 'gesture.release', false, 'gesture-owned release'));
    return withTransition(result(held.owner, 'none', false, 'owner handles its own release'));
  }

  /** App clears camera/modifiers on blur or visibility loss, then drains this. */
  invalidate(): readonly string[] {
    this.epoch++;
    const codes = [...this.held.keys()];
    this.held.clear();
    return codes;
  }
}
