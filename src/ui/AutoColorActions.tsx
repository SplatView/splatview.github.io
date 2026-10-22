import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { captureMenuScroll, type MenuScrollOwner } from './menuScroll';
import type { AppController } from '../app/controller';
import { useApp } from '../app/store';
import { UI_SIZES, uiSizeStyle, useUiPreferences } from '../app/uiPreferences';
import { useTranslation } from '../app/useLanguageAppearance';
import { applyAction } from './applyAction';
import type { AutoColorMethod } from '../document/colorProtocol';
import { colorFields, colorPresets } from '../generated/desktop';
import { Icon } from './Icon';
import { DecorativeChevron } from './DecorativeChevron';
import { isKnownBrowserKey } from '../input/inputScope';
import { approachingColorMenu, ColorMenuInteraction, containsMenuPoint, type ColorMenuKind } from './colorMenuInteraction';
import { MenuPress } from './menuPress';

// Captured desktop color_ui.cpp:41-64. Both profiles expose the same actions.
export const AUTO_COLOR_ACTIONS = Object.freeze([
  { method: 'enhance', label: 'Auto', icon: 'AutoColor' },
  { method: 'exposure', label: 'Exposure', icon: 'Exposure' },
  { method: 'contrast', label: 'Contrast', icon: 'AutoContrast' },
  { method: 'white_balance', label: 'White balance', icon: 'WhiteBalance' },
] as const satisfies readonly { method: AutoColorMethod; label: string; icon: string }[]);

type ColorController = Pick<AppController, 'autoColor' | 'colorControlsEnabled' | 'colorPreviewEnabled' | 'colorPending' | 'commitGrade' | 'setGrade'>;
export function dispatchAutoColor(controller: ColorController, method: unknown, validInput = true): Promise<boolean> {
  const action = AUTO_COLOR_ACTIONS.find(action => action.method === method);
  return validInput && action && controller.colorControlsEnabled ? controller.autoColor(action.method) : Promise.resolve(false);
}
// Native color_ui.cpp:68-94 iterates Recipe=nlohmann::json's sorted map for
// Pro choices and first-match labels. The captured catalog names are ASCII.
const proPresetNames = Object.freeze(Object.keys(colorPresets).sort());
const basicPresetNames = Object.freeze(['neutral', 'warm', 'cool', 'vibrant', 'muted', 'cinematic', 'grayscale']);
export function colorPresetNames(mode: 'basic' | 'pro'): readonly string[] {
  return mode === 'basic' ? basicPresetNames : proPresetNames;
}
export function dispatchColorPreset(controller: ColorController, name: unknown, validInput = true, onPresetValues?: (values: number[]) => void): boolean {
  if (!validInput || !controller.colorPreviewEnabled || typeof name !== 'string' || !Object.hasOwn(colorPresets, name)) return false;
  const values = colorFields.map(field => colorPresets[name][field.name] ?? field.neutral);
  if (onPresetValues) onPresetValues(values);else controller.setGrade(values);
  return true;
}
export function dispatchColorApply(controller: ColorController, validInput = true): Promise<boolean> {
  return validInput && controller.colorControlsEnabled && controller.colorPending ? controller.commitGrade() : Promise.resolve(false);
}
export function colorPresetName(values: readonly number[]): string {
  // Desktop ColorValues are float32, including native acknowledgements. Match
  // that representation on both sides instead of adding an epsilon tolerance.
  return proPresetNames.find(name => values.length === colorFields.length &&
    colorFields.every((field, index) => Number.isFinite(values[index]) &&
      Math.fround(values[index]) === Math.fround(colorPresets[name][field.name] ?? field.neutral))) ?? 'Custom';
}

