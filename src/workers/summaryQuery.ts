import type { WasmModule } from './wasm';

// The canonical request uses the native summary fast path. Keep its small input
// allocation for the module lifetime so failure telemetry needs no new native
// allocation. Its storage is part of the measured heap remainder, not scene C.
const REQUEST = new TextEncoder().encode('{"command":"summary"}\0');

export class NativeSummaryQuery {
  private pointer: number;

  constructor(private readonly module: WasmModule) {
    const pointer = module._malloc(REQUEST.byteLength);
    if (!pointer) throw new Error('There is not enough memory to initialize scene telemetry.');
    try { module.HEAPU8.set(REQUEST, pointer); }
    catch (error) { module._free(pointer); throw error; }
    this.pointer = pointer;
  }

  read(): number {
    if (!this.pointer) throw new Error('The scene telemetry query has been released.');
    return this.module._sv_command(this.pointer);
  }

  dispose(): void {
    const pointer = this.pointer;
    this.pointer = 0;
    if (pointer) this.module._free(pointer);
  }
}
