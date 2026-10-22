import type { FilterGizmoFrame, FilterGizmoMode, FilterGizmoPrimitive } from './filterGizmo';
import type { TransformMatrix, TransformVec3 } from './transformProtocol';

/** Matrices returned by native math use the GPU/internal translation12/13/14 layout. */
export type TransformComposition = { matrix: TransformMatrix; pivot: TransformVec3 };
export type TransformGizmoMode = FilterGizmoMode;
export type TransformGizmoFrame = FilterGizmoFrame;
export type TransformGizmoPrimitive = FilterGizmoPrimitive;
export type TransformGizmoConfig = {
  mode: TransformGizmoMode;
  viewport: { x: number; y: number; width: number; height: number };
  panelScale: number; local: boolean; snap: boolean;
  pointer: readonly [number, number]; pivot: TransformVec3; widgetMatrix: TransformMatrix;
};
/** Both delta layouts are emitted natively; the host never transposes a matrix. */
export type TransformGizmoPose = {
  widgetMatrix: TransformMatrix; deltaMatrix: TransformMatrix; rowMajorDelta: TransformMatrix;
};
declare const transformGizmoSessionBrand: unique symbol;
export type TransformGizmoSession = Readonly<{ [transformGizmoSessionBrand]: true }>;
