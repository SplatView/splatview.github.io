import { describe, expect, it, vi } from 'vitest';
import { LOADED_PREVIEW_LIMIT, MAX_INPUT_BYTES, probeSceneFile } from '../src/document/loadProbe';
import { AdmissionError, MiB, ResourceLedger } from '../src/document/resources';
import { assertSceneInputBytes, assertSourceFitsDecodeBudget, MAX_SOURCE_TRANSPORT_BYTES,
  NATIVE_LOAD_BUDGET_BYTES, sceneFileBytes } from '../src/document/sceneInputLimits';

const encode = (value: string) => new TextEncoder().encode(value);
function ply(vertexCount: number | string, extra: string[] = [], vertexProperties = ['x', 'y', 'z'], newline = '\n') {
  return ['ply', 'format ascii 1.0', `element vertex ${vertexCount}`, ...vertexProperties.map(name => `property float ${name}`),
    ...extra, 'end_header', ''].join(newline);
}
const points = (vertices: number | string = 3, extra: string[] = []) => new File([ply(vertices, extra), '0 0 0\n1 0 0\n0 1 0\n'], 'points.ply');
const meshHeader = (vertices: number, faces: number) => ply(vertices, [`element face ${faces}`, 'property list uchar uint vertex_indices']);
async function geometry(file: File) {
  const result = await probeSceneFile(file); expect(result.kind).toBe('geometry');
  if (result.kind !== 'geometry') throw new Error('Expected independently classified ordinary geometry.');
  return result;
}

