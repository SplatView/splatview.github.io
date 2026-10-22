import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { captureMenuScroll, type MenuScrollOwner } from './menuScroll';
import { MenuPress } from './menuPress';
import { focusAndReveal } from './focusScroll';
import type { SelectionTool, ToolsMode } from '../app/store';
import type { SelectionFilterKind } from '../document/filterProtocol';
import { UI_SIZES, uiSizeStyle, useUiPreferences } from '../app/uiPreferences';
import { Icon } from './Icon';
import { DecorativeChevron } from './DecorativeChevron';
import { isKnownBrowserKey } from '../input/inputScope';
import { useTranslation } from '../app/useLanguageAppearance';

// Committed selection_ui.cpp: both profiles use Tool; Pro also exposes Filter.
// Opening either menu does not evaluate a filter or change the selected tool.
export const FILTER_CHOICES = Object.freeze([
  { value: 'sphere', label: 'Sphere', display: 'Sphere', icon: 'Sphere', title: 'Sphere filter' },
  { value: 'box', label: 'Box', display: 'Box', icon: 'Box', title: 'Rotated box filter' },
  { value: 'ellipsoid', label: 'Ellipsoid', display: 'Ellipsoid', icon: 'Ellipsoid', title: 'Ellipsoid filter' },
  { value: 'frustum', label: 'Frustum', display: 'Frustum', icon: 'Frustum', title: 'Camera frustum filter' },
  { value: 'opacity', label: 'Opacity filter', display: 'Opacity', icon: 'Opacity', title: 'Opacity filter' },
  { value: 'scale', label: 'Scale filter', display: 'Scale', icon: 'ScaleFilter', title: 'Splat scale filter' },
] as const satisfies readonly { value: SelectionFilterKind; label: string; display: string; icon: string; title: string }[]);
const TOOL_CHOICES = Object.freeze([
  { value: 'navigate', label: 'Navigate', icon: 'Orbit', title: 'Navigate (Esc)' },
  { value: 'single', label: 'Single splat', icon: 'Pointer', title: 'Pick the strongest contributor at the clicked pixel' },
  { value: 'brush', label: 'Brush', icon: 'Brush', title: 'Brush (B)\nPaint, then release to select\nAlt + scroll to change size' },
  { value: 'volume', label: 'Volume brush', icon: 'Volume', title: 'Volume brush (Shift+B)\nPaint a sphere along the rendered surface' },
  { value: 'rectangle', label: 'Box select', icon: 'Select', title: 'Box select (X)\nDrag a rectangle' },
  { value: 'polygon', label: 'Polygon', icon: 'Polygon', title: 'Polygon (P)\nClick points or drag a contour' },
  { value: 'color', label: 'Color picker', icon: 'Eyedropper', title: 'Color picker\nClick a splat to select similar colors' },
  { value: 'fill', label: 'Fill', icon: 'Fill', title: 'Fill (G)\nClick a patch to select its connected area in the current view' },
] as const);
const TOOL_SHORTCUTS: Readonly<Record<string, string>> = Object.freeze({
  navigate: 'Escape', brush: 'B', volume: 'Shift+B', rectangle: 'X', polygon: 'P', color: 'Control+E', fill: 'G',
});
type MenuKind = 'tool' | 'filter';

