import { IDENTITY_MATRIX, NEUTRAL_COLOR } from './defaults';
import type { BackgroundColor } from '../input/background';

export type RenderCamera = Readonly<{
  view: Float32Array<ArrayBuffer>; projection: Float32Array<ArrayBuffer>; eye: Float32Array<ArrayBuffer>;
  revision: number; background: BackgroundColor;
}>;
export const FRAME_BYTES = 320;
/** Canonical native/WebGPU frame. GL raster depth conversion never changes it. */
export function encodeGaussianFrame(scene: {count:number;stride:number;degree:number;duplicateSelectionGuarded:boolean},
  camera: RenderCamera, grade: number[], highlight: boolean, geometry: number[], selectedOnly: boolean,
  width: number, height: number, geometrySelectedOnly = selectedOnly, opacityScale = 1, opacitySelectedOnly = false) {
  if (!Number.isFinite(opacityScale) || opacityScale < 0 || opacityScale > 5) throw new RangeError('Opacity scale must be between 0 and 5.');
  opacityScale = Math.fround(opacityScale); opacitySelectedOnly = opacityScale !== 1 && opacitySelectedOnly;
  const values = new Float32Array(FRAME_BYTES / 4), words = new Uint32Array(values.buffer);
  const geometryActive = geometry.some((value,index) => value !== IDENTITY_MATRIX[index]);
  const geometryScope = geometryActive && geometrySelectedOnly;
  values.set(camera.view); values.set(camera.projection,16); values.set(camera.eye,32); values[35]=scene.degree;
  values.set([width,height,width*camera.projection[0]*.5,height*camera.projection[5]*.5],36);
  words.set([scene.count,scene.stride/4,Number(grade.some((value,i) => value !== NEUTRAL_COLOR[i])),Number(selectedOnly)],40);
  values.set(grade,44); values[59]=opacityScale; values.set(geometry,60);
  words.set([Number(geometryActive),Number(geometryScope),highlight ? scene.duplicateSelectionGuarded ? 2:1:0,
    opacityScale===1 ? 0:1|(opacitySelectedOnly?2:0)],76);
  return {values,words,geometryKey:geometry.join(',')+':'+geometryScope};
}
