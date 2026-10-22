import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { captureMenuScroll, type MenuScrollOwner } from './menuScroll';
import { MenuPress } from './menuPress';
import { focusAndReveal } from './focusScroll';
import { isKnownBrowserKey } from '../input/inputScope';
import type { AppController } from '../app/controller';
import { useApp } from '../app/store';
import { UI_SIZES, uiSizeStyle, useUiPreferences } from '../app/uiPreferences';
import { sameColorValues } from '../document/colorSession';
import type { FloorPlane } from '../document/floorProtocol';
import { webFeatureAllowed } from '../app/productPolicy';
import { Icon } from './Icon';
import { DecorativeChevron } from './DecorativeChevron';
import { useTranslation } from '../app/useLanguageAppearance';

type AlignmentController = Pick<AppController, 'alignmentControlsEnabled' | 'alignmentPlaneControlsEnabled' | 'camera' | 'startCenterAlignment' | 'startScaleAlignment' |
  'startPlaneAlignment' | 'floorDetectionEnabled' | 'floorCandidateReady' | 'startFloorDetection' | 'setAlignmentFlip' | 'setAlignmentTargetDistance' |
  'confirmAlignment' | 'cancelAlignment' | 'clearAlignmentPoint' | 'resetAlignment'>;

export const ALIGNMENT_ACTIONS = [
  { value: 'center', label: '1-point center', icon: 'PickCenter', available: true, hint: 'Pick a point to move it to the origin' },
  { value: 'scale', label: '2-point scale', icon: 'CalibrateScale', available: true, hint: 'Pick two points and set their distance in meters' },
  { value: 'align', label: '3-point align', icon: 'AlignPlane', available: true, hint: 'Pick three points to align their plane' },
  { value: 'floor', label: 'Level floor', icon: 'LevelFloor', available: true, hint: 'Detect a floor plane and confirm leveling' },
] as const;

export function alignmentControlsEnabled(controller: Pick<AlignmentController, 'alignmentControlsEnabled'>) {
  const state = useApp.getState();
  return controller.alignmentControlsEnabled && !state.settingsOpen && !state.exportOpen &&
    !state.navigationPrompt && !state.outputPending && state.savedViewChoices.length === 0;
}
export function alignmentPlaneControlsEnabled(controller: Pick<AlignmentController, 'alignmentControlsEnabled' | 'alignmentPlaneControlsEnabled'>) {
  return alignmentControlsEnabled(controller) && controller.alignmentPlaneControlsEnabled;
}
export function floorControlsVisible() {
  const state = useApp.getState();
  return !state.settingsOpen && !state.exportOpen && !state.navigationPrompt && !state.outputPending && !state.savedViewChoices.length;
}
export function floorCancellationEnabled() {
  const state = useApp.getState();
  return state.alignmentTool === 'floor' && !!state.alignmentFloor && floorControlsVisible() &&
    !(state.alignmentFloor.phase === 'candidate' && state.busy);
}
export function alignmentMeasuredDistance(first: readonly number[] | null, second: readonly number[] | null): number | null {
  if (!first || !second) return null;
  const distance = Math.fround(Math.sqrt(first.reduce((sum, value, index) => sum + (value - second[index]) ** 2, 0)));
  return Number.isFinite(distance) ? distance : null;
}
export function alignmentConfirmationReady(controller: Pick<AlignmentController, 'alignmentControlsEnabled' | 'alignmentPlaneControlsEnabled' | 'floorCandidateReady'>) {
  const state = useApp.getState();
  if (state.alignmentTool === 'floor') return floorControlsVisible() && !state.busy && controller.floorCandidateReady &&
    state.alignmentFloor?.phase === 'candidate' && state.alignmentFloor.candidate?.status === 'ready';
  if (!alignmentControlsEnabled(controller) || !state.alignmentPoint || state.alignmentPicking) return false;
  if (state.alignmentTool === 'scale') return !!state.alignmentSecondPoint &&
    (alignmentMeasuredDistance(state.alignmentPoint, state.alignmentSecondPoint) ?? 0) > 0 &&
    Number.isFinite(state.alignmentTargetDistance) && (state.alignmentTargetDistance ?? 0) > 0;
  if (state.alignmentTool === 'align') return alignmentPlaneControlsEnabled(controller) && !!state.alignmentSecondPoint && !!state.alignmentThirdPoint && !!state.alignmentNormal;
  return state.alignmentTool === 'center';
}
const distanceText = (value: number | null) => value !== null && Number.isFinite(value) ? String(Number(value.toPrecision(5))) : '';

// Consume alignment confirmation/cancellation before Selection and Polygon.
// Floor has no point undo; its Backspace remains with the scene edit owner.
export function handleAlignmentKey(event: Pick<globalThis.KeyboardEvent, 'key' | 'repeat' | 'ctrlKey' | 'metaKey' | 'altKey' | 'defaultPrevented' | 'preventDefault'> &
  { isComposing?: boolean; nativeEvent?: { isComposing?: boolean } },
  controller: AlignmentController) {
  const state = useApp.getState();
  if (!state.alignmentTool || event.defaultPrevented || event.isComposing || event.nativeEvent?.isComposing || event.ctrlKey || event.metaKey || event.altKey ||
      state.settingsOpen || state.exportOpen || state.navigationPrompt || state.outputPending || state.savedViewChoices.length ||
      !['Escape', 'Backspace', 'Enter'].includes(event.key)) return false;
  if (state.alignmentTool === 'floor' && (event.key === 'Backspace' || event.key === 'Enter' && !alignmentConfirmationReady(controller))) return false;
  event.preventDefault();
  if (event.repeat) return true;
  if (event.key === 'Escape') { if (state.alignmentTool !== 'floor' || floorCancellationEnabled()) controller.cancelAlignment(); }
  else if (event.key === 'Backspace') controller.clearAlignmentPoint();
  else if (alignmentConfirmationReady(controller)) void controller.confirmAlignment();
  return true;
}
export function handleAlignmentDistanceKey(event: Parameters<typeof handleAlignmentKey>[0], controller: AlignmentController) {
  // Numeric Backspace belongs to text editing; Enter still confirms an
  // unchanged distance and Escape cancels the point tool.
  return ['Escape', 'Enter'].includes(event.key) && handleAlignmentKey(event, controller);
}

