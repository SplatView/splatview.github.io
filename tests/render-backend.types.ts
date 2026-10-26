import type { GaussianScene,GeometryScene,SceneRenderer } from '../src/renderer/contracts';
import type { GpuScene,GpuGeometryScene,GaussianRenderer } from '../src/renderer/webgpu/renderer';
import type { GlScene } from '../src/renderer/webgl2/scene';
import type { GlGeometryScene } from '../src/renderer/webgl2/geometry';
import type { GlRenderer } from '../src/renderer/webgl2/renderer';

declare const gpu:GaussianRenderer,gl:GlRenderer,gpuScene:GpuScene,glScene:GlScene,gpuGeometry:GpuGeometryScene,glGeometry:GlGeometryScene;
const renderers:SceneRenderer[]=[gpu,gl];
const gaussians:GaussianScene[]=[gpuScene,glScene];
const geometries:GeometryScene[]=[gpuGeometry,glGeometry];
void [renderers,gaussians,geometries];
