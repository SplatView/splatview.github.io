import { createProgram, depth32, framebuffer, FULLSCREEN_VERTEX, texture2d } from './gl';

export const WEBGL_CONTEXT_ATTRIBUTES: WebGLContextAttributes = Object.freeze({ alpha: false, antialias: false,
  depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
export type WebglCapabilities = Readonly<{
  maxTextureSize: number; maxRenderbufferSize: number; maxViewport: readonly [number, number];
  maxVertexTextureUnits: number; maxFragmentTextureUnits: number; maxCombinedTextureUnits: number;
  maxDrawBuffers: number; maxColorAttachments: number;
  fragmentFloatPrecision: number; fragmentIntPrecision: number;
  extensions: readonly string[]; enabledExtensions:readonly string[]; version: string; shadingLanguageVersion: string;
  vendor: string; renderer: string; unmaskedVendor: string | null; unmaskedRenderer: string | null;
  steady: boolean; steadyReason: string | null;
}>;

/** The exact four-output layout, including full-precision coverage metadata. */
function probeSteady(gl: WebGL2RenderingContext): string | null {
  if (!gl.getExtension('EXT_color_buffer_float')) return 'Floating-point color targets are unavailable.';
  if (gl.getParameter(gl.MAX_DRAW_BUFFERS) < 4 || gl.getParameter(gl.MAX_COLOR_ATTACHMENTS) < 4)
    return 'Four simultaneous color attachments are unavailable.';
  if (gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS)<10 || gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS)<13)
    return 'The texture units required for reconstruction are unavailable.';
  const textures: WebGLTexture[] = [], targets: WebGLFramebuffer[] = [];
  let depth: WebGLRenderbuffer | undefined, program: WebGLProgram | undefined;
  try {
    for (const format of [gl.RGBA16F, gl.RGBA32UI, gl.RGBA32F, gl.R32F]) textures.push(texture2d(gl, 2, 2, format));
    depth = depth32(gl, 2, 2); targets.push(framebuffer(gl, textures, depth));
    program = createProgram(gl, FULLSCREEN_VERTEX, `#version 300 es
precision highp float; precision highp int;
layout(location=0) out vec4 rawColor;
layout(location=1) out uvec4 sampleData;
layout(location=2) out vec4 axes;
layout(location=3) out float opacity;
void main() { rawColor=vec4(.5,.25,.75,1.); sampleData=uvec4(16777217u,0u,0u,0u); axes=vec4(1.25,-2.5,3.75,4.); opacity=.1234567; }`);
    gl.viewport(0,0,2,2); gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.useProgram(program); gl.drawArrays(gl.TRIANGLES,0,3);
    const id = new Uint32Array(4); gl.readBuffer(gl.COLOR_ATTACHMENT1); gl.readPixels(0,0,1,1,gl.RGBA_INTEGER,gl.UNSIGNED_INT,id);
    const alpha = new Float32Array(4); gl.readBuffer(gl.COLOR_ATTACHMENT3); gl.readPixels(0,0,1,1,gl.RGBA,gl.FLOAT,alpha);
    if (gl.getError() !== gl.NO_ERROR || id[0] !== 16777217 || Math.abs(alpha[0] - .1234567) > 1e-7)
      return 'Mixed integer/float render targets did not preserve source IDs and opacity.';
    // FIFO targets need four simultaneous integer attachments too.
    const histories: WebGLTexture[] = [];
    for (let i=0;i<4;i++) { const texture=texture2d(gl,2,2,gl.RGBA32UI); histories.push(texture); textures.push(texture); }
    targets.push(framebuffer(gl,histories));
    return null;
  } catch (error) { return error instanceof Error ? error.message : String(error); }
  finally {
    gl.bindFramebuffer(gl.FRAMEBUFFER,null); gl.useProgram(null);
    for (const target of targets) gl.deleteFramebuffer(target);
    for (const texture of textures) gl.deleteTexture(texture);
    if (depth) gl.deleteRenderbuffer(depth); if (program) gl.deleteProgram(program);
    // A refused optional layout must not poison the ordinary sorted renderer.
    for (let i=0;i<16 && gl.getError()!==gl.NO_ERROR;i++) { /* Drain bounded probe errors. */ }
  }
}

/** Capability evidence is observed, never inferred from a browser/GPU brand. */
export function observeWebglCapabilities(gl: WebGL2RenderingContext): WebglCapabilities {
  if (gl.isContextLost()) throw new Error('The WebGL2 context was lost during initialization.');
  const size = (name: number) => {
    const value = gl.getParameter(name);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('The graphics context returned invalid resource limits.');
    return value as number;
  };
  const viewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array;
  if (viewport.length !== 2 || Array.from(viewport).some(v => !Number.isSafeInteger(v) || v < 1)) throw new Error('Invalid graphics viewport limits.');
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  const steadyReason = probeSteady(gl);
  const caps: WebglCapabilities = {
    maxTextureSize:size(gl.MAX_TEXTURE_SIZE), maxRenderbufferSize:size(gl.MAX_RENDERBUFFER_SIZE),
    maxViewport:[viewport[0],viewport[1]], maxVertexTextureUnits:size(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS),
    maxFragmentTextureUnits:size(gl.MAX_TEXTURE_IMAGE_UNITS), maxCombinedTextureUnits:size(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS),
    maxDrawBuffers:size(gl.MAX_DRAW_BUFFERS), maxColorAttachments:size(gl.MAX_COLOR_ATTACHMENTS),
    fragmentFloatPrecision:gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER,gl.HIGH_FLOAT)?.precision ?? 0,
    fragmentIntPrecision:gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER,gl.HIGH_INT)?.rangeMax ?? 0,
    extensions:Object.freeze([...(gl.getSupportedExtensions() ?? [])].sort()), version:String(gl.getParameter(gl.VERSION)),
    enabledExtensions:Object.freeze([...(debug?['WEBGL_debug_renderer_info']:[]),...(gl.getExtension('EXT_color_buffer_float')?['EXT_color_buffer_float']:[])].sort()),
    shadingLanguageVersion:String(gl.getParameter(gl.SHADING_LANGUAGE_VERSION)), vendor:String(gl.getParameter(gl.VENDOR)),
    renderer:String(gl.getParameter(gl.RENDERER)), unmaskedVendor:debug ? String(gl.getParameter(debug.UNMASKED_VENDOR_WEBGL)) : null,
    unmaskedRenderer:debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : null, steady:steadyReason===null, steadyReason,
  };
  if (caps.fragmentFloatPrecision < 23 || caps.fragmentIntPrecision < 30 || caps.maxVertexTextureUnits < 3 || caps.maxCombinedTextureUnits < 3)
    throw new Error('The graphics context lacks the precision or texture units required for Gaussian rendering.');
  if (gl.isContextLost()) throw new Error('The WebGL2 context was lost during capability probing.');
  return Object.freeze(caps);
}