export function AlignmentActionMenu({ active, activeTool, enabled, planeEnabled = false, floorEnabled = false, allowFloor = true, onChoose }: {
  active: boolean; activeTool?: 'center' | 'scale' | 'align' | 'floor' | null; enabled: boolean; planeEnabled?: boolean; floorEnabled?: boolean;
  allowFloor?: boolean;
  onChoose(tool: 'center' | 'scale' | 'align' | 'floor'): void;
}) {
  const { t } = useTranslation();
  const selected = activeTool === undefined ? active ? 'center' : null : activeTool;
  return <>{ALIGNMENT_ACTIONS.filter(choice => choice.value !== 'floor' || allowFloor).map(choice => <button key={choice.value} type="button" role="menuitemradio"
    aria-checked={choice.value === selected} disabled={choice.value === 'floor' ? !floorEnabled : !enabled || choice.value === 'align' && !planeEnabled}
    tabIndex={(choice.value === 'floor' ? floorEnabled : enabled && (choice.value !== 'align' || planeEnabled)) ? 0 : -1}
    title={t(choice.hint)} onClick={choice.available ? () => onChoose(choice.value) : undefined}>
    <Icon name={choice.icon} /><span>{t(choice.label)}</span><span className="grow" />{choice.value === selected && <Icon name="Check" />}
  </button>)}</>;
}