describe('bounded source allocation probe', () => {
  it('keeps ordinary color, normals, opacity and alpha on the geometry path', async () => {
    const header = ply(3, [], ['x', 'y', 'z', 'red', 'green', 'blue', 'nx', 'ny', 'nz', 'opacity', 'alpha']);
    expect(await geometry(new File([header], 'vertex-colors.ply'))).toMatchObject({ count: 3, degree: 0, sourceVertices: 3, sourceFaces: 0, triangleLimit: 0 });
  });
  for (const name of ['scale_0', 'scale_custom', 'rot_0', 'rot_unused', 'f_dc_0', 'f_dc_custom', 'f_rest_0', 'f_rest_unused'])
    it(`routes ANY native Gaussian attribute prefix ${name} away from ordinary geometry`, async () => {
      const result = await probeSceneFile(new File([ply(3, [], ['x', 'y', 'z', name])], 'prefix.ply'));
      expect(result.kind).toBe('gaussian'); expect(result.count).toBe(3);
    });
  it('recognizes a Gaussian prefix in a vertex list declaration, while native retains type validation', async () => {
    const result = await probeSceneFile(points(3, ['property list uchar float scale_custom']));
    expect(result.kind).toBe('gaussian');
  });
  it('does not misclassify body text, comments or other elements as vertex SH attributes', async () => {
    const header = ply(3, ['comment scale_0 f_rest_44', 'element metadata 1', 'property float f_dc_0']);
    const file = new File([header, 'element chunk 1\nproperty float scale_0\nelement vertex 10000000\n'], 'header-only.ply');
    expect(await geometry(file)).toMatchObject({ count: 3, sourceVertices: 3, sourceFaces: 0 });
  });
  it.each([0, 9, 24, 45])('reserves SH3 for compressed PLY with %i separate SH fields', async rest => {
    const header = ['ply', 'format binary_little_endian 1.0', 'element chunk 1', 'property float min_x',
      'element vertex 8', 'property uint packed_position', 'property uint packed_rotation', 'property uint packed_scale', 'property uint packed_color',
      ...(rest ? ['element sh 8', ...Array.from({ length: rest }, (_, index) => `property uchar f_rest_${index}`)] : []),
      'end_header', ''].join('\n');
    const result = await probeSceneFile(new File([header], 'compressed.ply'));
    expect(result).toMatchObject({ kind: 'gaussian', count: 8, degree: 3 });
  });
  it('routes even a zero-count chunk declaration to conservative compressed admission', async () => {
    expect(await probeSceneFile(points(3, ['element chunk 0', 'property float min_x'])))
      .toMatchObject({ kind: 'gaussian', count: 3, degree: 3 });
  });
  it.each([[0, 0], [9, 1], [24, 2], [45, 3], [72, 3]])('bounds ordinary Gaussian SH layout %i at retained degree %i', async (rest, degree) => {
    const attributes = ['x', 'y', 'z', 'scale_0', ...Array.from({ length: rest }, (_, index) => `f_rest_${index}`)];
    expect(await probeSceneFile(new File([ply(2_000_000, [], attributes)], 'gaussian.ply')))
      .toMatchObject({ kind: 'gaussian', count: 1_000_000, degree });
  });
  it('reads one bounded prefix without requesting or decoding the entire body', async () => {
    const header = ply(3, ['comment 标定 café 🌍'], ['x', 'y', 'z'], '\r\n');
    const file = new File([header, new Uint8Array(2 * MiB).fill(255)], 'utf8-and-binary-body.ply');
    const read = vi.spyOn(file, 'arrayBuffer').mockRejectedValue(new Error('Full input read was forbidden.'));
    const slice = vi.spyOn(file, 'slice'); const result = await geometry(file);
    expect(result.sourceVertices).toBe(3); expect(slice).toHaveBeenCalledExactlyOnceWith(0, 1024 * 1024); expect(read).not.toHaveBeenCalled();
    // Parser work is based on the encoded UTF-8 header, not its character count
    // and not the binary body that happened to fit in the prefix read.
    const empty = await geometry(new File([header], 'same-header.ply')); expect(result.peakBytes).toBe(empty.peakBytes);
    const asciiHeader = ply(3, ['comment ASCII'], ['x', 'y', 'z'], '\r\n');
    const ascii = await geometry(new File([asciiHeader], 'ascii-header.ply'));
    expect(result.peakBytes - ascii.peakBytes).toBe((encode(header).length - encode(asciiHeader).length) * 8);
  });
  it('accepts an end_header newline at the prefix boundary and refuses a header one byte beyond it', async () => {
    const prefix = ply(3).replace('end_header\n', ''), suffix = 'end_header\n';
    const comment = 'comment ' + 'a'.repeat(MiB - encode(prefix + suffix + 'comment \n').length) + '\n';
    const atLimit = prefix + comment + suffix; expect(encode(atLimit).length).toBe(MiB);
    expect(await geometry(new File([atLimit, new Uint8Array(1)], 'limit.ply'))).toMatchObject({ count: 3 });
    await expect(probeSceneFile(new File([prefix + comment.slice(0, -1) + 'a\n' + suffix], 'over-limit.ply'))).rejects.toThrow(AdmissionError);
  });
  it.each(['-1', '+1', '1.5', '1e3', 'NaN', 'Infinity', '10000001', '9007199254740993', ''])('refuses invalid or excessive count %j before candidate allocation', async count => {
    await expect(probeSceneFile(points(count))).rejects.toThrow(AdmissionError);
  });
  it('refuses empty vertices, duplicate elements and properties preceding any element', async () => {
    for (const header of [ply(0), ply(3, ['element vertex 4']), ply(3, ['element face 1', 'element face 2']),
      'ply\nformat ascii 1.0\nproperty float x\nelement vertex 3\nend_header\n'])
      await expect(probeSceneFile(new File([header], 'invalid.ply'))).rejects.toThrow(AdmissionError);
  });
  it('admits 64 bounded elements but refuses the next one without a preview', async () => {
    const extra = Array.from({ length: 63 }, (_, index) => `element auxiliary_${index} 0`);
    expect(await geometry(points(1, extra))).toMatchObject({ sourceVertices: 1 });
    await expect(probeSceneFile(points(1, [...extra, 'element overflow 0']))).rejects.toThrow(AdmissionError);
  });
  it('admits 256 vertex properties and refuses an additional declaration', async () => {
    const names = ['x', 'y', 'z', ...Array.from({ length: 253 }, (_, index) => `extra_${index}`)];
    expect(await geometry(new File([ply(1, [], names)], '256.ply'))).toMatchObject({ count: 1 });
    await expect(probeSceneFile(new File([ply(1, [], [...names, 'overflow'])], '257.ply'))).rejects.toThrow(AdmissionError);
  });
  it('enforces the same 256-property cap on a face element before entering native decode', async () => {
    const face = ['element face 1', 'property list uchar uint vertex_indices',
      ...Array.from({ length: 256 }, (_, index) => `property float face_${index}`)];
    await expect(probeSceneFile(points(3, face))).rejects.toThrow(AdmissionError);
  });
  it('probes above the former product ceiling using only a bounded prefix', async () => {
    // Retain the existing shared-part fixture; never construct a uint32-sized Blob.
    const part = new Blob([new Uint8Array(MiB)]), body = new Blob(Array.from({ length: 256 }, () => part));
    const header = ply(3), file = new File([header, body.slice(encode(header).byteLength), new Uint8Array(1)], 'larger.ply');
    expect(sceneFileBytes(file)).toBe(256 * MiB + 1);
    const slice = vi.spyOn(file, 'slice'), read = vi.spyOn(file, 'arrayBuffer');
    Object.defineProperty(file, 'size', { value: 0 });
    expect(await geometry(file)).toMatchObject({ sourceVertices: 3 });
    expect(slice).toHaveBeenCalledExactlyOnceWith(0, MiB); expect(read).not.toHaveBeenCalled();
  });
  it('uses intrinsic Blob size for both admission and the SPLAT preview count', async () => {
    const file = new File([new Uint8Array(96)], 'shadowed.splat'), size = vi.fn(() => { throw new Error('Shadowed size was accessed.'); });
    Object.defineProperty(file, 'size', { get: size });
    expect(sceneFileBytes(file)).toBe(96);
    expect(await probeSceneFile(file)).toMatchObject({ kind: 'gaussian', count: 3, degree: 0 });
    expect(size).not.toHaveBeenCalled();
  });
  it('refuses an imitated File before its slice or size property can run', async () => {
    const size = vi.fn(() => 0), slice = vi.fn();
    const file = { name: 'imitated.ply', get size() { return size(); }, slice } as unknown as File;
    await expect(probeSceneFile(file)).rejects.toThrow(AdmissionError);
    expect(size).not.toHaveBeenCalled(); expect(slice).not.toHaveBeenCalled();
  });
  it.each([-1, .5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, '4', null, undefined, 4n])(
    'refuses invalid scene byte length %s', value => {
      expect(() => assertSceneInputBytes(value)).toThrow(AdmissionError);
    });
  it('keeps the uint32 transport domain separate from resource-dependent admission', () => {
    expect(MAX_INPUT_BYTES).toBe(MAX_SOURCE_TRANSPORT_BYTES); expect(MAX_SOURCE_TRANSPORT_BYTES).toBe(0xffff_ffff);
    for (const value of [0, 256 * MiB + 1, 0xffff_ffff]) expect(() => assertSceneInputBytes(value)).not.toThrow();
    expect(() => assertSceneInputBytes(0x1_0000_0000)).toThrow(/32-bit input transport limit/);
  });
  it.each([64, NATIVE_LOAD_BUDGET_BYTES])('requires input headroom within the passed %i-byte decode budget', budget => {
    expect(() => assertSourceFitsDecodeBudget(budget - 1, budget)).not.toThrow();
    for (const bytes of [budget, budget + 1])
      expect(() => assertSourceFitsDecodeBudget(bytes, budget)).toThrow(/does not fit within the available decode memory budget/);
  });
  it.each([0, -1, .5, NaN, Infinity, 0x1_0000_0000, '64', null])('refuses an invalid decode budget %s', budget => {
    expect(() => assertSourceFitsDecodeBudget(0, budget)).toThrow('Invalid scene decode memory budget.');
  });
  it.each([-1, .5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '0', null])('refuses an invalid native input allocation size %s', bytes => {
    expect(() => assertSourceFitsDecodeBudget(bytes, NATIVE_LOAD_BUDGET_BYTES)).toThrow('Invalid scene source memory size.');
  });
  it('keeps non-PLY formats on conservative Gaussian admission without inspecting payload text as PLY', async () => {
    expect(await probeSceneFile(new File([new Uint8Array(96)], 'scene.SPLAT'))).toMatchObject({ kind: 'gaussian', count: 3, degree: 0 });
    expect(await probeSceneFile(new File([new Uint8Array(32)], 'scene.spz'))).toMatchObject({ kind: 'gaussian', count: LOADED_PREVIEW_LIMIT, degree: 3 });
  });
});

