import { useEffect, useRef, useState, type RefObject } from 'react';
import type { CameraController, FilterGizmoConfig, FilterGizmoFrame } from '../input/camera';
import type { FilterGizmoMode } from '../document/filterGizmo';
import type { SelectionFilterKind, SelectionFilterParameters } from '../document/filterProtocol';
import { UI_SIZES, useUiPreferences } from '../app/uiPreferences';
import { GizmoDrawing } from './GizmoDrawing';

// Native supplies the geometry and hit result. These shapes only present the
// fixed-size frame; no ray, rotation, scaling or snap math lives in this UI.
export const FilterGizmoDrawing = GizmoDrawing;

export function filterGizmoConfig(kind: SelectionFilterKind, mode: FilterGizmoMode, parameters: SelectionFilterParameters,
  width: number, height: number, panelScale: number, local: boolean, snap: boolean, showVolume: boolean,
  pointer: readonly [number, number]): FilterGizmoConfig {
  return { kind, mode, parameters, viewport: { x: 0, y: 0, width, height }, panelScale, local, snap, showVolume, pointer };
}

export function FilterGizmo({ camera, scene, kind, mode, parameters, local, snap, showVolume, pointer, capturedHandle, enabled }: {
  camera: CameraController | undefined; scene: RefObject<HTMLCanvasElement | null>; kind: SelectionFilterKind;
  mode: FilterGizmoMode; parameters: SelectionFilterParameters; local: boolean; snap: boolean; showVolume: boolean;
  pointer: readonly [number, number] | null; capturedHandle: number; enabled: boolean;
}) {
  const preference = useUiPreferences(), size = preference.previewSize ?? preference.size;
  const panelScale = UI_SIZES.find(info => info.size === size)!.panelScale;
  const [frame, setFrame] = useState<FilterGizmoFrame | null>(null);
  const latest = useRef({ kind, mode, parameters, local, snap, showVolume, pointer, panelScale });
  latest.current = { kind, mode, parameters, local, snap, showVolume, pointer, panelScale };
  useEffect(() => {
    let animation = 0, previousKey = '', previousParameters: SelectionFilterParameters | undefined;
    const update = () => {
      const bounds = scene.current?.getBoundingClientRect(), current = latest.current;
      if (camera && bounds) {
        const point = current.pointer ?? [-1, -1] as const;
        const key = `${camera.revision}:${bounds.width}:${bounds.height}:${current.kind}:${current.mode}:${current.local}:${current.snap}:${current.showVolume}:${current.panelScale}:${point[0]}:${point[1]}`;
        if (key !== previousKey || current.parameters !== previousParameters) {
          previousKey = key; previousParameters = current.parameters;
          try {
            setFrame(camera.filterGizmoFrame(filterGizmoConfig(current.kind, current.mode, current.parameters,
              bounds.width, bounds.height, current.panelScale, current.local, current.snap, current.showVolume, point)));
          } catch {
            // A refused scratch allocation or invalid staged definition cannot
            // acquire a parameter gesture or change its selection baseline.
            setFrame(null);
          }
        }
      }
      animation = requestAnimationFrame(update);
    };
    animation = requestAnimationFrame(update);
    return () => cancelAnimationFrame(animation);
  }, [camera, scene]);
  return frame ? <FilterGizmoDrawing frame={frame} capturedHandle={capturedHandle} enabled={enabled} /> : null;
}
