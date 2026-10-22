import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { Icon } from './Icon';
import { useTranslation } from '../app/useLanguageAppearance';

type Point = readonly [number, number];
// The manual tracker lives for the current source, including while a filter
// owns selection. Its remount clears this display-only release anchor; a
// filter's paused draft restart can then retain the same canvas placement.
const releaseAnchors = new WeakMap<HTMLCanvasElement, Point>();
const transformReleaseAnchors = new WeakMap<HTMLCanvasElement, Point>();
export type SelectionActionObstacle = { left: number; top: number; width: number; height: number };
/** Desktop 1.0.2 ui_widgets.hpp:100-150 and ui_design.hpp:15-16.
 * Three 30x28 buttons never cover their release or another visible control. */
export function placeSelectionActions(anchor: Point, viewport: { width: number; height: number }, obstacles: readonly SelectionActionObstacle[], scale: number) {
  const width = 90 * scale, height = 28 * scale, inset = 12 * scale, offset = 12 * scale, gap = 4 * scale;
  if (viewport.width < width + 2 * inset || viewport.height < height + 2 * inset) return null;
  const clamp = (left: number, top: number) => ({
    left: Math.max(inset, Math.min(left, viewport.width - inset - width)),
    top: Math.max(inset, Math.min(top, viewport.height - inset - height)),
  });
  const available = ({ left, top }: { left: number; top: number }) =>
    !(anchor[0] >= left && anchor[0] < left + width && anchor[1] >= top && anchor[1] < top + height) &&
    obstacles.every(box => left + width <= box.left - gap || left >= box.left + box.width + gap ||
      top + height <= box.top - gap || top >= box.top + box.height + gap);
  for (const [x, y] of [[anchor[0] + offset, anchor[1] + offset], [anchor[0] - offset - width, anchor[1] + offset],
    [anchor[0] + offset, anchor[1] - offset - height], [anchor[0] - offset - width, anchor[1] - offset - height]]) {
    const at = clamp(x, y); if (available(at)) return at;
  }
  let nearest: { left: number; top: number } | null = null, distance = Infinity;
  for (const box of obstacles) for (const [x, y] of [[box.left - gap - width, anchor[1] + offset],
    [box.left + box.width + gap, anchor[1] + offset], [anchor[0] + offset, box.top - gap - height],
    [anchor[0] + offset, box.top + box.height + gap]]) {
    const at = clamp(x, y), next = Math.hypot(at.left - anchor[0], at.top - anchor[1]);
    if (next < distance && available(at)) { nearest = at; distance = next; }
  }
  return nearest;
}

type FloatingActionsBase = {
  scene: RefObject<HTMLCanvasElement | null>; enabled: boolean; chromeVisible: boolean;
  captured?: boolean; scale: number; finishEnabled: boolean; undoEnabled: boolean;
  onFinish(): void; onUndo(): void;
};
export type FloatingSelectionActionsProps = FloatingActionsBase & {
  kind: 'manual' | 'filter'; clearEnabled: boolean; onClear(): void;
};
export type FloatingTransformActionsProps = FloatingActionsBase & {
  kind: 'transform'; cancelEnabled: boolean; onCancel(): void;
};
type SelectionButtonsBase = Pick<FloatingActionsBase, 'finishEnabled' | 'undoEnabled' | 'onFinish' | 'onUndo'>;
type SelectionButtonsProps = SelectionButtonsBase & (
  { kind: 'manual' | 'filter'; clearEnabled: boolean; onClear(): void } |
  { kind: 'transform'; cancelEnabled: boolean; onCancel(): void });
