import { BUILD_DESCRIPTOR } from '../generated/buildIdentity';
import type { NativeSource } from '../build/bootstrap';
import { boundedInitialization, instantiateVerifiedModule, nativeModuleIdentity } from '../build/native';
import { assertSourceHashExports, type SourceHashExports } from './sourceHash';

export interface WasmModule extends SourceHashExports {
  HEAPU8: Uint8Array<ArrayBuffer>;
  HEAPF32: Float32Array<ArrayBuffer>;
  _malloc(bytes: number): number;
  _free(pointer: number): void;
  _sv_abi_version(): number;
  _sv_build_identity(): number;
  _sv_allocation_snapshot(): number;
  _sv_recovery_prepare(): number;
  _sv_recovery_read(offset: number, count: number): number;
  _sv_recovery_read_size(): number;
  _sv_recovery_release(): void;
  _sv_recovery_restore_begin(totalBytes: number, maximumGraphSplats: number, budgetBytes: number, expectedJson: number): number;
  _sv_recovery_restore_write(offset: number, pointer: number, length: number): number;
  _sv_recovery_restore_finish(): number;
  _sv_recovery_restore_cancel(): void;
  UTF8ToString(pointer: number): string;
  _sv_open(bytes: number, length: number, format: number, maxSplats: number, budgetBytes: number): number;
  _sv_open_group(block: number, blockBytes: number, descriptor: number, descriptorBytes: number,
    maxSplats: number, budgetBytes: number, nativeWorkBytes: number): number;
  _sv_command(text: number): number;
  _sv_live_preview(text: number): number;
  _sv_step(batch: number): number;
  _sv_scene_ptr(): number;
  _sv_states_ptr(): number;
  _sv_pack(first: number, count: number): number;
  _sv_pack_color_base(first: number, count: number): number;
  _sv_color_base_states_ptr(sessionId: number, baseId: number, epochId: number): number;
  _sv_pack_transform_base(id: number, baseId: number, epoch: number, first: number, count: number): number;
  _sv_transform_base_states_ptr(id: number, baseId: number, epoch: number): number;
  _sv_pack_opacity_base(id: number, baseId: number, epoch: number, first: number, count: number): number;
  _sv_opacity_base_states_ptr(id: number, baseId: number, epoch: number): number;
  _sv_pack_len(): number;
  _sv_geometry_range(channel: number, first: number, count: number): number;
  _sv_geometry_range_len(): number;
  _sv_output_ptr(): number;
  _sv_output_len(): number;
  _sv_spz4_output_bound?(count: number, degree: number): number;
  _sv_spz4_work_bound?(count: number, degree: number): number;
  _sv_export_output_bound?(format: number, count: number, degree: number): number;
  _sv_export_work_bound?(format: number, count: number, degree: number): number;
  _sv_map_write(mapId: number, offset: number, pointer: number, length: number): number;
}
export type ModuleFactory<T = WasmModule> = (options?: Record<string, unknown>) => Promise<T>;
export function wasmString<T>(module: WasmModule, text: string, callback: (pointer: number) => T): T {
  const bytes = new TextEncoder().encode(text + '\0');
  const pointer = module._malloc(bytes.byteLength);
  if (!pointer) throw new Error('There is not enough memory for this command.');
  try { module.HEAPU8.set(bytes, pointer); return callback(pointer); }
  finally { module._free(pointer); }
}
export async function loadCore(assetBase: string, source?: NativeSource, signal?: AbortSignal): Promise<WasmModule> {
  // Absolute base URL is passed by the main thread; the worker bundle can live
  // under assets/ while static WASM remains under wasm/.
  const resolved = new URL('wasm/splatview-core.mjs', assetBase);
  signal?.throwIfAborted();
  let module: WasmModule;
  if (source) module = await instantiateVerifiedModule<WasmModule>(source, signal);
  else {
    if (!import.meta.env.DEV) throw new Error('The application core requires verified deployment bytes.');
    const imported = await boundedInitialization(import(/* @vite-ignore */ resolved.href), signal) as { default: ModuleFactory };
    signal?.throwIfAborted(); module = await boundedInitialization(imported.default(), signal); signal?.throwIfAborted();
  }
  if (module._sv_abi_version?.() !== BUILD_DESCRIPTOR.native.core.abi) throw new Error('The application core has a different version. Reload SplatView.');
  nativeModuleIdentity(module, BUILD_DESCRIPTOR.native.core);
  if (typeof module._sv_allocation_snapshot !== 'function')
    throw new Error('The application core cannot report native allocations. Reload SplatView.');
  if (typeof module._sv_geometry_range !== 'function' || typeof module._sv_geometry_range_len !== 'function')
    throw new Error('The application core does not support this geometry layout. Reload SplatView.');
  if (typeof module._sv_pack_color_base !== 'function')
    throw new Error('The application core cannot restore a color session. Reload SplatView.');
  assertSourceHashExports(module);
  if (BUILD_DESCRIPTOR.native.core.capabilities.groupedSog !== 3 || typeof module._sv_open_group !== 'function')
    throw new Error('The application core cannot load grouped SOG sources. Reload SplatView.');
  if (BUILD_DESCRIPTOR.native.core.capabilities.exportSpz4 !== 1 ||
      typeof module._sv_spz4_output_bound !== 'function' || typeof module._sv_spz4_work_bound !== 'function')
    throw new Error('The application core cannot export SPZ v4. Reload SplatView.');
  if (BUILD_DESCRIPTOR.native.core.capabilities.boundedAttributeExport !== 1 ||
      typeof module._sv_export_output_bound !== 'function' || typeof module._sv_export_work_bound !== 'function')
    throw new Error('The application core cannot admit attribute exports. Reload SplatView.');
  if (BUILD_DESCRIPTOR.native.core.capabilities.boundedSpz3Export !== 1 ||
      typeof module._sv_export_output_bound !== 'function' || typeof module._sv_export_work_bound !== 'function')
    throw new Error('The application core cannot admit SPZ v3 exports. Reload SplatView.');
  if (BUILD_DESCRIPTOR.native.core.capabilities.boundedSogExport !== 1 ||
      typeof module._sv_export_output_bound !== 'function' || typeof module._sv_export_work_bound !== 'function')
    throw new Error('The application core cannot admit SOG or SOGS exports. Reload SplatView.');
  if (BUILD_DESCRIPTOR.native.core.capabilities.currentViewScope !== 1 || typeof module._sv_color_base_states_ptr !== 'function')
    throw new Error('The application core cannot limit edits to the current view. Reload SplatView.');
  if (BUILD_DESCRIPTOR.native.core.capabilities.selectionFilter !== 2)
    throw new Error('The application core cannot preview selection filters. Reload SplatView.');
  if (BUILD_DESCRIPTOR.native.core.capabilities.selectionActions !== 2)
    throw new Error('The application core cannot authenticate selection actions. Reload SplatView.');
  if (BUILD_DESCRIPTOR.native.core.capabilities.selectionMorphology !== 2)
    throw new Error('The application core cannot refine selection by volume. Reload SplatView.');
  if (BUILD_DESCRIPTOR.native.core.capabilities.proTransformSession !== 2 ||
      typeof module._sv_pack_transform_base !== 'function' || typeof module._sv_transform_base_states_ptr !== 'function')
    throw new Error('The application core cannot restore transform sessions. Reload SplatView.');
  if (BUILD_DESCRIPTOR.native.core.capabilities.transformPivot !== 2)
    throw new Error('The application core cannot measure transform pivots. Reload SplatView.');
  if (BUILD_DESCRIPTOR.native.core.capabilities.colorFillRange !== 1)
    throw new Error('The application core cannot retain Color/Fill Range selections. Reload SplatView.');
  if (BUILD_DESCRIPTOR.native.core.capabilities.absoluteOpacitySession !== 1 || BUILD_DESCRIPTOR.native.core.capabilities.opacityBaseStream !== 1 ||
      typeof module._sv_pack_opacity_base !== 'function' || typeof module._sv_opacity_base_states_ptr !== 'function')
    throw new Error('The application core cannot restore opacity sessions. Reload SplatView.');
  if (BUILD_DESCRIPTOR.native.core.capabilities.duplicate !== 1 || BUILD_DESCRIPTOR.native.core.capabilities.transactionReceipt !== 2)
    throw new Error('The application core cannot duplicate exact scene records. Reload SplatView.');
  if (BUILD_DESCRIPTOR.native.core.capabilities.recoveryCheckpoint !== 2 ||
      ['_sv_recovery_prepare', '_sv_recovery_read', '_sv_recovery_read_size', '_sv_recovery_release',
        '_sv_recovery_restore_begin', '_sv_recovery_restore_write', '_sv_recovery_restore_finish', '_sv_recovery_restore_cancel']
        .some(name => typeof (module as unknown as Record<string, unknown>)[name] !== 'function'))
    throw new Error('The application core cannot preserve an exact recovery checkpoint. Reload SplatView.');
  return module;
}
