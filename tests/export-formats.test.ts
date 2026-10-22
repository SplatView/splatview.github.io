import { describe, expect, it } from 'vitest';
import { SCENE_EXPORT_FORMATS, isSceneExportFormat, sceneExportDescriptor, sceneExportFormatForFilename } from '../src/document/exportFormats';

describe('Capture02 scene export descriptors', () => {
  it('preserves serialized IDs independently of the desktop menu order', () => {
    expect(SCENE_EXPORT_FORMATS.map(value => value.format)).toEqual([0, 8, 1, 2, 3, 4, 5, 6, 7]);
    expect(new Set(SCENE_EXPORT_FORMATS.map(value => value.format)).size).toBe(9);
    expect(SCENE_EXPORT_FORMATS.map(value => [value.label, value.pattern, value.extension])).toEqual([
      ['Gaussian PLY (*.ply)', '*.ply', 'ply'],
      ['SPZ v4 (*.spz)', '*.spz', 'spz'],
      ['Legacy SPZ v3 (*.spz)', '*.spz', 'spz'],
      ['SPLAT - DC colors (*.splat)', '*.splat', 'splat'],
      ['SuperSplat compressed PLY (*.compressed.ply)', '*.ply', 'compressed.ply'],
      ['KSPLAT - float geometry, byte DC colors (*.ksplat)', '*.ksplat', 'ksplat'],
      ['Gaussian attributes CSV (*.csv)', '*.csv', 'csv'],
      ['SOG v2 bundle (*.sog)', '*.sog', 'sog'],
      ['Legacy SOGS v1 bundle (*.sogs)', '*.sogs', 'sogs'],
    ]);
  });

  it.each([0, 1, 2, 3, 4, 5, 6, 7, 8])('resolves valid wire ID %s rather than a menu position', format => {
    expect(isSceneExportFormat(format)).toBe(true);
    expect(sceneExportDescriptor(format)?.format).toBe(format);
  });

  it.each([-1, 9, 256, 0xffffffff, 1.5, NaN, Infinity, '0', '8', null, undefined, {}, true])('refuses invalid wire value %s', value => {
    expect(isSceneExportFormat(value)).toBe(false);
    expect(sceneExportDescriptor(value)).toBeUndefined();
  });

  it.each([
    ['ordinary.PLY', 0], ['ordinary.SPLAT', 2], ['ordinary.KSPLAT', 4],
    ['draft.part.CoMpReSsEd.PlY', 3], ['.compressed.ply', 3], ['attributes.CSV', 5],
    ['bundle.SOG', 6], ['bundle.SOGS', 7], ['directory.compressed.ply/scene.spz', 8],
    ['directory.spz\\scene.COMPRESSED.PLY', 3], ['scene.SPZ', 8], ['.spz', 8],
  ])('infers %s using the leaf and longest declared suffix', (filename, format) => {
    expect(sceneExportFormatForFilename(filename)).toBe(format);
  });

  it.each(['', 'scene', 'scenePly', 'scene.ply.backup', 'scene.zip', 'meta.json', 'directory.ply/scene.unknown', 'directory.spz\\scene', 'directory.spz/'])('does not infer a format from %s', filename => {
    expect(sceneExportFormatForFilename(filename)).toBeUndefined();
  });
});
