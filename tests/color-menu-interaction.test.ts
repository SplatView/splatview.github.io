import { describe, expect, it } from 'vitest';
import { approachingColorMenu, ColorMenuInteraction, containsMenuPoint } from '../src/ui/colorMenuInteraction';

describe('desktop color selector interaction', () => {
  it.each(['auto', 'presets'] as const)('%s opens only after an uninterrupted 300 ms hover', kind => {
    const menu = new ColorMenuInteraction(); menu.enter(kind, 50);
    expect(menu.tick(349, false, false, 0)).toBeNull(); expect(menu.tick(350, false, false, 0)).toBe(kind);
    menu.leave(kind); menu.enter(kind, 400);
    expect(menu.tick(699, false, false, 0)).toBeNull(); expect(menu.tick(700, false, false, 0)).toBe(kind);
  });
  it('does not accumulate multiple short visits or reset a continuous visit', () => {
    const menu = new ColorMenuInteraction(); menu.enter('auto', 0); menu.leave('auto'); menu.enter('auto', 200); menu.enter('auto', 300);
    expect(menu.tick(499, false, false, 0)).toBeNull(); expect(menu.tick(500, false, false, 0)).toBe('auto');
  });
  it.each([1, 2, 4, 8, 16, 3])('suppresses delayed opening while pointer buttons %i remain held', buttons => {
    const menu = new ColorMenuInteraction(); menu.enter('presets', 0);
    expect(menu.tick(1000, false, false, buttons)).toBeNull(); expect(menu.open).toBeNull();
    expect(menu.tick(1001, false, false, 0)).toBe('presets');
  });
  it('closes an unpinned menu only after 300 ms continuously away', () => {
    const menu = new ColorMenuInteraction(); menu.show('auto', false);
    expect(menu.tick(100, false, false, 0)).toBeNull(); expect(menu.tick(399, false, false, 0)).toBeNull();
    expect(menu.tick(400, false, false, 0)).toBe('dismiss');
  });
  it.each(['trigger', 'list', 'bridge'] as const)('resets the away deadline on %s re-entry', region => {
    const menu = new ColorMenuInteraction(); menu.show('auto', false); menu.tick(0, false, false, 0);
    if (region === 'trigger') menu.enter('auto', 200);
    expect(menu.tick(200, region === 'list', region === 'bridge', 0)).toBeNull();
    if (region === 'trigger') menu.leave('auto');
    expect(menu.tick(300, false, false, 0)).toBeNull(); expect(menu.tick(599, false, false, 0)).toBeNull();
    expect(menu.tick(600, false, false, 0)).toBe('dismiss');
  });
  it('retains a pinned list away from the pointer and lets a deliberate other-selector hover switch it', () => {
    const menu = new ColorMenuInteraction(); menu.show('auto', false); menu.pin();
    expect(menu.pinned).toBe(true); expect(menu.tick(10000, false, false, 0)).toBeNull();
    menu.enter('presets', 10000); expect(menu.tick(10299, false, false, 0)).toBeNull();
    expect(menu.tick(10300, false, false, 0)).toBe('presets'); menu.show('presets', false);
    expect(menu.open).toBe('presets'); expect(menu.pinned).toBe(false);
  });
  it('keeps a dismissed selector suppressed until its pointer leaves, including rapid click dismissal', () => {
    const menu = new ColorMenuInteraction(); menu.enter('auto', 0); menu.show('auto', true); menu.dismiss();
    expect(menu.open).toBeNull(); expect(menu.pinned).toBe(false); expect(menu.tick(1000, false, false, 0)).toBeNull();
    menu.enter('auto', 1100); expect(menu.tick(2000, false, false, 0)).toBeNull();
    menu.leave('auto'); menu.enter('auto', 2100); expect(menu.tick(2399, false, false, 0)).toBeNull();
    expect(menu.tick(2400, false, false, 0)).toBe('auto');
  });
  it('permits another selector immediately after the first was dismissed', () => {
    const menu = new ColorMenuInteraction(); menu.show('auto', true); menu.dismiss(); menu.enter('presets', 50);
    expect(menu.tick(350, false, false, 0)).toBe('presets'); menu.show('presets', false);
    expect(menu.dismissed).toBeNull();
  });
  it('does not suppress a fresh hover after a menu-item choice dismissed away from its trigger', () => {
    const menu = new ColorMenuInteraction(); menu.enter('auto', 0); menu.show('auto', true);
    menu.leave('auto'); menu.dismiss(); expect(menu.dismissed).toBeNull();
    menu.enter('auto', 1000); expect(menu.tick(1299, false, false, 0)).toBeNull();
    expect(menu.tick(1300, false, false, 0)).toBe('auto');
  });
  it('retires pending hover and open ownership without leaving a delayed reopen', () => {
    const menu = new ColorMenuInteraction(); menu.enter('auto', 0); menu.retire();
    expect(menu.tick(1000, false, false, 0)).toBeNull(); menu.show('presets', true); menu.enter('presets', 1000); menu.retire();
    expect(menu.open).toBeNull(); expect(menu.hovered).toBeNull(); expect(menu.pinned).toBe(false);
    expect(menu.tick(10000, true, true, 0)).toBeNull();
  });
  it('has no timer deadline while idle, over its trigger or list, or pinned', () => {
    const menu = new ColorMenuInteraction(); expect(menu.nextDelay(0, 0)).toBeNull();
    menu.enter('auto', 0); menu.show('auto', false); menu.tick(0, false, false, 0);
    expect(menu.nextDelay(0, 0)).toBeNull(); menu.leave('auto'); menu.tick(1, true, false, 0);
    expect(menu.nextDelay(1, 0)).toBeNull(); menu.pin(); menu.tick(10000, false, false, 0);
    expect(menu.nextDelay(10000, 0)).toBeNull();
  });
  it('schedules only the remaining hover deadline and stops scheduling after ownership changes', () => {
    const menu = new ColorMenuInteraction(); menu.enter('presets', 100);
    expect(menu.nextDelay(120, 0)).toBe(280); expect(menu.nextDelay(399, 0)).toBe(1); expect(menu.nextDelay(401, 0)).toBe(0);
    menu.show('presets', false); expect(menu.nextDelay(401, 0)).toBeNull();
    menu.dismiss(); expect(menu.nextDelay(500, 0)).toBeNull();
  });
  it('waits for a pointer release event rather than polling a button-blocked hover', () => {
    const menu = new ColorMenuInteraction(); menu.enter('auto', 0);
    expect(menu.nextDelay(1000, 1)).toBeNull(); expect(menu.nextDelay(1000, 0)).toBe(0);
    expect(menu.tick(1000, false, false, 0)).toBe('auto');
  });
  it('chooses the earliest pending hover or away boundary, then cancels an away deadline on re-entry', () => {
    const menu = new ColorMenuInteraction(); menu.show('auto', false); menu.tick(0, false, false, 0); menu.enter('presets', 100);
    expect(menu.nextDelay(200, 0)).toBe(100); menu.tick(200, true, false, 0);
    expect(menu.nextDelay(200, 0)).toBe(200); menu.leave('presets');
    expect(menu.nextDelay(200, 0)).toBeNull();
  });
  it('restarts a single away deadline after each approach movement without retaining a stationary bridge forever', () => {
    const menu = new ColorMenuInteraction(); menu.show('auto', false); menu.tick(0, false, false, 0);
    menu.tick(200, false, true, 0); menu.tick(200, false, false, 0);
    expect(menu.nextDelay(200, 0)).toBe(300); expect(menu.tick(499, false, false, 0)).toBeNull();
    expect(menu.tick(500, false, false, 0)).toBe('dismiss'); menu.dismiss();
    expect(menu.nextDelay(500, 0)).toBeNull();
  });
});

