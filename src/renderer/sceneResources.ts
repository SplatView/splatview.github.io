import { checkedBytes,estimateSceneBytes,MiB } from '../document/resources';
import type { GraphicsBackend } from './backend';
import { planGlScene } from './webgl2/sceneLayout';

/** Native memory stays authoritative; each graphics backend charges its own mirror. */
export function estimateRendererSceneBytes(count:number,degree:number,backend:GraphicsBackend='webgpu') {
  if(backend==='webgpu') return estimateSceneBytes(count,degree);
  // Small-limit devices refuse impossible textures during backend admission.
  // The fixed allowance covers narrower-row padding and driver bookkeeping.
  return checkedBytes(count,144)+planGlScene(count,degree,16384).bytes+4*MiB;
}
