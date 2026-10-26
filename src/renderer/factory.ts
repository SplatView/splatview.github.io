import { canvasBackend,validateBackendPreference,type GraphicsBackend,type GraphicsBackendPreference } from './backend';
import type { SceneRenderer } from './contracts';
import { GaussianRenderer } from './webgpu/renderer';
import { GlRenderer } from './webgl2/renderer';
import type { RendererNegotiationObserver } from './webgpu/diagnostics';
import { validateSortPrecision, type SortPrecision } from './sortPrecision';

export type SceneRendererOptions={createCompute:()=>Promise<import('./webgl2/computeClient').RenderComputeClient>;preference:GraphicsBackendPreference;recoveryBackend?:GraphicsBackend;allowFallback:boolean;
  replaceCanvas?:(previous:HTMLCanvasElement)=>Promise<HTMLCanvasElement>;observe?:RendererNegotiationObserver;
  fallback?:(reason:string)=>void;sortPrecision?:SortPrecision};
/** Startup choice only. Recovery pins the previously selected API. */
export async function createSceneRenderer(initialCanvas:HTMLCanvasElement,options:SceneRendererOptions):Promise<SceneRenderer> {
  const preference=validateBackendPreference(options.preference),backend=options.recoveryBackend??(preference==='auto'?'webgpu':preference);
  const precision=validateSortPrecision(options.sortPrecision??32);
  const configure=(renderer:SceneRenderer)=>{renderer.displaySortPrecision=precision;return renderer;};
  let canvas=initialCanvas;
  const replace=async()=>{
    if(!options.replaceCanvas) throw new Error('A new presentation canvas is required to restore graphics. Your document is retained.');
    const next=await options.replaceCanvas(canvas);
    if(next===canvas || canvasBackend(next)) throw new Error('The replacement graphics canvas is already in use.');
    canvas=next;
  };
  if(canvasBackend(canvas) && (canvasBackend(canvas)!==backend || backend==='webgl2')) await replace();
  if(backend==='webgl2') return configure(await GlRenderer.create(canvas,options.createCompute,options.observe));
  try { return configure(await GaussianRenderer.create(canvas,options.observe)); }
  catch(error) {
    if(options.recoveryBackend || preference!=='auto' || !options.allowFallback) throw error;
    const reason=error instanceof Error?error.message:String(error); options.fallback?.(reason);
    if(canvasBackend(canvas)) await replace();
    return configure(await GlRenderer.create(canvas,options.createCompute,options.observe));
  }
}
