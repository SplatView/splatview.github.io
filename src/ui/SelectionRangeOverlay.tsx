import { useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { AppController } from '../app/controller';
import { useApp } from '../app/store';
import { projectAlignmentSegment } from './AlignmentControls';

type Point = readonly [number, number, number];
type Segment = readonly [Point, Point];
type ProjectedSegment = [[number, number], [number, number]];
type Frame = { width: number; height: number; segments: ProjectedSegment[] };
/** Committed viewport_drawing.cpp: three great circles, each64 segments.
 * This display helper never classifies records or creates native work. */
export function selectionRangeSphereSegments(center: Point, radius: number): Segment[] {
  if (![...center, radius].every(Number.isFinite) || radius <= 0) return [];
  const segments: Segment[] = [];
  for (let plane = 0; plane < 3; plane++) for (let index = 0; index < 64; index++) {
    const at = (step: number): Point => {
      const theta = step * Math.PI * 2 / 64, c = radius * Math.cos(theta), s = radius * Math.sin(theta);
      return plane === 0 ? [center[0], center[1] + c, center[2] + s] :
        plane === 1 ? [center[0] + c, center[1], center[2] + s] : [center[0] + c, center[1] + s, center[2]];
    };
    segments.push([at(index), at(index + 1)]);
  }
  return segments;
}

/** The retained picked sphere appears over Tools. Continuous next-pick hover
 * acquisition is omitted; the canvas never shows an old pick as a new hover.
 * Each actual input/layout/store change schedules at most one paint. */
export function SelectionRangeOverlay({ controller, scene, radius, enabled }: {
  controller: Pick<AppController, 'selectionRangePreview' | 'camera'>;
  scene: RefObject<HTMLCanvasElement | null>; radius?: number; enabled: boolean;
}) {
  const state = useApp(), latest = useRef({ controller, scene, radius, enabled, state });
  latest.current = { controller, scene, radius, enabled, state };
  const [frame, setFrame] = useState<Frame>(), refresh = useRef<() => void>(() => undefined);
  useEffect(() => {
    const canvas = scene.current;
    if (!canvas) return;
    let scheduled = 0, pointer: { x: number; y: number } | undefined, keyboard = false, keys = new Set<string>(), buttons = 0, lastKey = '';
    const tools = canvas.parentElement?.querySelector<HTMLElement>('.tools-panel');
    const paint = () => {
      scheduled = 0;
      const current = latest.current, bounds = canvas.getBoundingClientRect(), camera = current.controller.camera;
      const panel = tools?.getBoundingClientRect();
      const active = document.activeElement, focusInTools = active instanceof Element && !!active.closest('.tools-panel');
      const overTools = pointer && panel && pointer.x >= panel.left && pointer.x < panel.right && pointer.y >= panel.top && pointer.y < panel.bottom;
      const blocked = !current.enabled || current.state.fly || current.state.autoOrbit || buttons !== 0 || keys.size > 0 || document.hidden ||
        !!document.querySelector('[role="menu"], [role="dialog"]') || !(keyboard ? focusInTools : overTools);
      const preview = blocked ? undefined : current.controller.selectionRangePreview;
      const effectiveRadius = current.radius ?? preview?.radius;
      const key = preview && camera && effectiveRadius !== undefined ?
        JSON.stringify([preview.center, effectiveRadius, camera.revision, bounds.width, bounds.height]) : '';
      if (key === lastKey) return;
      lastKey = key;
      if (!key || !preview || !camera || effectiveRadius === undefined || bounds.width <= 0 || bounds.height <= 0) { setFrame(undefined); return; }
      const segments = selectionRangeSphereSegments(preview.center, effectiveRadius)
        .map(([a, b]) => projectAlignmentSegment(a, b, camera.view, camera.projection, bounds.width, bounds.height))
        .filter((segment): segment is ProjectedSegment => segment !== null);
      setFrame({ width: bounds.width, height: bounds.height, segments });
    };
    const schedule = () => { if (!scheduled) scheduled = requestAnimationFrame(paint); };
    refresh.current = schedule;
    const pointerInput = (event: PointerEvent) => {
      keyboard = false; pointer = { x: event.clientX, y: event.clientY };
      buttons = event.buttons & 6; schedule();
    };
    const keyDown = (event: KeyboardEvent) => {
      keyboard = true;
      const target = event.target, widget = target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName));
      if (!widget && ['w', 'a', 's', 'd', 'q', 'e', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) keys.add(event.key);
      schedule();
    };
    const keyUp = (event: KeyboardEvent) => { keys.delete(event.key); schedule(); };
    const clear = () => { pointer = undefined; buttons = 0; keys.clear(); keyboard = false; schedule(); };
    const leaveWindow = (event: PointerEvent) => { if (event.relatedTarget === null) clear(); };
    const mutations = new MutationObserver(records => {
      if (records.some(record => !(record.target instanceof Element) || !record.target.closest('.selection-range-overlay'))) schedule();
    });
    mutations.observe(canvas.parentElement ?? document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'open', 'role'] });
    const resize = new ResizeObserver(schedule); resize.observe(canvas); if (canvas.parentElement) resize.observe(canvas.parentElement); if (tools) resize.observe(tools);
    for (const name of ['pointermove', 'pointerdown', 'pointerup', 'pointercancel'] as const) window.addEventListener(name, pointerInput, true);
    window.addEventListener('pointerout', leaveWindow, true);
    window.addEventListener('keydown', keyDown, true); window.addEventListener('keyup', keyUp, true);
    window.addEventListener('resize', schedule); window.addEventListener('scroll', schedule, true); window.addEventListener('blur', clear);
    document.addEventListener('focusin', schedule); document.addEventListener('focusout', schedule); document.addEventListener('visibilitychange', clear);
    schedule();
    return () => {
      refresh.current = () => undefined;
      if (scheduled) cancelAnimationFrame(scheduled);
      for (const name of ['pointermove', 'pointerdown', 'pointerup', 'pointercancel'] as const) window.removeEventListener(name, pointerInput, true);
      window.removeEventListener('pointerout', leaveWindow, true);
      window.removeEventListener('keydown', keyDown, true); window.removeEventListener('keyup', keyUp, true);
      window.removeEventListener('resize', schedule); window.removeEventListener('scroll', schedule, true); window.removeEventListener('blur', clear);
      document.removeEventListener('focusin', schedule); document.removeEventListener('focusout', schedule); document.removeEventListener('visibilitychange', clear);
      mutations.disconnect(); resize.disconnect();
    };
  }, [controller, scene]);
  useEffect(() => refresh.current(), [enabled, radius, state]);
  const host = scene.current?.parentElement;
  if (!host || !frame) return null;
  const operation = state.selectionOperation ?? state.operation;
  const stroke = operation === 1 ? 'rgb(125 210 146)' : operation === 2 ? 'rgb(242 128 115)' :
    operation === 3 ? 'rgb(224 195 117)' : 'var(--accent-hover)';
  return createPortal(<svg className="selection-range-overlay" aria-hidden="true" data-selection-range-sphere data-source-segments="192"
    viewBox={`0 0 ${frame.width} ${frame.height}`} style={{ stroke, strokeOpacity: .86 }}>
    {frame.segments.map(([a, b], index) => <line key={index} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} />)}
  </svg>, host);
}
