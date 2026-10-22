import { afterEach, describe, expect, it, vi } from 'vitest';
import { GaussianRenderer, type RenderableScene } from '../src/renderer/webgpu/renderer';
import { IDENTITY_MATRIX, NEUTRAL_COLOR } from '../src/document/types';
import { ResourceLedger } from '../src/document/resources';
import type { CameraController } from '../src/input/camera';

function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(options: { format?: string; geometry?: boolean; holdAllocation?: boolean; holdMap?: boolean; holdFence?: boolean } = {}) {
  vi.stubGlobal('GPUTextureUsage', { RENDER_ATTACHMENT: 16, COPY_SRC: 1 });
  vi.stubGlobal('GPUBufferUsage', { MAP_READ: 1, COPY_DST: 8 });
  vi.stubGlobal('GPUMapMode', { READ: 1 });
  const allocation = deferred(), mapping = deferred(), fence = deferred(), abort = new AbortController();
  if (!options.holdAllocation) allocation.resolve(); if (!options.holdMap) mapping.resolve(); if (!options.holdFence) fence.resolve();
  const events: string[] = [], ledger = new ResourceLedger(1024 * 1024);
  const rawRows = [[1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255], [11, 12, 13, 255, 14, 15, 16, 255, 17, 18, 19, 255]];
  let uniform: unknown[] | undefined, shade: unknown, readbackBytes = 0, capturedCopy: unknown;
  const texture = () => ({ createView: () => ({}), destroy: () => { events.push('texture-destroy'); return undefined; } });
  const device = {
    limits: { maxTextureDimension2D: 16384 }, pushErrorScope() {}, popErrorScope: () => allocation.promise.then(() => null),
    createTexture: texture,
    createBuffer(descriptor: { size: number }) {
      readbackBytes = descriptor.size; const bytes = new Uint8Array(descriptor.size).fill(231);
      rawRows.forEach((row, index) => bytes.set(row, index * 256));
      return { mapAsync: () => { events.push('map-start'); return mapping.promise; }, getMappedRange: () => bytes.buffer,
        unmap: () => { events.push('unmap'); return undefined; }, destroy: () => { events.push('readback-destroy'); return undefined; } };
    },
    createCommandEncoder: () => ({
      copyTextureToBuffer(_texture: unknown, buffer: unknown, size: unknown) { capturedCopy = { buffer, size }; }, finish: () => ({}),
    }),
    queue: { submit: () => { events.push('submit'); }, onSubmittedWorkDone: () => { events.push('fence-start'); return fence.promise; } },
  };
  const renderer = Object.assign(Object.create(GaussianRenderer.prototype), {
    canvas: { width: 3, height: 2 }, device, deviceEpoch: 1, format: options.format ?? 'rgba8unorm',
    uniform: (...args: unknown[]) => { uniform = args; }, prepare() {}, draw: (...args: unknown[]) => { shade = args[3]; },
    geometryUniform: (...args: unknown[]) => { uniform = args; }, drawGeometry: (...args: unknown[]) => { shade = args[4]; },
  }) as GaussianRenderer;
  const scene = { kind: options.geometry ? 'geometry' : 'gaussian', renderer, deviceEpoch: 1, revision: 7, retired: false } as unknown as RenderableScene;
  const camera = { view: new Float32Array(IDENTITY_MATRIX), projection: new Float32Array(IDENTITY_MATRIX),
    eye: new Float32Array([0, 0, 3]), revision: 2, background: 'white' } as unknown as CameraController;
  const operation = { signal: abort.signal, current: vi.fn(), admit: (bytes: number) => {
    const release = ledger.reserve('image', bytes); return () => { events.push('credit-release:' + bytes); release(); };
  } };
  return { renderer, scene, camera, operation, abort, ledger, events, allocation, mapping, fence, rawRows,
    uniform: () => uniform!, shade: () => shade, readbackBytes: () => readbackBytes, capturedCopy: () => capturedCopy };
}
afterEach(() => vi.unstubAllGlobals());

