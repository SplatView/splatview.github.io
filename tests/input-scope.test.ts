import { describe, expect, it } from 'vitest';
import { admitKeyDown, KeyOwnershipLedger, scopeOwner, type InputContext, type KeyStroke } from '../src/input/inputScope';

const stroke = (key: string, code: string, more: Partial<KeyStroke> = {}): KeyStroke => ({
  key, code, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false,
  repeat: false, defaultPrevented: false, isComposing: false, ...more,
});
const scope = (more: Partial<InputContext> = {}): InputContext => ({
  tutorial: false, modal: null, menu: false, focus: 'canvas', capturedGesture: false, sceneReady: true, ...more,
});

describe('plain control Escape returns viewport focus', () => {
  it('admits only an unmodified fresh Escape from plain controls, including an unloaded viewport', () => {
    for (const sceneReady of [false, true]) expect(admitKeyDown(stroke('Escape', 'Escape'), scope({ focus: 'ui', sceneReady })))
      .toMatchObject({ owner: 'ui', action: 'ui.focus-scene', preventDefault: true });
  });

  it.each([
    scope({ focus: 'field' }), scope({ focus: 'ui', modal: 'save' }), scope({ focus: 'ui', menu: true }),
    scope({ focus: 'ui', tutorial: true }), scope({ focus: 'ui', composing: true }), scope({ focus: 'ui', capturedGesture: true }),
  ])('preserves field, modal, menu, tutorial, composition and captured-gesture ownership %#', context => {
    expect(admitKeyDown(stroke('Escape', 'Escape'), context).action).not.toBe('ui.focus-scene');
  });

  it.each([
    { repeat: true }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true },
    { defaultPrevented: true }, { isComposing: true },
  ])('does not turn a modified, repeated or target-owned Escape into focus navigation %#', more => {
    expect(admitKeyDown(stroke('Escape', 'Escape', more), scope({ focus: 'ui' })).action).not.toBe('ui.focus-scene');
  });

  it('keeps browser F6 available and quarantines the focus-return press before a later scene Escape', () => {
    const ledger = new KeyOwnershipLedger();
    expect(admitKeyDown(stroke('F6', 'F6'), scope({ focus: 'ui' }))).toMatchObject({ owner: 'browser', action: 'none', preventDefault: false });
    expect(ledger.keyDown(stroke('Escape', 'Escape'), scope({ focus: 'ui' })).action).toBe('ui.focus-scene');
    ledger.transition(scope());
    expect(ledger.keyDown(stroke('Escape', 'Escape', { repeat: true }), scope()).action).toBe('none');
    expect(ledger.keyUp(stroke('Escape', 'Escape'), scope()).action).toBe('none');
    expect(ledger.keyDown(stroke('Escape', 'Escape'), scope()).action).toBe('scene.key');
    expect(ledger.keyUp(stroke('Escape', 'Escape'), scope()).action).toBe('scene.release');
  });
});

