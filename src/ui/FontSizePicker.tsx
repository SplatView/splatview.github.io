import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { captureMenuScroll, type MenuScrollOwner } from './menuScroll';
import { UI_SIZES, uiSizeStyle, useUiPreferences } from '../app/uiPreferences';
import { Icon } from './Icon';
import { DecorativeChevron } from './DecorativeChevron';
import { useTranslation } from '../app/useLanguageAppearance';

export function FontSizePicker() {
  const { t } = useTranslation();
  const preference = useUiPreferences(), displayed = preference.previewSize ?? preference.size;
  const [open, setOpen] = useState(false), [active, setActive] = useState(0);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 0 });
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const scrollOwner = useRef<MenuScrollOwner | undefined>(undefined);
  const keyboard = useRef(false), suspended = useRef(false), menuId = useId();
  const dismiss = useCallback((restoreFocus = false) => {
    setOpen(false); preference.cancelPreview();
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  }, [preference.cancelPreview]);
  const show = (navigation: boolean) => {
    const anchor = trigger.current!, bounds = anchor.getBoundingClientRect();
    scrollOwner.current = captureMenuScroll(anchor);
    // Retain the menu anchor while its preview resizes the surrounding panels.
    // Otherwise a centered Settings dialog can move a hovered item away.
    const height = Math.min(UI_SIZES.length * 28 + 10, window.innerHeight - 24);
    // Prefer the space above a low trigger to overlapping its click point.
    // Otherwise a stationary pointer can preview Large as the popup opens,
    // resize the scrolled Settings body and immediately dismiss its own menu.
    const below = bounds.bottom + 4, above = bounds.top - height - 4;
    const top = below + height <= window.innerHeight - 12 ? below : above >= 12 ? above :
      Math.max(12, Math.min(below, window.innerHeight - height - 12));
    setPosition({ left: Math.max(12, Math.min(bounds.left, window.innerWidth - bounds.width - 12)),
      top, width: bounds.width });
    keyboard.current = navigation;
    setActive(UI_SIZES.findIndex(info => info.size === preference.size));
    setOpen(true);
  };
  const preview = (index: number) => {
    if (!suspended.current && !document.hidden) preference.preview(UI_SIZES[index].size);
  };
  const commit = (index: number) => { preference.commit(UI_SIZES[index].size); dismiss(true); };
  useEffect(() => {
    const blur = () => { suspended.current = true; dismiss(); };
    const focus = () => { suspended.current = false; };
    const visibility = () => { if (document.hidden) blur(); };
    window.addEventListener('blur', blur); window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      window.removeEventListener('blur', blur); window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', visibility); preference.cancelPreview();
    };
  }, [dismiss, preference.cancelPreview]);
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>(`[data-size="${preference.size}"]`)?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !trigger.current?.contains(target)) dismiss();
    };
    const resized = () => dismiss();
    const scroll = (event: Event) => { if (scrollOwner.current?.shouldDismiss(event.target, menu.current) ?? true) dismiss(); };
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', resized); window.addEventListener('scroll', scroll, true);
    return () => { document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', resized); window.removeEventListener('scroll', scroll, true); };
  }, [open, dismiss, preference.size]);
  const navigate = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss(true); return; }
    if (event.key === 'Tab') { dismiss(true); return; }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault(); event.stopPropagation(); commit(active); return;
    }
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? UI_SIZES.length - 1 :
      event.key === 'ArrowDown' ? (active + 1) % UI_SIZES.length :
      event.key === 'ArrowUp' ? (active + UI_SIZES.length - 1) % UI_SIZES.length : null;
    if (next === null) return;
    event.preventDefault(); event.stopPropagation(); keyboard.current = true; setActive(next);
    menu.current?.querySelector<HTMLButtonElement>(`[data-size="${UI_SIZES[next].size}"]`)?.focus({ preventScroll: true });
  };
  const info = UI_SIZES.find(info => info.size === displayed)!;
  return <div className="font-size-setting">
    <span className="font-size-caption" title={t('Font size')}>{t('Font size')}</span>
    <button ref={trigger} className="font-size-trigger" type="button" aria-label={t('Font size')} aria-description={t('Current size: %s', t(info.name))}
      aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? menuId : undefined}
      onClick={() => open ? dismiss() : show(false)}
      onKeyDown={event => {
        if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
          event.preventDefault(); event.stopPropagation(); show(true);
        }
      }}>
      <span className="font-size-value">{t(info.name)}</span><span className="preference-chevron" aria-hidden="true"><DecorativeChevron /></span>
    </button>
    {preference.error && <p className="preference-error" role="alert">{t(preference.error)}</p>}
    {open && createPortal(<div ref={menu} id={menuId} role="listbox" aria-label={t('Font size choices')} className="ui-size-menu"
      style={{ ...uiSizeStyle(displayed), ...position }} onKeyDown={navigate}
      onPointerLeave={() => { if (!keyboard.current) preference.cancelPreview(); }}>
      {UI_SIZES.map((choice, index) => <button key={choice.size} role="option" type="button" className="ui-size-option"
        data-size={choice.size} aria-selected={preference.size === choice.size} tabIndex={active === index ? 0 : -1}
        onPointerEnter={() => { keyboard.current = false; setActive(index); preview(index); }}
        onPointerLeave={() => { if (!keyboard.current) preference.cancelPreview(); }}
        onFocus={() => { if (keyboard.current) { setActive(index); preview(index); } }} onClick={() => commit(index)}>
        <Icon name="Settings" /><span>{t(choice.name)}</span><span className="grow" />{preference.size === choice.size && <span className="preference-selected-dot" aria-hidden="true" />}
      </button>)}
    </div>, document.body)}
  </div>;
}
