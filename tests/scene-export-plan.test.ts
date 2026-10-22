import { describe, expect, it } from 'vitest';
import { isAdmittedSceneExportFormat } from '../src/document/exportFormats';
import { validateSceneExportPlan, validateSpz4ExportPlan } from '../src/document/spz4Export';

const nativePlan = { format: 5, scope: 2, count: 1_000_000, shDegree: 3,
  outputCapacity: 1536 * 1024 * 1024, nativeWorkBytes: 1792 * 1024 * 1024 };

describe('native scene export plan envelope', () => {
  it('admits a native-sized text plan above the SPZ limits without allocating output or altering its bounds', () => {
    const plan = validateSceneExportPlan(nativePlan);
    expect(plan).toEqual(nativePlan); expect(plan).not.toBe(nativePlan); expect(Object.isFrozen(plan)).toBe(true);
  });

  it.each([0, 1, 2, 3, 4, 5, 6, 7, 8])('accepts bounded writer format %s independently of menu order', format => {
    expect(isAdmittedSceneExportFormat(format)).toBe(true);
    expect(validateSceneExportPlan({ ...nativePlan, format }).format).toBe(format);
  });

  it.each([9, '0', null])('gives no admitted authority to unsupported writer %s', format => {
    expect(isAdmittedSceneExportFormat(format)).toBe(false);
    expect(() => validateSceneExportPlan({ ...nativePlan, format })).toThrow();
  });

  it.each([
    { scope: -1 }, { scope: 3 }, { scope: 0.5 }, { count: 0 }, { count: 1_000_001 },
    { shDegree: -1 }, { shDegree: 4 }, { outputCapacity: 0 }, { outputCapacity: 0x8000_0000 },
    { outputCapacity: Number.NaN }, { nativeWorkBytes: 1 }, { nativeWorkBytes: 0x1_0000_0000 },
    { nativeWorkBytes: Number.POSITIVE_INFINITY }, { unadmitted: 32 },
  ])('refuses malformed bounds or extra authority %j', mutation => {
    expect(() => validateSceneExportPlan({ ...nativePlan, ...mutation })).toThrow();
  });

  it('preserves the legacy strict four-field SPZ4 contract and its codec-specific limits', () => {
    const legacy = { count: 3, shDegree: 0, outputCapacity: 512, nativeWorkBytes: 4 * 1024 * 1024 };
    expect(validateSpz4ExportPlan(legacy)).toEqual(legacy);
    expect(() => validateSpz4ExportPlan({ ...legacy, format: 8, scope: 0 })).toThrow();
    expect(() => validateSpz4ExportPlan({ ...legacy, outputCapacity: 129 * 1024 * 1024 })).toThrow();
  });
});