/** Pure shared desktop button presentation; no release anchor or scene owner. */
export function selectionActionButtons(props: SelectionButtonsProps, t: (key: string) => string) {
  const transform = props.kind === 'transform';
  const prefix = transform ? 'transform-gizmo' : props.kind === 'manual' ? 'manual-selection' : 'filter';
  const finish = transform ? 'Finish transform tool (Enter)' : props.kind === 'manual' ? 'Finalize selection' : 'Confirm filter';
  const finishTip = transform ? finish : props.kind === 'manual' ? 'Finish selection tool (keeps selection)' : 'Confirm filter (Enter)';
  const undo = transform ? t('Undo transform') : `${t('Undo')} (${t(props.kind === 'manual' ? 'Selection' : 'Filter')})`;
  const last = transform ? 'Cancel transforms (Esc)' : 'Clear selection (C)';
  const lastEnabled = props.kind === 'transform' ? props.cancelEnabled : props.clearEnabled;
  const onLast = props.kind === 'transform' ? props.onCancel : props.onClear;
  return <>
    <button type="button" className={`icon-button selection-floating-confirm ${prefix}-confirm`}
      aria-label={t(finish)} title={t(finishTip)}
      disabled={!props.finishEnabled} onClick={event => { event.stopPropagation(); props.onFinish(); }}><Icon name="Check" /></button>
    <button type="button" className="icon-button selection-floating-undo" aria-label={undo} title={t(transform ? 'Undo transform' : 'Undo')}
      disabled={!props.undoEnabled} onClick={event => { event.stopPropagation(); props.onUndo(); }}><Icon name="Undo" /></button>
    <button type="button" className={`icon-button selection-floating-clear ${prefix}-${transform ? 'cancel' : 'clear'}`} aria-label={t(last)} title={t(last)}
      disabled={!lastEnabled} onClick={event => { event.stopPropagation(); onLast(); }}><Icon name="Cancel" /></button>
  </>;
}
const tutorialNoAction = () => undefined;
/** Pinned app_ui_tutorial.cpp:268-306 uses disabled selection action examples.
 * This view never mounts the real tray's pointer/anchor bookkeeping. */
export function TutorialSelectionActions({ rootRef, scale, inline = false }: { rootRef?: RefObject<HTMLDivElement | null>; scale: number; inline?: boolean }) {
  const { t } = useTranslation();
  return <div ref={rootRef} className={`selection-segments floating-selection-actions tutorial-selection-actions${inline ? ' tutorial-selection-actions-inline' : ''}`}
    data-tutorial-target="selection-finish" data-tutorial-demo="selection-finish" data-tutorial-inline={inline || undefined} aria-hidden="true" inert
    style={{ '--selection-action-scale': scale } as CSSProperties}>
    {selectionActionButtons({ kind: 'manual', finishEnabled: false, undoEnabled: false, clearEnabled: false,
      onFinish: tutorialNoAction, onUndo: tutorialNoAction, onClear: tutorialNoAction }, t)}
  </div>;
}
/** Call only after the shared input ledger admits scene/gesture ownership.
 * Text fields, browser shortcuts and UI focus therefore keep their keys. */
export function handleFloatingSelectionKey(event: Pick<KeyboardEvent, 'key' | 'repeat' | 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey' | 'isComposing' | 'defaultPrevented' | 'preventDefault'>,
  primary: boolean, actions: { onUndo(): void; onClear(): void }): boolean {
  if (event.defaultPrevented || event.isComposing || event.altKey) return false;
  const key = event.key.toLowerCase(), undo = primary && !event.shiftKey && key === 'z';
  const clear = !primary && !event.ctrlKey && !event.metaKey && key === 'c';
  if (!undo && !clear) return false;
  event.preventDefault();
  if (!event.repeat) { if (undo) actions.onUndo(); else actions.onClear(); }
  return true;
}
/** Shared selection_ui.cpp:543-621 presentation. Painting is coalesced only
 * after real input/layout/state changes; no idle animation or native work. */
