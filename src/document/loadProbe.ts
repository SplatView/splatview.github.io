import { AdmissionError, checkedBytes, estimateSceneBytes, MiB } from './resources';
import { sceneFileBytes } from './sceneInputLimits';

export { MAX_INPUT_BYTES } from './sceneInputLimits';

export const LOADED_PREVIEW_LIMIT = 1_000_000;
export const PROBE_WORK_BYTES = 8 * MiB;
const HEADER_LIMIT = MiB;
type GaussianProbe = { kind: 'gaussian'; count: number; degree: number; peakBytes: number };
type GeometryProbe = {
  kind: 'geometry'; count: number; degree: 0; sourceVertices: number;
  sourceFaces: number; triangleLimit: number; peakBytes: number;
};
export type SceneProbe = GaussianProbe | GeometryProbe;

function add(...values: number[]) {
  const sum = values.reduce((total, value) => total + checkedBytes(value, 1), 0);
  return checkedBytes(sum, 1);
}
function gaussian(count: number, degree: number): GaussianProbe {
  return { kind: 'gaussian', count, degree, peakBytes: estimateSceneBytes(count, degree) };
}
function sourceCount(text: string | undefined) {
  if (!text || !/^\d+$/.test(text)) throw new AdmissionError('Invalid PLY element count.');
  const count = Number(text);
  if (!Number.isSafeInteger(count) || count > 10_000_000) throw new AdmissionError('PLY elements are limited to 10 million records.');
  return count;
}

// This is an allocation probe, not a second decoder. The authoritative native
// loader validates values, property types, topology and the complete file body.
// Classify sources by the same header names as the frozen ordinary-PLY loader.
export async function probeSceneFile(file: File): Promise<SceneProbe> {
  const byteLength = sceneFileBytes(file);
  const bytes = await file.slice(0, HEADER_LIMIT).arrayBuffer();
  const header = new TextDecoder().decode(bytes);
  if (!header.startsWith('ply\n') && !header.startsWith('ply\r\n')) {
    if (/\.splat$/i.test(file.name)) return gaussian(Math.min(Math.floor(byteLength / 32), LOADED_PREVIEW_LIMIT), 0);
    return gaussian(LOADED_PREVIEW_LIMIT, 3);
  }
  let element = '', vertices = 0, faces = 0, elements = 0, properties = 0, vertexProperties = 0;
  let restProperties = 0, elementProperties = 0, isGaussian = false, compressed = false, end = 0;
  const names = new Set<string>();
  // Consume complete header lines only, retaining no array of the file body.
  for (const match of header.matchAll(/[^\n]*\n/g)) {
    const line = match[0].trim(), words = line.split(/\s+/, 5);
    if (words[0] === 'end_header') { end = match.index + match[0].length; break; }
    if (words[0] === 'element') {
      element = words[1]; elementProperties = 0; const count = sourceCount(words[2]);
      if (!element || names.has(element) || ++elements > 64) throw new AdmissionError('Invalid or duplicate PLY element.');
      names.add(element);
      if (element === 'vertex') vertices = count;
      if (element === 'face') faces = count;
      if (element === 'chunk') { isGaussian = true; compressed = true; }
    } else if (words[0] === 'property') {
      if (!element) throw new AdmissionError('PLY properties need an element.');
      if (++elementProperties > 256) throw new AdmissionError('Too many PLY element properties.');
      properties++;
      if (element === 'vertex') {
        if (++vertexProperties > 256) throw new AdmissionError('Too many PLY vertex properties.');
        const name = words[1] === 'list' ? words[4] ?? '' : words[2] ?? '';
        if (/^(scale_|rot_|f_dc_|f_rest_)/.test(name)) isGaussian = true;
        if (/^f_rest_\d+$/.test(name)) restProperties++;
      }
    }
  }
  if (!end) throw new AdmissionError('PLY header is missing or exceeds 1 MiB.');
  if (!vertices) throw new AdmissionError('The PLY contains no vertices.');
  if (properties > 64 * 256) throw new AdmissionError('Too many PLY properties.');
  if (isGaussian) return gaussian(Math.min(vertices, LOADED_PREVIEW_LIMIT), compressed ? 3 : Math.min(3, Math.ceil(Math.sqrt(restProperties / 3 + 1)) - 1));
  const triangleLimit = Math.min(LOADED_PREVIEW_LIMIT, checkedBytes(faces, 1022), 60_000_000);
  const retainedVertices = faces ? Math.min(vertices, checkedBytes(triangleLimit, 3)) : Math.min(vertices, LOADED_PREVIEW_LIMIT);
  // Native SceneVector admits its real allocations. Reserve their conservative
  // overlapping peak here as well, so the browser's aggregate budget includes
  // the old document while the independent candidate worker decodes/uploads.
  // Meshes retain ALL source vertices, a remap and possible shrink overlap.
  // Triangle vector growth may retain old+new capacities (at most 3*T).
  const headerBytes = new TextEncoder().encode(header.slice(0, end)).byteLength;
  const parser = add(checkedBytes(headerBytes, 8), checkedBytes(properties, 256), checkedBytes(elements, 256),
    checkedBytes(vertexProperties, 8), 64 * 1024, faces ? add(checkedBytes(vertices, 4), 8192) : 0);
  const native = faces ? add(checkedBytes(vertices, 32), checkedBytes(triangleLimit, 36), parser) :
    add(checkedBytes(retainedVertices, 16), parser);
  const gpu = add(checkedBytes(retainedVertices, 16), checkedBytes(triangleLimit, 12));
  return { kind: 'geometry', count: retainedVertices, degree: 0, sourceVertices: vertices,
    sourceFaces: faces, triangleLimit, peakBytes: add(native, gpu, 20 * MiB) };
}
