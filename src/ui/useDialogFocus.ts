import { useLayoutEffect, useRef, type RefObject } from 'react';
import { focusAndReveal } from './focusScroll';

type DialogFocusOptions = {
  active?: boolean;
  onEscape?(): void;
  initialFocus?(): HTMLElement | null | undefined;
  /** Share this ref when one modal hands ownership to another. */
  returnFocus?: RefObject<HTMLElement | null>;
  fallbackFocus?(): readonly (HTMLElement | null | undefined)[];
  /** Read current state so a departing modal cannot steal its successor's focus. */
  restoreAllowed?(): boolean;
};

function usable(target: HTMLElement | null | undefined): target is HTMLElement {
  if (!target?.isConnected || target === target.ownerDocument.body ||
      target.matches(':disabled, [aria-disabled="true"]') ||
      target.closest('[hidden], [inert], [aria-hidden="true"]') || !target.getClientRects().length) return false;
  const visibility = target.ownerDocument.defaultView?.getComputedStyle(target).visibility;
  return visibility !== 'hidden' && visibility !== 'collapse';
}

function focus(target: HTMLElement | null | undefined, boundary?: HTMLElement) {
  if (!usable(target)) return false;
  return focusAndReveal(target, boundary);
}

/** The returned panel ref needs tabIndex={-1} as a fallback when no control is usable. */
export function useDialogFocus<T extends HTMLElement = HTMLDivElement>(options: DialogFocusOptions): RefObject<T | null> {
  const panel = useRef<T>(null), latest = useRef(options);
  latest.current = options;
  const { active = true, returnFocus } = options;
  useLayoutEffect(() => {
    const root = panel.current;
    if (!active || !root) return;
    const document = root.ownerDocument;
    const previous = document.activeElement instanceof HTMLElement && !root.contains(document.activeElement)
      ? document.activeElement : null;
    // Capture before initial focus, and retain the session origin during handoffs.
    if (returnFocus && !returnFocus.current && usable(previous)) returnFocus.current = previous;
    const controls = () => Array.from(root.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, summary, [tabindex], [contenteditable="true"]',
    )).filter(target => target.tabIndex >= 0 && usable(target));
    const focusInitial = () => {
      const preferred = latest.current.initialFocus?.();
      if (preferred && root.contains(preferred) && focus(preferred, root)) return;
      if (!controls().some(target => focus(target, root))) focus(root, root);
    };
    const contain = (event: FocusEvent) => {
      if (event.target instanceof Node && !root.contains(event.target)) focusInitial();
    };
    const key = (event: KeyboardEvent) => {
      // Browser Find, zoom, tab switching, and IME cancellation keep their keys.
      if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation();
        if (!event.repeat) latest.current.onEscape?.();
      } else if (event.key === 'Tab') {
        event.preventDefault(); event.stopPropagation();
        const values = controls(), index = values.indexOf(document.activeElement as HTMLElement);
        const next = index < 0 ? event.shiftKey ? values.length - 1 : 0
          : (index + (event.shiftKey ? values.length - 1 : 1)) % values.length;
        if (!focus(values[next], root)) focusInitial();
      }
    };
    document.addEventListener('focusin', contain);
    document.addEventListener('keydown', key, true);
    focusInitial();
    return () => {
      document.removeEventListener('focusin', contain);
      document.removeEventListener('keydown', key, true);
      if (latest.current.restoreAllowed?.() === false) return;
      const targets = [returnFocus?.current, previous, ...(latest.current.fallbackFocus?.() ?? [])];
      targets.some(target => target && !root.contains(target) && focus(target));
      if (returnFocus) returnFocus.current = null;
    };
  }, [active, returnFocus]);
  return panel;
}
