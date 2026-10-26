import { expect, it, vi } from 'vitest';
import { preparePrograms } from '../src/renderer/webgl2/programPreparation';

function fixture(parallel: boolean) {
  const log: string[] = [], deletedPrograms: object[] = [], deletedShaders: object[] = [];
  let complete = !parallel, lost = false, linked = true;
  const gl = { VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, LINK_STATUS: 3,
    getExtension: () => parallel ? { COMPLETION_STATUS_KHR: 4 } : null,
    createShader: () => ({}), shaderSource: () => {}, compileShader: () => log.push('compile'),
    createProgram: () => ({}), attachShader: () => {}, linkProgram: () => log.push('link'),
    getProgramParameter: (_program: object, kind: number) => { log.push(kind === 4 ? 'completion' : 'status'); return kind === 4 ? complete : linked; },
    getProgramInfoLog: () => 'shader diagnostic', getShaderInfoLog: () => '', isContextLost: () => lost,
    deleteProgram: (value: object) => deletedPrograms.push(value), deleteShader: (value: object) => deletedShaders.push(value),
  } as unknown as WebGL2RenderingContext;
  return { gl, log, deletedPrograms, deletedShaders, ready: () => { complete = true; }, fail: () => { linked = false; }, lose: () => { complete = true; lost = true; } };
}
const sources = [{ vertex: 'a', fragment: 'b' }, { vertex: 'c', fragment: 'd' }];
it('submits the complete batch before checking status, including without the optional extension', async () => {
  const f = fixture(false); expect(await preparePrograms(f.gl, sources)).toHaveLength(2);
  expect(f.log).toEqual(['compile', 'compile', 'link', 'compile', 'compile', 'link', 'status', 'status']);
  expect(f.deletedShaders).toHaveLength(4); expect(f.deletedPrograms).toHaveLength(0);
});
it('waits without blocking, then checks link status and cleans failed objects', async () => {
  vi.useFakeTimers();
  try { const f = fixture(true), task = preparePrograms(f.gl, sources); void task.catch(() => undefined);
    expect(f.log).not.toContain('status'); f.ready(); f.fail(); await vi.runAllTimersAsync();
    await expect(task).rejects.toThrow('shader diagnostic'); expect(f.deletedPrograms).toHaveLength(2); expect(f.deletedShaders).toHaveLength(4);
  } finally { vi.useRealTimers(); }
});
it('treats completion during context loss as retirement rather than a successful link', async () => {
  vi.useFakeTimers();
  try { const f = fixture(true), task = preparePrograms(f.gl, sources); void task.catch(() => undefined); f.lose();
    await vi.runAllTimersAsync(); await expect(task).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.log).not.toContain('status'); expect(f.deletedPrograms).toHaveLength(2);
  } finally { vi.useRealTimers(); }
});
