import { checkedBytes } from '../../document/resources';
import type { WebglCapabilities } from './capabilities';

export const GL_STEADY_PIXEL_BYTES=224;
export const GL_STEADY_NOISE_BYTES=32*32*64;
export const GL_STEADY_UNIFORM_BYTES=240;
export function planGlSteady(width:number,height:number,caps:Pick<WebglCapabilities,'maxTextureSize'|'maxRenderbufferSize'|'maxViewport'|'steady'|'steadyReason'>) {
  if(!caps.steady) throw new Error(caps.steadyReason??'SteadySplats render targets are unavailable.');
  if(![width,height].every(Number.isSafeInteger) || width<1 || height<1 || width>caps.maxTextureSize || height>caps.maxTextureSize ||
    width>caps.maxRenderbufferSize || height>caps.maxRenderbufferSize || width>caps.maxViewport[0] || height>caps.maxViewport[1])
    throw new RangeError('The SteadySplats viewport exceeds the WebGL2 device limit.');
  return Object.freeze({width,height,bytes:checkedBytes(checkedBytes(width,height),GL_STEADY_PIXEL_BYTES)+GL_STEADY_NOISE_BYTES+GL_STEADY_UNIFORM_BYTES});
}
