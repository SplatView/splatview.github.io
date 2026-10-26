import type { AppController } from '../src/app/controller';
import { GlRenderer } from '../src/renderer/webgl2/renderer';
import { GlScene } from '../src/renderer/webgl2/scene';
import { requireGaussianScene, requireWebGpuRenderer } from './gaussian-harness-scene';

/** Read the actual graphics allocation; a host/worker mirror is not an oracle. */
export async function gaussianStorage(app: AppController) {
  const scene = app.scene;
  if (!scene || scene.kind !== 'gaussian' || scene.count > 4096)
    throw new Error('The graphics storage oracle requires a bounded Gaussian fixture.');
  if (app.renderer instanceof GlRenderer) {
    if (!(scene instanceof GlScene)) throw new Error('The GL storage belongs to another renderer.');
    await app.renderer.finish();
    const { gl } = app.renderer, previous = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const pack = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING) as WebGLBuffer | null;
    const target = gl.createFramebuffer();
    if (!target) throw new Error('The GL storage readback could not allocate its framebuffer.');
    try {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, target); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      const read = (texture: WebGLTexture, width: number, entries: number) => {
        gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
        gl.readBuffer(gl.COLOR_ATTACHMENT0);
        if (gl.checkFramebufferStatus(gl.READ_FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
          throw new Error('The actual GL integer storage is not readable.');
        const result = new Uint32Array(entries), row = new Uint32Array(Math.min(width, entries) * 4);
        for (let first = 0; first < entries; first += width) {
          const count = Math.min(width, entries - first);
          gl.readPixels(0, first / width, count, 1, gl.RGBA_INTEGER, gl.UNSIGNED_INT, row);
          for (let x = 0; x < count; x++) result[first + x] = row[x * 4];
        }
        if (gl.getError() !== gl.NO_ERROR) throw new Error('The actual GL integer readback failed.');
        return result;
      };
      return { source: read(scene.words, scene.layout.words.width, scene.count * scene.stride / 4).buffer,
        masks: read(scene.snapshotMasks().texture, scene.layout.states.width, scene.count) };
    } finally {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, previous); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pack); gl.deleteFramebuffer(target);
    }
  }
  const renderer = requireWebGpuRenderer(app.renderer), gpu = requireGaussianScene(scene);
  const read = async (buffer: GPUBuffer, size: number) => {
    const readback = renderer.device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    try {
      const encoder = renderer.device.createCommandEncoder(); encoder.copyBufferToBuffer(buffer, 0, readback, 0, size);
      renderer.device.queue.submit([encoder.finish()]); await readback.mapAsync(GPUMapMode.READ);
      const bytes = readback.getMappedRange().slice(0); readback.unmap(); return bytes;
    } finally { readback.destroy(); }
  };
  return { source: await read(gpu.buffers.splats, gpu.count * gpu.stride),
    masks: new Uint32Array(await read(gpu.buffers.states, gpu.count * 4)) };
}