describe('owned raw image capture', () => {
  it.each(['rgba8unorm', 'bgra8unorm'])('copies only unpadded %s pixels and retains their genuine CPU credit until disposal', async format => {
    const f = fixture({ format }); const raw = await f.renderer.captureRgba(f.scene, f.camera, f.operation);
    const expected = f.rawRows.flat();
    if (format.startsWith('bgra')) for (let index = 0; index < expected.length; index += 4) [expected[index], expected[index + 2]] = [expected[index + 2], expected[index]];
    expect(raw.width).toBe(3); expect(raw.height).toBe(2); expect(Array.from(raw.pixels)).toEqual(expected);
    expect(f.readbackBytes()).toBe(512); expect(f.ledger.usage).toMatchObject({ bytes: 24, peakBytes: 560, allocations: 1 });
    expect(f.events.indexOf('fence-start')).toBeLessThan(f.events.indexOf('readback-destroy'));
    expect(f.events.filter(event => event === 'texture-destroy')).toHaveLength(1);
    const borrowedView = raw.pixels; raw.dispose(); raw.dispose();
    expect(borrowedView.byteLength).toBe(0); expect(f.ledger.usage).toMatchObject({ bytes: 0, allocations: 0 });
    expect(f.events.filter(event => event === 'credit-release:24')).toHaveLength(1);
  });

  it('snapshots camera, background, viewport, RGB, geometry and independent opacity scopes before asynchronous allocation', async () => {
    const f = fixture({ holdAllocation: true }), grade = [...NEUTRAL_COLOR], geometry = [...IDENTITY_MATRIX];
    grade[0] = 1.5; geometry[12] = .25;
    const capture = f.renderer.captureRgba(f.scene, f.camera, f.operation, grade, geometry, true, false, 2, true);
    f.camera.view[0] = 8; f.camera.projection[5] = 9; f.camera.eye[2] = 20; f.camera.background = 'black';
    f.renderer.canvas.width = 30; f.renderer.canvas.height = 20; grade[0] = 3; geometry[12] = 2;
    f.allocation.resolve(); const raw = await capture;
    try {
      const args = f.uniform(), captured = args[1] as CameraController;
      expect(captured.view[0]).toBe(1); expect(captured.projection[5]).toBe(1); expect(captured.eye[2]).toBe(3);
      expect(captured.background).toBe('white'); expect((args[2] as number[])[0]).toBe(1.5);
      expect((args[4] as number[])[12]).toBe(.25); expect(args.slice(5)).toEqual([true, 3, 2, false, 2, true, false]);
      expect(raw.width).toBe(3); expect(raw.height).toBe(2); expect(f.shade()).toBe(1);
    } finally { raw.dispose(); }
    expect(f.ledger.usage.bytes).toBe(0);
  });

  it('keeps all image credits and resources until a cancelled mapping and its submitted GPU fence both join', async () => {
    const f = fixture({ holdMap: true, holdFence: true });
    const capture = f.renderer.captureRgba(f.scene, f.camera, f.operation); const failure = expect(capture).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(f.events).toContain('map-start')); f.abort.abort();
    expect(f.ledger.usage.bytes).toBe(560); expect(f.events).not.toContain('readback-destroy');
    f.mapping.resolve(); await vi.waitFor(() => expect(f.events).toContain('fence-start'));
    expect(f.ledger.usage.bytes).toBe(560); expect(f.events).not.toContain('readback-destroy');
    f.fence.resolve(); await failure;
    expect(f.events).toContain('unmap'); expect(f.ledger.usage).toMatchObject({ bytes: 0, allocations: 0 });
  });

  it('refuses a changed scene before submitting capture work and retires every provisional allocation', async () => {
    const f = fixture({ holdAllocation: true });
    const capture = f.renderer.captureRgba(f.scene, f.camera, f.operation); const failure = expect(capture).rejects.toThrow('scene changed');
    (f.scene as unknown as { revision: number }).revision++; f.allocation.resolve(); await failure;
    expect(f.events).not.toContain('submit'); expect(f.events).not.toContain('fence-start');
    expect(f.events.filter(event => event === 'texture-destroy')).toHaveLength(1);
    expect(f.events).toContain('readback-destroy'); expect(f.ledger.usage).toMatchObject({ bytes: 0, allocations: 0 });
  });

  it('joins rejected device work before retiring geometry depth and both CPU/GPU admissions', async () => {
    const f = fixture({ geometry: true, holdMap: true, holdFence: true });
    const capture = f.renderer.captureRgba(f.scene, f.camera, f.operation); const failure = expect(capture).rejects.toThrow('device lost');
    await vi.waitFor(() => expect(f.events).toContain('map-start')); f.mapping.reject(new Error('device lost'));
    await vi.waitFor(() => expect(f.events).toContain('fence-start'));
    expect(f.ledger.usage.bytes).toBe(584); expect(f.events).not.toContain('texture-destroy');
    f.fence.reject(new Error('device lost')); await failure;
    expect(f.events.filter(event => event === 'texture-destroy')).toHaveLength(2);
    expect(f.ledger.usage).toMatchObject({ bytes: 0, allocations: 0 });
  });
});
