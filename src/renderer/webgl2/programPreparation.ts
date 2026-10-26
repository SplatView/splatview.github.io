export type ProgramSources = Readonly<{ vertex: string; fragment: string }>;

/** Submit all compilation/link work before asking for status. Optional parallel
 * compilation keeps the event loop available; the ordinary GL2 fallback works
 * without the extension. Every pending object has this single preparation owner.
 */
export async function preparePrograms(gl: WebGL2RenderingContext, sources: readonly ProgramSources[],
  current: () => boolean = () => true): Promise<WebGLProgram[]> {
  const programs: WebGLProgram[] = [], shaders: WebGLShader[] = [];
  const check = () => {
    if (!current() || gl.isContextLost()) throw new DOMException('Program preparation was retired.', 'AbortError');
  };
  try {
    check();
    const parallel = gl.getExtension('KHR_parallel_shader_compile');
    for (const source of sources) {
      const program = gl.createProgram(); if (!program) throw new Error('The graphics program could not be allocated.');
      programs.push(program);
      for (const [type, text] of [[gl.VERTEX_SHADER, source.vertex], [gl.FRAGMENT_SHADER, source.fragment]] as const) {
        const shader = gl.createShader(type); if (!shader) throw new Error('The graphics shader could not be allocated.');
        shaders.push(shader); gl.shaderSource(shader, text); gl.compileShader(shader); gl.attachShader(program, shader);
      }
      gl.linkProgram(program);
    }
    if (parallel) {
      while (programs.some(program => !gl.getProgramParameter(program, parallel.COMPLETION_STATUS_KHR))) {
        check(); await new Promise<void>(resolve => setTimeout(resolve, 1));
      }
    }
    check();
    for (const program of programs) if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(program) || shaders.map(shader => gl.getShaderInfoLog(shader)).filter(Boolean).join('\n') || 'The graphics program did not link.');
    return programs;
  } catch (error) { for (const program of programs) gl.deleteProgram(program); throw error; }
  finally { for (const shader of shaders) gl.deleteShader(shader); }
}
