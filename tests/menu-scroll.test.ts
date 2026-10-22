import { describe, expect, it, vi } from 'vitest';
import { captureMenuScroll } from '../src/ui/menuScroll';

// Pure ownership tests: no DOM renderer, browser, native module or GPU.
class ScrollElement extends EventTarget {
  readonly nodeType = 1;
  scrollLeft = 0; scrollTop = 0;
  parentElement: ScrollElement | null = null;
  ownerDocument!: ScrollDocument;
  contains(target: EventTarget | null) {
    for (let element = target as ScrollElement | null; element; element = element.parentElement)
      if (element === this) return true;
    return false;
  }
}
class ScrollDocument extends EventTarget {
  readonly nodeType = 9;
  scrollingElement: ScrollElement | null = null;
  defaultView: ScrollWindow | null = null;
}
class ScrollWindow extends EventTarget { scrollX = 0; scrollY = 0; }
function fixture() {
  const document = new ScrollDocument(), view = new ScrollWindow(), root = new ScrollElement(), body = new ScrollElement(),
    panel = new ScrollElement(), trigger = new ScrollElement(), menu = new ScrollElement(), item = new ScrollElement();
  document.defaultView = view; document.scrollingElement = root;
  body.parentElement = root; panel.parentElement = body; trigger.parentElement = panel; menu.parentElement = body; item.parentElement = menu;
  for (const element of [root, body, panel, trigger, menu, item]) element.ownerDocument = document;
  const capture = () => captureMenuScroll(trigger as unknown as Element);
  const popup = menu as unknown as Element;
  return { document, view, root, body, panel, trigger, menu, item, capture, popup };
}

describe('menu scroll position ownership', () => {
  it('admits a queued scroll event from the already scrolled trigger ancestor after popup opening', () => {
    const f = fixture(); f.panel.scrollTop = 5;
    const owner = f.capture(); let dismiss: boolean | undefined;
    f.panel.addEventListener('scroll', event => { dismiss = owner.shouldDismiss(event.target, f.popup); });
    f.panel.dispatchEvent(new Event('scroll'));
    expect(dismiss).toBe(false); expect(f.panel.scrollTop).toBe(5);
  });
  it.each(['vertical', 'horizontal'] as const)('dismisses a subsequent %s ancestor scroll without a time window', axis => {
    const f = fixture(); f.panel.scrollTop = 5; const owner = f.capture();
    if (axis === 'vertical') f.panel.scrollTop = 6; else f.panel.scrollLeft = 1;
    expect(owner.shouldDismiss(f.panel, f.popup)).toBe(true);
  });
  it('captures every ancestor, including the trigger itself and document scrolling element', () => {
    const f = fixture(); const owner = f.capture();
    for (const target of [f.trigger, f.panel, f.body, f.root]) {
      expect(owner.shouldDismiss(target, f.popup)).toBe(false);
      target.scrollTop = 1; expect(owner.shouldDismiss(target, f.popup)).toBe(true); target.scrollTop = 0;
    }
  });
  it('compares a document-targeted scroll against its actual current scrolling element position', () => {
    const f = fixture(); f.root.scrollTop = 20; f.root.scrollLeft = 7; const owner = f.capture();
    expect(owner.shouldDismiss(f.document, f.popup)).toBe(false);
    f.root.scrollLeft = 8; expect(owner.shouldDismiss(f.document, f.popup)).toBe(true);
    f.root.scrollLeft = 7; f.root.scrollTop = 21; expect(owner.shouldDismiss(f.document, f.popup)).toBe(true);
  });
  it('handles window scroll targets without passing a non-Node to popup.contains', () => {
    const f = fixture(); f.view.scrollX = 4; f.view.scrollY = 9; const owner = f.capture(), contains = vi.spyOn(f.menu, 'contains');
    expect(owner.shouldDismiss(f.view, f.popup)).toBe(false); expect(contains).not.toHaveBeenCalled();
    f.view.scrollY = 10; expect(owner.shouldDismiss(f.view, f.popup)).toBe(true);
    f.view.scrollY = 9; f.view.scrollX = 5; expect(owner.shouldDismiss(f.view, f.popup)).toBe(true);
  });
  it('uses the actual viewport position for a document without a scrolling element', () => {
    const f = fixture(); f.document.scrollingElement = null; f.view.scrollY = 4; const owner = f.capture();
    expect(owner.shouldDismiss(f.document, f.popup)).toBe(false);
    f.view.scrollY = 5; expect(owner.shouldDismiss(f.document, f.popup)).toBe(true);
  });
  it('admits popup and popup-descendant scrolling even when an ancestor position changed', () => {
    const f = fixture(), owner = f.capture(); f.panel.scrollTop = 5; f.menu.scrollTop = 7; f.item.scrollTop = 3;
    expect(owner.shouldDismiss(f.menu, f.popup)).toBe(false); expect(owner.shouldDismiss(f.item, f.popup)).toBe(false);
    expect(owner.shouldDismiss(f.panel, f.popup)).toBe(true);
  });
  it('dismisses scrolling from an unknown outside container or absent event target', () => {
    const f = fixture(), owner = f.capture(), other = new ScrollElement(); other.ownerDocument = f.document;
    expect(owner.shouldDismiss(other, f.popup)).toBe(true); expect(owner.shouldDismiss(new EventTarget(), f.popup)).toBe(true);
    expect(owner.shouldDismiss(null, f.popup)).toBe(true);
  });
  it('recaptures a new popup opening without changing the authority of an older owner', () => {
    const f = fixture(), old = f.capture(); f.panel.scrollTop = 5; const reopened = f.capture();
    expect(old.shouldDismiss(f.panel, f.popup)).toBe(true); expect(reopened.shouldDismiss(f.panel, f.popup)).toBe(false);
    f.panel.scrollTop = 6; expect(reopened.shouldDismiss(f.panel, f.popup)).toBe(true);
  });
});
