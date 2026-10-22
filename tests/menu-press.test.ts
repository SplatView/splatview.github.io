import { describe, expect, it } from 'vitest';
import { MenuPress } from '../src/ui/menuPress';

describe('outside popup press ownership', () => {
  const down = { pointerId: 7, button: 0 }, click = { ...down, detail: 1 };
  it('does not consume ordinary clicks without an owned outside press', () => {
    const owner = new MenuPress(); expect(owner.consume(click)).toBe(false);
  });
  it('consumes the corresponding physical click exactly once after dismissal', () => {
    const owner = new MenuPress(); owner.arm(down);
    expect(owner.consume(click)).toBe(true); expect(owner.consume(click)).toBe(false);
  });
  it('leaves unrelated keyboard activation available while a pointer press is pending', () => {
    const owner = new MenuPress(); owner.arm(down);
    expect(owner.consume({ button: 0, pointerId: -1, detail: 0 })).toBe(false);
    expect(owner.consume({ button: 0, detail: 0 })).toBe(false);
    expect(owner.consume(click)).toBe(true);
  });
  it('does not consume a click from another pointer', () => {
    const owner = new MenuPress(); owner.arm(down);
    expect(owner.consume({ ...click, pointerId: 8 })).toBe(false); expect(owner.consume(click)).toBe(true);
  });
  it('does not consume a click from a different button', () => {
    const owner = new MenuPress(); owner.arm(down);
    expect(owner.consume({ ...click, button: 1 })).toBe(false); expect(owner.consume(click)).toBe(true);
  });
  it('handles MouseEvent clicks without a pointer id, including a double-click count', () => {
    const owner = new MenuPress(); owner.arm(down);
    expect(owner.consume({ button: 0, detail: 2 })).toBe(true);
    expect(owner.consume({ button: 0, detail: 2 })).toBe(false);
  });
  it('retires a missing or cancelled click before a subsequent activation', () => {
    const owner = new MenuPress(); owner.arm(down); owner.reset();
    expect(owner.consume(click)).toBe(false);
    owner.arm({ pointerId: 8, button: 0 }); expect(owner.consume({ ...click, pointerId: 8 })).toBe(true);
  });
  it('replaces ownership when a newer outside press begins', () => {
    const owner = new MenuPress(); owner.arm(down); owner.arm({ pointerId: 9, button: 1 });
    expect(owner.consume(click)).toBe(false); expect(owner.consume({ pointerId: 9, button: 1, detail: 1 })).toBe(true);
  });

  it('consumes a physical right contextmenu even when its click count is zero', () => {
    const owner = new MenuPress(); owner.arm({ pointerId: 7, button: 2 });
    expect(owner.consume({ type: 'contextmenu', pointerId: 7, button: 2, detail: 0 })).toBe(true);
  });
  it('supports a physical MouseEvent contextmenu without a pointer id or click count', () => {
    const owner = new MenuPress(); owner.arm({ pointerId: 7, button: 2 });
    expect(owner.consume({ type: 'contextmenu', button: 2, detail: 0 })).toBe(true);
    expect(owner.consume({ type: 'auxclick', button: 2, detail: 1 })).toBe(true);
  });
  for (const sequence of [['contextmenu', 'auxclick'], ['auxclick', 'contextmenu']] as const)
    it(`owns right-button ${sequence.join(' then ')} from the same press`, () => {
      const owner = new MenuPress(); owner.arm({ pointerId: 7, button: 2 });
      for (const type of sequence) expect(owner.consume({ type, pointerId: 7, button: 2, detail: type === 'contextmenu' ? 0 : 1 })).toBe(true);
      for (const type of sequence) expect(owner.consume({ type, pointerId: 7, button: 2, detail: 1 })).toBe(false);
    });
  for (const first of ['contextmenu', 'auxclick'] as const)
    it(`does not consume a duplicate ${first} or lose its right-button sibling`, () => {
      const owner = new MenuPress(); owner.arm({ pointerId: 7, button: 2 });
      const event = { type: first, pointerId: 7, button: 2, detail: 1 };
      expect(owner.consume(event)).toBe(true); expect(owner.consume(event)).toBe(false);
      expect(owner.consume({ ...event, type: first === 'contextmenu' ? 'auxclick' : 'contextmenu' })).toBe(true);
    });
  it('consumes a middle auxclick once, including the MouseEvent fallback', () => {
    const owner = new MenuPress(); owner.arm({ pointerId: 7, button: 1 });
    const event = { type: 'auxclick', button: 1, detail: 1 };
    expect(owner.consume(event)).toBe(true); expect(owner.consume(event)).toBe(false);
  });
  it('does not claim contextmenu or auxclick for a primary press', () => {
    const owner = new MenuPress(); owner.arm(down);
    for (const type of ['contextmenu', 'auxclick']) expect(owner.consume({ ...click, type })).toBe(false);
    expect(owner.consume(click)).toBe(true);
  });
  it('does not claim a contextmenu for a middle press or spend its auxclick', () => {
    const owner = new MenuPress(); owner.arm({ pointerId: 7, button: 1 });
    const event = { pointerId: 7, button: 1, detail: 1 };
    expect(owner.consume({ ...event, type: 'contextmenu' })).toBe(false);
    expect(owner.consume({ ...event, type: 'auxclick' })).toBe(true);
  });
  it('does not consume a non-primary activation from another pointer or button', () => {
    const owner = new MenuPress(); owner.arm({ pointerId: 7, button: 2 });
    for (const type of ['contextmenu', 'auxclick']) {
      expect(owner.consume({ type, pointerId: 8, button: 2, detail: 1 })).toBe(false);
      expect(owner.consume({ type, pointerId: 7, button: 1, detail: 1 })).toBe(false);
      expect(owner.consume({ type, pointerId: 7, button: 2, detail: 1 })).toBe(true);
    }
  });
  it('does not consume an unrelated event type or spend the pending activation', () => {
    const owner = new MenuPress(); owner.arm(down);
    expect(owner.consume({ ...click, type: 'dblclick' })).toBe(false); expect(owner.consume(click)).toBe(true);
  });
  for (const key of [{ key: 'ContextMenu', shiftKey: false }, { key: 'F10', shiftKey: true }])
    it(`retires a partial physical press before keyboard ${key.shiftKey ? 'Shift+' : ''}${key.key}`, () => {
      const owner = new MenuPress(); owner.arm({ pointerId: 7, button: 2 });
      expect(owner.consume({ type: 'contextmenu', button: 2, detail: 0 })).toBe(true);
      owner.keyDown(key);
      expect(owner.consume({ type: 'contextmenu', button: 2, detail: 0 })).toBe(false);
      expect(owner.consume({ type: 'auxclick', button: 2, detail: 1 })).toBe(false);
    });
  it('keeps a physical sibling owned across an unrelated key or unmodified F10', () => {
    const owner = new MenuPress(); owner.arm({ pointerId: 7, button: 2 });
    expect(owner.consume({ type: 'contextmenu', button: 2, detail: 0 })).toBe(true);
    owner.keyDown({ key: 'F10', shiftKey: false }); owner.keyDown({ key: 'Enter', shiftKey: false });
    expect(owner.consume({ type: 'auxclick', button: 2, detail: 1 })).toBe(true);
  });
  it('leaves a keyboard click available while both right-button activations are pending', () => {
    const owner = new MenuPress(); owner.arm({ pointerId: 7, button: 2 });
    expect(owner.consume({ type: 'click', button: 0, detail: 0 })).toBe(false);
    expect(owner.consume({ type: 'contextmenu', button: 2, detail: 0 })).toBe(true);
    expect(owner.consume({ type: 'click', pointerId: -1, button: 0, detail: 0 })).toBe(false);
    expect(owner.consume({ type: 'auxclick', button: 2, detail: 1 })).toBe(true);
  });
  it('retires both right-button siblings on cancellation before a fresh primary press', () => {
    const owner = new MenuPress(); owner.arm({ pointerId: 7, button: 2 }); owner.reset();
    for (const type of ['contextmenu', 'auxclick']) expect(owner.consume({ type, button: 2, detail: 1 })).toBe(false);
    owner.arm(down); expect(owner.consume(click)).toBe(true);
  });
  it('a fresh primary press replaces a right-button press that emitted only contextmenu', () => {
    const owner = new MenuPress(); owner.arm({ pointerId: 7, button: 2 });
    expect(owner.consume({ type: 'contextmenu', button: 2, detail: 0 })).toBe(true);
    owner.reset(); owner.arm({ pointerId: 7, button: 0 });
    expect(owner.consume({ type: 'auxclick', button: 2, detail: 1 })).toBe(false);
    expect(owner.consume(click)).toBe(true);
  });
});