type MenuKind = ColorMenuKind;
export function AutoColorActions({ controller, method, onMethodChanged, validInput = true, onPresetValues, displayMode, onInputScopeChange }: {
  controller: ColorController; method: AutoColorMethod; onMethodChanged(method: AutoColorMethod): void; validInput?: boolean;
  onPresetValues?(values: number[]): void;
  displayMode?: 'basic' | 'pro'; onInputScopeChange?(owner: string, open: boolean): void;
}) {
  const { t } = useTranslation();
  const state = useApp(), preference = useUiPreferences();
  const size = preference.previewSize ?? preference.size;
  const enabled = validInput && controller.colorControlsEnabled;
  const previewEnabled = validInput && controller.colorPreviewEnabled;
  const [open, setOpen] = useState<MenuKind | null>(null), [active, setActive] = useState(0);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 0 });
  const row = useRef<HTMLDivElement>(null), menu = useRef<HTMLDivElement>(null);
  const scrollOwner = useRef<MenuScrollOwner | undefined>(undefined);
  const auto = useRef<HTMLButtonElement>(null), presets = useRef<HTMLButtonElement>(null), menuId = useId();
  const interaction = useRef(new ColorMenuInteraction()), activeRef = useRef(0), focusOnOpen = useRef(false);
  const outsidePress = useRef(new MenuPress());
  const pointer = useRef({ x: -1, y: -1, deltaX: 0, buttons: 0, moved: false });
  const timer = useRef<number | undefined>(undefined), tick = useRef<() => void>(() => {});
  const scopeId = `color-menu:${menuId}`, scopeCallback = useRef(onInputScopeChange); scopeCallback.current = onInputScopeChange;
  const last = AUTO_COLOR_ACTIONS.find(action => action.method === method) ?? AUTO_COLOR_ACTIONS[0];
  const preset = colorPresetName(state.grade);
  const presetNames = colorPresetNames(displayMode ?? state.mode);
  const choices = open === 'auto' ? AUTO_COLOR_ACTIONS.map(action => ({ value: action.method, label: t(action.label), icon: action.icon })) :
    presetNames.map(name => ({ value: name, label: name, icon: 'ColorPresets' }));
  const clearTimer = useCallback(() => {
    if (timer.current !== undefined) window.clearTimeout(timer.current);
    timer.current = undefined;
  }, []);
  const dismiss = useCallback((focus = false, retire = false) => {
    clearTimer(); const kind = interaction.current.open;
    if (retire) interaction.current.retire(); else interaction.current.dismiss();
    focusOnOpen.current = false; scopeCallback.current?.(scopeId, false); setOpen(null);
    if (focus && kind) (kind === 'auto' ? auto : presets).current?.focus({ preventScroll: true });
  }, [clearTimer, scopeId]);
  const admitted = () => !document.hidden && !document.querySelector('[role="dialog"]') &&
    !Array.from(document.querySelectorAll('[role="menu"]')).some(element => element !== menu.current);
  const focusChoice = (index: number) => {
    const list = menu.current, item = list?.querySelector<HTMLButtonElement>(`[data-choice="${index}"]`);
    if (!list || !item) return;
    item.focus({ preventScroll: true });
    // Reveal within this scrolling portal only. scrollIntoView can move the
    // Tools anchor or page and close the menu through its scroll owner.
    const bounds = list.getBoundingClientRect(), target = item.getBoundingClientRect();
    const top = bounds.top + list.clientTop + 4, bottom = bounds.top + list.clientTop + list.clientHeight - 4;
    if (target.top < top) list.scrollTop -= top - target.top;
    else if (target.bottom > bottom) list.scrollTop += target.bottom - bottom;
    pointer.current.moved = false;
  };
  const show = (kind: MenuKind, pin: boolean) => {
    if (!validInput || !(kind === 'auto' ? controller.colorControlsEnabled : controller.colorPreviewEnabled) || !admitted()) return;
    clearTimer();
    if (interaction.current.open === kind) {
      if (pin && interaction.current.pinned) dismiss();
      else if (pin) { interaction.current.pin(); focusChoice(activeRef.current); }
      return;
    }
    const trigger = (kind === 'auto' ? auto : presets).current!, bounds = trigger.getBoundingClientRect();
    scrollOwner.current = captureMenuScroll(trigger);
    const panel = row.current!.closest('.tools-panel')?.getBoundingClientRect() ?? bounds;
    const scale = UI_SIZES.find(info => info.size === size)!.panelScale;
    const width = Math.max(1, Math.min(224 * scale, window.innerWidth - 24));
    const count = kind === 'auto' ? AUTO_COLOR_ACTIONS.length : presetNames.length;
    const height = Math.min(count * 28 + 10, window.innerHeight - 24);
    let left = panel.left - width - 12, top = bounds.top;
    if (left < 12) {
      left = panel.right + 12;
      if (left + width > window.innerWidth - 12) {
        left = Math.max(12, Math.min(bounds.left, window.innerWidth - width - 12));
        top = bounds.bottom + 4;
        if (top + height > window.innerHeight - 12) top = bounds.top - height - 4;
      }
    }
    setPosition({ left, top: Math.max(12, Math.min(top, window.innerHeight - height - 12)), width });
    const index = kind === 'auto' ? AUTO_COLOR_ACTIONS.findIndex(action => action.method === method) : Math.max(0, presetNames.indexOf(preset));
    interaction.current.show(kind, pin); activeRef.current = index; focusOnOpen.current = pin;
    scopeCallback.current?.(scopeId, true); setActive(index); setOpen(kind);
  };
  const choose = (index: number) => {
    const choice = choices[index];
    const kind = interaction.current.open;
    if (!kind || !choice || !validInput || !(kind === 'auto' ? controller.colorControlsEnabled : controller.colorPreviewEnabled)) return;
    if (kind === 'auto') {
      const action = AUTO_COLOR_ACTIONS[index];
      onMethodChanged(action.method);
      dismiss(true);
      void dispatchAutoColor(controller, action.method, validInput);
    } else {
      dispatchColorPreset(controller, choice.value, validInput, onPresetValues);
      dismiss(true);
    }
  };
  const wake = () => { clearTimer(); tick.current(); };
  tick.current = () => {
    const owner = interaction.current;
    if (!admitted()) { dismiss(false, true); return; }
    const bounds = menu.current?.getBoundingClientRect(), trigger = owner.open && (owner.open === 'auto' ? auto : presets).current?.getBoundingClientRect();
    const point = pointer.current, now = performance.now(), overMenu = !!bounds && containsMenuPoint(bounds, point);
    const approaching = !!bounds && !!trigger && approachingColorMenu(trigger, bounds, point, point.deltaX);
    const decision = owner.tick(now, overMenu, approaching, point.buttons);
    if (decision === 'dismiss') dismiss();
    else if (decision) {
      if (!validInput || !(decision === 'auto' ? controller.colorControlsEnabled : controller.colorPreviewEnabled)) { dismiss(false, true); return; }
      show(decision, false);
    }
    point.deltaX = 0;
    // Moving toward the popup resets the away clock. If the pointer pauses in
    // the bridge, the next 300 ms boundary closes it without a frame poll.
    if (approaching) owner.tick(now, overMenu, false, point.buttons);
    const delay = owner.nextDelay(now, point.buttons);
    if (delay !== null) timer.current = window.setTimeout(() => { timer.current = undefined; tick.current(); }, delay);
  };
  const hover = (kind: MenuKind) => {
    if (!admitted() || !(kind === 'auto' ? enabled : previewEnabled)) return;
    // Pointer entry can follow scrollIntoView before its queued scroll event.
    // Retain this already-current anchor during the 300 ms opening delay too.
    if (!interaction.current.open) scrollOwner.current = captureMenuScroll((kind === 'auto' ? auto : presets).current!);
    interaction.current.enter(kind, performance.now()); wake();
  };
  const leave = (kind: MenuKind) => { interaction.current.leave(kind); wake(); };
  useLayoutEffect(() => {
    if ((interaction.current.open || interaction.current.hovered) && !admitted()) dismiss(false, true);
  });
  useLayoutEffect(() => {
    if (open && focusOnOpen.current) { focusOnOpen.current = false; focusChoice(activeRef.current); }
  }, [open]);
  useEffect(() => { if (open && !(open === 'auto' ? enabled : previewEnabled)) dismiss(); }, [enabled, previewEnabled, open, dismiss]);
  const keyHandler = useRef<(event: globalThis.KeyboardEvent) => void>(() => {});
  keyHandler.current = event => {
    if (!interaction.current.open) return;
    event.stopImmediatePropagation();
    if (event.key !== 'Tab' && isKnownBrowserKey(event) || (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') return;
    if (event.key === 'Escape') { event.preventDefault(); dismiss(true); return; }
    if (event.key === 'Tab') { dismiss(true); return; }
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (!event.repeat) choose(activeRef.current); return; }
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 :
      event.key === 'ArrowDown' ? (activeRef.current + 1) % choices.length : event.key === 'ArrowUp' ? (activeRef.current + choices.length - 1) % choices.length : null;
    if (next !== null) {
      event.preventDefault(); interaction.current.pin(); clearTimer(); activeRef.current = next; setActive(next); focusChoice(next);
    } else if (event.ctrlKey || event.metaKey) event.preventDefault();
  };
  useEffect(() => {
    const move = (event: PointerEvent) => {
      const point = pointer.current; point.moved = event.clientX !== point.x || event.clientY !== point.y;
      point.deltaX = event.clientX - point.x; point.x = event.clientX; point.y = event.clientY; point.buttons = event.buttons;
      if (interaction.current.open || interaction.current.hovered) { clearTimer(); tick.current(); }
    };
    const buttons = (event: PointerEvent) => {
      pointer.current.buttons = event.buttons;
      if (interaction.current.open || interaction.current.hovered) { clearTimer(); tick.current(); }
    };
    const press = (event: PointerEvent) => { outsidePress.current.reset(); buttons(event); };
    const activate = (event: MouseEvent) => {
      if (outsidePress.current.consume(event)) { event.preventDefault(); event.stopImmediatePropagation(); }
    };
    const contextKey = (event: globalThis.KeyboardEvent) => outsidePress.current.keyDown(event);
    const retire = () => { outsidePress.current.reset(); dismiss(false, true); };
    const cancel = () => { pointer.current.buttons = 0; retire(); };
    const visibility = () => { if (document.hidden) retire(); };
    const scroll = (event: Event) => {
      pointer.current.moved = false;
      if ((interaction.current.open || interaction.current.hovered) &&
          (scrollOwner.current?.shouldDismiss(event.target, menu.current) ?? true)) retire();
    };
    window.addEventListener('pointermove', move, true); window.addEventListener('pointerdown', press, true); window.addEventListener('pointerup', buttons, true);
    window.addEventListener('pointercancel', cancel, true); window.addEventListener('keydown', contextKey, true);
    document.addEventListener('click', activate, true); document.addEventListener('contextmenu', activate, true); document.addEventListener('auxclick', activate, true);
    window.addEventListener('resize', retire); window.addEventListener('blur', retire); window.addEventListener('scroll', scroll, true);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      clearTimer(); outsidePress.current.reset(); interaction.current.retire(); scopeCallback.current?.(scopeId, false);
      window.removeEventListener('pointermove', move, true); window.removeEventListener('pointerdown', press, true); window.removeEventListener('pointerup', buttons, true);
      window.removeEventListener('pointercancel', cancel, true); window.removeEventListener('keydown', contextKey, true);
      document.removeEventListener('click', activate, true); document.removeEventListener('contextmenu', activate, true); document.removeEventListener('auxclick', activate, true);
      window.removeEventListener('resize', retire); window.removeEventListener('blur', retire); window.removeEventListener('scroll', scroll, true);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [clearTimer, dismiss, scopeId]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !row.current?.contains(target)) {
        outsidePress.current.arm(event);
        event.preventDefault(); event.stopImmediatePropagation(); dismiss(false, true);
      }
    };
    const key = (event: globalThis.KeyboardEvent) => keyHandler.current(event), release = (event: globalThis.KeyboardEvent) => event.stopImmediatePropagation();
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('keydown', key, true); window.addEventListener('keyup', release, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('keydown', key, true); window.removeEventListener('keyup', release, true);
    };
  }, [open, dismiss]);
  const triggerKey = (event: KeyboardEvent, kind: MenuKind) => {
    event.stopPropagation();
    if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
      event.preventDefault(); if (!event.repeat) show(kind, true);
    }
  };
  const selectedOnly = state.colorSession?.active || controller.colorPending ? state.colorSelectedOnly : (state.summary?.selected ?? 0) > 0;
  return <div ref={row} className="two-columns color-actions" role="group" aria-label={t('Color actions')} onKeyDown={event => event.stopPropagation()}>
    <button ref={auto} type="button" data-tutorial-target="auto-color" className="color-selector" aria-label={t('Auto color')} title={t('Auto color')}
      aria-description={t(selectedOnly ? 'Applies to selected splats. Current action: %s.' : 'Applies to the whole scene. Current action: %s.', t(last.label))}
      disabled={!enabled} aria-haspopup="menu" aria-expanded={open === 'auto'} aria-controls={open === 'auto' ? menuId : undefined}
      onPointerEnter={() => hover('auto')} onPointerLeave={() => leave('auto')}
      onClick={() => show('auto', true)} onKeyDown={event => triggerKey(event, 'auto')}>
      <span className="color-selector-caption">{t('Auto color')}</span><span className="color-selector-value"><Icon name={last.icon} /><span>{t(last.label)}</span><span aria-hidden="true" className="color-chevron"><DecorativeChevron /></span></span>
    </button>
    <button ref={presets} type="button" data-tutorial-target="presets" className={`color-selector ${preset !== 'Custom' ? 'active' : ''}`} aria-label={t('Color preset')} title={t('Presets')}
      disabled={!previewEnabled} aria-haspopup="menu" aria-expanded={open === 'presets'} aria-controls={open === 'presets' ? menuId : undefined}
      onPointerEnter={() => hover('presets')} onPointerLeave={() => leave('presets')}
      onClick={() => show('presets', true)} onKeyDown={event => triggerKey(event, 'presets')}>
      <span className="color-selector-caption">{t('Presets')}</span><span className="color-selector-value"><Icon name="ColorPresets" /><span>{t(preset)}</span><span aria-hidden="true" className="color-chevron"><DecorativeChevron /></span></span>
    </button>
    {open && createPortal(<div ref={menu} id={menuId} role="menu" aria-label={t(open === 'auto' ? 'Auto color actions' : 'Color presets')}
      className="color-actions-menu" style={{ ...uiSizeStyle(size), ...position }} onPointerEnter={wake} onPointerLeave={wake}
      onPointerDown={() => { interaction.current.pin(); clearTimer(); }}>
      {choices.map((choice, index) => <button type="button" key={choice.value} role={open === 'auto' ? 'menuitem' : 'menuitemradio'}
        aria-checked={open === 'presets' ? choice.value === preset : undefined} tabIndex={active === index ? 0 : -1} data-choice={index}
        disabled={open === 'auto' ? !enabled : !previewEnabled} title={t(choice.label)}
        onPointerMove={() => { if (pointer.current.moved && !pointer.current.buttons) { activeRef.current = index; setActive(index); } }}
        onFocus={() => { activeRef.current = index; setActive(index); }} onClick={() => choose(index)}>
        <Icon name={choice.icon} /><span>{t(choice.label)}</span><span className="grow" />{open === 'presets' && choice.value === preset && <Icon name="Check" />}
      </button>)}
    </div>, document.body)}
  </div>;
}

export function ColorApplyButton({ controller, validInput = true }: { controller: ColorController; validInput?: boolean }) {
  const { t } = useTranslation();
  useApp();
  return <button type="button" className="action-button" hidden={!controller.colorPending}
    disabled={!validInput || !controller.colorControlsEnabled || !controller.colorPending}
    onClick={event => {
      const button = event.currentTarget;
      const slider = button.closest('fieldset')?.querySelector<HTMLInputElement>('.grade-controls input:not(:disabled)');
      applyAction(button, slider, () => dispatchColorApply(controller, validInput));
    }}>{t('Apply color')}</button>;
}