export function FloatingSelectionActions(props: FloatingSelectionActionsProps | FloatingTransformActionsProps) {
  const { t } = useTranslation(), latest = useRef(props); latest.current = props;
  const root = useRef<HTMLDivElement>(null), refresh = useRef<() => void>(() => undefined);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    const canvas = props.scene.current; if (!canvas) return;
    let scheduled = 0, buttons = 0;
    const anchors = props.kind === 'transform' ? transformReleaseAnchors : releaseAnchors;
    if (props.kind === 'manual') releaseAnchors.delete(canvas);
    if (props.kind === 'transform') transformReleaseAnchors.delete(canvas);
    const paint = () => {
      scheduled = 0;
      const current = latest.current, bounds = canvas.getBoundingClientRect();
      const popup = !!document.querySelector('[role="menu"], [role="dialog"], .alignment-popup');
      if (!current.enabled || !current.chromeVisible || current.captured || buttons || document.hidden || popup || bounds.width <= 0 || bounds.height <= 0) {
        setAt(previous => previous === null ? previous : null); return;
      }
      const obstacles = Array.from(canvas.parentElement?.querySelectorAll<HTMLElement>(
        '.toolbar,.tools-panel,.collection-arrow,.status,.error-banner,.output-receipt,.brand-link,.offline-update-notice') ?? [])
        .filter(element => element.getClientRects().length > 0 && !element.closest('[hidden],[inert],[aria-hidden="true"]'))
        .map(element => { const box = element.getBoundingClientRect(); return { left: box.left - bounds.left, top: box.top - bounds.top, width: box.width, height: box.height }; });
      const release = anchors.get(canvas) ?? [bounds.width * .45, bounds.height - 72 * current.scale];
      const next = placeSelectionActions(release, bounds, obstacles, current.scale);
      setAt(previous => previous?.left === next?.left && previous?.top === next?.top ? previous : next);
    };
    const schedule = () => { if (!scheduled) scheduled = requestAnimationFrame(paint); };
    refresh.current = schedule;
    const pointer = (event: PointerEvent) => {
      const bit = 1 << event.button;
      if (event.type === 'pointerdown' && event.target === canvas) buttons |= bit;
      else if (event.type === 'pointerup') {
        if (buttons & bit) { const bounds = canvas.getBoundingClientRect(); anchors.set(canvas, [event.clientX - bounds.left, event.clientY - bounds.top]); }
        buttons &= ~bit;
      } else if (event.type === 'pointercancel') buttons = 0;
      schedule();
    };
    const clearCapture = () => { buttons = 0; schedule(); };
    const mutation = new MutationObserver(records => {
      if (records.some(record => !root.current?.contains(record.target))) schedule();
    });
    mutation.observe(canvas.parentElement!, { subtree: true, childList: true, attributes: true,
      attributeFilter: ['class', 'hidden', 'inert', 'aria-hidden', 'open', 'role'] });
    const resize = new ResizeObserver(schedule); resize.observe(canvas);
    if (canvas.parentElement) resize.observe(canvas.parentElement);
    for (const element of canvas.parentElement?.querySelectorAll<HTMLElement>('.toolbar,.tools-panel') ?? []) resize.observe(element);
    for (const name of ['pointerdown', 'pointerup', 'pointercancel'] as const) window.addEventListener(name, pointer, true);
    canvas.addEventListener('lostpointercapture', clearCapture); window.addEventListener('blur', clearCapture);
    window.addEventListener('resize', schedule); window.addEventListener('scroll', schedule, true);
    window.addEventListener('keydown', schedule); window.addEventListener('keyup', schedule);
    document.addEventListener('focusin', schedule); document.addEventListener('focusout', schedule);
    document.addEventListener('visibilitychange', clearCapture); schedule();
    return () => {
      refresh.current = () => undefined; if (scheduled) cancelAnimationFrame(scheduled);
      for (const name of ['pointerdown', 'pointerup', 'pointercancel'] as const) window.removeEventListener(name, pointer, true);
      canvas.removeEventListener('lostpointercapture', clearCapture); window.removeEventListener('blur', clearCapture);
      window.removeEventListener('resize', schedule); window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('keydown', schedule); window.removeEventListener('keyup', schedule);
      document.removeEventListener('focusin', schedule); document.removeEventListener('focusout', schedule);
      document.removeEventListener('visibilitychange', clearCapture); mutation.disconnect(); resize.disconnect();
    };
  }, [props.scene, props.kind]);
  useEffect(() => refresh.current(), [props]);
  const transform = props.kind === 'transform';
  const prefix = transform ? 'transform-gizmo' : props.kind === 'manual' ? 'manual-selection' : 'filter';
  return <div ref={root} className={`selection-segments floating-selection-actions ${prefix}-finish`} role="group"
    aria-label={t(transform ? 'Transform gizmo' : props.kind === 'manual' ? 'Selection' : 'Filter preview actions')} data-chrome inert={!props.chromeVisible} aria-hidden={!props.chromeVisible || undefined} hidden={!at || !props.enabled || !props.chromeVisible || !!props.captured}
    style={{ ...at, '--selection-action-scale': props.scale } as CSSProperties}
    onPointerDown={event => event.stopPropagation()} onPointerUp={event => event.stopPropagation()}
    onMouseDown={event => event.stopPropagation()} onMouseUp={event => event.stopPropagation()}
    onKeyDown={event => event.stopPropagation()} onKeyUp={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}>
    {selectionActionButtons(props, t)}
  </div>;
}