describe('native color menu approach bridge', () => {
  const trigger = { left: 600, right: 730, top: 300, bottom: 344 };
  const left = { left: 340, right: 564, top: 250, bottom: 500 };
  const right = { left: 766, right: 990, top: 250, bottom: 500 };
  it('admits the left and top edge but excludes the right and bottom edge', () => {
    expect(containsMenuPoint(trigger, { x: 600, y: 300 })).toBe(true);
    expect(containsMenuPoint(trigger, { x: 730, y: 310 })).toBe(false);
    expect(containsMenuPoint(trigger, { x: 610, y: 344 })).toBe(false);
  });
  it.each([[-1, true], [0, false], [1, false]])('requires approaching a left popup (delta %i)', (delta, expected) => {
    expect(approachingColorMenu(trigger, left, { x: 580, y: 330 }, delta as number)).toBe(expected);
  });
  it.each([[1, true], [0, false], [-1, false]])('requires approaching a right popup (delta %i)', (delta, expected) => {
    expect(approachingColorMenu(trigger, right, { x: 750, y: 330 }, delta as number)).toBe(expected);
  });
  it('does not protect unrelated empty space or a stacked compact popup', () => {
    expect(approachingColorMenu(trigger, left, { x: 580, y: 510 }, -1)).toBe(false);
    expect(approachingColorMenu(trigger, left, { x: 320, y: 330 }, -1)).toBe(false);
    expect(approachingColorMenu(trigger, { left: 600, right: 824, top: 348, bottom: 598 }, { x: 610, y: 346 }, -1)).toBe(false);
  });
});
