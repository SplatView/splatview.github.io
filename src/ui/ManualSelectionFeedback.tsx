import { useEffect, useRef, useState, type RefObject } from 'react';
import type { SelectionTool } from '../app/store';
import { Icon } from './Icon';
import { useTranslation } from '../app/useLanguageAppearance';
import { FloatingSelectionActions } from './FloatingSelectionActions';
export { placeSelectionActions as placeManualActions } from './FloatingSelectionActions';

type Point = readonly [number, number];
export type ManualFeedbackGeometry = {
  rectangle: readonly number[] | null; polygon: readonly Point[]; vertices: readonly Point[];
  trail: readonly Point[]; radius: number;
};
type Props = {
  scene: RefObject<HTMLCanvasElement | null>; tool: SelectionTool | null; operation: number; radius: number;
  enabled: boolean; chromeVisible: boolean; actionsVisible: boolean; finishEnabled: boolean; undoEnabled: boolean; clearEnabled: boolean; scale: number;
  geometry(): ManualFeedbackGeometry; onFinish(): void; onUndo(): void; onClear(): void;
};
type Frame = { pointer: Point | null; geometry: ManualFeedbackGeometry; width: number; height: number };
/** Display-only captured selection_ui.cpp:794-877. One coalesced paint per
 * actual input/layout event; no idle animation, native query or selection work. */
