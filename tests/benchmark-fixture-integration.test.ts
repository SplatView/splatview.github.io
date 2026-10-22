import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { admittedNativeCommand } from './fixtures/native-export';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildSplatFixture } from '../tools/bench/build-fixtures.ts';
import { benchmarkExpectedIdentities, validateBenchmarkPacked, validateBenchmarkRaw, validateBenchmarkSplatExport } from '../tools/bench/oracles.ts';
import { nativeModuleIdentity } from '../src/build/native';
import { BUILD_DESCRIPTOR } from '../src/generated/buildIdentity';
import type { NativeSummary } from '../src/document/types';
import { wasmString, type ModuleFactory, type WasmModule } from '../src/workers/wasm';

// Generator, independent oracle and actual native codec meet only here.
// This is full-workload native correctness, not a browser timing/capacity run.
const COUNT = 256_000;
let core: WasmModule;
let loaded: NativeSummary;
let raw: ReturnType<typeof validateBenchmarkRaw>;
let decoded: ReturnType<typeof validateBenchmarkPacked>;
let exported: ReturnType<typeof validateBenchmarkSplatExport>;

beforeAll(async () => {
  const input = buildSplatFixture();
  raw = validateBenchmarkRaw(input);
  const url = pathToFileURL(resolve('public/wasm/splatview-core.mjs')).href;
  const factory = (await import(/* @vite-ignore */ url) as { default: ModuleFactory }).default;
  core = await factory({ locateFile: (name: string) => {
    if (name !== 'splatview-core.wasm') throw new Error('Unexpected native artifact request.');
    return resolve('public/wasm/splatview-core.wasm');
  } });
  nativeModuleIdentity(core, BUILD_DESCRIPTOR.native.core);
  expect(core._sv_abi_version()).toBe(BUILD_DESCRIPTOR.native.core.abi);
  const pointer = core._malloc(input.byteLength);
  if (!pointer) throw new Error('Native input allocation refused.');
  try {
    core.HEAPU8.set(input, pointer);
    loaded = JSON.parse(core.UTF8ToString(core._sv_open(pointer, input.byteLength, 1, COUNT, 1024 * 1024 * 1024))) as NativeSummary;
  } finally { core._free(pointer); }
  expect(loaded.ok, loaded.error).toBe(true);
}, 30_000);

describe('independent benchmark fixture against the frozen native codec', () => {
  it('loads every SH0 record and validates the complete canonical 144-byte native scene', () => {
    expect(loaded.count).toBe(COUNT);
    expect(loaded.sourceCount).toBe(COUNT);
    expect(loaded.shDegree).toBe(0);
    expect(loaded.selected).toBe(0);
    const start = core._sv_scene_ptr();
    expect(start).toBeGreaterThan(0);
    decoded = validateBenchmarkPacked(core.HEAPU8.slice(start, start + 144 * COUNT));
    const expected = benchmarkExpectedIdentities();
    expect(raw.count).toBe(COUNT);
    expect(decoded.count).toBe(COUNT);
    expect(decoded.expectedSceneSha256).toBe(expected.expectedSceneSha256);
    expect(decoded.canonicalSceneSha256).toBe(expected.expectedSceneSha256);
    expect(decoded.sourceOrderSha256).toBe(expected.sourceOrderSha256);
    expect(decoded.membershipSha256).toBe(expected.membershipSha256);
    expect(decoded.distributionSha256).toBe(expected.distributionSha256);
  }, 30_000);

  it('independently decodes every exported SPLAT record, membership and bounded numeric attribute', () => {
    const summary = wasmString(core, JSON.stringify(admittedNativeCommand(core, { command: 'export', format: 2, scope: 0 })),
      pointer => JSON.parse(core.UTF8ToString(core._sv_command(pointer))) as NativeSummary);
    expect(summary.ok, summary.error).toBe(true);
    const pointer = core._sv_output_ptr(), length = core._sv_output_len();
    expect(length).toBe(COUNT * 32);
    exported = validateBenchmarkSplatExport(core.HEAPU8.slice(pointer, pointer + length));
    const expected = benchmarkExpectedIdentities();
    expect(exported.count).toBe(COUNT);
    expect(exported.expectedSceneSha256).toBe(expected.expectedSceneSha256);
    expect(exported.membershipSha256).toBe(expected.membershipSha256);
    expect(exported.sourceOrderSha256).toBe(expected.sourceOrderSha256);
    expect(exported.distributionSha256).toBe(expected.distributionSha256);
  }, 30_000);
});

afterAll(() => {
  if (raw && decoded && exported) process.stdout.write('Full benchmark fixture/native oracle: ' + JSON.stringify({
    scope: 'native-correctness-only', count: COUNT, input: raw, nativeCanonical: decoded, exported,
  }) + '\n');
});
