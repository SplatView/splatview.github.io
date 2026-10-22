import type { WasmModule } from '../../src/workers/wasm';
import { wasmString } from '../../src/workers/wasm';
import { isAdmittedSceneExportFormat } from '../../src/document/exportFormats';

/** Test callers must obtain the real native bound before a direct ABI export. */
export function admittedNativeCommand(core: WasmModule, value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const command = value as Record<string, unknown>;
  if (command.command !== 'export' || !isAdmittedSceneExportFormat(command.format) ||
      'outputCapacity' in command || 'nativeWorkBytes' in command) return value;
  const summary = wasmString(core, JSON.stringify({ command: 'summary' }), pointer =>
    JSON.parse(core.UTF8ToString(core._sv_command(pointer)))) as { count: number; shDegree: number };
  return { ...command,
    outputCapacity: core._sv_export_output_bound!(Number(command.format), summary.count, summary.shDegree),
    nativeWorkBytes: core._sv_export_work_bound!(Number(command.format), summary.count, summary.shDegree) };
}
