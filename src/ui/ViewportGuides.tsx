import { useEffect, useState, type RefObject } from 'react';
import type { AppController } from '../app/controller';
import { useApp } from '../app/store';
import { layoutViewportGuides, type ViewportGuides } from '../input/viewportGuides';

type GuidesFrame = {
  mode: ViewportGuides;
  background: ReturnType<typeof useApp.getState>['background'];
  width: number;
  height: number;
  revision: number;
  layout: ReturnType<typeof layoutViewportGuides>;
};
const rgb = ({ r, g, b }: { r: number; g: number; b: number }) => `rgb(${r}, ${g}, ${b})`;

/** Display-only guides. No GPU queries, scene edits or independent animation loop. */
export function ViewportGuidesOverlay({ controller, scene, mode }: {
  controller: AppController;
  scene: RefObject<HTMLCanvasElement | null>;
  mode: ViewportGuides;
}) {
  const ready = useApp(state => !!state.summary && state.rendererState === 'ready');
  const background = useApp(state => state.background);
  const [frame, setFrame] = useState<GuidesFrame | null>(null);
  useEffect(() => {
    if (!ready || mode === 'none') { setFrame(null); return; }
    let live = true, previousCamera: AppController['camera'], previousRevision = -1;
    let previousWidth = -1, previousHeight = -1;
    const update = () => {
      if (!live) return;
      const camera = controller.camera, canvas = scene.current, bounds = canvas?.getBoundingClientRect();
      if (!camera || !bounds || bounds.width <= 0 || bounds.height <= 0) {
        previousCamera = undefined; setFrame(null); return;
      }
      if (camera === previousCamera && camera.revision === previousRevision &&
          bounds.width === previousWidth && bounds.height === previousHeight) return;
      const state = camera.state;
      const layout = layoutViewportGuides({ mode, view: camera.view, projection: camera.projection,
        target: state.slice(0, 3), distance: state[5], width: bounds.width, height: bounds.height,
        background, scale: 1 });
      previousCamera = camera; previousRevision = camera.revision;
      previousWidth = bounds.width; previousHeight = bounds.height;
      setFrame({ mode, background, width: bounds.width, height: bounds.height, revision: camera.revision, layout });
    };
    const unsubscribe = controller.subscribeViewport(update), resize = new ResizeObserver(update);
    if (scene.current) resize.observe(scene.current);
    window.addEventListener('resize', update);
    update();
    return () => {
      live = false; unsubscribe(); resize.disconnect(); window.removeEventListener('resize', update);
    };
  }, [controller, scene, mode, ready, background]);

  if (!ready || mode === 'none' || !frame || frame.mode !== mode || frame.background !== background) return null;
  const { layout } = frame;
  return <svg className="viewport-guides" aria-hidden="true" role="presentation" focusable="false" pointerEvents="none"
    viewBox={`0 0 ${frame.width} ${frame.height}`} data-guides-mode={mode} data-guides-step={layout.step}
    data-guides-camera-revision={frame.revision}>
    {layout.lines.map((line, index) => <line key={index} className={`viewport-guide-line viewport-guide-${line.kind}`}
      data-guide-kind={line.kind} data-guide-axis={line.axis} data-guide-direction={line.direction}
      data-guide-cell={line.cell} data-guide-major={line.major}
      data-world-from={line.worldFrom.join(',')} data-world-to={line.worldTo.join(',')}
      x1={line.from.x} y1={line.from.y} x2={line.to.x} y2={line.to.y}
      stroke={rgb(line.color)} strokeOpacity={line.color.a / 255} strokeWidth={line.width} />)}
    {layout.labels.map(label => <g key={label.text} className="viewport-guide-label" data-guide-axis={label.text}
      dominantBaseline="text-before-edge">
      <text className="viewport-guide-label-shadow" x={label.shadowX} y={label.shadowY} fill="var(--window)">{label.text}</text>
      <text className="viewport-guide-label-ink" x={label.x} y={label.y}
        fill={rgb(label.color)} fillOpacity={label.color.a / 255}>{label.text}</text>
    </g>)}
    {layout.origin && <circle className="viewport-guide-origin" data-guide-origin="true" cx={layout.origin.x} cy={layout.origin.y}
      r={layout.origin.radius} fill={rgb(layout.origin.color)} fillOpacity={layout.origin.color.a / 255} />}
  </svg>;
}
