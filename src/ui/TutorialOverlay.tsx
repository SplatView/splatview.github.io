import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { TUTORIAL_OFFER_TEXT, type TutorialCourseId, type TutorialCourseStep } from '../app/tutorialCourse';
import { TutorialTopics } from './TutorialTopics';
import { UI_SIZES, uiSizeStyle, useUiPreferences } from '../app/uiPreferences';
import { useTranslation } from '../app/useLanguageAppearance';
import { Icon } from './Icon';
import { focusAndReveal } from './focusScroll';
import { placeSelectionActions, TutorialSelectionActions } from './FloatingSelectionActions';
import { intersectTutorialRect, mergeTutorialRects, positionTutorialCard, tutorialCardWidth, tutorialTargetBounds,
  tutorialViewportBounds, type TutorialRect, type TutorialViewport } from './tutorialLayout';

export type TutorialOverlayProps = {
  step: TutorialCourseStep | null;
  stepIndex: number;
  totalSteps: number;
  courseId: TutorialCourseId;
  onSelectTopic(course: TutorialCourseId, index: number): void;
  offer: boolean;
  preparing?: boolean;
  preferenceError: string | null;
  returnFocus?: RefObject<HTMLElement | null>;
  restoreFocusWhenAllowed?(): boolean;
  onStart(): void;
  onSkip(): void;
  onClose(): void;
  onBack(): void;
  onNext(): void;
};

const focusable = (panel: HTMLElement | null) => Array.from(panel?.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, summary, [tabindex]') ?? [])
  .filter(element => element.tabIndex >= 0 && !element.matches(':disabled') && element.getClientRects().length > 0);
const usableFocus = (element: HTMLElement | null | undefined): element is HTMLElement => !!element?.isConnected && element !== document.body &&
  !element.closest('[inert], [hidden]') && !element.matches(':disabled') && element.getClientRects().length > 0;
const viewport = (): TutorialViewport => ({ left: window.visualViewport?.offsetLeft ?? 0, top: window.visualViewport?.offsetTop ?? 0,
  width: window.visualViewport?.width ?? window.innerWidth, height: window.visualViewport?.height ?? window.innerHeight });
const sameRects = (a: readonly TutorialRect[], b: readonly TutorialRect[]) => a.length === b.length &&
  a.every((rect, index) => rect.left === b[index].left && rect.right === b[index].right && rect.top === b[index].top && rect.bottom === b[index].bottom);

function visibleRects(element: HTMLElement, bounds: TutorialViewport): TutorialRect[] {
  let clip: TutorialRect = { left: bounds.left, top: bounds.top, right: bounds.left + bounds.width, bottom: bounds.top + bounds.height };
  for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
    const style = getComputedStyle(ancestor);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) return [];
    if (ancestor === element) continue;
    const box = ancestor.getBoundingClientRect(), clipX = /^(hidden|clip|auto|scroll)$/.test(style.overflowX), clipY = /^(hidden|clip|auto|scroll)$/.test(style.overflowY);
    const interior = { left: clipX ? box.left + ancestor.clientLeft : clip.left, right: clipX ? box.left + ancestor.clientLeft + ancestor.clientWidth : clip.right,
      top: clipY ? box.top + ancestor.clientTop : clip.top, bottom: clipY ? box.top + ancestor.clientTop + ancestor.clientHeight : clip.bottom };
    const intersection = intersectTutorialRect(clip, interior);
    if (!intersection) return [];
    clip = intersection;
  }
  return Array.from(element.getClientRects()).flatMap(rect => {
    const intersection = intersectTutorialRect(rect, clip);
    return intersection ? [intersection] : [];
  });
}