export function AlignmentControls({ controller, scene, showReset = true }: {
  controller: AlignmentController; scene: RefObject<HTMLCanvasElement | null>; showReset?: boolean;
}) {
  const { t } = useTranslation();
  const state = useApp(), preference = useUiPreferences(), size = preference.previewSize ?? preference.size;
  const enabled = alignmentControlsEnabled(controller), active = state.alignmentTool !== null;
  const floorEnabled = floorControlsVisible() && (controller.floorDetectionEnabled || floorCancellationEnabled());
  const menuEnabled = enabled || floorEnabled;
  const selected = ALIGNMENT_ACTIONS.find(choice => choice.value === state.alignmentTool);
  const [open, setOpen] = useState(false), [position, setPosition] = useState({ left: 0, top: 0, width: 0 });
  const row = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null), menuId = useId();
  const scrollOwner = useRef<MenuScrollOwner | undefined>(undefined);
  const outsidePress = useRef(new MenuPress());
  const interaction = useRef({ open: false, pinned: false, hovered: false, dismissed: false,
    hoverSince: 0, awaySince: null as number | null });
  const pointer = useRef({ x: -1, y: -1, deltaX: 0, buttons: 0 });
  const timer = useRef<number | undefined>(undefined), tick = useRef<() => void>(() => {}), focusOnOpen = useRef(false);
  const clearTimer = useCallback(() => { if (timer.current !== undefined) window.clearTimeout(timer.current); timer.current = undefined; }, []);
  const dismiss = useCallback((focus = false, retire = false) => {
    clearTimer(); const owner = interaction.current;
    owner.dismissed = owner.hovered; owner.open = owner.pinned = false; owner.awaySince = null;
    if (retire) owner.hovered = false;
    focusOnOpen.current = false; setOpen(false);
    if (focus) focusAndReveal(trigger.current);
  }, [clearTimer]);
  const admitted = () => !document.hidden && !document.querySelector('[role="dialog"]') &&
    !Array.from(document.querySelectorAll('[role="menu"]')).some(element => element !== menu.current);
  const enabledButtons = () => Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
  const focusChoice = () => focusAndReveal(menu.current?.querySelector<HTMLButtonElement>('button[aria-checked="true"]:not(:disabled)') ??
    enabledButtons()[0], menu.current);
  const show = (pin: boolean) => {
    if (!menuEnabled || !admitted()) return;
    clearTimer(); const owner = interaction.current;
    if (owner.open) {
      if (pin && owner.pinned) dismiss();
      else if (pin) { owner.pinned = true; focusChoice(); }
      return;
    }
    const anchor = trigger.current!, bounds = anchor.getBoundingClientRect(), panel = row.current!.closest('.tools-panel')?.getBoundingClientRect() ?? bounds;
    scrollOwner.current = captureMenuScroll(anchor);
    const scale = UI_SIZES.find(info => info.size === size)!.panelScale;
    const width = Math.max(1, Math.min(224 * scale, window.innerWidth - 24)), height = Math.min(122, window.innerHeight - 24);
    let left = panel.left - width - 12, top = bounds.top;
    if (left < 12) { left = Math.max(12, Math.min(bounds.left, window.innerWidth - width - 12)); top = bounds.bottom + 4; }
    setPosition({ left, top: Math.max(12, Math.min(top, window.innerHeight - height - 12)), width });
    owner.open = true; owner.pinned = pin; owner.dismissed = false; owner.awaySince = null;
    focusOnOpen.current = pin; setOpen(true);
  };
  const choose = (tool: 'center' | 'scale' | 'align' | 'floor') => {
    if (tool === 'floor' ? !floorEnabled : !alignmentControlsEnabled(controller) || tool === 'align' && !alignmentPlaneControlsEnabled(controller)) return;
    dismiss();
    if (useApp.getState().alignmentTool === tool) { controller.cancelAlignment(); scene.current?.focus({ preventScroll: true }); }
    else void (tool === 'floor' ? controller.startFloorDetection() : tool === 'align' ? controller.startPlaneAlignment() : tool === 'scale' ? controller.startScaleAlignment() : controller.startCenterAlignment())
      .then(accepted => { if (accepted) scene.current?.focus({ preventScroll: true }); });
  };
  // Committed selection_ui.cpp:43-72,148-164: passive selector timing only.
  // Hover never asks native code to pick, fit, detect, edit or prepare a preview.
  const wake = () => { clearTimer(); tick.current(); };
  tick.current = () => {
    const owner = interaction.current;
    if (!menuEnabled || !admitted()) { dismiss(false, true); return; }
    const point = pointer.current, now = performance.now();
    if (owner.hovered && !owner.open && !owner.dismissed && !point.buttons && now - owner.hoverSince >= 300) show(false);
    const anchor = trigger.current?.getBoundingClientRect(), list = menu.current?.getBoundingClientRect();
    const contains = (bounds: DOMRect) => point.x >= bounds.left && point.x < bounds.right && point.y >= bounds.top && point.y < bounds.bottom;
    const overList = !!list && contains(list);
    const approaching = !!anchor && !!list &&
      point.x >= Math.min(anchor.left, list.left) && point.x < Math.max(anchor.right, list.right) &&
      point.y >= Math.min(anchor.top, list.top) && point.y < Math.max(anchor.bottom, list.bottom) &&
      (list.right <= anchor.left && point.deltaX < 0 || list.left >= anchor.right && point.deltaX > 0);
    if (!owner.open || owner.pinned || owner.hovered || overList || approaching) owner.awaySince = null;
    else {
      owner.awaySince ??= now;
      if (now - owner.awaySince >= 300) dismiss();
    }
    point.deltaX = 0;
    // A directional bridge renews the away clock while moving; stopping there
    // still closes after 300 ms, without a frame loop or stationary polling.
    if (approaching && !owner.pinned && !owner.hovered && !overList) owner.awaySince = now;
    const hoverDeadline = owner.hovered && !owner.open && !owner.dismissed && !point.buttons ? owner.hoverSince + 300 : Infinity;
    const awayDeadline = owner.open && !owner.pinned && owner.awaySince !== null ? owner.awaySince + 300 : Infinity;
    const deadline = Math.min(hoverDeadline, awayDeadline);
    if (Number.isFinite(deadline)) timer.current = window.setTimeout(() => { timer.current = undefined; tick.current(); }, Math.max(0, deadline - now));
  };
  const hover = () => {
    if (!menuEnabled || !admitted()) return;
    const owner = interaction.current;
    if (!owner.open) scrollOwner.current = captureMenuScroll(trigger.current!);
    if (!owner.hovered) { owner.hovered = true; owner.hoverSince = performance.now(); }
    wake();
  };
  const leave = () => { interaction.current.hovered = interaction.current.dismissed = false; wake(); };
  useLayoutEffect(() => {
    if ((interaction.current.open || interaction.current.hovered) && (!menuEnabled || !admitted())) dismiss(false, true);
  });
  useLayoutEffect(() => { if (open && focusOnOpen.current) { focusOnOpen.current = false; focusChoice(); } }, [open]);
  const keyHandler = useRef<(event: globalThis.KeyboardEvent) => void>(() => {});
  keyHandler.current = event => {
    if (!interaction.current.open) return;
    event.stopImmediatePropagation();
    if (event.key !== 'Tab' && isKnownBrowserKey(event) || (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') return;
    if (event.key === 'Escape') { event.preventDefault(); dismiss(true); return; }
    if (event.key === 'Tab') { dismiss(true); return; }
    const buttons = enabledButtons(), focused = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (!event.repeat) (buttons[focused] ?? menu.current?.querySelector<HTMLButtonElement>('button[aria-checked="true"]:not(:disabled)') ?? buttons[0])?.click();
      return;
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); if (!buttons.length) return;
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : focused < 0 ?
        event.key === 'ArrowUp' ? buttons.length - 1 : 0 : (focused + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length;
      interaction.current.pinned = true; clearTimer(); focusAndReveal(buttons[next], menu.current);
    } else if (event.ctrlKey || event.metaKey) event.preventDefault();
  };
  useEffect(() => {
    const move = (event: PointerEvent) => {
      const point = pointer.current; point.deltaX = event.clientX - point.x; point.x = event.clientX; point.y = event.clientY; point.buttons = event.buttons;
      if (interaction.current.open || interaction.current.hovered) { clearTimer(); tick.current(); }
    };
    const buttons = (event: PointerEvent) => { pointer.current.buttons = event.buttons; if (interaction.current.open || interaction.current.hovered) { clearTimer(); tick.current(); } };
    const press = (event: PointerEvent) => { outsidePress.current.reset(); buttons(event); };
    const activate = (event: MouseEvent) => { if (outsidePress.current.consume(event)) { event.preventDefault(); event.stopImmediatePropagation(); } };
    const contextKey = (event: globalThis.KeyboardEvent) => outsidePress.current.keyDown(event);
    const retire = () => { outsidePress.current.reset(); dismiss(false, true); };
    const cancel = () => { pointer.current.buttons = 0; retire(); };
    const visibility = () => { if (document.hidden) retire(); };
    const scroll = (event: Event) => {
      if ((interaction.current.open || interaction.current.hovered) && (scrollOwner.current?.shouldDismiss(event.target, menu.current) ?? true)) retire();
    };
    window.addEventListener('pointermove', move, true); window.addEventListener('pointerdown', press, true); window.addEventListener('pointerup', buttons, true);
    window.addEventListener('pointercancel', cancel, true); window.addEventListener('keydown', contextKey, true);
    document.addEventListener('click', activate, true); document.addEventListener('contextmenu', activate, true); document.addEventListener('auxclick', activate, true);
    window.addEventListener('resize', retire); window.addEventListener('blur', retire); window.addEventListener('scroll', scroll, true); document.addEventListener('visibilitychange', visibility);
    return () => {
      clearTimer(); outsidePress.current.reset(); interaction.current.open = interaction.current.hovered = false;
      window.removeEventListener('pointermove', move, true); window.removeEventListener('pointerdown', press, true); window.removeEventListener('pointerup', buttons, true);
      window.removeEventListener('pointercancel', cancel, true); window.removeEventListener('keydown', contextKey, true);
      document.removeEventListener('click', activate, true); document.removeEventListener('contextmenu', activate, true); document.removeEventListener('auxclick', activate, true);
      window.removeEventListener('resize', retire); window.removeEventListener('blur', retire); window.removeEventListener('scroll', scroll, true); document.removeEventListener('visibilitychange', visibility);
    };
  }, [clearTimer, dismiss]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      // Reset is a sibling control, not part of the selector popup. Its first
      // outside press dismisses too, just like a canvas or toolbar press.
      if (!trigger.current?.contains(target) && !menu.current?.contains(target)) {
        outsidePress.current.arm(event); event.preventDefault(); event.stopImmediatePropagation(); dismiss(false, true);
      }
    };
    const key = (event: globalThis.KeyboardEvent) => keyHandler.current(event), release = (event: globalThis.KeyboardEvent) => event.stopImmediatePropagation();
    document.addEventListener('pointerdown', outside, true); window.addEventListener('keydown', key, true); window.addEventListener('keyup', release, true);
    return () => { document.removeEventListener('pointerdown', outside, true); window.removeEventListener('keydown', key, true); window.removeEventListener('keyup', release, true); };
  }, [open, dismiss]);
  return <div className="alignment-controls" ref={row} onKeyDown={event => event.stopPropagation()}>
    <button ref={trigger} type="button" data-tutorial-target="pick-center scale-align plane-align floor" className={`color-selector alignment-selector ${active ? 'active' : ''}`} aria-label={t('Alignment')}
      title={t('Alignment affects the whole scene')} disabled={!menuEnabled} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
      onPointerEnter={hover} onPointerLeave={leave} onClick={() => show(true)} onKeyDown={event => {
        if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
          event.preventDefault(); if (!event.repeat) show(true);
        }
      }}>
      <span className="color-selector-caption">{t('Alignment')}</span><span className="color-selector-value"><Icon name={selected?.icon ?? 'AlignPlane'} />
        <span>{t(selected?.label ?? 'Choose')}</span><span aria-hidden="true" className="color-chevron"><DecorativeChevron /></span></span>
    </button>
    {showReset && <button type="button" className="icon-button small" aria-label={t('Reset alignment')} title={t('Reset alignment')}
      disabled={!enabled || !state.summary?.alignment?.canReset || !sameColorValues(state.grade, state.appliedGrade)}
      onClick={() => void controller.resetAlignment()}><Icon name="Reset" /></button>}
    {open && createPortal(<div ref={menu} id={menuId} role="menu" aria-label={t('Alignment actions')} className="color-actions-menu alignment-menu"
      style={{ ...uiSizeStyle(size), ...position }} onPointerEnter={wake} onPointerLeave={wake}><AlignmentActionMenu active={active} activeTool={state.alignmentTool} enabled={enabled} allowFloor={webFeatureAllowed('alignment.auto')}
        planeEnabled={alignmentPlaneControlsEnabled(controller)} floorEnabled={floorEnabled} onChoose={choose} /></div>, document.body)}
  </div>;
}

