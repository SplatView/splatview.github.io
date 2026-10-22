import { describe, expect, it, vi } from 'vitest';
import { NativeSummaryQuery } from '../src/workers/summaryQuery';
import type { WasmModule } from '../src/workers/wasm';

function fixture() {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 2 });
  const module = {
    HEAPU8: new Uint8Array(memory.buffer),
    _malloc: vi.fn(() => 64), _free: vi.fn(),
    _sv_command: vi.fn((pointer: number) => {
      expect(new TextDecoder().decode(module.HEAPU8.subarray(pointer, pointer + 22)))
        .toBe('{"command":"summary"}\0');
      return 128;
    }),
  };
  return { module, memory, core: module as unknown as WasmModule };
}

describe('module-owned native summary request', () => {
  it('allocates once and reuses the canonical request after heap growth and malloc refusal', () => {
    const { module, memory, core } = fixture(), query = new NativeSummaryQuery(core);
    module._malloc.mockReturnValue(0);
    expect(query.read()).toBe(128);
    memory.grow(1); module.HEAPU8 = new Uint8Array(memory.buffer);
    expect(query.read()).toBe(128);
    expect(module._malloc).toHaveBeenCalledTimes(1);
    expect(module._free).not.toHaveBeenCalled();
    query.dispose(); query.dispose();
    expect(module._free).toHaveBeenCalledExactlyOnceWith(64);
    expect(() => query.read()).toThrow('released');
  });

  it('refuses initialization before writing a null allocation', () => {
    const { module, core } = fixture(); module._malloc.mockReturnValue(0);
    const bytes = module.HEAPU8.slice();
    expect(() => new NativeSummaryQuery(core)).toThrow('initialize scene telemetry');
    expect(module.HEAPU8).toEqual(bytes);
    expect(module._free).not.toHaveBeenCalled();
    expect(module._sv_command).not.toHaveBeenCalled();
  });

  it('releases the input if the initial copy fails', () => {
    const { module, core } = fixture(); module._malloc.mockReturnValue(module.HEAPU8.byteLength);
    expect(() => new NativeSummaryQuery(core)).toThrow(RangeError);
    expect(module._free).toHaveBeenCalledExactlyOnceWith(module.HEAPU8.byteLength);
  });
});
