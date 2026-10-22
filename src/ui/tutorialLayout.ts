/** Browser geometry equivalent of app_ui_tutorial.cpp:16-44,218-242.
 * Separate rows stay separate even when joined toolbar controls wrap.
 */
export type TutorialRect = Readonly<{ left: number; top: number; right: number; bottom: number }>;
export type TutorialViewport = Readonly<{ left: number; top: number; width: number; height: number }>;

const finiteRect = (rect: TutorialRect) => [rect.left, rect.top, rect.right, rect.bottom].every(Number.isFinite) &&
  rect.right > rect.left && rect.bottom > rect.top;

export function intersectTutorialRect(rect: TutorialRect, clip: TutorialRect): TutorialRect | null {
  if (!finiteRect(rect) || !finiteRect(clip)) return null;
  const result = { left: Math.max(rect.left, clip.left), top: Math.max(rect.top, clip.top),
    right: Math.min(rect.right, clip.right), bottom: Math.min(rect.bottom, clip.bottom) };
  return finiteRect(result) ? result : null;
}

export function tutorialTargetBounds(rects: readonly TutorialRect[]): TutorialRect | null {
  const valid = rects.filter(finiteRect);
  if (!valid.length) return null;
  return { left: Math.min(...valid.map(rect => rect.left)), top: Math.min(...valid.map(rect => rect.top)),
    right: Math.max(...valid.map(rect => rect.right)), bottom: Math.max(...valid.map(rect => rect.bottom)) };
}

export function mergeTutorialRects(rects: readonly TutorialRect[], gap = 6): TutorialRect[] {
  const result: TutorialRect[] = [];
  for (const original of rects.filter(finiteRect).toSorted((a, b) => a.top - b.top || a.left - b.left)) {
    let bounds = original;
    // A newly extended span may bridge two previously separate controls.
    for (let index = 0; index < result.length;) {
      const other = result[index];
      if (Math.abs(other.top - bounds.top) < 1 && Math.abs(other.bottom - bounds.bottom) < 1 &&
          other.left <= bounds.right + gap && other.right + gap >= bounds.left) {
        bounds = { left: Math.min(other.left, bounds.left), top: Math.min(other.top, bounds.top),
          right: Math.max(other.right, bounds.right), bottom: Math.max(other.bottom, bounds.bottom) };
        result.splice(index, 1); index = 0;
      } else index++;
    }
    result.push(bounds);
  }
  return result.toSorted((a, b) => a.top - b.top || a.left - b.left);
}

export function tutorialViewportBounds(viewport: TutorialViewport, inset = 12): TutorialRect {
  const width = Number.isFinite(viewport.width) ? Math.max(1, viewport.width) : 1;
  const height = Number.isFinite(viewport.height) ? Math.max(1, viewport.height) : 1;
  const left = Number.isFinite(viewport.left) ? viewport.left : 0, top = Number.isFinite(viewport.top) ? viewport.top : 0;
  const marginX = Math.min(Math.max(0, inset), (width - 1) / 2), marginY = Math.min(Math.max(0, inset), (height - 1) / 2);
  return { left: left + marginX, top: top + marginY, right: left + width - marginX, bottom: top + height - marginY };
}

export function tutorialCardWidth(targets: readonly TutorialRect[], viewport: TutorialViewport, tools: boolean, scale = 1): number {
  const inset = tutorialViewportBounds(viewport), maximum = inset.right - inset.left;
  const preferred = Math.min(300 * scale, maximum), bounds = tutorialTargetBounds(targets);
  if (!tools || !bounds) return preferred;
  const available = Math.min(bounds.left, viewport.left + viewport.width - preferred - 12) - 12 - inset.left;
  return available >= 200 * scale ? Math.min(preferred, available) : preferred;
}

export function positionTutorialCard(targets: readonly TutorialRect[], size: Readonly<{ width: number; height: number }>,
  viewport: TutorialViewport, tools: boolean, toolbarBottom = 0, panelWidth = 300): Readonly<{ left: number; top: number }> {
  const inset = tutorialViewportBounds(viewport), gap = 12;
  const width = Math.min(Math.max(1, size.width), inset.right - inset.left), height = Math.min(Math.max(1, size.height), inset.bottom - inset.top);
  const clamp = (left: number, top: number) => ({ left: Math.min(Math.max(left, inset.left), inset.right - width),
    top: Math.min(Math.max(top, inset.top), inset.bottom - height) });
  const bounds = tutorialTargetBounds(targets);
  if (!bounds) return clamp(inset.left, toolbarBottom + gap);
  // The desktop first tries the clear column beside the entire Tools panel.
  const toolsLeft = Math.min(bounds.left, viewport.left + viewport.width - panelWidth - gap);
  if (tools && toolsLeft - width - gap >= inset.left)
    return clamp(toolsLeft - width - gap, Math.max(bounds.top, toolbarBottom + gap));
  const below = { left: bounds.left, top: bounds.bottom + gap }, right = { left: bounds.right + gap, top: bounds.top };
  const above = { left: bounds.left, top: bounds.top - height - gap }, left = { left: bounds.left - width - gap, top: bounds.top };
  const candidates = tools ? [left, below, right, above] : [below, right, above, left];
  const clearance = { left: bounds.left - gap / 2, top: bounds.top - gap / 2, right: bounds.right + gap / 2, bottom: bounds.bottom + gap / 2 };
  let best = clamp(candidates[0].left, candidates[0].top), leastOverlap = Infinity;
  for (const candidate of candidates) {
    const position = clamp(candidate.left, candidate.top);
    const overlap = Math.max(0, Math.min(position.left + width, clearance.right) - Math.max(position.left, clearance.left)) *
      Math.max(0, Math.min(position.top + height, clearance.bottom) - Math.max(position.top, clearance.top));
    if (overlap === 0) return position;
    if (overlap < leastOverlap) { best = position; leastOverlap = overlap; }
  }
  return best;
}
