import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { TransformMode } from '../document/transformProtocol';
import { UI_SIZES, uiSizeStyle, useUiPreferences } from '../app/uiPreferences';
import { useTranslation } from '../app/useLanguageAppearance';
import { captureMenuScroll, type MenuScrollOwner } from './menuScroll';
import { Icon } from './Icon';
import { DecorativeChevron } from './DecorativeChevron';

// Capture02 alignment_ui.cpp:46-58. Mode chooses retained independent values.
export const TRANSFORM_MODES = Object.freeze([
  { value: 'euler', label: 'Euler XYZ (degrees)' },
  { value: 'quaternion', label: 'Quaternion (wxyz)' },
  { value: 'axis-angle', label: 'Axis + angle' },
  { value: 'matrix', label: 'Affine 4x4 matrix' },
] as const satisfies readonly { value: TransformMode; label: string }[]);

export function TransformModeMenu({ mode, enabled, onMode }: {
  mode: TransformMode; enabled: boolean; onMode(mode: TransformMode): void;
}) {
  const { t } = useTranslation();
  const preference = useUiPreferences(), size = preference.previewSize ?? preference.size;
  const selected = TRANSFORM_MODES.findIndex(choice => choice.value === mode);
  const [open, setOpen] = useState(false), [active, setActive] = useState(selected);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 0 });
  const row = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const scrollOwner = useRef<MenuScrollOwner | undefined>(undefined), id = useId();
  const pinned = useRef(false), dismissed = useRef(false), timer = useRef<number | undefined>(undefined);
  const openRef = useRef(open), activeRef = useRef(active);
  openRef.current = open; activeRef.current = active;
  const clearTimer = useCallback(() => { if (timer.current !== undefined) window.clearTimeout(timer.current); timer.current = undefined; }, []);
  const dismiss = useCallback((focus = false) => {
    clearTimer(); openRef.current = false; setOpen(false); pinned.current = false; dismissed.current = true;
    if (focus) trigger.current?.focus({ preventScroll: true });
  }, [clearTimer]);
  const show = (pin: boolean) => {
    if (!enabled || document.querySelector('[role="dialog"]')) return;
    clearTimer();
    if (openRef.current) { if (pin && pinned.current) dismiss(); else pinned.current ||= pin; return; }
    if (document.querySelector('[role="menu"]') && !menu.current) return;
    const anchor = trigger.current!, bounds = anchor.getBoundingClientRect();
    scrollOwner.current = captureMenuScroll(anchor);
    const panel = row.current!.closest('.tools-panel')?.getBoundingClientRect() ?? bounds;
    const scale = UI_SIZES.find(info => info.size === size)!.panelScale;
    const width = Math.max(1, Math.min(224 * scale, window.innerWidth - 24));
    const height = Math.min(TRANSFORM_MODES.length * 28 + 10, window.innerHeight - 24);
    let left = panel.left - width - 12, top = bounds.top;
    if (left < 12) {
      left = panel.right + 12;
      if (left + width > window.innerWidth - 12) {
        left = Math.max(12, Math.min(bounds.left, window.innerWidth - width - 12)); top = bounds.bottom + 4;
        if (top + height > window.innerHeight - 12) top = bounds.top - height - 4;
      }
    }
    setPosition({ left, top: Math.max(12, Math.min(top, window.innerHeight - height - 12)), width });
    pinned.current = pin; dismissed.current = false; openRef.current = true; activeRef.current = selected;
    setActive(selected); setOpen(true);
    if (pin) requestAnimationFrame(() => menu.current?.querySelector<HTMLButtonElement>(`[data-choice="${selected}"]`)?.focus({ preventScroll: true }));
  };
  const choose = (index: number) => {
    if (!enabled || !openRef.current) return;
    const choice = TRANSFORM_MODES[index]; if (!choice) return;
    dismiss(true); onMode(choice.value);
  };
  const hover = () => {
    clearTimer(); if (!enabled || dismissed.current || pinned.current && openRef.current) return;
    timer.current = window.setTimeout(() => { timer.current = undefined; show(false); }, 300);
  };
  const leave = () => { clearTimer(); if (!pinned.current && openRef.current) timer.current = window.setTimeout(() => dismiss(), 180); };
  const keyHandler = useRef<(event: KeyboardEvent) => void>(() => {});
  keyHandler.current = event => {
    if (!openRef.current) return;
    event.stopImmediatePropagation();
    if (event.key === 'Escape') { event.preventDefault(); dismiss(true); return; }
    if (event.key === 'Tab') { dismiss(true); return; }
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (!event.repeat) choose(activeRef.current); return; }
    const length = TRANSFORM_MODES.length;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? length - 1 : event.key === 'ArrowDown' ?
      (activeRef.current + 1) % length : event.key === 'ArrowUp' ? (activeRef.current + length - 1) % length : null;
    if (next !== null) {
      event.preventDefault(); pinned.current = true; activeRef.current = next; setActive(next);
      menu.current?.querySelector<HTMLButtonElement>(`[data-choice="${next}"]`)?.focus({ preventScroll: true });
    } else if (event.ctrlKey || event.metaKey) event.preventDefault();
  };
  useEffect(() => { if (!enabled && open) dismiss(); }, [enabled, open, dismiss]);
  useEffect(() => () => clearTimer(), [clearTimer]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!row.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) {
        event.preventDefault(); event.stopImmediatePropagation(); dismiss();
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
  return <div ref={row} className="transform-mode-control">
    <button ref={trigger} type="button" className="color-selector" aria-label={t('Transform mode')} title={t('Transform representation')}
      disabled={!enabled} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      onPointerEnter={hover} onPointerLeave={() => { dismissed.current = false; leave(); }} onClick={() => show(true)}
      onKeyDown={event => {
        if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
          event.stopPropagation(); event.preventDefault(); show(true);
        }
      }}>
      <span className="color-selector-caption">{t('Mode')}</span><span className="color-selector-value"><Icon name="Rotate" />
        <span>{t(TRANSFORM_MODES[selected].label)}</span><span className="color-chevron" aria-hidden="true"><DecorativeChevron /></span></span>
    </button>
    {open && createPortal(<div ref={menu} id={id} className="color-actions-menu transform-mode-menu" role="menu" aria-label={t('Transform modes')}
      style={{ ...uiSizeStyle(size), ...position }} onPointerEnter={clearTimer} onPointerLeave={leave}>
      {TRANSFORM_MODES.map((choice, index) => <button key={choice.value} type="button" role="menuitemradio" data-choice={index}
        tabIndex={active === index ? 0 : -1} aria-checked={choice.value === mode}
        onFocus={() => { activeRef.current = index; setActive(index); }} onPointerEnter={() => { activeRef.current = index; setActive(index); }} onClick={() => choose(index)}>
        <Icon name="Rotate" /><span>{t(choice.label)}</span><span className="grow" />{choice.value === mode && <Icon name="Check" />}
      </button>)}
    </div>, document.body)}
  </div>;
}
