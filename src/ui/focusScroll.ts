/** Reveal focus only within the control's own scrolling UI ancestors. */
export function revealFocus(target: HTMLElement, boundary?: HTMLElement | null): void {
  const document = target.ownerDocument, view = document.defaultView;
  if (!view || boundary && !boundary.contains(target) || target === boundary) return;
  for (let owner = target.parentElement; owner && owner !== document.body && owner !== document.documentElement; owner = owner.parentElement) {
    const style = view.getComputedStyle(owner), viewport = owner.getBoundingClientRect();
    const bounds = target.getBoundingClientRect();
    const left = viewport.left + owner.clientLeft, top = viewport.top + owner.clientTop;
    const right = left + owner.clientWidth, bottom = top + owner.clientHeight;
    // Hidden clipping is a layout concern. Never pan the document or a hidden
    // ancestor to make a focused control appear to fit its owning panel.
    if (/^(auto|scroll|overlay)$/.test(style.overflowY) && owner.scrollHeight > owner.clientHeight) {
      if (bounds.top < top) owner.scrollTop += bounds.top - top;
      else if (bounds.bottom > bottom) owner.scrollTop += bounds.bottom - bottom;
    }
    if (/^(auto|scroll|overlay)$/.test(style.overflowX) && owner.scrollWidth > owner.clientWidth) {
      if (bounds.left < left) owner.scrollLeft += bounds.left - left;
      else if (bounds.right > right) owner.scrollLeft += bounds.right - right;
    }
    if (owner === boundary) break;
  }
}

export function focusAndReveal(target: HTMLElement | null | undefined, boundary?: HTMLElement | null): boolean {
  if (!target?.isConnected || boundary && !boundary.contains(target)) return false;
  target.focus({ preventScroll: true });
  if (target.ownerDocument.activeElement !== target) return false;
  revealFocus(target, boundary);
  return true;
}