describe('keyboard input admission', () => {
  it.each([
    ['tutorial before modal', scope({ tutorial: true, modal: 'save' }), stroke('b', 'KeyB'), 'tutorial', 'none', false],
    ['state modal before menu', scope({ modal: 'unsaved', menu: true }), stroke('b', 'KeyB'), 'modal', 'none', false],
    ['menu before editing', scope({ menu: true, focus: 'field' }), stroke('b', 'KeyB'), 'menu', 'none', false],
    ['composition before other UI', scope({ focus: 'ui', composing: true }), stroke('b', 'KeyB'), 'field', 'none', false],
    ['event composition before capture', scope({ capturedGesture: true }), stroke('b', 'KeyB', { isComposing: true }), 'field', 'none', false],
    ['field owns PageUp', scope({ focus: 'field' }), stroke('PageUp', 'PageUp'), 'field', 'none', false],
    ['UI before captured gesture', scope({ focus: 'ui', capturedGesture: true }), stroke('Delete', 'Delete'), 'ui', 'none', false],
    ['neutral body has no scene B', scope({ focus: 'neutral' }), stroke('b', 'KeyB'), 'neutral', 'none', false],
    ['captured gesture owns Escape', scope({ capturedGesture: true }), stroke('Escape', 'Escape'), 'gesture', 'gesture.key', true],
    ['capture preserves existing scene binding order', scope({ focus: 'neutral', capturedGesture: true }), stroke('b', 'KeyB'), 'gesture', 'gesture.key', true],
    ['focused canvas owns B', scope(), stroke('b', 'KeyB'), 'scene', 'scene.key', true],
    ['Shift B still reaches volume branch', scope(), stroke('B', 'KeyB', { shiftKey: true }), 'scene', 'scene.key', true],
    ['collection page key reaches App', scope(), stroke('PageDown', 'PageDown'), 'scene', 'scene.key', true],
    ['Alt W retains native slow camera chord', scope(), stroke('w', 'KeyW', { altKey: true }), 'scene', 'scene.key', true],
    ['Shift Alt W retains both native speed flags', scope(), stroke('W', 'KeyW', { shiftKey: true, altKey: true }), 'scene', 'scene.key', true],
    ['Alt Escape preserves existing cancellation', scope(), stroke('Escape', 'Escape', { altKey: true }), 'scene', 'scene.key', true],
    ['primary Z reaches history', scope(), stroke('z', 'KeyZ', { ctrlKey: true }), 'scene', 'scene.key', true],
    ['primary Shift Z reaches redo', scope(), stroke('Z', 'KeyZ', { metaKey: true, shiftKey: true }), 'scene', 'scene.key', true],
    ['primary Shift A reaches select none', scope(), stroke('A', 'KeyA', { ctrlKey: true, shiftKey: true }), 'scene', 'scene.key', true],
    ['primary E preserves color binding', scope(), stroke('e', 'KeyE', { ctrlKey: true }), 'scene', 'scene.key', true],
    ['filter digit code fallback remains admitted', scope(), stroke('!', 'Digit1', { shiftKey: true }), 'scene', 'scene.key', true],
    ['Save modal owns history despite canvas focus', scope({ modal: 'save' }), stroke('z', 'KeyZ', { ctrlKey: true }), 'modal', 'none', false],
    ['Unsaved modal owns history despite neutral focus', scope({ modal: 'unsaved', focus: 'neutral' }), stroke('z', 'KeyZ', { metaKey: true }), 'modal', 'none', false],
    ['neutral body allows App Open', scope({ focus: 'neutral' }), stroke('o', 'KeyO', { ctrlKey: true }), 'app', 'app.open', true],
    ['canvas allows App Save', scope(), stroke('s', 'KeyS', { metaKey: true }), 'app', 'app.save', true],
    ['Shift Open preserves existing App branch', scope(), stroke('O', 'KeyO', { ctrlKey: true, shiftKey: true }), 'app', 'app.open', true],
    ['canvas allows image Copy', scope(), stroke('c', 'KeyC', { ctrlKey: true }), 'app', 'app.copy', true],
    ['body text retains Copy', scope({ focus: 'neutral' }), stroke('c', 'KeyC', { ctrlKey: true }), 'neutral', 'none', false],
    ['UI text retains Copy', scope({ focus: 'ui' }), stroke('c', 'KeyC', { ctrlKey: true }), 'ui', 'none', false],
    ['field retains ordinary Copy', scope({ focus: 'field' }), stroke('c', 'KeyC', { ctrlKey: true }), 'field', 'none', false],
    ['Open can cancel an existing gesture in App', scope({ capturedGesture: true }), stroke('o', 'KeyO', { ctrlKey: true }), 'app', 'app.open', true],
    ['Save modal suppresses App Open and browser picker', scope({ modal: 'save' }), stroke('o', 'KeyO', { ctrlKey: true }), 'modal', 'none', true],
    ['field suppresses App Save and browser save', scope({ focus: 'field' }), stroke('s', 'KeyS', { ctrlKey: true }), 'field', 'none', true],
    ['plain focused G reaches App availability checks before consumption', scope(), stroke('g', 'KeyG'), 'scene', 'scene.key', false],
    ['Shift G has no Fill binding', scope(), stroke('G', 'KeyG', { shiftKey: true }), 'scene', 'none', false],
    ['plain focused T reaches App thumbnail availability checks before consumption', scope(), stroke('t', 'KeyT'), 'scene', 'scene.key', false],
    ['Shift T has no thumbnail binding', scope(), stroke('T', 'KeyT', { shiftKey: true }), 'scene', 'none', false],
    ['Alt T has no thumbnail binding', scope(), stroke('t', 'KeyT', { altKey: true }), 'scene', 'none', false],
    ['captured T cannot change the default view', scope({ capturedGesture: true }), stroke('t', 'KeyT'), 'gesture', 'none', false],
    ['unavailable T stays unconsumed', scope({ sceneReady: false }), stroke('t', 'KeyT'), 'scene', 'none', false],
    ['T in UI stays local', scope({ focus: 'ui' }), stroke('t', 'KeyT'), 'ui', 'none', false],
    ['T in a modal stays local even with stale canvas focus', scope({ modal: 'save' }), stroke('t', 'KeyT'), 'modal', 'none', false],
    ['scene availability gates new commands', scope({ sceneReady: false }), stroke('b', 'KeyB'), 'scene', 'none', true],
    ['unavailable scene still admits owned modifiers', scope({ sceneReady: false }), stroke('Shift', 'ShiftLeft', { shiftKey: true }), 'scene', 'scene.modifier', false],
    ['target handling wins before App admission', scope(), stroke('b', 'KeyB', { defaultPrevented: true }), 'neutral', 'none', false],
  ] as const)('%s', (_name, context, key, owner, action, preventDefault) => {
    const decision = admitKeyDown(key, context);
    expect([decision.owner, decision.action, decision.preventDefault]).toEqual([owner, action, preventDefault]);
  });

  it.each([
    stroke('Tab', 'Tab'), stroke('Tab', 'Tab', { shiftKey: true }), stroke('F5', 'F5'), stroke('F6', 'F6'),
    stroke('f', 'KeyF', { ctrlKey: true }), stroke('g', 'KeyG', { ctrlKey: true }),
    stroke('t', 'KeyT', { ctrlKey: true }), stroke('t', 'KeyT', { metaKey: true }),
    stroke('T', 'KeyT', { ctrlKey: true, shiftKey: true }),
    stroke('T', 'KeyT', { metaKey: true, shiftKey: true }),
    stroke('G', 'KeyG', { metaKey: true, shiftKey: true }), stroke('0', 'Digit0', { ctrlKey: true }),
    stroke('+', 'Equal', { metaKey: true }), stroke('-', 'NumpadSubtract', { ctrlKey: true }),
    stroke(' ', 'Space', { altKey: true }), stroke('ArrowLeft', 'ArrowLeft', { altKey: true }),
    stroke('I', 'KeyI', { ctrlKey: true, shiftKey: true }),
  ])('case %#: preserves browser/focus shortcut $key ($code)', key => {
    expect(admitKeyDown(key, scope())).toMatchObject({ owner: 'browser', action: 'none', preventDefault: false });
  });

  it.each([
    stroke('z', 'KeyZ', { ctrlKey: true }), stroke('e', 'KeyE', { metaKey: true }),
    stroke('b', 'KeyB'), stroke('v', 'KeyV'), stroke('PageDown', 'PageDown'),
  ])('suppresses existing one-shot repetition for $key', key => {
    expect(admitKeyDown({ ...key, repeat: true }, scope())).toMatchObject({ owner: 'scene', action: 'none', preventDefault: true });
  });

  it.each([
    stroke('w', 'KeyW'), stroke('[', 'BracketLeft'), stroke('Delete', 'Delete'), stroke('Backspace', 'Backspace'),
    stroke('Enter', 'Enter'), stroke('Escape', 'Escape'), stroke('1', 'Digit1'),
  ])('leaves existing branch repetition contract with App for $key', key => {
    expect(admitKeyDown({ ...key, repeat: true }, scope())).toMatchObject({ owner: 'scene', action: 'scene.key' });
  });

  it('does not turn a modifier or availability change into a different input scope', () => {
    expect(scopeOwner(scope({ sceneReady: false }))).toBe('scene');
    expect(scopeOwner(scope({ composing: true, capturedGesture: true }))).toBe('field');
  });

  it('preserves physical navigation repetition when the keyboard layout produces a scene letter', () => {
    expect(admitKeyDown(stroke('o', 'KeyS', { repeat: true }), scope())).toMatchObject({ action: 'scene.key' });
    // App's focused G branch still precedes camera navigation and validates
    // availability before consuming this repeat without rearming Fill.
    expect(admitKeyDown(stroke('g', 'KeyS', { repeat: true }), scope())).toMatchObject({ action: 'scene.key', preventDefault: false });
  });

  it.each([scope(), scope({ capturedGesture: true })])('leaves Fill repeat consumption with the existing App branch: %j', context => {
    expect(admitKeyDown(stroke('g', 'KeyG', { repeat: true }), context)).toMatchObject({
      action: context.capturedGesture ? 'gesture.key' : 'scene.key', preventDefault: false,
    });
  });

  it('keeps fresh and repeated G unconsumed when the scene itself is unavailable', () => {
    for (const repeat of [false, true]) expect(admitKeyDown(stroke('g', 'KeyG', { repeat }), scope({ sceneReady: false })))
      .toMatchObject({ action: 'none', preventDefault: false });
  });

  it.each([scope(), scope({ capturedGesture: true }), scope({ sceneReady: false })])
    ('never consumes or dispatches thumbnail autorepeat: %j', context => {
      expect(admitKeyDown(stroke('t', 'KeyT', { repeat: true }), context))
        .toMatchObject({ action: 'none', preventDefault: false });
    });

  it('never invents an App action for an unrecognized key', () => {
    expect(admitKeyDown(stroke('constructor', 'Unknown', { ctrlKey: true }), scope())).toMatchObject({ action: 'none' });
  });
});

