import { useEffect, useRef, useState, type RefObject } from 'react';
import type { CameraController } from '../input/camera';
import type { TransformGizmoConfig, TransformGizmoFrame, TransformGizmoMode } from '../document/transformGizmo';
import type { TransformMatrix, TransformVec3 } from '../document/transformProtocol';
import { UI_SIZES, useUiPreferences } from '../app/uiPreferences';
import { GizmoDrawing } from './GizmoDrawing';

export function transformGizmoConfig(mode: TransformGizmoMode, widgetMatrix: TransformMatrix, pivot: TransformVec3,
  width: number, height: number, panelScale: number, local: boolean, snap: boolean,
  pointer: readonly [number, number]): TransformGizmoConfig {
  return { mode, widgetMatrix, pivot, viewport: { x: 0, y: 0, width, height }, panelScale, local, snap, pointer };
}

export function TransformGizmo({ camera, scene, mode, widgetMatrix, pivot, local, snap, pointer, capturedHandle, enabled }: {
  camera: CameraController | undefined; scene: RefObject<HTMLCanvasElement | null>; mode: TransformGizmoMode;
  widgetMatrix: TransformMatrix | null; pivot: TransformVec3; local: boolean; snap: boolean;
  pointer: readonly [number, number] | null; capturedHandle: number; enabled: boolean;
}) {
  const preference = useUiPreferences(), size = preference.previewSize ?? preference.size;
  const panelScale = UI_SIZES.find(info => info.size === size)!.panelScale;
  const [frame, setFrame] = useState<TransformGizmoFrame | null>(null);
  const latest = useRef({ mode, widgetMatrix, pivot, local, snap, pointer, panelScale });
  latest.current = { mode, widgetMatrix, pivot, local, snap, pointer, panelScale };
  useEffect(() => {
    let animation = 0, previousKey = '', previousMatrix: TransformMatrix | null = null, previousPivot: TransformVec3 | undefined;
    const update = () => {
      const bounds = scene.current?.getBoundingClientRect(), current = latest.current;
      if (camera && bounds && current.widgetMatrix) {
        const point = current.pointer ?? [-1, -1] as const;
        const key = `${camera.revision}:${bounds.width}:${bounds.height}:${current.mode}:${current.local}:${current.snap}:${current.panelScale}:${point[0]}:${point[1]}`;
        if (key !== previousKey || current.widgetMatrix !== previousMatrix || current.pivot !== previousPivot) {
          previousKey = key; previousMatrix = current.widgetMatrix; previousPivot = current.pivot;
          try {
            setFrame(camera.transformGizmoFrame(transformGizmoConfig(current.mode, current.widgetMatrix, current.pivot,
              bounds.width, bounds.height, current.panelScale, current.local, current.snap, point)));
          } catch { setFrame(null); }
        }
      } else if (previousMatrix) { previousMatrix = null; setFrame(null); }
      animation = requestAnimationFrame(update);
    };
    animation = requestAnimationFrame(update);
    return () => cancelAnimationFrame(animation);
  }, [camera, scene]);
  return frame ? <GizmoDrawing frame={frame} capturedHandle={capturedHandle} enabled={enabled} target="transform" /> : null;
}