// Camera arrays use the same column-major matrices consumed by WGSL. Reproject
// the retained world point as navigation changes; never reinterpret it as a pixel.
export function projectAlignmentPoint(point: readonly number[], view: ArrayLike<number>, projection: ArrayLike<number>, width: number, height: number): [number, number] | null {
  const transform = (matrix: ArrayLike<number>, vector: number[]) => [0, 1, 2, 3].map(row =>
    matrix[row] * vector[0] + matrix[4 + row] * vector[1] + matrix[8 + row] * vector[2] + matrix[12 + row] * vector[3]);
  const clip = transform(projection, transform(view, [...point, 1]));
  if (!clip.every(Number.isFinite) || clip[3] <= .001 || clip[2] < 0 || clip[2] > clip[3]) return null;
  const x = (clip[0] / clip[3] + 1) * width / 2, y = (1 - clip[1] / clip[3]) * height / 2;
  return x >= 0 && x <= width && y >= 0 && y <= height ? [x, y] : null;
}
export function projectAlignmentSegment(first: readonly number[], second: readonly number[], view: ArrayLike<number>, projection: ArrayLike<number>, width: number, height: number): [[number, number], [number, number]] | null {
  const transform = (matrix: ArrayLike<number>, vector: readonly number[]) => [0, 1, 2, 3].map(row =>
    matrix[row] * vector[0] + matrix[4 + row] * vector[1] + matrix[8 + row] * vector[2] + matrix[12 + row] * vector[3]);
  const a = transform(projection, transform(view, [...first, 1])), b = transform(projection, transform(view, [...second, 1]));
  if (![...a, ...b].every(Number.isFinite)) return null;
  const planes = (point: number[]) => [point[0] + point[3], point[3] - point[0], point[1] + point[3], point[3] - point[1], point[2], point[3] - point[2], point[3] - .001];
  const from = planes(a), to = planes(b); let begin = 0, end = 1;
  for (let index = 0; index < from.length; index++) {
    if (from[index] < 0 && to[index] < 0) return null;
    if (from[index] < 0) begin = Math.max(begin, from[index] / (from[index] - to[index]));
    else if (to[index] < 0) end = Math.min(end, from[index] / (from[index] - to[index]));
  }
  if (begin > end) return null;
  const screen = (amount: number): [number, number] => {
    const clip = a.map((value, index) => value + (b[index] - value) * amount);
    return [(clip[0] / clip[3] + 1) * width / 2, (1 - clip[1] / clip[3]) * height / 2];
  };
  return [screen(begin), screen(end)];
}

