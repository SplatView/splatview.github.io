import { useEffect, useRef, useState, type RefObject } from 'react';
import type { CameraController } from '../input/camera';
import type { SelectionFilterKind, SelectionFilterParameters } from '../document/filterProtocol';
import { UI_SIZES, useUiPreferences } from '../app/uiPreferences';
import { useTranslation } from '../app/useLanguageAppearance';
import { projectAlignmentSegment } from './AlignmentControls';
import { FloatingSelectionActions } from './FloatingSelectionActions';

export type FilterDisplaySegment = readonly [readonly number[], readonly number[]];
// Display-only adaptation of Capture02 viewport_tools.cpp:472-484,692-726.
// It draws an enclosure and never classifies a splat or constructs a mask.
export function filterDisplaySegments(kind: SelectionFilterKind, parameters: SelectionFilterParameters): FilterDisplaySegment[] {
  if (kind === 'opacity' || kind === 'scale') return [];
  const size = kind === 'sphere' ? [parameters.radius, parameters.radius, parameters.radius] : kind === 'frustum' ? [1, 1, 1] : parameters.size;
  if (![...parameters.center, ...size, ...(kind === 'sphere' ? [] : parameters.rotation),
    ...(kind === 'frustum' ? [parameters.fov, parameters.aspect, parameters.near, parameters.far] : [])].every(Number.isFinite)) return [];
  const rotation = parameters.rotation.every(Number.isFinite) ? parameters.rotation : [0, 0, 0];
  const length = Math.hypot(...rotation), angle = length * Math.PI / 180;
  const axis = length ? rotation.map(value => value / length) : [0, 0, 1], cosine = Math.cos(angle), sine = Math.sin(angle);
  const transform = (point: readonly number[]) => {
    const p = point.map((value, index) => value * Math.max(1e-6, size[index]));
    const dot = axis[0] * p[0] + axis[1] * p[1] + axis[2] * p[2];
    const cross = [axis[1] * p[2] - axis[2] * p[1], axis[2] * p[0] - axis[0] * p[2], axis[0] * p[1] - axis[1] * p[0]];
    return p.map((value, index) => parameters.center[index] + value * cosine + cross[index] * sine + axis[index] * dot * (1 - cosine));
  };
  const segments: FilterDisplaySegment[] = [];
  if (kind === 'box' || kind === 'frustum') {
    const corners = Array.from({ length: 8 }, (_, index) => {
      const p = [index & 1 ? .5 : -.5, index & 2 ? .5 : -.5, index & 4 ? .5 : -.5];
      if (kind === 'frustum') {
        const depth = index & 4 ? parameters.far : parameters.near, height = depth * Math.tan(parameters.fov * Math.PI / 360);
        p[0] *= 2 * height * parameters.aspect; p[1] *= 2 * height; p[2] = -depth;
      }
      return transform(p);
    });
    for (let index = 0; index < 8; index++) for (const bit of [1, 2, 4]) if (!(index & bit)) segments.push([corners[index], corners[index | bit]]);
  } else {
    for (let plane = 0; plane < 3; plane++) for (let index = 0; index < 64; index++) {
      const at = (step: number) => {
        const theta = step * 2 * Math.PI / 64, cosine = Math.cos(theta), sine = Math.sin(theta);
        return transform(plane === 0 ? [0, cosine, sine] : plane === 1 ? [cosine, 0, sine] : [cosine, sine, 0]);
      };
      segments.push([at(index), at(index + 1)]);
    }
  }
  return segments;
}

export function FilterOverlay({ kind, parameters, camera, scene, showVolume, picking, pending, cursor, captured, chromeVisible, finishEnabled, undoEnabled, clearEnabled, onConfirm, onUndo, onClear }: {
  kind: SelectionFilterKind; parameters: SelectionFilterParameters; camera: CameraController | undefined;
  scene: RefObject<HTMLCanvasElement | null>; showVolume: boolean; picking: boolean; pending: boolean;
  cursor: readonly [number, number] | null; captured: boolean; chromeVisible: boolean; finishEnabled: boolean; undoEnabled: boolean; clearEnabled: boolean;
  onConfirm(): void; onUndo(): void; onClear(): void;
}) {
  const { t } = useTranslation();
  const preference = useUiPreferences(), size = preference.previewSize ?? preference.size;
  const scale = UI_SIZES.find(info => info.size === size)!.panelScale;
  const [segments, setSegments] = useState<([[number, number], [number, number]])[]>([]);
  const lastKey = useRef('');
  useEffect(() => {
    const display = showVolume ? filterDisplaySegments(kind, parameters) : []; let frame = 0;
    const update = () => {
      const canvas = scene.current, bounds = canvas?.getBoundingClientRect();
      if (!bounds) { frame = requestAnimationFrame(update); return; }
      const key = `${camera?.revision}:${bounds.width}:${bounds.height}:${showVolume}`;
      if (key !== lastKey.current) {
        lastKey.current = key;
        setSegments(camera ? display.map(([a, b]) => projectAlignmentSegment(a, b, camera.view, camera.projection, bounds.width, bounds.height))
          .filter((segment): segment is [[number, number], [number, number]] => segment !== null) : []);
      }
      frame = requestAnimationFrame(update);
    };
    lastKey.current = ''; frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [kind, parameters, camera, scene, showVolume, captured, picking, scale]);
  return <>
    {showVolume && kind !== 'opacity' && kind !== 'scale' && <svg className="filter-volume-overlay" data-filter-volume={kind} aria-hidden="true">
      {segments.map(([a, b], index) => <line key={index} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} strokeWidth={(kind === 'sphere' || kind === 'ellipsoid' ? 1.2 : 1.5) * scale} />)}
    </svg>}
    {picking && <>
      {cursor && <svg className="filter-volume-overlay filter-pick-crosshair" aria-hidden="true"><path d={`M${cursor[0] - 8 * scale} ${cursor[1]}h${16 * scale}M${cursor[0]} ${cursor[1] - 8 * scale}v${16 * scale}`} strokeWidth={1.5 * scale} /></svg>}
      <div className="filter-pick-caption" role="status">{t(pending ? 'Picking filter center…' : 'Pick filter center | Click a splat | Esc cancel | Middle drag orbit')}</div>
    </>}
    <FloatingSelectionActions scene={scene} kind="filter" enabled={!picking && !pending} chromeVisible={chromeVisible} captured={captured}
      scale={scale} finishEnabled={finishEnabled} undoEnabled={undoEnabled} clearEnabled={clearEnabled}
      onFinish={onConfirm} onUndo={onUndo} onClear={onClear} />
  </>;
}
