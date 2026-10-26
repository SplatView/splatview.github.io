/** The graphics API is independent of the sorted/SteadySplats algorithm. */
export type GraphicsBackendPreference = 'auto' | 'webgpu' | 'webgl2';
export type GraphicsBackend = Exclude<GraphicsBackendPreference, 'auto'>;
export function validateBackendPreference(value: unknown): GraphicsBackendPreference {
  if (value !== 'auto' && value !== 'webgpu' && value !== 'webgl2') throw new RangeError('Invalid graphics backend.');
  return value;
}
let epoch = 0;
export function nextRendererEpoch() { return ++epoch; }
const canvasBackends=new WeakMap<HTMLCanvasElement,GraphicsBackend>();
export function recordCanvasBackend(canvas:HTMLCanvasElement,backend:GraphicsBackend) { canvasBackends.set(canvas,backend); }
export function canvasBackend(canvas:HTMLCanvasElement) { return canvasBackends.get(canvas); }
