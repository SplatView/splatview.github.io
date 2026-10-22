import { admittedNativeCommand } from './fixtures/native-export';
import { beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { wasmString, type ModuleFactory, type WasmModule } from '../src/workers/wasm';
import type { NativeSummary } from '../src/document/types';
import manifest from './fixtures/sog-numeric-v1/manifest.json';

let core: WasmModule;
const decode = (pointer: number) => JSON.parse(core.UTF8ToString(pointer)) as NativeSummary;
const command = (value: unknown) => wasmString(core, JSON.stringify(admittedNativeCommand(core, value)), pointer => decode(core._sv_command(pointer)));
const bytes = (name: string) => new Uint8Array(readFileSync(resolve('tests/fixtures/sog-numeric-v1', name)));
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
function open(value: Uint8Array) {
  const pointer = core._malloc(value.length);
  expect(pointer).not.toBe(0);
  try { core.HEAPU8.set(value, pointer); return decode(core._sv_open(pointer, value.length, 0, 100, 128 * 1024 * 1024)); }
  finally { core._free(pointer); }
}
function scene() {
  return core.HEAPU8.slice(core._sv_scene_ptr(), core._sv_scene_ptr() + 144);
}
function exported() {
  const result = command({ command: 'export', format: 0, scope: 0 });
  expect(result.ok, result.error).toBe(true);
  return core.HEAPU8.slice(core._sv_output_ptr(), core._sv_output_ptr() + core._sv_output_len());
}
beforeAll(async () => {
  const factory = (await import(/* @vite-ignore */ pathToFileURL(resolve('public/wasm/splatview-core.mjs')).href) as { default: ModuleFactory }).default;
  core = await factory({ locateFile(name: string) {
    if (name !== 'splatview-core.wasm') throw new Error('Unexpected native artifact request.');
    return resolve('public/wasm/splatview-core.wasm');
  } });
});

describe('actual native SOG source-count numeric kinds', () => {
  it('binds the independent standard-ZIP construction and all fixed archive bytes', () => {
    expect(sha(new Uint8Array(readFileSync('tools/generate-sog-numeric-fixtures.py')))).toBe(manifest.generatorSha256);
    for (const item of manifest.cases) {
      expect(bytes(item.file).length).toBe(item.bytes);
      expect(sha(bytes(item.file))).toBe(item.sha256);
    }
  });
  for (const version of [1, 2]) {
    it(`accepts paired numeric count one in v${version}`, () => {
      const result = open(bytes(`v${version}-count-one.sog`));
      expect(result.ok, result.error).toBe(true);
      expect(result).toMatchObject({ count: 1, sourceCount: 1, format: `SOG v${version}` });
    });
    it(`refuses boolean count true in v${version} while preserving an edited owner and executable Redo`, () => {
      expect(open(bytes(`v${version}-count-one.sog`)).ok).toBe(true);
      expect(command({ command: 'single', index: 0 }).selected).toBe(1);
      expect(command({ command: 'delete' }).visible).toBe(0);
      expect(command({ command: 'undo' }).canRedo).toBe(true);
      const content = scene(), mask = core.HEAPU8[core._sv_states_ptr()], output = exported();
      // Include the retained diagnostic export in the rollback baseline.
      const before = command({ command: 'summary' });
      const refused = open(bytes(`v${version}-count-true.sog`));
      expect(refused.ok).toBe(false); expect(refused.error).toBeTruthy();
      const after = command({ command: 'summary' });
      for (const field of ['count', 'sourceCount', 'format', 'selected', 'visible', 'revision', 'contentRevision', 'canUndo', 'canRedo', 'memoryBytes'] as const)
        expect(after[field], field).toEqual(before[field]);
      expect(scene()).toEqual(content); expect(core.HEAPU8[core._sv_states_ptr()]).toBe(mask); expect(exported()).toEqual(output);
      expect(command({ command: 'redo' }).visible).toBe(0);
      expect(command({ command: 'undo' }).visible).toBe(1);
      expect(scene()).toEqual(content); expect(exported()).toEqual(output);
    });
  }
});