export type AlignmentNormalProjection = {
  shaft: [[number, number], [number, number]] | null;
  head: [[number, number], [number, number], [number, number]] | null;
};
type AlignmentPopupBox = { x: number; y: number; width: number; height: number };
type AlignmentPopupPosition = { left: number; top: number };
// R0 tries four quadrants beside the release and avoids other controls. The
// larger web panel also leaves the projected candidate normal visible.
export function placeAlignmentPlanePopup(anchor: readonly [number, number], extent: { width: number; height: number },
  viewport: { width: number; height: number }, obstacles: readonly AlignmentPopupBox[], scale = 1,
  previous?: AlignmentPopupPosition): AlignmentPopupPosition {
  const inset = 12, offset = 12 * scale, gap = 4 * scale;
  const clamp = ({ left, top }: AlignmentPopupPosition) => ({
    left: Math.max(inset, Math.min(left, viewport.width - extent.width - inset)),
    top: Math.max(inset, Math.min(top, viewport.height - extent.height - inset)),
  });
  const available = ({ left, top }: AlignmentPopupPosition) => {
    const right = left + extent.width, bottom = top + extent.height;
    if (anchor[0] >= left && anchor[0] <= right && anchor[1] >= top && anchor[1] <= bottom) return false;
    return obstacles.every(box => right <= box.x - gap || left >= box.x + box.width + gap ||
      bottom <= box.y - gap || top >= box.y + box.height + gap);
  };
  if (previous) { const at = clamp(previous); if (available(at)) return at; }
  const candidates = [
    { left: anchor[0] + offset, top: anchor[1] + offset },
    { left: anchor[0] - offset - extent.width, top: anchor[1] + offset },
    { left: anchor[0] + offset, top: anchor[1] - offset - extent.height },
    { left: anchor[0] - offset - extent.width, top: anchor[1] - offset - extent.height },
  ].map(clamp);
  // Keep the action reachable when the viewport cannot offer a clear quadrant.
  return candidates.find(available) ?? (previous ? clamp(previous) : candidates[0]);
}
// The controller supplies the captured native normal. This only projects its
// direction; candidate display never validates or transforms scene geometry.
export function projectAlignmentNormal(first: readonly number[], second: readonly number[], third: readonly number[], normal: readonly number[], flip: boolean,
  view: ArrayLike<number>, projection: ArrayLike<number>, width: number, height: number, scale = 1): AlignmentNormalProjection | null {
  if (![...first, ...second, ...third, ...normal].every(Number.isFinite)) return null;
  const center = first.map((value, index) => Math.fround(Math.fround(Math.fround(value / 3) + Math.fround(second[index] / 3)) + Math.fround(third[index] / 3)));
  const radius = Math.fround(.5 * Math.max(...[first, second, third].map(point => alignmentMeasuredDistance(center, point) ?? 0)));
  return projectAlignmentNormalArrow(center, normal, radius, flip, view, projection, width, height, scale);
}
function projectAlignmentNormalArrow(center: readonly number[], normal: readonly number[], radius: number, flip: boolean,
  view: ArrayLike<number>, projection: ArrayLike<number>, width: number, height: number, scale: number): AlignmentNormalProjection | null {
  const extent = Math.fround(Math.max(1e-5, radius) * (flip ? -1 : 1));
  const tip = center.map((value, index) => Math.fround(value + Math.fround(normal[index] * extent)));
  const shaft = projectAlignmentSegment(center, tip, view, projection, width, height);
  const b = projectAlignmentPoint(tip, view, projection, width, height);
  let head: AlignmentNormalProjection['head'] = null;
  if (b) {
    const transform = (matrix: ArrayLike<number>, vector: number[]) => [0, 1, 2, 3].map(row =>
      matrix[row] * vector[0] + matrix[4 + row] * vector[1] + matrix[8 + row] * vector[2] + matrix[12 + row] * vector[3]);
    const clip = transform(projection, transform(view, [...center, 1]));
    if (clip.every(Number.isFinite) && clip[3] > .001 && Math.abs(clip[0] / clip[3]) <= 20 && Math.abs(clip[1] / clip[3]) <= 20) {
      const a = [(clip[0] / clip[3] + 1) * width / 2, (1 - clip[1] / clip[3]) * height / 2];
      const distance = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (distance >= 2 * scale) {
        const direction = [(b[0] - a[0]) / distance, (b[1] - a[1]) / distance];
        const length = Math.min(10 * scale, distance * .35), wing = length * .45;
        const base = [b[0] - direction[0] * length, b[1] - direction[1] * length];
        head = [b, [base[0] - direction[1] * wing, base[1] + direction[0] * wing],
          [base[0] + direction[1] * wing, base[1] - direction[0] * wing]];
      }
    }
  }
  return shaft || head ? { shaft, head } : null;
}