function targetScrollOwners(elements: readonly HTMLElement[]): Map<HTMLElement, HTMLElement[]> {
  const owners = new Map<HTMLElement, HTMLElement[]>();
  for (const element of elements) {
    if (!Array.from(element.getClientRects()).some(rect => rect.width > 0 && rect.height > 0)) continue;
    const document = element.ownerDocument;
    for (let owner = element.parentElement; owner && owner !== document.body && owner !== document.documentElement; owner = owner.parentElement) {
      const style = getComputedStyle(owner);
      if (/^(auto|scroll|overlay)$/.test(style.overflowY) && owner.scrollHeight > owner.clientHeight ||
          /^(auto|scroll|overlay)$/.test(style.overflowX) && owner.scrollWidth > owner.clientWidth)
        owners.set(owner, [...(owners.get(owner) ?? []), element]);
    }
  }
  return owners;
}

function revealTargets(owners: ReadonlyMap<HTMLElement, readonly HTMLElement[]>) {
  const depth = (element: HTMLElement) => {
    let count = 0;
    for (let parent = element.parentElement; parent; parent = parent.parentElement) count++;
    return count;
  };
  // Reveal an inner body first, then use its updated target rectangles when
  // revealing the whole compact panel. Never scroll the document or window.
  const ordered = [...owners].sort(([a], [b]) => depth(b) - depth(a));
  for (const [owner, targets] of ordered) {
    const viewportRect = owner.getBoundingClientRect(), style = getComputedStyle(owner);
    const left = viewportRect.left + owner.clientLeft, top = viewportRect.top + owner.clientTop;
    const right = left + owner.clientWidth, bottom = top + owner.clientHeight;
    const grouped = tutorialTargetBounds(targets.map(element => element.getBoundingClientRect()));
    if (!grouped) continue;
    if (/^(auto|scroll|overlay)$/.test(style.overflowY) && owner.clientHeight > 0 && owner.scrollHeight > owner.clientHeight) {
      const target = grouped.bottom - grouped.top > owner.clientHeight ? targets[0].getBoundingClientRect() : grouped;
      if (target.top < top || target.bottom - target.top > owner.clientHeight) owner.scrollTop += target.top - top;
      else if (target.bottom > bottom) owner.scrollTop += target.bottom - bottom;
    }
    if (/^(auto|scroll|overlay)$/.test(style.overflowX) && owner.clientWidth > 0 && owner.scrollWidth > owner.clientWidth) {
      const target = grouped.right - grouped.left > owner.clientWidth ? targets[0].getBoundingClientRect() : grouped;
      if (target.left < left || target.right - target.left > owner.clientWidth) owner.scrollLeft += target.left - left;
      else if (target.right > right) owner.scrollLeft += target.right - right;
    }
  }
}