export function ManualSelectionFeedback(props: Props) {
  const { t } = useTranslation(), latest = useRef(props); latest.current = props;
  const root = useRef<HTMLDivElement>(null), [frame, setFrame] = useState<Frame | null>(null);
  const refresh = useRef<() => void>(() => undefined);
  useEffect(() => {
    const canvas = latest.current.scene.current;
    if (!canvas) return;
    let scheduled = 0, pointer: { x: number; y: number; canvas: boolean } | null = null;
    const paint = () => {
      scheduled = 0;
      const current = latest.current, bounds = canvas.getBoundingClientRect();
      const visible = current.enabled && !!current.tool && bounds.width > 0 && bounds.height > 0 && !document.hidden;
      const popup = !!document.querySelector('[role="menu"], [role="dialog"], .alignment-popup');
      const cursor = visible && !popup && pointer?.canvas && pointer.x >= bounds.left && pointer.y >= bounds.top && pointer.x < bounds.right && pointer.y < bounds.bottom
        ? [pointer.x - bounds.left, pointer.y - bounds.top] as Point : null;
      canvas.toggleAttribute('data-selection-cursor', !!cursor);
      if (!visible) { setFrame(null); return; }
      const geometry = current.geometry();
      const trail: Point[] = [], step = Math.max(1, Math.ceil(geometry.trail.length / 4096));
      for (let index = 0; index < geometry.trail.length; index += step) trail.push([...geometry.trail[index]] as Point);
      const end = geometry.trail.at(-1), last = trail.at(-1);
      if (end && (!last || last[0] !== end[0] || last[1] !== end[1])) trail.push([...end] as Point);
      setFrame({ pointer: cursor, geometry: { ...geometry, trail }, width: bounds.width, height: bounds.height });
    };
    const schedule = () => { if (!scheduled) scheduled = requestAnimationFrame(paint); };
    refresh.current = schedule;
    const input = (event: PointerEvent) => {
      pointer = { x: event.clientX, y: event.clientY, canvas: event.target === canvas || canvas.hasPointerCapture(event.pointerId) };
      schedule();
    };
    const leave = () => { pointer = null; schedule(); };
    const lostCapture = schedule;
    const blur = () => { pointer = null; schedule(); };
    const mutation = new MutationObserver(records => {
      if (records.some(record => !root.current?.contains(record.target))) schedule();
    });
    mutation.observe(canvas.parentElement!, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'hidden', 'inert', 'aria-hidden'] });
    const resize = new ResizeObserver(schedule); resize.observe(canvas);
    const events = ['pointermove', 'pointerdown', 'pointerup', 'pointercancel'] as const;
    for (const name of events) window.addEventListener(name, input, true);
    canvas.addEventListener('pointerleave', leave); canvas.addEventListener('lostpointercapture', lostCapture); window.addEventListener('blur', blur);
    window.addEventListener('resize', schedule); window.addEventListener('scroll', schedule, true);
    window.addEventListener('keydown', schedule); window.addEventListener('keyup', schedule);
    document.addEventListener('visibilitychange', blur); schedule();
    return () => {
      cancelAnimationFrame(scheduled); refresh.current = () => undefined; canvas.removeAttribute('data-selection-cursor');
      for (const name of events) window.removeEventListener(name, input, true);
      canvas.removeEventListener('pointerleave', leave); canvas.removeEventListener('lostpointercapture', lostCapture); window.removeEventListener('blur', blur);
      window.removeEventListener('resize', schedule); window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('keydown', schedule); window.removeEventListener('keyup', schedule);
      document.removeEventListener('visibilitychange', blur); mutation.disconnect(); resize.disconnect();
    };
  }, [props.scene]);
  useEffect(() => refresh.current(), [props]);
  const actions = <FloatingSelectionActions key="actions" scene={props.scene} kind="manual" enabled={props.enabled && props.actionsVisible} chromeVisible={props.chromeVisible}
    scale={props.scale} finishEnabled={props.finishEnabled} undoEnabled={props.undoEnabled} clearEnabled={props.clearEnabled}
    onFinish={props.onFinish} onUndo={props.onUndo} onClear={props.onClear} />;
  if (!frame || !props.tool) return <div ref={root} className="manual-feedback-root">{actions}</div>;
  const { geometry, pointer } = frame, scale = props.scale;
  const ink = props.operation === 1 ? 'rgb(125 210 146)' : props.operation === 2 ? 'rgb(242 128 115)'
    : props.operation === 3 ? 'rgb(224 195 117)' : 'var(--accent-hover)';
  const line = { stroke: ink, strokeOpacity: .86, fill: 'none', strokeWidth: 1.5 * scale };
  const area = { ...line, fill: ink, fillOpacity: 22 / 255 };
  const brush = props.tool === 'brush' || props.tool === 'volume', sampled = geometry.trail;
  const badge = props.operation === 1 ? 'Add' : props.operation === 2 ? 'Subtract' : 'Intersect';
  return <div ref={root} className="manual-feedback-root">
    {actions}
    <svg className="gesture-overlay manual-selection-feedback" aria-hidden="true" data-selection-tool={props.tool} data-selection-operation={props.operation} viewBox={`0 0 ${frame.width} ${frame.height}`}>
      {geometry.rectangle && <rect {...area} x={Math.min(geometry.rectangle[0], geometry.rectangle[2])} y={Math.min(geometry.rectangle[1], geometry.rectangle[3])}
        width={Math.abs(geometry.rectangle[2] - geometry.rectangle[0])} height={Math.abs(geometry.rectangle[3] - geometry.rectangle[1])} />}
      {geometry.polygon.length > 0 && <>
        <polyline {...area} points={geometry.polygon.map(point => point.join(',')).join(' ')} />
        <line {...line} x1={geometry.polygon.at(-1)![0]} y1={geometry.polygon.at(-1)![1]} x2={geometry.polygon[0][0]} y2={geometry.polygon[0][1]} />
        {geometry.vertices.map((point, index) => <circle key={index} cx={point[0]} cy={point[1]} r={3 * scale} fill={ink} fillOpacity={.86} />)}
        <circle {...line} cx={geometry.polygon[0][0]} cy={geometry.polygon[0][1]} r={7 * scale} />
      </>}
      {brush && sampled.length > 0 && <g data-brush-trail>
        <polyline points={sampled.map(point => point.join(',')).join(' ')} stroke={ink} strokeOpacity={22 / 255} strokeWidth={geometry.radius * 2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
        {[sampled[0], sampled.at(-1)!].map((point, index) => <circle key={index} cx={point[0]} cy={point[1]} r={geometry.radius} fill={ink} fillOpacity={22 / 255} />)}
      </g>}
      {pointer && <g data-selection-cursor={props.tool}>
        {brush ? <circle {...line} cx={pointer[0]} cy={pointer[1]} r={props.radius} data-brush-radius={props.radius} /> : <>
          <path {...line} strokeWidth={1.25 * scale} d={`M${pointer[0] - 7 * scale} ${pointer[1]}h${14 * scale}M${pointer[0]} ${pointer[1] - 7 * scale}v${14 * scale}`} />
          {props.tool === 'single' && <circle {...line} strokeWidth={scale} cx={pointer[0]} cy={pointer[1]} r={3 * scale} />}
          {(props.tool === 'color' || props.tool === 'fill') && <foreignObject x={pointer[0] - 23.5 * scale} y={pointer[1] - 23.5 * scale} width={17 * scale} height={17 * scale}>
            <span className="manual-cursor-icon" style={{ color: ink, width: 17 * scale, height: 17 * scale }}><Icon name={props.tool === 'color' ? 'Eyedropper' : 'Fill'} /></span>
          </foreignObject>}
        </>}
        {props.tool === 'volume' && <g data-volume-cursor>
          <circle cx={pointer[0]} cy={pointer[1]} r={props.radius} fill={ink} fillOpacity={22 / 255} />
          <ellipse {...line} strokeWidth={scale} cx={pointer[0]} cy={pointer[1]} rx={props.radius} ry={props.radius * .45} transform={`rotate(60 ${pointer[0]} ${pointer[1]})`} />
        </g>}
        {props.operation !== 0 && <foreignObject x={pointer[0] + 5 * scale} y={pointer[1] + 5 * scale} width={18 * scale} height={18 * scale}>
          <span className="manual-operation-badge" data-operation-badge={badge} style={{ color: ink, width: 18 * scale, height: 18 * scale }}><Icon name={badge} /></span>
        </foreignObject>}
      </g>}
    </svg>
    {pointer && brush && <div className="manual-brush-hint" style={{ left: Math.max(4, Math.min(pointer[0] + 14 * scale, frame.width - 210 * scale)),
      top: Math.max(4, Math.min(pointer[1] + props.radius + 8 * scale, frame.height - 28 * scale)) }}>{t('Alt + scroll to change size')}</div>}
  </div>;
}
