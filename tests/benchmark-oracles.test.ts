import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  assertBenchmarkPackedRecord, assertBenchmarkRawRecord, assertBenchmarkSplatExportRecord,
  benchmarkExpectedIdentities, benchmarkExpectedRecord, scanRawSplat,
  validateBenchmarkPacked, validateBenchmarkRaw, validateBenchmarkSplatExport,
} from '../tools/bench/oracles';

// Literal source 3 is separately specified here; this test imports no builder,
// production/native parser or fixture-generation helper.
function redSource3(): Uint8Array {
  const bytes = new Uint8Array(32), view = new DataView(bytes.buffer);
  view.setFloat32(0, -57 / 32, true); view.setFloat32(4, -49 / 32, true); view.setFloat32(8, -79 / 32, true);
  view.setFloat32(12, 1 / 1024, true); view.setFloat32(16, 1 / 512, true); view.setFloat32(20, 1 / 256, true);
  bytes.set([255, 0, 0, 255, 255, 128, 128, 128], 24);
  return bytes;
}

function nativeRedSource3(): Uint8Array {
  const bytes = new Uint8Array(144), view = new DataView(bytes.buffer);
  view.setFloat32(0, -57 / 32, true); view.setFloat32(4, 49 / 32, true); view.setFloat32(8, 79 / 32, true);
  view.setFloat32(12, 1, true); view.setFloat32(16, 1 / 1048576, true);
  view.setFloat32(28, 1 / 262144, true); view.setFloat32(36, 1 / 65536, true);
  view.setUint16(48, 0x3f17, true); view.setUint16(50, 0xbf17, true); view.setUint16(52, 0xbf17, true);
  return bytes;
}

function checkRaw(bytes: Uint8Array, sourceId = 3): void {
  scanRawSplat(bytes, row => assertBenchmarkRawRecord(row, sourceId), 2);
}
function checkPacked(bytes: Uint8Array, sourceId = 3): void {
  assertBenchmarkPackedRecord(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), 0, sourceId);
}