describe('full-source ordinary PLY peak admission', () => {
  it('retains the point preview ceiling without charging a mesh-sized unsampled vertex table', async () => {
    const header = ply(10_000_000), result = await geometry(new File([header], 'sampled-points.ply'));
    expect(result).toMatchObject({ count: 1_000_000, sourceVertices: 10_000_000, sourceFaces: 0, triangleLimit: 0 });
    const independentComponents = [16_000_000, 16_000_000, 20 * MiB, 8 * encode(header).length, 3 * 256, 256, 3 * 8, 64 * 1024];
    expect(result.peakBytes).toBe(independentComponents.reduce((sum, bytes) => sum + bytes, 0));
  });
  it('charges full mesh vertices and remap even when retained topology can reference only a small subset', async () => {
    const header = meshHeader(10_000_000, 1), result = await geometry(new File([header], 'large-source-one-face.ply'));
    expect(result).toMatchObject({ sourceVertices: 10_000_000, sourceFaces: 1, triangleLimit: 1022, count: 3066 });
    // A single legal 1024-corner polygon emits at most 1022 triangles. The
    // admission oracle includes all 10M source vertices and the remap, not
    // just the 3066 uploaded vertices implied by that retained topology.
    const independentComponents = [320_000_000, 40_000_000, 1022 * 36, 3066 * 16, 1022 * 12, 20 * MiB,
      8 * encode(header).length, 4 * 256, 2 * 256, 3 * 8, 64 * 1024, 8192];
    expect(result.peakBytes).toBe(independentComponents.reduce((sum, bytes) => sum + bytes, 0));
    expect(result.peakBytes).toBeGreaterThan(360_000_000);
  });
  it('charges triangle vector growth overlap and allows up to three vertices per retained triangle', async () => {
    const header = meshHeader(10_000_000, 2000), result = await geometry(new File([header], 'sampled-mesh.ply'));
    expect(result).toMatchObject({ count: 3_000_000, triangleLimit: 1_000_000, sourceVertices: 10_000_000, sourceFaces: 2000 });
    const independentComponents = [320_000_000, 40_000_000, 36_000_000, 48_000_000, 12_000_000, 20 * MiB,
      8 * encode(header).length, 4 * 256, 2 * 256, 3 * 8, 64 * 1024, 8192];
    expect(result.peakBytes).toBe(independentComponents.reduce((sum, bytes) => sum + bytes, 0));
    expect(result.count).toBeGreaterThan(LOADED_PREVIEW_LIMIT);
  });
  it('makes the old document reservation participate in candidate admission, with no partial grant', async () => {
    const candidate = await geometry(new File([meshHeader(10_000_000, 2000)], 'candidate.ply'));
    const ledger = new ResourceLedger(candidate.peakBytes + 1024), old = ledger.reserve('decoded', 1025), before = ledger.usage;
    expect(() => ledger.reserve('decoded', candidate.peakBytes)).toThrow(AdmissionError); expect(ledger.usage).toEqual(before);
    old(); const accepted = ledger.reserve('decoded', candidate.peakBytes); expect(ledger.usage.bytes).toBe(candidate.peakBytes);
    accepted(); expect(ledger.usage.bytes).toBe(0);
  });
  it('bounds a small mesh by its original vertices and treats an empty face element as points', async () => {
    expect(await geometry(new File([meshHeader(7, 1)], 'seven.ply'))).toMatchObject({ count: 7, triangleLimit: 1022, sourceVertices: 7 });
    expect(await geometry(new File([meshHeader(7, 0)], 'zero-faces.ply'))).toMatchObject({ count: 7, triangleLimit: 0, sourceFaces: 0 });
  });
});
