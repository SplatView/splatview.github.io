
const locations = new WeakMap<WebGLProgram, Map<string, WebGLUniformLocation | null>>();
const blocks = new WeakMap<WebGLProgram, Map<string, number>>();
const samplers = new WeakMap<WebGLProgram, Map<string, number>>();
export function samplerUniform(gl: WebGL2RenderingContext, program: WebGLProgram, name: string, unit: number) {
  let cache = samplers.get(program); if (!cache) { cache = new Map(); samplers.set(program, cache); }
  if (cache.get(name) !== unit) { gl.uniform1i(uniformLocation(gl, program, name), unit); cache.set(name, unit); }
}
/** Program objects are context-owned; retired programs cannot serve a new epoch. */
export function uniformLocation(gl: WebGL2RenderingContext, program: WebGLProgram, name: string) {
  let cache = locations.get(program); if (!cache) { cache = new Map(); locations.set(program, cache); }
  if (!cache.has(name)) cache.set(name, gl.getUniformLocation(program, name));
  return cache.get(name)!;
}
export function uniformBlock(gl: WebGL2RenderingContext, program: WebGLProgram, name: string, binding: number) {
  let cache = blocks.get(program); if (!cache) { cache = new Map(); blocks.set(program, cache); }
  if (!cache.has(name)) { const index = gl.getUniformBlockIndex(program, name); cache.set(name, index);
    if (index !== gl.INVALID_INDEX) gl.uniformBlockBinding(program, index, binding); }
  return cache.get(name)!;
}

/** WebGL objects and synchronization stay inside their backend. */
export function createProgram(gl: WebGL2RenderingContext, vertex: string, fragment: string): WebGLProgram {
  const shaders: WebGLShader[] = [];
  let program: WebGLProgram | null = null;
  try {
    for (const [type, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]] as const) {
      const shader = gl.createShader(type);
      if (!shader) throw new Error('The graphics shader could not be allocated.');
      shaders.push(shader); gl.shaderSource(shader, source); gl.compileShader(shader);

    }
    program = gl.createProgram();
    if (!program) throw new Error('The graphics program could not be allocated.');
    for (const shader of shaders) gl.attachShader(program, shader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'The graphics program did not link.');
    return program;
  } catch (error) { if (program) gl.deleteProgram(program); throw error; }
  finally { for (const shader of shaders) gl.deleteShader(shader); }
}

/** A real nonblocking fence. Cancellation never releases queued work early. */
export function finishGl(gl: WebGL2RenderingContext): Promise<void> {
  if (gl.isContextLost()) return Promise.resolve();
  const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  if (!sync) return Promise.reject(new Error('The graphics completion fence could not be allocated.'));
  gl.flush();
  return new Promise<void>((resolve, reject) => {
    const poll = () => {
      if (gl.isContextLost()) { gl.deleteSync(sync); resolve(); return; }
      const status = gl.clientWaitSync(sync, 0, 0);
      if (status === gl.TIMEOUT_EXPIRED) { setTimeout(poll, 1); return; }
      gl.deleteSync(sync);
      if (status === gl.WAIT_FAILED) {
        gl.finish(); reject(new Error('The graphics completion fence failed.')); return;
      }
      resolve();
    };
    poll();
  });
}

export function requireGlAllocation(gl: WebGL2RenderingContext, label: string) {
  const error = gl.getError();
  if (gl.isContextLost() || error !== gl.NO_ERROR) throw new Error(`${label} could not be allocated (${error}).`);
}

export function texture2d(gl: WebGL2RenderingContext, width: number, height: number, format: number) {
  const texture = gl.createTexture();
  if (!texture) throw new Error('The graphics texture could not be allocated.');
  try {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texStorage2D(gl.TEXTURE_2D, 1, format, width, height);
    requireGlAllocation(gl, 'The graphics texture'); return texture;
  } catch (error) { gl.deleteTexture(texture); throw error; }
}

export function framebuffer(gl: WebGL2RenderingContext, colors: WebGLTexture[], depth?: WebGLRenderbuffer) {
  const target = gl.createFramebuffer();
  if (!target) throw new Error('The graphics framebuffer could not be allocated.');
  try {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target);
    colors.forEach((texture, i) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, texture, 0));
    gl.drawBuffers(colors.map((_, i) => gl.COLOR_ATTACHMENT0 + i));
    if (depth) gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('The graphics framebuffer is incomplete.');
    requireGlAllocation(gl, 'The graphics framebuffer'); return target;
  } catch (error) { gl.deleteFramebuffer(target); throw error; }
}

export function depth32(gl: WebGL2RenderingContext, width: number, height: number) {
  const depth = gl.createRenderbuffer();
  if (!depth) throw new Error('The graphics depth target could not be allocated.');
  try {
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth); gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT32F, width, height);
    requireGlAllocation(gl, 'The graphics depth target'); return depth;
  } catch (error) { gl.deleteRenderbuffer(depth); throw error; }
}

export const FULLSCREEN_VERTEX = `#version 300 es
precision highp float;
void main() {
  vec2 p = gl_VertexID == 0 ? vec2(-1.,-1.) : gl_VertexID == 1 ? vec2(3.,-1.) : vec2(-1.,3.);
  gl_Position = vec4(p,0.,1.);
}`;