/** Explanatory chrome only. The parent owns preference writes and scene-input admission. */
export function TutorialOverlay({ step, stepIndex, totalSteps, courseId, onSelectTopic, offer, preparing = false, preferenceError, returnFocus, restoreFocusWhenAllowed,
  onStart, onSkip, onClose, onBack, onNext }: TutorialOverlayProps) {
  const { t, locale } = useTranslation(), preferences = useUiPreferences();
  const size = preferences.previewSize ?? preferences.size, scale = UI_SIZES.find(info => info.size === size)!.panelScale;
  const layer = useRef<HTMLDivElement>(null), card = useRef<HTMLDivElement>(null), body = useRef<HTMLDivElement>(null);
  const selectionActions = useRef<HTMLDivElement>(null);
  const [rects, setRects] = useState<readonly TutorialRect[]>([]), id = useId();
  const [inlineSelectionActions, setInlineSelectionActions] = useState(false);
  const [topicsOpen, setTopicsOpen] = useState(false);
  const active = offer || step !== null;
  const selectionFinish = !offer && !topicsOpen && step?.target === 'selection-finish';
  const offerRef = useRef(offer), closeRef = useRef(onClose), skipRef = useRef(onSkip);
  const restoreFocus = useRef(restoreFocusWhenAllowed); restoreFocus.current = restoreFocusWhenAllowed;
  offerRef.current = offer; closeRef.current = onClose; skipRef.current = onSkip;
  useLayoutEffect(() => { if (body.current) body.current.scrollTop = 0; }, [offer, step?.id, topicsOpen]);

  useLayoutEffect(() => {
    if (!active || !card.current) return;
    let live = true, queued = 0, reveal = true;
    const observed = new Set<Element>(), scrolling = new Set<HTMLElement>();
    const targets = (target = step?.target) => target ? Array.from(document.querySelectorAll<HTMLElement>(`[data-tutorial-target~="${CSS.escape(target)}"]`)) : [];
    const resize = new ResizeObserver(() => schedule(true));
    const measure = () => {
      queued = 0;
      if (!live || !card.current) return;
      // Place the disabled example using the same finite desktop candidates.
      // Real release anchors and all native owners remain untouched.
      if (selectionActions.current) {
        const demo = selectionActions.current, canvas = document.querySelector('canvas'), bounds = canvas?.getBoundingClientRect();
        const obstacles = Array.from(document.querySelectorAll<HTMLElement>('.toolbar,.tools-panel,.collection-arrow,.status,.error-banner,.brand-link'))
          .filter(element => element.getClientRects().length > 0 && !element.closest('[hidden]'))
          .map(element => { const box = element.getBoundingClientRect(); return { left: box.left - (bounds?.left ?? 0), top: box.top - (bounds?.top ?? 0), width: box.width, height: box.height }; });
        const at = bounds ? placeSelectionActions([bounds.width * .45, bounds.height - 72 * scale], bounds, obstacles, scale) : null;
        // A compact viewport may be completely covered by projected chrome.
        // Keep the disabled example reachable in the card's scroll body there.
        if (inlineSelectionActions !== !at) { setInlineSelectionActions(!at); return; }
        demo.hidden = false;
        if (at && bounds) { demo.style.left = `${bounds.left + at.left}px`; demo.style.top = `${bounds.top + at.top}px`; }
      }
      const elements = targets();
      // The finish example lives on the canvas (or inside this card on small
      // screens). Keep its lesson in the panel's reading flow, independently
      // of the outline, without positioning a card against its own child.
      const anchors = selectionFinish ? targets('selection-edits') : elements;
      const owners = targetScrollOwners(selectionFinish ? [...anchors, ...elements] : elements), display = viewport();
      scrolling.clear(); for (const owner of owners.keys()) scrolling.add(owner);
      if (reveal) { reveal = false; revealTargets(owners); }
      const next = mergeTutorialRects(elements.flatMap(element => visibleRects(element, display)));
      setRects(previous => sameRects(previous, next) ? previous : next);
      const placementRects = selectionFinish ? mergeTutorialRects(anchors.flatMap(element => visibleRects(element, display))) : next;
      const inset = tutorialViewportBounds(display), panel = card.current;
      panel.style.width = `${tutorialCardWidth(placementRects, display, !!step?.tools, scale)}px`;
      panel.style.maxHeight = `${inset.bottom - inset.top}px`;
      const bounds = panel.getBoundingClientRect();
      const toolbarBottom = document.querySelector('.toolbar')?.getBoundingClientRect().bottom ?? display.top;
      const position = offer ? { left: inset.left, top: Math.max(inset.top, inset.bottom - bounds.height) } :
        positionTutorialCard(placementRects, bounds, display, !!step?.tools, toolbarBottom, Math.min(300 * scale, inset.right - inset.left));
      panel.style.left = `${position.left}px`; panel.style.top = `${position.top}px`;
      const wanted = new Set<Element>([panel, ...elements, ...anchors, ...owners.keys()]);
      for (const element of observed) if (!wanted.has(element)) { resize.unobserve(element); observed.delete(element); }
      for (const element of wanted) if (!observed.has(element)) { observed.add(element); resize.observe(element); }
    };
    const schedule = (shouldReveal = false) => {
      if (!live) return;
      reveal ||= shouldReveal;
      if (!queued) queued = requestAnimationFrame(measure);
    };
    const resized = () => schedule(true), scrolled = (event: Event) => {
      if (event.target instanceof HTMLElement && scrolling.has(event.target)) schedule();
    };
    const mutation = new MutationObserver(() => schedule(true)), app = document.getElementById('root');
    if (app) mutation.observe(app, { childList: true, subtree: true });
    mutation.observe(document.body, { childList: true });
    window.addEventListener('resize', resized); window.addEventListener('scroll', scrolled, true);
    window.visualViewport?.addEventListener('resize', resized); window.visualViewport?.addEventListener('scroll', resized);
    document.fonts?.addEventListener('loadingdone', resized);
    measure();
    return () => {
      live = false; if (queued) cancelAnimationFrame(queued); resize.disconnect(); mutation.disconnect();
      window.removeEventListener('resize', resized); window.removeEventListener('scroll', scrolled, true);
      window.visualViewport?.removeEventListener('resize', resized); window.visualViewport?.removeEventListener('scroll', resized);
      document.fonts?.removeEventListener('loadingdone', resized);
    };
  }, [active, offer, step?.id, step?.target, step?.tools, scale, locale, inlineSelectionActions, selectionFinish]);

  useEffect(() => {
    if (!active) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusInitial = () => focusAndReveal(card.current?.querySelector<HTMLElement>('[data-tutorial-initial-focus]') ?? focusable(card.current)[0], card.current);
    const contain = (event: FocusEvent) => { if (event.target instanceof Node && !card.current?.contains(event.target)) focusInitial(); };
    focusInitial(); document.addEventListener('focusin', contain);
    return () => {
      document.removeEventListener('focusin', contain);
      // The parent removes inert/projected layout during the same commit.
      queueMicrotask(() => {
        if (layer.current?.isConnected || document.querySelector('.tutorial-layer') || restoreFocus.current?.() === false) return;
        const target = usableFocus(returnFocus?.current) ? returnFocus!.current : usableFocus(previous) ? previous : null;
        focusAndReveal(target);
      });
    };
  }, [active, returnFocus]);
  useEffect(() => {
    // Start replaces the focused offer button without unmounting this owner.
    if (active) focusAndReveal(card.current?.querySelector<HTMLElement>('[data-tutorial-initial-focus]'), card.current);
  }, [active, offer, preparing, topicsOpen]);

  const navigate = (event: KeyboardEvent) => {
    event.stopPropagation();
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (topicsOpen) setTopicsOpen(false);
      else if (offerRef.current) skipRef.current();
      else closeRef.current();
    }
    if (event.key === 'Tab') {
      const controls = focusable(card.current), index = controls.indexOf(document.activeElement as HTMLElement);
      event.preventDefault();
      focusAndReveal(controls[index < 0 ? event.shiftKey ? controls.length - 1 : 0 : (index + (event.shiftKey ? controls.length - 1 : 1)) % controls.length], card.current);
    }
    const editable = event.target instanceof HTMLElement && (event.target.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(event.target.tagName));
    if (!offer && !topicsOpen && !preparing && !editable && !event.repeat && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
      const key = event.key.toLowerCase();
      if (key === 'b' || key === 'n') { event.preventDefault(); if (key === 'b') onBack(); else onNext(); }
    }
  };
  if (!active) return null;
  return createPortal(<div ref={layer} className="tutorial-layer" style={uiSizeStyle(size)} data-tutorial-phase={offer ? 'offer' : 'tour'}
    data-tutorial-course={courseId}
    data-tutorial-step={offer ? undefined : stepIndex + 1} data-tutorial-step-id={step?.id} data-tutorial-active-target={step?.target} data-tutorial-target-status={offer ? undefined : rects.length ? 'visible' : 'unavailable'}
    onKeyDown={navigate} onKeyUp={event => event.stopPropagation()} onPointerDown={event => {
      event.stopPropagation();
      // Pressing a now-disabled Start again must not blur the enabled Skip.
      if (event.target === event.currentTarget || event.target instanceof Element && event.target.closest('button:disabled')) event.preventDefault();
    }} onPointerUp={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
    onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}>
    {selectionFinish && !inlineSelectionActions && <TutorialSelectionActions rootRef={selectionActions} scale={scale} />}
    {!offer && rects.map((rect, index) => <div key={index} aria-hidden="true" className={`tutorial-highlight${selectionFinish && inlineSelectionActions ? ' tutorial-highlight-inline' : ''}`}
      style={{ left: rect.left - 2, top: rect.top - 2, width: rect.right - rect.left + 4, height: rect.bottom - rect.top + 4 }} />)}
    <div ref={card} className={`tutorial-card panel${offer ? ' tutorial-offer' : ''}`} role="dialog" aria-modal="true" aria-busy={preparing || undefined} aria-label={t('Tutorial')} aria-describedby={`${id}-body`}>
      {offer ? <div className="tutorial-card-heading"><h1>{t('Tutorial')}</h1></div> : <div className="tutorial-card-heading tutorial-step-heading">
        <div className="tutorial-step-meta"><span className="tutorial-chapter" title={t(step!.chapter)}>{t(step!.chapter)}</span>
          <span className="tutorial-counter" aria-live="polite">{t('Tutorial %u / %u', stepIndex + 1, totalSteps)}</span></div><span className="grow" />
        <button type="button" className="icon-button small" aria-label={t('Topics')} title={t('Topics')} aria-expanded={topicsOpen} aria-controls={`${id}-topics`}
          onClick={() => setTopicsOpen(value => !value)}><Icon name="Tutorial" /></button>
        <button type="button" className="icon-button small" aria-label={t('Close tutorial')} title={t('Close tutorial (Esc)')} onClick={onClose}><Icon name="Cancel" /></button>
      </div>}
      {!offer && <div className="tutorial-progress" role="progressbar" aria-label={t('Tutorial')} aria-valuemin={0} aria-valuemax={totalSteps} aria-valuenow={stepIndex + 1}>
        <span style={{ width: `${(stepIndex + 1) / totalSteps * 100}%` }} /></div>}
      <div ref={body} id={`${id}-body`} className="tutorial-card-body" tabIndex={0} aria-labelledby={offer ? undefined : topicsOpen ? `${id}-topics-title` : `${id}-title`}>
        {offer ? <p>{t(TUTORIAL_OFFER_TEXT)}</p> : topicsOpen ? <TutorialTopics id={`${id}-topics`} courseId={courseId} step={step!}
          onSelect={(course, index) => { onSelectTopic(course, index); setTopicsOpen(false); }} /> : <>
          <h1 id={`${id}-title`}>{t(step!.title)}</h1><p className="tutorial-course-kind">{t('Text tour')}</p><p>{t(step!.text)}</p>
          {selectionFinish && inlineSelectionActions && <TutorialSelectionActions rootRef={selectionActions} scale={scale} inline />}
          {!rects.length && <p className="tutorial-unavailable" role="status">{t('This control is unavailable in the current view. You can continue the tutorial.')}</p>}
        </>}
        {preferenceError && <p className="preference-error" role="alert">{t(preferenceError)}</p>}
      </div>
      {offer ? <div className="tutorial-offer-actions"><button type="button" className="tutorial-start" data-tutorial-initial-focus={preparing ? undefined : true} disabled={preparing} onClick={onStart}><Icon name="Tutorial" />{t(preparing ? 'Opening scene' : 'Start')}</button>
        <button type="button" className="tutorial-skip" data-tutorial-initial-focus={preparing ? true : undefined} onClick={onSkip}>{t('Skip')}</button></div> :
        <div className="tutorial-card-actions">{topicsOpen ? <button type="button" onClick={() => setTopicsOpen(false)}>{t('Back')}</button> : <>
          <button type="button" onClick={onBack} disabled={stepIndex === 0} title={`${t('Back')} (B)`}>{t('Back')}</button>
          <button type="button" data-tutorial-initial-focus onClick={onNext} title={`${t(stepIndex + 1 === totalSteps ? 'Finish' : 'Next')} (N)`}>{t(stepIndex + 1 === totalSteps ? 'Finish' : 'Next')}</button></>}</div>}
    </div>
  </div>, document.body);
}
