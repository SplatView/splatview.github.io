export type MenuScrollOwner = Readonly<{
  shouldDismiss(target: EventTarget | null, menu: Element | null): boolean;
}>;

/** Capture the positions after trigger scrolling and before the popup opens. */
export function captureMenuScroll(trigger: Element): MenuScrollOwner {
  const positions = new Map<EventTarget, { left: number; top: number; current(): readonly [number, number] }>();
  const retain = (target: EventTarget, current: () => readonly [number, number]) => {
    const [left, top] = current(); positions.set(target, { left, top, current });
  };
  for (let ancestor: Element | null = trigger; ancestor; ancestor = ancestor.parentElement) {
    const element = ancestor;
    retain(element, () => [element.scrollLeft, element.scrollTop]);
  }
  const document = trigger.ownerDocument, view = document.defaultView;
  const documentPosition = (): readonly [number, number] => [document.scrollingElement?.scrollLeft ?? view?.scrollX ?? 0,
    document.scrollingElement?.scrollTop ?? view?.scrollY ?? 0];
  retain(document, documentPosition);
  if (document.scrollingElement) {
    const element = document.scrollingElement; retain(element, () => [element.scrollLeft, element.scrollTop]);
  }
  if (view) retain(view, () => [view.scrollX, view.scrollY]);
  return Object.freeze({
    shouldDismiss(target: EventTarget | null, menu: Element | null) {
      // Window scroll targets are not Nodes. Own popup scrolling remains
      // available, including a scrolling child inside its portal.
      if (target && typeof (target as Node).nodeType === 'number' && menu?.contains(target as Node)) return false;
      const captured = target && positions.get(target);
      if (!captured) return true;
      const [left, top] = captured.current();
      // A trigger can scroll into view before click, while its queued scroll
      // event arrives after the popup listener is installed. That event does
      // not move this newly captured anchor; a later position change does.
      return left !== captured.left || top !== captured.top;
    },
  });
}
