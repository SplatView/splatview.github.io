import { describe, expect, it } from 'vitest';
import { validateFloorSummary } from '../src/document/floorProtocol';
import { validateSimilarityAlignmentFrame } from '../src/document/alignment';
import reference from './fixtures/floor-reference.json';

const candidates = reference.floorCases.filter(example => example.plane !== null);
const floatBits = (values: readonly number[]) => Array.from(new Uint32Array(new Float32Array(values).buffer));

describe('actual captured Floor source fixtures at the public math boundary', () => {
  it('retains bounded actual-MSVC provenance, source defaults and separate RNG sequences', () => {
    expect(reference.source).toBe('windows-r0-20261012-02');
    expect(reference.provenance.output).toEqual({ path: '.build/floor-reference-01/output-01.json', bytes: 2247542,
      sha256: 'f3dd9653d1842fd2cda25af1a5f8ed53c5020daca36e595a98e6b1ac78aae015' });
    expect(reference.defaultOptions).toMatchObject({ threshold: 0, iterations: 1000, samples: 50_000 });
    expect(reference.floorCases).toHaveLength(24); expect(candidates).toHaveLength(14);
    expect(reference.settingsRefusals).toHaveLength(8); expect(reference.rngCases).toHaveLength(14);
    expect(reference.floorCases.reduce((count, row) => count + row.alignments.length, 0)).toBe(56);
    expect(reference.rngCases.reduce((count, row) => count + row.draws.length, 0)).toBe(224);
  });

  it.each(candidates)('$name transports all eight actual source float bits and support counts unchanged', example => {
    const input = { version: 1, id: 1, status: 'ready', stage: 'complete', selectedOnly: example.input.selectedOnly, plane: example.plane };
    // floatBits is a fixture annotation rather than a native DTO field.
    const { floatBits: expected, ...plane } = example.plane!;
    const parsed = validateFloorSummary({ ...input, plane }, { loadedCount: example.input.members.length, pending: false });
    expect(parsed?.status).toBe('ready');
    if (parsed?.status !== 'ready') throw new Error('Expected actual-source candidate.');
    expect(floatBits([...parsed.plane.normal, ...parsed.plane.center, parsed.plane.radius, parsed.plane.rms])).toEqual(expected);
    expect(parsed.plane.inliers).toBe(plane.inliers); expect(parsed.plane.tested).toBe(plane.tested);
  });

  it.each(candidates)('$name admits every captured Flip/yUp leveling frame without broadening to shear', example => {
    for (const alignment of example.alignments) {
      // This checks the current TS scene-frame admission, not native geometry,
      // camera execution, RNG mapping or cross-target bit equivalence.
      expect(validateSimilarityAlignmentFrame(alignment.matrix)).toEqual(alignment.matrix);
      expect(alignment.effectiveFlip).toBe(alignment.uiFlip !== !alignment.yUp);
      expect(alignment.worldUprightCamera.state[9]).toBe(0);
      expect(alignment.worldUprightCamera.state[8]).toBe(alignment.yUp ? 1 : 0);
    }
  });
});
