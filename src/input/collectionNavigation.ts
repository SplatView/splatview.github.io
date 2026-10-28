type CollectionRect = Readonly<{ left: number; right: number; top: number; bottom: number }>;
/** Desktop edge hit areas are omitted when they intersect another shell control. */
export function collectionArrowVisibility(width: number, height: number, scale: number, controls: readonly CollectionRect[]) {
  const inset = 12 * scale, arrowWidth = 36 * scale, arrowHeight = 64 * scale;
  if (width - 2 * inset < 2 * arrowWidth + 6 * scale || height < arrowHeight + 2 * inset) return [false, false] as const;
  const top = (height - arrowHeight) / 2;
  const clear = (left: number) => !controls.some(rect => left < rect.right && left + arrowWidth > rect.left && top < rect.bottom && top + arrowHeight > rect.top);
  return [clear(inset), clear(width - inset - arrowWidth)] as const;
}
export function collectionPageDirection(event: Pick<KeyboardEvent, 'key' | 'repeat' | 'ctrlKey' | 'metaKey' | 'altKey' | 'isComposing' | 'defaultPrevented'>,
  context: Readonly<{ available: boolean; text: boolean; activeUi: boolean; popup: boolean; captured: boolean }>) {
  if (event.key !== 'PageUp' && event.key !== 'PageDown') return undefined;
  if (event.defaultPrevented || event.isComposing || event.repeat || event.ctrlKey || event.metaKey || event.altKey ||
      !context.available || context.text || context.activeUi || context.popup || context.captured) return 0;
  return event.key === 'PageUp' ? -1 : 1;
}
