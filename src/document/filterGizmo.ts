import type { SelectionFilterKind, SelectionFilterParameters } from './filterProtocol';

export type FilterGizmoMode = 'move' | 'rotate' | 'scale';
export type FilterGizmoPose = Pick<SelectionFilterParameters, 'center' | 'rotation' | 'size' | 'radius'>;

export type FilterGizmoConfig = {
  kind: SelectionFilterKind; mode: FilterGizmoMode; parameters: SelectionFilterParameters;
  viewport: { x: number; y: number; width: number; height: number };
  panelScale: number; local: boolean; snap: boolean; showVolume: boolean;
  pointer: readonly [number, number];
};
export type FilterGizmoPrimitive = {
  handle: number; role: 0 | 1 | 2 | 3 | 4; type: 0 | 1 | 2 | 3;
  points: readonly [number, number, number, number, number, number, number, number]; weight: number;
};
export type FilterGizmoFrame = {
  primitives: readonly FilterGizmoPrimitive[]; hitHandle: number; center: readonly [number, number];
};
declare const filterGizmoSessionBrand: unique symbol;
export type FilterGizmoSession = Readonly<{ [filterGizmoSessionBrand]: true }>;
