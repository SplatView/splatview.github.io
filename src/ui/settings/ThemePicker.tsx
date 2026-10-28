import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { UI_THEMES, useThemePreferences } from '../../app/themePreferences';
import { uiSizeStyle, useUiPreferences } from '../../app/uiPreferences';
import { Icon } from '../Icon';
import { DecorativeChevron } from '../DecorativeChevron';
import { useTranslation } from '../../app/useLanguageAppearance';
import { captureMenuScroll, type MenuScrollOwner } from '../menuScroll';

/** Native Settings theme preview is ephemeral until a menu item is committed. */
export function ThemePicker() {
  const { t } = useTranslation();
  const preference = useThemePreferences(), displayed = preference.previewTheme ?? preference.theme;
  const size = useUiPreferences(), displayedSize = size.previewSize ?? size.size;
  const [open, setOpen] = useState(false), [active, setActive] = useState(0);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 0 });
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const scrollOwner = useRef<MenuScrollOwner | undefined>(undefined);
  const pointerPosition = useRef<{ x: number; y: number } | null>(null);
  const keyboard = useRef(false), suspended = useRef(false), returnFocus = useRef(false), menuId = useId();
  const dismiss = useCallback((restoreFocus = false) => {
    returnFocus.current = restoreFocus; setOpen(false); preference.cancelPreview();
  }, [preference.cancelPreview]);
  const show = (navigation: boolean) => {
    if (!trigger.current) return;
    const bounds = trigger.current.getBoundingClientRect();
    scrollOwner.current = captureMenuScroll(trigger.current);
    setPosition({ left: Math.max(12, Math.min(bounds.left, window.innerWidth - bounds.width - 12)),
      top: Math.max(12, Math.min(bounds.bottom + 4, window.innerHeight - 242)), width: bounds.width });
    keyboard.current = navigation; returnFocus.current = false;
    setActive(UI_THEMES.findIndex(info => info.theme === preference.theme)); setOpen(true);
  };
  const preview = (index: number) => {
    if (!suspended.current && !document.hidden) preference.preview(UI_THEMES[index].theme);
  };
  const commit = (index: number) => { preference.commit(UI_THEMES[index].theme); dismiss(true); };
  const reveal = (item: HTMLButtonElement | null | undefined) => {
    const list = menu.current;
    if (!list || !item) return;
    const viewport = list.getBoundingClientRect(), bounds = item.getBoundingClientRect();
    const top = viewport.top + list.clientTop, bottom = top + list.clientHeight;
    // Reveal only inside the portal. scrollIntoView() can also move Settings
    // ancestors and dismiss this menu through its captured scroll owner.
    if (bounds.top < top) list.scrollTop += bounds.top - top;
    else if (bounds.bottom > bottom) list.scrollTop += bounds.bottom - bottom;
  };
  useLayoutEffect(() => {
    if (open) {
      const item = menu.current?.querySelector<HTMLButtonElement>(`[data-theme="${preference.theme}"]`);
      item?.focus({ preventScroll: true }); reveal(item);
    }
    else if (returnFocus.current) { returnFocus.current = false; trigger.current?.focus({ preventScroll: true }); }
    // Only opening/closing owns focus. Hover previews must not refocus a row.
  }, [open]);
  useEffect(() => {
    const blur = () => { suspended.current = true; dismiss(); };
    const focus = () => { suspended.current = false; };
    const visibility = () => { if (document.hidden) blur(); };
    const pointerMove = (event: PointerEvent) => {
      const previous = pointerPosition.current;
      const moved = previous ? event.clientX !== previous.x || event.clientY !== previous.y :
        event.movementX !== 0 || event.movementY !== 0;
      pointerPosition.current = { x: event.clientX, y: event.clientY };
      if (!moved || !menu.current) return;
      // Scrolling a focused option into view can emit pointer-enter on a
      // different row beneath a stationary cursor. Only actual movement
      // transfers ownership away from keyboard navigation.
      keyboard.current = false;
      if (!(event.target instanceof Node) || !menu.current.contains(event.target)) preference.cancelPreview();
    };
    window.addEventListener('blur', blur); window.addEventListener('focus', focus);
    window.addEventListener('pointermove', pointerMove, true);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      window.removeEventListener('blur', blur); window.removeEventListener('focus', focus);
      window.removeEventListener('pointermove', pointerMove, true);
      document.removeEventListener('visibilitychange', visibility); preference.cancelPreview();
    };
  }, [dismiss, preference.cancelPreview]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !trigger.current?.contains(target)) dismiss();
    };
    const resized = () => dismiss();
    const scroll = (event: Event) => { if (scrollOwner.current?.shouldDismiss(event.target, menu.current) ?? true) dismiss(); };
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', resized); window.addEventListener('scroll', scroll, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', resized); window.removeEventListener('scroll', scroll, true);
    };
  }, [open, dismiss]);
  const navigate = (event: KeyboardEvent) => {
    // A focused Settings popup owns these keys, including viewport shortcuts.
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); dismiss(true); return; }
    if (event.key === 'Tab') { dismiss(true); return; }
    const focused = document.activeElement;
    const focusedTheme = focused instanceof HTMLElement && menu.current?.contains(focused) ?
      focused.closest<HTMLButtonElement>('[data-theme]')?.dataset.theme : undefined;
    const focusedIndex = UI_THEMES.findIndex(choice => choice.theme === focusedTheme);
    const current = focusedIndex < 0 ? active : focusedIndex;
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); commit(current); return; }
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? UI_THEMES.length - 1 :
      event.key === 'ArrowDown' ? (current + 1) % UI_THEMES.length :
      event.key === 'ArrowUp' ? (current + UI_THEMES.length - 1) % UI_THEMES.length : null;
    if (next === null) return;
    event.preventDefault(); keyboard.current = true; setActive(next);
    const item = menu.current?.querySelector<HTMLButtonElement>(`[data-theme="${UI_THEMES[next].theme}"]`);
    // Pointer hover can leave this very row focused; preview it even when
    // focus() does not generate another event.
    if (item === document.activeElement) preview(next); else item?.focus({ preventScroll: true });
    reveal(item);
  };
  const info = UI_THEMES.find(info => info.theme === displayed)!;
  return <div className="theme-setting">
    <span className="theme-caption" title={t('Theme')}>{t('Theme')}</span>
    <button ref={trigger} className="theme-trigger" type="button" aria-label={t('Theme')} aria-description={t('Current theme: %s', t(info.name))}
      aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? menuId : undefined}
      onPointerDown={event => { pointerPosition.current = { x: event.clientX, y: event.clientY }; }}
      onClick={() => open ? dismiss() : show(false)}
      onKeyDown={event => {
        if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
          event.preventDefault(); event.stopPropagation(); show(true);
        }
      }}>
      <span className="theme-value">{t(info.name)}</span><span className="preference-chevron" aria-hidden="true"><DecorativeChevron /></span>
    </button>
    {preference.error && <p className="preference-error" role="alert">{t(preference.error)}</p>}
    {open && createPortal(<div ref={menu} id={menuId} role="listbox" aria-label={t('Theme choices')} className="ui-theme-menu"
      style={{ ...uiSizeStyle(displayedSize), ...position }} onKeyDown={navigate} onKeyUp={event => event.stopPropagation()}
      onBlur={event => { const next = event.relatedTarget as Node | null;
        if (!next || (!menu.current?.contains(next) && !trigger.current?.contains(next))) dismiss(); }}
      onPointerLeave={() => { if (!keyboard.current) preference.cancelPreview(); }}>
      {UI_THEMES.map((choice, index) => <button key={choice.theme} role="option" type="button" className="ui-theme-option"
        data-theme={choice.theme} aria-selected={preference.theme === choice.theme} tabIndex={active === index ? 0 : -1}
        onPointerEnter={() => { if (!keyboard.current) { setActive(index); preview(index); } }}
        onPointerMove={() => { if (!keyboard.current) { setActive(index); preview(index); } }}
        onPointerLeave={() => { if (!keyboard.current) preference.cancelPreview(); }}
        onFocus={() => { if (keyboard.current) { setActive(index); preview(index); } }} onClick={() => commit(index)}>
        <Icon name="ColorPresets" /><span>{t(choice.name)}</span><span className="grow" />{preference.theme === choice.theme && <span className="preference-selected-dot" aria-hidden="true" />}
      </button>)}
    </div>, document.body)}
  </div>;
}