describe('held keyboard ownership', () => {
  it('never rearms T from autorepeat after a rejected gesture press or a scope handoff', () => {
    const ledger = new KeyOwnershipLedger();
    expect(ledger.keyDown(stroke('t', 'KeyT'), scope({ capturedGesture: true })))
      .toMatchObject({ action: 'none', preventDefault: false });
    expect(ledger.keyUp(stroke('t', 'KeyT'), scope()).action).toBe('none');
    expect(ledger.keyDown(stroke('t', 'KeyT'), scope())).toMatchObject({ action: 'scene.key', preventDefault: false });
    ledger.transition(scope({ modal: 'save' })); ledger.transition(scope());
    expect(ledger.keyDown(stroke('t', 'KeyT', { repeat: true }), scope()))
      .toMatchObject({ action: 'none', preventDefault: false });
    expect(ledger.keyUp(stroke('t', 'KeyT'), scope()).action).toBe('none');
    expect(ledger.keyDown(stroke('t', 'KeyT'), scope())).toMatchObject({ action: 'scene.key', preventDefault: false });
  });

  it('requires a matching admitted down and consumes its release once', () => {
    const ledger = new KeyOwnershipLedger();
    expect(ledger.keyUp(stroke('w', 'KeyW'), scope()).action).toBe('none');
    ledger.keyDown(stroke('w', 'KeyW'), scope());
    expect(ledger.keyUp(stroke('w', 'KeyW'), scope())).toMatchObject({ owner: 'scene', action: 'scene.release' });
    expect(ledger.keyUp(stroke('w', 'KeyW'), scope()).action).toBe('none');
  });

  it('allows current held navigation to repeat but never creates ownership from repeat alone', () => {
    const ledger = new KeyOwnershipLedger(), repeat = stroke('w', 'KeyW', { repeat: true });
    expect(ledger.keyDown(repeat, scope()).action).toBe('none');
    expect(ledger.keyUp(stroke('w', 'KeyW'), scope()).action).toBe('none');
    ledger.keyDown(stroke('w', 'KeyW'), scope());
    expect(ledger.keyDown(repeat, scope()).action).toBe('scene.key');
    expect(ledger.keyUp(stroke('w', 'KeyW'), scope()).action).toBe('scene.release');
  });

  it('lets App validate G repeats without creating or recovering held release ownership', () => {
    const ledger = new KeyOwnershipLedger(), repeat = stroke('g', 'KeyG', { repeat: true });
    expect(ledger.keyDown(repeat, scope())).toMatchObject({ action: 'scene.key', preventDefault: false });
    expect(ledger.keyUp(stroke('g', 'KeyG'), scope()).action).toBe('none');
    ledger.keyDown(stroke('g', 'KeyG'), scope());
    ledger.transition(scope({ modal: 'save' })); ledger.transition(scope());
    expect(ledger.keyDown(repeat, scope())).toMatchObject({ action: 'scene.key', preventDefault: false });
    expect(ledger.keyUp(stroke('g', 'KeyG'), scope()).action).toBe('none');
  });

  it.each([
    scope({ tutorial: true }), scope({ modal: 'save', focus: 'ui' }), scope({ modal: 'unsaved', focus: 'neutral' }),
    scope({ menu: true }), scope({ focus: 'field' }), scope({ focus: 'ui' }), scope({ composing: true }),
    scope({ focus: 'neutral' }),
  ])('quarantines a held camera key through scope changes: %j', next => {
    const ledger = new KeyOwnershipLedger();
    ledger.keyDown(stroke('w', 'KeyW'), scope());
    expect(ledger.transition(next)).toMatchObject({
      changed: true, clearCamera: true, resetSelectionModifiers: true, quarantinedCodes: ['KeyW'],
    });
    ledger.transition(scope());
    expect(ledger.keyDown(stroke('w', 'KeyW', { repeat: true }), scope()).action).toBe('none');
    expect(ledger.keyUp(stroke('w', 'KeyW'), scope()).action).toBe('none');
  });

  it('returns a transition plan if a modal change is first noticed on an event', () => {
    const ledger = new KeyOwnershipLedger();
    ledger.keyDown(stroke('w', 'KeyW'), scope());
    expect(ledger.keyDown(stroke('z', 'KeyZ', { ctrlKey: true }), scope({ modal: 'save' }))).toMatchObject({
      owner: 'modal', action: 'none', scopeTransition: {
        changed: true, clearCamera: true, resetSelectionModifiers: true, quarantinedCodes: ['KeyW'],
      },
    });
  });

  it('notices composition on an event and prevents a prior modifier release from reaching scene', () => {
    const ledger = new KeyOwnershipLedger();
    ledger.keyDown(stroke('Shift', 'ShiftLeft', { shiftKey: true }), scope());
    expect(ledger.keyDown(stroke('Process', 'KeyB', { isComposing: true }), scope())).toMatchObject({
      owner: 'field', action: 'none', scopeTransition: { clearCamera: true, quarantinedCodes: ['ShiftLeft'] },
    });
    expect(ledger.keyUp(stroke('Shift', 'ShiftLeft'), scope()).action).toBe('none');
  });

  it('recovers a missed outside-scope release with a fresh nonrepeat press', () => {
    const ledger = new KeyOwnershipLedger();
    ledger.keyDown(stroke('Shift', 'ShiftLeft', { shiftKey: true }), scope());
    ledger.transition(scope({ menu: true }));
    ledger.transition(scope());
    ledger.keyDown(stroke('Shift', 'ShiftLeft', { shiftKey: true }), scope());
    expect(ledger.keyUp(stroke('Shift', 'ShiftLeft'), scope()).action).toBe('scene.release');
  });

  it('keeps UI-origin releases and repeats out of a reopened scene', () => {
    const ledger = new KeyOwnershipLedger(), modal = scope({ modal: 'unsaved', focus: 'ui' });
    ledger.keyDown(stroke('Shift', 'ShiftLeft', { shiftKey: true }), modal);
    ledger.keyDown(stroke('Escape', 'Escape'), modal);
    ledger.transition(scope());
    expect(ledger.keyDown(stroke('Shift', 'ShiftLeft', { shiftKey: true, repeat: true }), scope()).action).toBe('none');
    expect(ledger.keyUp(stroke('Escape', 'Escape'), scope()).action).toBe('none');
    expect(ledger.keyUp(stroke('Shift', 'ShiftLeft'), scope()).action).toBe('none');
  });

  it('treats successive registered menus as a new epoch even while focus stays on canvas', () => {
    const ledger = new KeyOwnershipLedger(), menu = scope({ menu: true, ownerId: 'menu-1' });
    ledger.keyDown(stroke('Control', 'ControlLeft', { ctrlKey: true }), menu);
    expect(ledger.transition({ ...menu, ownerId: 'menu-2' })).toMatchObject({
      changed: true, resetSelectionModifiers: true, quarantinedCodes: ['ControlLeft'],
    });
    expect(ledger.keyUp(stroke('Control', 'ControlLeft'), { ...menu, ownerId: 'menu-2' }).action).toBe('none');
  });

  it('retains held Shift and Control across capture entry and exit in the scene region', () => {
    const ledger = new KeyOwnershipLedger(), captured = scope({ capturedGesture: true, ownerId: 'drag-1' });
    ledger.keyDown(stroke('Shift', 'ShiftLeft', { shiftKey: true }), scope());
    ledger.keyDown(stroke('Control', 'ControlLeft', { shiftKey: true, ctrlKey: true }), scope());
    expect(ledger.transition(captured)).toMatchObject({ changed: false, clearCamera: false, resetSelectionModifiers: false });
    expect(ledger.keyUp(stroke('Control', 'ControlLeft', { shiftKey: true }), captured)).toMatchObject({
      owner: 'gesture', action: 'gesture.release', scopeTransition: { changed: false },
    });
    expect(ledger.transition(scope())).toMatchObject({ changed: false, clearCamera: false, resetSelectionModifiers: false });
    expect(ledger.keyUp(stroke('Shift', 'ShiftLeft'), scope()).action).toBe('scene.release');
    ledger.keyDown(stroke('Shift', 'ShiftLeft', { shiftKey: true }), captured);
    expect(ledger.transition({ ...captured, ownerId: 'drag-2' }).changed).toBe(false);
    expect(ledger.keyUp(stroke('Shift', 'ShiftLeft'), scope()).action).toBe('scene.release');
  });

  it('keeps an admitted native release available when scene commands become unavailable', () => {
    const ledger = new KeyOwnershipLedger();
    ledger.keyDown(stroke('w', 'KeyW'), scope());
    expect(ledger.keyUp(stroke('w', 'KeyW'), scope({ sceneReady: false }))).toMatchObject({
      action: 'scene.release', scopeTransition: { changed: false },
    });
  });

  it('clears native held input when another target handles an admitted release', () => {
    const ledger = new KeyOwnershipLedger();
    ledger.keyDown(stroke('w', 'KeyW'), scope());
    ledger.keyDown(stroke('Shift', 'ShiftLeft', { shiftKey: true }), scope());
    expect(ledger.keyUp(stroke('w', 'KeyW', { defaultPrevented: true }), scope())).toMatchObject({
      action: 'none', scopeTransition: {
        changed: true, clearCamera: true, resetSelectionModifiers: true, quarantinedCodes: ['ShiftLeft'],
      },
    });
    expect(ledger.keyUp(stroke('Shift', 'ShiftLeft'), scope()).action).toBe('none');
    ledger.keyDown(stroke('w', 'KeyW'), scope());
    expect(ledger.keyUp(stroke('w', 'KeyW'), scope()).action).toBe('scene.release');
  });

  it('does not own releases of unavailable or target-handled downs', () => {
    const ledger = new KeyOwnershipLedger();
    ledger.keyDown(stroke('b', 'KeyB'), scope({ sceneReady: false }));
    expect(ledger.keyUp(stroke('b', 'KeyB'), scope()).action).toBe('none');
    ledger.keyDown(stroke('w', 'KeyW', { defaultPrevented: true }), scope());
    expect(ledger.keyUp(stroke('w', 'KeyW'), scope()).action).toBe('none');
  });

  it('replaces a denied down with a new admitted press without requiring a scope transition', () => {
    const ledger = new KeyOwnershipLedger();
    ledger.keyDown(stroke('b', 'KeyB'), scope({ sceneReady: false }));
    expect(ledger.keyDown(stroke('b', 'KeyB'), scope()).action).toBe('scene.key');
    expect(ledger.keyUp(stroke('b', 'KeyB'), scope()).action).toBe('scene.release');
  });

  it('drains held ownership on blur and permits a fresh press on return', () => {
    const ledger = new KeyOwnershipLedger();
    ledger.keyDown(stroke('w', 'KeyW'), scope());
    ledger.keyDown(stroke('Alt', 'AltLeft', { altKey: true }), scope());
    expect(ledger.invalidate()).toEqual(['KeyW', 'AltLeft']);
    expect(ledger.invalidate()).toEqual([]);
    expect(ledger.keyUp(stroke('w', 'KeyW'), scope()).action).toBe('none');
    expect(ledger.keyDown(stroke('w', 'KeyW', { repeat: true }), scope()).action).toBe('none');
    ledger.keyDown(stroke('w', 'KeyW'), scope());
    expect(ledger.keyUp(stroke('w', 'KeyW'), scope()).action).toBe('scene.release');
  });

  it('matches fallback physical identity despite Shift changing a letter at release', () => {
    const ledger = new KeyOwnershipLedger();
    ledger.keyDown(stroke('B', '', { shiftKey: true }), scope());
    expect(ledger.keyUp(stroke('b', ''), scope()).action).toBe('scene.release');
  });
});