export function SelectionMenus({ tool, filter, enabled, mode = 'pro', onTool, onFilter, onInputScopeChange }: {
  tool: SelectionTool | null; filter: SelectionFilterKind | null; enabled: boolean; mode?: ToolsMode;
  onTool(tool: SelectionTool | null): void; onFilter(kind: SelectionFilterKind): void;
  onInputScopeChange?(owner: string, open: boolean): void;
}) {
  const { t } = useTranslation();
  const preference = useUiPreferences(), size = preference.previewSize ?? preference.size;
  const [open, setOpen] = useState<MenuKind | null>(null), [active, setActive] = useState(0);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 0 });
  const row = useRef<HTMLDivElement>(null), menu = useRef<HTMLDivElement>(null);
  const scrollOwner = useRef<MenuScrollOwner | undefined>(undefined);
  const outsidePress = useRef(new MenuPress());
  const toolButton = useRef<HTMLButtonElement>(null), filterButton = useRef<HTMLButtonElement>(null);
  const pinned = useRef(false), timer = useRef<number | undefined>(undefined), openRef = useRef<MenuKind | null>(null), activeRef = useRef(0);
  const dismissed = useRef<MenuKind | null>(null), id = useId();
  const scopeId = `selection-menu:${id}`, scopeCallback = useRef(onInputScopeChange); scopeCallback.current = onInputScopeChange;
  useEffect(() => () => scopeCallback.current?.(scopeId, false), [scopeId]);
  openRef.current = open; activeRef.current = active;
  const toolChoice = TOOL_CHOICES.find(choice => choice.value === (tool ?? 'navigate'))!;
  const filterChoice = FILTER_CHOICES.find(choice => choice.value === filter);
  const clearTimer = useCallback(() => { if (timer.current !== undefined) window.clearTimeout(timer.current); timer.current = undefined; }, []);
  const dismiss = useCallback((focus = false) => {
    clearTimer(); const kind = openRef.current;
    // Native beginIconMenu clears dismissal as soon as the pointer is outside
    // the selector. A choice in the portal must allow the next genuine hover.
    dismissed.current = kind && (kind === 'tool' ? toolButton : filterButton).current?.matches(':hover') ? kind : null;
    openRef.current = null; scopeCallback.current?.(scopeId, false); setOpen(null); pinned.current = false;
    if (focus) focusAndReveal((kind === 'tool' ? toolButton : filterButton).current);
  }, [clearTimer, scopeId]);
  const show = (kind: MenuKind, pin: boolean) => {
    if (!enabled || kind === 'filter' && mode === 'basic' || document.querySelector('[role="dialog"]')) return;
    clearTimer();
    if (openRef.current === kind) { if (pin && pinned.current) dismiss(); else pinned.current ||= pin; return; }
    if (document.querySelector('[role="menu"]') && !menu.current) return;
    const trigger = (kind === 'tool' ? toolButton : filterButton).current;
    if (!trigger) return;
    const bounds = trigger.getBoundingClientRect();
    scrollOwner.current = captureMenuScroll(trigger);
    const panel = row.current!.closest('.tools-panel')?.getBoundingClientRect() ?? bounds;
    const scale = UI_SIZES.find(info => info.size === size)!.panelScale;
    const width = Math.max(1, Math.min(224 * scale, window.innerWidth - 24));
    const height = Math.min((kind === 'tool' ? TOOL_CHOICES.length : FILTER_CHOICES.length) * 28 + 10, window.innerHeight - 24);
    let left = panel.left - width - 12, top = bounds.top;
    if (left < 12) {
      left = panel.right + 12;
      if (left + width > window.innerWidth - 12) {
        left = Math.max(12, Math.min(bounds.left, window.innerWidth - width - 12)); top = bounds.bottom + 4;
        if (top + height > window.innerHeight - 12) top = bounds.top - height - 4;
      }
    }
    const index = kind === 'tool' ? TOOL_CHOICES.findIndex(choice => choice.value === (tool ?? 'navigate')) :
      Math.max(0, FILTER_CHOICES.findIndex(choice => choice.value === filter));
    setPosition({ left, top: Math.max(12, Math.min(top, window.innerHeight - height - 12)), width });
    pinned.current = pin; dismissed.current = null; openRef.current = kind; activeRef.current = index;
    scopeCallback.current?.(scopeId, true); setActive(index); setOpen(kind);
    if (pin) requestAnimationFrame(() => focusAndReveal(menu.current?.querySelector<HTMLButtonElement>(`[data-choice="${index}"]`), menu.current));
  };
  const choose = (index: number) => {
    if (!enabled || openRef.current === null) return;
    const kind = openRef.current; dismiss(true);
    if (kind === 'tool') { const choice = TOOL_CHOICES[index]; if (choice) onTool(choice.value === 'navigate' ? null : choice.value); }
    else { const choice = FILTER_CHOICES[index]; if (choice) onFilter(choice.value); }
  };
  const hover = (kind: MenuKind) => {
    clearTimer(); if (dismissed.current === kind || !enabled || pinned.current && openRef.current === kind) return;
    timer.current = window.setTimeout(() => { timer.current = undefined; show(kind, false); }, 300);
  };
  const leave = () => { clearTimer(); if (!pinned.current && openRef.current) timer.current = window.setTimeout(() => dismiss(), 180); };
  const keyHandler = useRef<(event: KeyboardEvent) => void>(() => {});
  keyHandler.current = event => {
    if (!openRef.current) return;
    event.stopImmediatePropagation();
    if (event.key !== 'Tab' && isKnownBrowserKey(event) ||
        (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') return;
    if (event.key === 'Escape') { event.preventDefault(); dismiss(true); return; }
    if (event.key === 'Tab') { dismiss(true); return; }
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (!event.repeat) choose(activeRef.current); return; }
    const length = openRef.current === 'tool' ? TOOL_CHOICES.length : FILTER_CHOICES.length;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? length - 1 : event.key === 'ArrowDown' ?
      (activeRef.current + 1) % length : event.key === 'ArrowUp' ? (activeRef.current + length - 1) % length : null;
    if (next !== null) {
      event.preventDefault(); pinned.current = true; activeRef.current = next; setActive(next);
      focusAndReveal(menu.current?.querySelector<HTMLButtonElement>(`[data-choice="${next}"]`), menu.current);
    } else if (event.ctrlKey || event.metaKey) event.preventDefault();
  };
  useEffect(() => { if (!enabled && open) dismiss(); }, [enabled, open, dismiss]);
  useEffect(() => {
    clearTimer();
    if (mode === 'basic' && openRef.current === 'filter') dismiss();
  }, [mode, clearTimer, dismiss]);
  useEffect(() => () => clearTimer(), [clearTimer]);
  useEffect(() => {
    // Keep activation ownership alive after pointerdown dismisses the portal.
    const reset = () => outsidePress.current.reset();
    const visibility = () => { if (document.hidden) reset(); };
    const activate = (event: MouseEvent) => {
      if (outsidePress.current.consume(event)) { event.preventDefault(); event.stopImmediatePropagation(); }
    };
    const contextKey = (event: KeyboardEvent) => outsidePress.current.keyDown(event);
    window.addEventListener('pointerdown', reset, true); window.addEventListener('pointercancel', reset, true);
    window.addEventListener('blur', reset); document.addEventListener('visibilitychange', visibility);
    window.addEventListener('keydown', contextKey, true);
    document.addEventListener('click', activate, true); document.addEventListener('contextmenu', activate, true); document.addEventListener('auxclick', activate, true);
    return () => {
      reset(); window.removeEventListener('pointerdown', reset, true); window.removeEventListener('pointercancel', reset, true);
      window.removeEventListener('blur', reset); document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('keydown', contextKey, true);
      document.removeEventListener('click', activate, true); document.removeEventListener('contextmenu', activate, true); document.removeEventListener('auxclick', activate, true);
    };
  }, []);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!row.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) {
        outsidePress.current.arm(event); event.preventDefault(); event.stopImmediatePropagation(); dismiss();
      }
    };
    const key = (event: KeyboardEvent) => keyHandler.current(event), release = (event: KeyboardEvent) => event.stopImmediatePropagation();
    const retire = () => dismiss(), scroll = (event: Event) => { if (scrollOwner.current?.shouldDismiss(event.target, menu.current) ?? true) dismiss(); };
    document.addEventListener('pointerdown', outside, true); window.addEventListener('keydown', key, true); window.addEventListener('keyup', release, true);
    window.addEventListener('resize', retire); window.addEventListener('blur', retire); window.addEventListener('scroll', scroll, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true); window.removeEventListener('keydown', key, true); window.removeEventListener('keyup', release, true);
      window.removeEventListener('resize', retire); window.removeEventListener('blur', retire); window.removeEventListener('scroll', scroll, true);
    };
  }, [open, dismiss]);
  const choices = open === 'tool' ? TOOL_CHOICES : FILTER_CHOICES;
  return <div ref={row} className={`two-columns selection-menus${mode === 'basic' ? ' selection-menus-basic' : ''}`} role="group" aria-label={t('Selection controls')}>
    {(mode === 'basic' ? ['tool'] as const : ['tool', 'filter'] as const).map(kind => <button key={kind} ref={kind === 'tool' ? toolButton : filterButton} type="button"
      data-tutorial-target={kind === 'filter' ? 'filter' : 'single brushes area color-select fill'} className={`color-selector ${(kind === 'tool' ? !!tool : !!filter) ? 'active' : ''}`} aria-label={t(kind === 'tool' ? 'Selection tool' : 'Selection filter')}
      disabled={!enabled} aria-haspopup="menu" aria-expanded={open === kind} aria-controls={open === kind ? id : undefined}
      onPointerEnter={() => hover(kind)} onPointerLeave={() => { dismissed.current = null; leave(); }} onClick={() => show(kind, true)}
      onKeyDown={event => {
        if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
          event.stopPropagation(); event.preventDefault(); show(kind, true);
        }
      }}>
      <span className="color-selector-caption">{t(kind === 'tool' ? 'Tool' : 'Filter')}</span>
      <span className="color-selector-value"><Icon name={kind === 'tool' ? toolChoice.icon : filterChoice?.icon ?? 'Cancel'} />
        <span>{t(kind === 'tool' ? toolChoice.label : filterChoice?.display ?? 'Off')}</span><span className="color-chevron" aria-hidden="true"><DecorativeChevron /></span></span>
    </button>)}
    {open && createPortal(<div ref={menu} id={id} className="color-actions-menu selection-menu" role="menu" aria-label={t(open === 'tool' ? 'Selection tools' : 'Selection filters')}
      style={{ ...uiSizeStyle(size), ...position }} onPointerEnter={clearTimer} onPointerLeave={leave}>
      {choices.map((choice, index) => <button key={choice.value} type="button" role="menuitemradio" data-choice={index} tabIndex={active === index ? 0 : -1}
        aria-checked={open === 'tool' ? choice.value === (tool ?? 'navigate') && !filter : choice.value === filter} title={t(choice.title)}
        aria-keyshortcuts={open === 'tool' ? choice.value === 'color' && /Mac|iPhone|iPad/.test(navigator.platform) ? 'Meta+E' : TOOL_SHORTCUTS[choice.value] : undefined}
        onFocus={() => { activeRef.current = index; setActive(index); }} onPointerEnter={() => { activeRef.current = index; setActive(index); }} onClick={() => choose(index)}>
        <Icon name={choice.icon} /><span>{t(choice.label)}</span><span className="grow" />
        {(open === 'tool' ? choice.value === (tool ?? 'navigate') && !filter : choice.value === filter) && <Icon name="Check" />}
      </button>)}
    </div>, document.body)}
  </div>;
}