describe('independent original benchmark fixture oracle', () => {
  it('fixes literal anchors, axis convention, dyadic last row and exact attribute layout', () => {
    expect(benchmarkExpectedRecord(0)).toEqual({
      sourceId: 0, wirePosition: [-8, 0, 0], rubPosition: [-8, -0, -0],
      scales: [1 / 1024, 1 / 512, 1 / 256], rgba: [255, 0, 0, 255],
      quaternionBytes: [255, 128, 128, 128], covariance: [1 / 1048576, 0, 0, 1 / 262144, 0, 1 / 65536],
      dcHalfBits: [0x3f17, 0xbf17, 0xbf17],
    });
    expect(benchmarkExpectedRecord(1).wirePosition).toEqual([8, 0, 0]);
    expect(benchmarkExpectedRecord(1).rgba).toEqual([0, 255, 0, 255]);
    expect(benchmarkExpectedRecord(2).wirePosition).toEqual([0, 8, 0]);
    expect(benchmarkExpectedRecord(2).rgba).toEqual([0, 0, 255, 255]);
    expect(benchmarkExpectedRecord(3).wirePosition).toEqual([-57 / 32, -49 / 32, -79 / 32]);
    expect(benchmarkExpectedRecord(3199).wirePosition).toEqual([63 / 32, 49 / 32, -79 / 32]);
    expect(benchmarkExpectedRecord(255999).wirePosition).toEqual([63 / 32, 49 / 32, 79 / 32]);
    expect(() => benchmarkExpectedRecord(-1)).toThrow(/source ID/);
    expect(() => benchmarkExpectedRecord(256000)).toThrow(/source ID/);
    expect(() => benchmarkExpectedRecord(0.5)).toThrow(/source ID/);
  });

  it('parses every wire field with little endian and a nonzero byte offset', () => {
    const outer = new Uint8Array(39); outer.set(redSource3(), 3);
    const bytes = outer.subarray(3, 35), seen: unknown[] = [];
    const result = scanRawSplat(bytes, (row, index) => {
      seen.push({ index, position: [...row.position], scales: [...row.scales], rgba: [...row.rgba],
        quaternion: [...row.quaternion], quaternionBytes: [...row.quaternionBytes] });
    }, 1);
    expect(result).toEqual({ count: 1, encodedSha256: createHash('sha256').update(bytes).digest('hex') });
    expect(seen).toEqual([{ index: 0, position: [-57 / 32, -49 / 32, -79 / 32], scales: [1 / 1024, 1 / 512, 1 / 256],
      rgba: [255, 0, 0, 255], quaternion: [127 / 128, 0, 0, 0], quaternionBytes: [255, 128, 128, 128] }]);
    expect(() => checkRaw(bytes)).not.toThrow();
  });

  it('reuses bounded visitor storage instead of retaining a row object per input', () => {
    const bytes = new Uint8Array(64); bytes.set(redSource3()); bytes.set(redSource3(), 32);
    let previous: unknown, callbacks = 0;
    scanRawSplat(bytes, row => { if (callbacks) expect(row).toBe(previous); previous = row; callbacks++; }, 2);
    expect(callbacks).toBe(2);
    expect(() => scanRawSplat(bytes, undefined, 1)).toThrow(/record bound/);
  });

  it.each([0, 1, 31, 33, 63])('refuses empty or partial wire bytes: %i', length => {
    expect(() => scanRawSplat(new Uint8Array(length))).toThrow(/complete 32-byte rows/);
  });

  it.each([0, -1, 1.5, 1000001, Number.NaN])('refuses an invalid parser bound: %s', maximum => {
    expect(() => scanRawSplat(redSource3(), undefined, maximum)).toThrow(/record bound/);
  });

  it.each([
    { name: 'NaN position', offset: 0, value: Number.NaN, message: /non-finite position/ },
    { name: 'infinite position', offset: 8, value: Number.POSITIVE_INFINITY, message: /non-finite position/ },
    { name: 'zero scale', offset: 12, value: 0, message: /invalid scale/ },
    { name: 'negative scale', offset: 16, value: -1, message: /invalid scale/ },
    { name: 'infinite scale', offset: 20, value: Number.POSITIVE_INFINITY, message: /invalid scale/ },
  ])('refuses $name without a full workload allocation', ({ offset, value, message }) => {
    const bytes = redSource3(); new DataView(bytes.buffer).setFloat32(offset, value, true);
    expect(() => scanRawSplat(bytes)).toThrow(message);
  });

  it('refuses the centered-byte zero quaternion', () => {
    const bytes = redSource3(); bytes.set([128, 128, 128, 128], 28);
    expect(() => scanRawSplat(bytes)).toThrow(/zero quaternion/);
  });

  it.each([
    { name: 'position or source order', offset: 0, byte: undefined, value: -55 / 32, message: /position\/order/ },
    { name: 'scale', offset: 12, byte: undefined, value: 1 / 512, message: /wire scales/ },
    { name: 'RGB', offset: 24, byte: 254, value: undefined, message: /wire RGBA/ },
    { name: 'opacity', offset: 27, byte: 254, value: undefined, message: /wire RGBA/ },
    { name: 'quaternion', offset: 29, byte: 129, value: undefined, message: /wire quaternion/ },
  ])('checks exact original $name', ({ offset, byte, value, message }) => {
    const bytes = redSource3();
    if (byte !== undefined) bytes[offset] = byte; else new DataView(bytes.buffer).setFloat32(offset, value!, true);
    expect(() => checkRaw(bytes)).toThrow(message);
  });

  it('checks a literal canonical native 144B record rather than the GPU stream', () => {
    expect(() => checkPacked(nativeRedSource3())).not.toThrow();
    expect(() => checkPacked(new Uint8Array(48))).toThrow(/incomplete native/);
    const outer = new Uint8Array(151); outer.set(nativeRedSource3(), 5);
    expect(() => checkPacked(outer.subarray(5, 149))).not.toThrow();
  });

  it.each([
    { name: 'RDF y sign', offset: 4, value: -49 / 32, message: /RUB position/ },
    { name: 'RDF z sign', offset: 8, value: -79 / 32, message: /RUB position/ },
    { name: 'opacity', offset: 12, value: 0.5, message: /native opacity/ },
    { name: 'tiny wrong covariance', offset: 16, value: 2 / 1048576, message: /covariance diagonal/ },
    { name: 'nonfinite covariance', offset: 36, value: Number.NaN, message: /covariance diagonal/ },
    { name: 'nonzero off diagonal', offset: 24, value: 1 / 1048576, message: /off diagonal/ },
    { name: 'padding', offset: 40, value: 1, message: /padding/ },
  ])('refuses native $name', ({ offset, value, message }) => {
    const bytes = nativeRedSource3(); new DataView(bytes.buffer).setFloat32(offset, value, true);
    expect(() => checkPacked(bytes)).toThrow(message);
  });

  it('rejects negative-zero padding/off-diagonal covariance before canonicalization', () => {
    for (const offset of [20, 40, 44]) {
      const bytes = nativeRedSource3(); new DataView(bytes.buffer).setUint32(offset, 0x80000000, true);
      expect(() => checkPacked(bytes)).toThrow(/padding|off diagonal/);
    }
  });

  it('accepts absent negative zero only for independently known negative SH parity', () => {
    const bytes = nativeRedSource3(), view = new DataView(bytes.buffer);
    for (const band of [1, 2, 4, 7, 9, 11, 12, 14]) for (let channel = 0; channel < 3; channel++) {
      view.setUint16(48 + 2 * (band * 3 + channel), 0x8000, true);
    }
    expect(() => checkPacked(bytes)).not.toThrow();
    view.setUint16(48 + 2 * 9, 0x8000, true); // Band3 is x, positive parity.
    expect(() => checkPacked(bytes)).toThrow(/absent native SH 9/);
  });

  it.each([
    { offset: 48, value: 0xbf17, message: /native DC/ },
    { offset: 52, value: 0xbf16, message: /native DC/ },
    { offset: 54, value: 1, message: /absent native SH/ },
    { offset: 142, value: 0x7c00, message: /absent native SH/ },
  ])('checks all half fields including offset $offset', ({ offset, value, message }) => {
    const bytes = nativeRedSource3(); new DataView(bytes.buffer).setUint16(offset, value, true);
    expect(() => checkPacked(bytes)).toThrow(message);
  });

  it('permits legal export axis/quaternion reparameterization under the frozen covariance policy', () => {
    const bytes = redSource3(), view = new DataView(bytes.buffer);
    // Rotate +90deg about z, exchanging x/y scales: identical covariance.
    view.setFloat32(12, 1 / 512, true); view.setFloat32(16, 1 / 1024, true);
    bytes.set([219, 128, 128, 219], 28);
    scanRawSplat(bytes, row => {
      const numeric = assertBenchmarkSplatExportRecord(row, 3);
      expect(numeric.covariance.maxNormalizedError).toBeLessThan(1e-12);
      expect(numeric.covariance.worstRecord).toBe(3);
      expect(numeric.opacity.maxNormalizedError).toBe(0);
    });
  });

  it('adds exact primary RGBA without widening the generic one-byte codec bound', () => {
    scanRawSplat(redSource3(), row => {
      expect(assertBenchmarkSplatExportRecord(row, 3).color).toEqual({
        maxAbsoluteError: 0, maxNormalizedError: 0, worstRecord: 3, worstComponent: 0,
      });
    });
    const bytes = redSource3(); bytes.set([254, 1, 0], 24);
    expect(() => scanRawSplat(bytes, row => assertBenchmarkSplatExportRecord(row, 3))).toThrow(/exact workload RGBA/);
    bytes[25] = 2;
    expect(() => scanRawSplat(bytes, row => assertBenchmarkSplatExportRecord(row, 3))).toThrow(/exported color/);
  });

  it('detects erasure of the smallest axis even inside the generic covariance bound', () => {
    const bytes = redSource3(); new DataView(bytes.buffer).setFloat32(12, 2 ** -30, true);
    expect(() => scanRawSplat(bytes, row => assertBenchmarkSplatExportRecord(row, 3))).toThrow(/fixture sorted linear scale/);
  });

  it('retains an explicit maximum for the fixed relative linear-scale invariant', () => {
    const bytes = redSource3(); new DataView(bytes.buffer).setFloat32(12, (1 + 2 ** -20) / 1024, true);
    scanRawSplat(bytes, row => {
      const maximum = assertBenchmarkSplatExportRecord(row, 3).linearScales;
      expect(maximum.maxNormalizedError).toBeCloseTo(2 ** -20 / 4e-6, 12);
      expect(maximum.worstRecord).toBe(3); expect(maximum.worstComponent).toBe(0);
    });
  });

  it('rejects semantically wrong export covariance and opacity despite valid wire rows', () => {
    const bytes = redSource3(); new DataView(bytes.buffer).setFloat32(20, 1 / 128, true);
    expect(() => scanRawSplat(bytes, row => assertBenchmarkSplatExportRecord(row, 3))).toThrow(/exported covariance/);
    const opacity = redSource3(); opacity[27] = 254;
    expect(() => scanRawSplat(opacity, row => assertBenchmarkSplatExportRecord(row, 3))).toThrow(/exported opacity/);
  });

  it('never treats a small valid record packet as full benchmark evidence', () => {
    expect(() => validateBenchmarkRaw(redSource3())).toThrow(/requires 256000/);
    expect(() => validateBenchmarkPacked(nativeRedSource3())).toThrow(/complete fixed 144-byte/);
    expect(() => validateBenchmarkSplatExport(redSource3())).toThrow(/requires 256000/);
  });

  it('separates canonical scene/distribution/order/input identities and protects cached expectations', () => {
    const expected = benchmarkExpectedIdentities();
    expect(expected.count).toBe(256000); expect(expected.canonicalRecordBytes).toBe(144);
    for (const identity of [expected.inputSha256, expected.expectedSceneSha256, expected.distributionSha256, expected.sourceOrderSha256]) {
      expect(identity).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(new Set([expected.inputSha256, expected.expectedSceneSha256, expected.distributionSha256, expected.sourceOrderSha256]).size).toBe(4);
    expect(expected.membershipSha256).toBe(expected.sourceOrderSha256);
    expected.inputSha256 = 'caller mutation';
    expect(benchmarkExpectedIdentities().inputSha256).not.toBe('caller mutation');
  });
});