export type FloorOverlayProjection = {
  grid: (ReturnType<typeof projectAlignmentSegment>)[];
  normal: AlignmentNormalProjection | null;
};
// Fixed-size display of the native candidate. The basis does not fit, validate,
// or change a scene; navigation and Flip only reproject this retained plane.
export function projectFloorOverlay(plane: FloorPlane, flip: boolean, view: ArrayLike<number>, projection: ArrayLike<number>,
  width: number, height: number, scale = 1): FloorOverlayProjection {
  const normal = plane.normal, helper = Math.abs(normal[1]) < .9 ? [0, 1, 0] : [1, 0, 0];
  const cross = (a: readonly number[], b: readonly number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const tangent = cross(normal, helper), length = Math.hypot(...tangent);
  if (!Number.isFinite(length) || length === 0 || ![...plane.center, ...normal, plane.radius].every(Number.isFinite)) return { grid: [], normal: null };
  const u = tangent.map(value => value / length), v = cross(normal, u), radius = Math.max(1e-5, plane.radius * .5);
  const point = (a: number, b: number) => plane.center.map((value, index) => value + radius * (u[index] * a + v[index] * b));
  const grid: FloorOverlayProjection['grid'] = [];
  for (let index = -4; index <= 4; index++) {
    const at = index / 4;
    grid.push(projectAlignmentSegment(point(at, -1), point(at, 1), view, projection, width, height),
      projectAlignmentSegment(point(-1, at), point(1, at), view, projection, width, height));
  }
  return { grid, normal: projectAlignmentNormalArrow(plane.center, normal, radius, flip, view, projection, width, height, scale) };
}

function AlignmentTargetDistance({ controller, disabled }: { controller: AlignmentController; disabled: boolean }) {
  const { t } = useTranslation();
  const target = useApp().alignmentTargetDistance, field = useRef<HTMLInputElement>(null), editing = useRef(false);
  const [text, setText] = useState(distanceText(target));
  useEffect(() => { if (!editing.current) setText(distanceText(target)); }, [target]);
  useEffect(() => { field.current?.focus({ preventScroll: true }); field.current?.select(); }, []);
  return <label className="alignment-target-distance"><span>{t('Target distance')}</span><span className="alignment-distance-field">
    <input ref={field} type="number" aria-label={t('Target distance (m)')} title={t('Target distance (m)')} min="0" step="any" value={text} disabled={disabled}
      onFocus={() => { editing.current = true; field.current?.select(); }}
      onChange={event => { const next = event.currentTarget.value; setText(next); controller.setAlignmentTargetDistance(next.trim() ? Number(next) : null); }}
      onBlur={() => { editing.current = false; setText(distanceText(useApp.getState().alignmentTargetDistance)); }}
      onKeyDown={event => { event.stopPropagation(); handleAlignmentDistanceKey(event, controller); }} />
    <span aria-hidden="true">m</span></span></label>;
}

export function AlignmentOverlay({ controller, scene, marker, secondMarker = null, thirdMarker = null, segment = null, triangleSegments = [], normalProjection = null, distanceMarker = null, floorGrid = [] }: {
  controller: AlignmentController; scene: RefObject<HTMLCanvasElement | null>; marker: [number, number] | null;
  secondMarker?: [number, number] | null; segment?: [[number, number], [number, number]] | null; distanceMarker?: [number, number] | null;
  thirdMarker?: [number, number] | null; triangleSegments?: ([[number, number], [number, number]] | null)[];
  normalProjection?: AlignmentNormalProjection | null;
  floorGrid?: FloorOverlayProjection['grid'];
}) {
  const { t } = useTranslation();
  const state = useApp(), preference = useUiPreferences(), size = preference.previewSize ?? preference.size;
  const popup = useRef<HTMLDivElement>(null), lastPoint = useRef(state.alignmentPoint), lastSecondPoint = useRef(state.alignmentSecondPoint), lastThirdPoint = useRef(state.alignmentThirdPoint);
  const planeAnchor = useRef<{ point: typeof state.alignmentThirdPoint; marker: [number, number] } | null>(null);
  const floorAnchor = useRef<[number, number] | null>(null);
  const [at, setAt] = useState({ left: 18, top: 60 });
  const scaling = state.alignmentTool === 'scale', aligning = state.alignmentTool === 'align', picked = !!state.alignmentPoint;
  const flooring = state.alignmentTool === 'floor', floor = state.alignmentFloor;
  const secondPicked = (scaling || aligning) && !!state.alignmentSecondPoint, thirdPicked = aligning && !!state.alignmentThirdPoint;
  const readyPlane = aligning && thirdPicked && !!state.alignmentNormal;
  const enabled = aligning ? alignmentPlaneControlsEnabled(controller) : alignmentControlsEnabled(controller);
  const measured = scaling ? alignmentMeasuredDistance(state.alignmentPoint, state.alignmentSecondPoint) : null;
  const anchorPoint = thirdPicked ? state.alignmentThirdPoint : secondPicked ? state.alignmentSecondPoint : state.alignmentPoint;
  const anchorMarker = thirdPicked ? thirdMarker : secondPicked ? secondMarker : marker;
  // Anchor the confirmation beside the accepted pick, as desktop does. The
  // marker follows camera navigation while this floating action stays reachable.
  useEffect(() => {
    if (!state.alignmentTool || !popup.current || flooring) return;
    if (readyPlane) return;
    const changed = lastPoint.current !== state.alignmentPoint || lastSecondPoint.current !== state.alignmentSecondPoint || lastThirdPoint.current !== state.alignmentThirdPoint;
    if (anchorPoint && !anchorMarker && changed) return;
    if (changed || !picked) {
      const bounds = popup.current.getBoundingClientRect(), scale = UI_SIZES.find(info => info.size === size)!.panelScale;
      setAt({ left: Math.max(12, Math.min((anchorMarker?.[0] ?? 18) + 12 * scale, window.innerWidth - bounds.width - 12)),
        top: Math.max(12, Math.min((anchorMarker?.[1] ?? 48) + 12 * scale, window.innerHeight - bounds.height - 12)) });
      lastPoint.current = state.alignmentPoint;
      lastSecondPoint.current = state.alignmentSecondPoint;
      lastThirdPoint.current = state.alignmentThirdPoint;
    }
  }, [state.alignmentTool, state.alignmentPoint, state.alignmentSecondPoint, state.alignmentThirdPoint, picked, anchorPoint, anchorMarker, size, readyPlane, flooring]);
  useEffect(() => {
    if (!readyPlane) { planeAnchor.current = null; return; }
    if (!popup.current || !anchorMarker && !planeAnchor.current) return;
    const changed = planeAnchor.current?.point !== state.alignmentThirdPoint;
    if (changed) {
      if (!anchorMarker) return;
      planeAnchor.current = { point: state.alignmentThirdPoint, marker: anchorMarker };
    }
    let initialPlacement = changed;
    const place = () => {
      if (!popup.current || !planeAnchor.current) return;
      const acceptedAnchor = planeAnchor.current.marker;
      const bounds = popup.current.getBoundingClientRect(), scale = UI_SIZES.find(info => info.size === size)!.panelScale;
      const obstacles: AlignmentPopupBox[] = Array.from(document.querySelectorAll<HTMLElement>('.tools-panel, .toolbar-group'))
        .filter(element => !element.closest('.chrome-hidden') && window.getComputedStyle(element).visibility !== 'hidden')
        .map(element => element.getBoundingClientRect()).filter(rect => rect.width > 0 && rect.height > 0);
      const points = [...(normalProjection?.shaft ?? []), ...(normalProjection?.head ?? [])];
      if (points.length) {
        const stroke = 1.5 * scale, left = Math.min(...points.map(point => point[0])), top = Math.min(...points.map(point => point[1]));
        obstacles.push({ x: left - stroke, y: top - stroke,
          width: Math.max(...points.map(point => point[0])) - left + stroke * 2,
          height: Math.max(...points.map(point => point[1])) - top + stroke * 2 });
      }
      const resetPosition = initialPlacement; initialPlacement = false;
      setAt(previous => {
        const next = placeAlignmentPlanePopup(acceptedAnchor, bounds,
          { width: window.innerWidth, height: window.innerHeight }, obstacles, scale, resetPosition ? undefined : previous);
        return next.left === previous.left && next.top === previous.top ? previous : next;
      });
      lastPoint.current = state.alignmentPoint; lastSecondPoint.current = state.alignmentSecondPoint; lastThirdPoint.current = state.alignmentThirdPoint;
    };
    place(); window.addEventListener('resize', place); return () => window.removeEventListener('resize', place);
  }, [readyPlane, state.alignmentPoint, state.alignmentSecondPoint, state.alignmentThirdPoint, state.alignmentFlip,
    state.toolsOpen, state.mode, anchorMarker, normalProjection, size]);
  useEffect(() => {
    if (!flooring) { floorAnchor.current = null; return; }
    if (!popup.current) return;
    const initial = !floorAnchor.current;
    let firstPlacement = initial;
    const place = () => {
      if (!popup.current) return;
      const scale = UI_SIZES.find(info => info.size === size)!.panelScale;
      const row = document.querySelector('.alignment-controls'), bounds = row?.getBoundingClientRect();
      const tools = row?.closest('.tools-panel')?.getBoundingClientRect();
      // Leave the Tools padding and the normal's stroke gap outside the web
      // popup. Reobserve the menu row after resize/profile/layout changes.
      floorAnchor.current = bounds ? [tools ? tools.left - 12 * scale : bounds.left, bounds.bottom] : [18, 48];
      const obstacles: AlignmentPopupBox[] = Array.from(document.querySelectorAll<HTMLElement>('.tools-panel, .toolbar-group'))
        .filter(element => !element.closest('.chrome-hidden') && window.getComputedStyle(element).visibility !== 'hidden')
        .map(element => element.getBoundingClientRect()).filter(rect => rect.width > 0 && rect.height > 0);
      const points = [...(normalProjection?.shaft ?? []), ...(normalProjection?.head ?? [])];
      if (points.length) {
        const stroke = 1.5 * scale, x = Math.min(...points.map(point => point[0])), y = Math.min(...points.map(point => point[1]));
        obstacles.push({ x: x - stroke, y: y - stroke, width: Math.max(...points.map(point => point[0])) - x + stroke * 2,
          height: Math.max(...points.map(point => point[1])) - y + stroke * 2 });
      }
      const reset = firstPlacement; firstPlacement = false;
      setAt(previous => {
        const next = placeAlignmentPlanePopup(floorAnchor.current!, popup.current!.getBoundingClientRect(),
          { width: window.innerWidth, height: window.innerHeight }, obstacles, scale, reset ? undefined : previous);
        return next.left === previous.left && next.top === previous.top ? previous : next;
      });
    };
    place(); window.addEventListener('resize', place);
    const resize = new ResizeObserver(place), row = document.querySelector('.alignment-controls');
    if (row) { resize.observe(row); const tools = row.closest('.tools-panel'); if (tools) resize.observe(tools); }
    return () => { window.removeEventListener('resize', place); resize.disconnect(); };
  }, [flooring, floor?.phase, floor?.candidate, state.alignmentFlip, state.toolsOpen, state.mode, normalProjection, size]);
  useEffect(() => {
    if (!state.alignmentTool) return;
    if (readyPlane || flooring) return;
    const clamp = () => {
      const bounds = popup.current?.getBoundingClientRect();
      if (bounds) setAt(previous => ({ left: Math.max(12, Math.min(previous.left, window.innerWidth - bounds.width - 12)),
        top: Math.max(12, Math.min(previous.top, window.innerHeight - bounds.height - 12)) }));
    };
    clamp(); window.addEventListener('resize', clamp); return () => window.removeEventListener('resize', clamp);
  }, [state.alignmentTool, picked, secondPicked, thirdPicked, size, readyPlane, flooring]);
  if (!state.alignmentTool) return null;
  const focusScene = () => scene.current?.focus({ preventScroll: true });
  if (flooring) {
    const candidate = floor?.phase === 'candidate' && floor.candidate?.status === 'ready';
    const failed = floor?.phase === 'failed', cancelling = floor?.phase === 'cancelling';
    const confirming = candidate && state.busy;
    const retryEnabled = failed && floorControlsVisible() && controller.floorDetectionEnabled;
    return <>
      {candidate && <svg className="alignment-marker alignment-floor-overlay" aria-hidden="true">
        {floorGrid.map((edge, index) => edge && <line key={index} className="alignment-floor-grid"
          x1={edge[0][0]} y1={edge[0][1]} x2={edge[1][0]} y2={edge[1][1]} />)}
        {normalProjection?.shaft && <line className="alignment-normal" x1={normalProjection.shaft[0][0]} y1={normalProjection.shaft[0][1]}
          x2={normalProjection.shaft[1][0]} y2={normalProjection.shaft[1][1]} />}
        {normalProjection?.head && <polygon className="alignment-normal-head" points={normalProjection.head.map(point => point.join(',')).join(' ')} />}
      </svg>}
      <div ref={popup} className="alignment-popup alignment-floor panel" style={at} role="region" aria-label={t('Alignment action')} data-alignment-controls
        onKeyDown={event => {
          if (event.key !== 'Enter' || !(event.target instanceof HTMLButtonElement)) {
            if (handleAlignmentKey(event, controller)) event.stopPropagation();
          } else event.stopPropagation();
        }}>
        <div className="section-heading"><h2>{t('Level floor')}</h2></div>
        {!candidate && !failed && <><div className="alignment-floor-status" role="status">{t(cancelling ? 'Cancelling floor detection...' : 'Detecting floor... | Esc cancel')}</div>
          <progress aria-label={t('Floor detection progress')} max="1" value={Math.max(0, Math.min(1, floor?.progress ?? 0))} /></>}
        {failed && <p role="status">{t(floor?.message ?? 'No stable plane found. Clear the selection, or select a wider floor region and retry.')}</p>}
        {candidate && <><small>{t('Whole scene')}</small>{floor.candidate?.selectedOnly && <small>{t('Detected from selected points')}</small>}</>}
        <div className="alignment-confirm-actions">
          {candidate && <button type="button" className={`icon-button small alignment-flip${state.alignmentFlip ? ' active' : ''}`}
            aria-label={t('Flip normal')} title={t('Flip normal')} aria-pressed={state.alignmentFlip} disabled={!alignmentConfirmationReady(controller)}
            onClick={() => controller.setAlignmentFlip(!useApp.getState().alignmentFlip)}
            onKeyDown={event => { if (event.key === 'Enter' && handleAlignmentKey(event, controller)) event.stopPropagation(); }}><Icon name="FlipUp" /></button>}
          {failed ? <button type="button" className="alignment-retry" title={t('Re-detect floor')} disabled={!retryEnabled}
            onClick={() => { void controller.startFloorDetection().then(accepted => { if (accepted) focusScene(); }); }}><Icon name="Reset" />{t('Re-detect floor')}</button> :
            <button type="button" className="alignment-confirm" title={t('Level floor (Enter)')} aria-keyshortcuts={candidate ? 'Enter' : undefined}
              disabled={!alignmentConfirmationReady(controller)} onClick={() => { void controller.confirmAlignment().then(accepted => { if (accepted) focusScene(); }); }}><Icon name="Check" />{t('Level floor')}</button>}
          <button type="button" className="icon-button small" aria-label={t('Cancel alignment')} title={t('Cancel (Esc)')} aria-keyshortcuts="Escape"
            disabled={!floorCancellationEnabled() || confirming} onClick={() => { controller.cancelAlignment(); focusScene(); }}><Icon name="Cancel" /></button>
        </div>
        <p className="alignment-navigation-hint">{t('Drag to orbit · Right drag to pan')}</p>
      </div>
    </>;
  }
  const action = aligning ? 'Align plane' : scaling ? 'Set scale' : 'Set center';
  return <>
    {picked && (marker || secondMarker || thirdMarker || segment || triangleSegments.some(Boolean) || normalProjection) && <svg className="alignment-marker" aria-hidden="true">
      {secondPicked && segment && <line className="alignment-segment" x1={segment[0][0]} y1={segment[0][1]} x2={segment[1][0]} y2={segment[1][1]} />}
      {thirdPicked && triangleSegments.map((edge, index) => edge && <line key={index} className="alignment-segment alignment-triangle-edge"
        x1={edge[0][0]} y1={edge[0][1]} x2={edge[1][0]} y2={edge[1][1]} />)}
      {thirdPicked && state.alignmentNormal && normalProjection?.shaft && <line className="alignment-normal" x1={normalProjection.shaft[0][0]} y1={normalProjection.shaft[0][1]}
        x2={normalProjection.shaft[1][0]} y2={normalProjection.shaft[1][1]} />}
      {thirdPicked && state.alignmentNormal && normalProjection?.head && <polygon className="alignment-normal-head" points={normalProjection.head.map(point => point.join(',')).join(' ')} />}
      {marker && <><circle cx={marker[0]} cy={marker[1]} r="4" /><circle className="alignment-marker-ring" cx={marker[0]} cy={marker[1]} r="5.5" /><text x={marker[0] + 8} y={marker[1] - 8}>1</text></>}
      {secondPicked && secondMarker && <><circle cx={secondMarker[0]} cy={secondMarker[1]} r="4" /><circle className="alignment-marker-ring" cx={secondMarker[0]} cy={secondMarker[1]} r="5.5" /><text x={secondMarker[0] + 8} y={secondMarker[1] - 8}>2</text></>}
      {thirdPicked && thirdMarker && <><circle cx={thirdMarker[0]} cy={thirdMarker[1]} r="4" /><circle className="alignment-marker-ring" cx={thirdMarker[0]} cy={thirdMarker[1]} r="5.5" /><text x={thirdMarker[0] + 8} y={thirdMarker[1] - 8}>3</text></>}
    </svg>}
    {scaling && measured !== null && distanceMarker && <div className="alignment-distance-caption" aria-hidden="true" style={{ left: distanceMarker[0] + 10, top: distanceMarker[1] + 10 }}>{t('Distance: %s m', distanceText(measured))}</div>}
    <div ref={popup} className={`alignment-popup panel${aligning ? ' alignment-plane' : scaling ? ' alignment-scale' : ''}`} style={at} role="region" aria-label={t('Alignment action')} data-alignment-controls
      onKeyDown={event => { if (event.key !== 'Enter' || !(event.target instanceof HTMLButtonElement)) {
        if (handleAlignmentKey(event, controller)) event.stopPropagation();
      } else event.stopPropagation(); }}>
      <div className="section-heading"><h2>{t(aligning ? '3-point align' : scaling ? '2-point scale' : '1-point center')}</h2><span className="grow" /><button type="button" className="icon-button small"
        aria-label={t('Cancel alignment')} title={t('Cancel (Esc)')} aria-keyshortcuts="Escape" onClick={() => { controller.cancelAlignment(); focusScene(); }}><Icon name="Cancel" /></button></div>
      <div className="alignment-point-status" role="status">{state.alignmentPicking ? t('Picking point…') : t('%zu / %zu points', Number(picked) + Number(secondPicked) + Number(thirdPicked), aligning ? 3 : scaling ? 2 : 1)}</div>
      {scaling ? <>{!secondPicked && <p>{t('Click two points to set their distance.')}</p>}
        {measured !== null && <output className="alignment-measured-distance" aria-label={t('Measured distance')}>{t('Distance: %s m', distanceText(measured))}</output>}
        {secondPicked && <AlignmentTargetDistance controller={controller} disabled={!enabled || state.alignmentPicking} />}</> : aligning ?
        !thirdPicked && <p>{t('Click three points on the plane to align.')}</p> : !picked && <p>{t('Click the point to move to the origin.')}</p>}
      <small>{t('Whole scene')}</small>
      <div className="alignment-confirm-actions">
        {aligning && thirdPicked && <button type="button" className={`icon-button small alignment-flip${state.alignmentFlip ? ' active' : ''}`}
          aria-label={t('Flip normal')} title={t('Flip normal')} aria-pressed={state.alignmentFlip} disabled={!enabled || state.alignmentPicking || !state.alignmentNormal}
          onClick={() => controller.setAlignmentFlip(!useApp.getState().alignmentFlip)}
          onKeyDown={event => { if (event.key === 'Enter' && handleAlignmentKey(event, controller)) event.stopPropagation(); }}><Icon name="FlipUp" /></button>}
        <button type="button" className="alignment-confirm" title={t('%s (Enter)', t(action))} aria-keyshortcuts="Enter" disabled={!alignmentConfirmationReady(controller)}
        onClick={() => { void controller.confirmAlignment().then(accepted => { if (accepted) focusScene(); }); }}><Icon name="Check" />{t(action)}</button>
        <button type="button" className="icon-button small" aria-label={t('Undo point')} title={t('Undo point (Backspace)')} aria-keyshortcuts="Backspace"
          disabled={!picked && !state.alignmentPicking} onClick={() => { controller.clearAlignmentPoint(); focusScene(); }}><Icon name="Undo" /></button></div>
      <p className="alignment-navigation-hint">{t('Middle drag to orbit · Right drag to pan')}</p>
    </div>
  </>;
}
