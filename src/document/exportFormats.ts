// Capture02 scene_export_formats.hpp: wire IDs are independent of menu order.
export const SCENE_EXPORT_FORMATS = [
  { format: 0, label: 'Gaussian PLY (*.ply)', pattern: '*.ply', extension: 'ply' },
  { format: 8, label: 'SPZ v4 (*.spz)', pattern: '*.spz', extension: 'spz' },
  { format: 1, label: 'Legacy SPZ v3 (*.spz)', pattern: '*.spz', extension: 'spz' },
  { format: 2, label: 'SPLAT - DC colors (*.splat)', pattern: '*.splat', extension: 'splat' },
  { format: 3, label: 'SuperSplat compressed PLY (*.compressed.ply)', pattern: '*.ply', extension: 'compressed.ply' },
  { format: 4, label: 'KSPLAT - float geometry, byte DC colors (*.ksplat)', pattern: '*.ksplat', extension: 'ksplat' },
  { format: 5, label: 'Gaussian attributes CSV (*.csv)', pattern: '*.csv', extension: 'csv' },
  { format: 6, label: 'SOG v2 bundle (*.sog)', pattern: '*.sog', extension: 'sog' },
  { format: 7, label: 'Legacy SOGS v1 bundle (*.sogs)', pattern: '*.sogs', extension: 'sogs' },
] as const;

export type SceneExportFormat = typeof SCENE_EXPORT_FORMATS[number]['format'];
export type SceneExportDescriptor = typeof SCENE_EXPORT_FORMATS[number];
export type AdmittedSceneExportFormat = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export function sceneExportDescriptor(value: unknown): SceneExportDescriptor | undefined {
  return SCENE_EXPORT_FORMATS.find(descriptor => descriptor.format === value);
}

export function isSceneExportFormat(value: unknown): value is SceneExportFormat {
  return sceneExportDescriptor(value) !== undefined;
}

/** Every retained native writer exposes a checked output/workspace bound. */
export function isAdmittedSceneExportFormat(value: unknown): value is AdmittedSceneExportFormat {
  return isSceneExportFormat(value);
}

/** Match only the output leaf, with the target's longest suffix and ASCII folding. */
export function sceneExportFormatForFilename(filename: string): SceneExportFormat | undefined {
  const leaf = (filename.split(/[\\/]/).at(-1) ?? '').replace(/[A-Z]/g, character => character.toLowerCase());
  let matched: SceneExportDescriptor | undefined;
  for (const descriptor of SCENE_EXPORT_FORMATS) {
    if ((!matched || descriptor.extension.length > matched.extension.length) && leaf.endsWith(`.${descriptor.extension}`))
      matched = descriptor;
  }
  return matched?.format;
}
