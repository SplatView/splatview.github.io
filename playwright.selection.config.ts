import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import base from './playwright.config';

// Keep each spec's base project identity so its browser is retired before the
// next spec. Order the GPU oracles before controller and Basic UI coverage.
const files = [
  'surface-bounds.spec.ts',
  'selection-interaction.spec.ts',
  'surface-optimization.spec.ts',
  'surface.spec.ts',
  'opacity-surface.spec.ts',
  'map-cache.spec.ts',
  'fill.spec.ts',
  'connected.spec.ts',
  'volume.spec.ts',
  'web-lite.spec.ts',
];
const boundaries = new Map([
  ['fill.spec.ts', /Fill controller boundaries/],
  ['connected.spec.ts', /Connected Color controller boundaries/],
  ['volume.spec.ts', /during surface acquisition preserves/],
]);
const projects = files.map(file => {
  const project = base.projects!.find(value => value.name === `spec:${file}`);
  if (!project) throw new Error(`Missing browser project: ${file}`);
  const grep = boundaries.get(file);
  return grep ? { ...project, grep } : project;
});

// A single object replaces projects rather than merging the full base cohort.
// Server reuse, origin, reporters and output locations retain base/CLI defaults.
export default defineConfig({
  ...base,
  testDir: fileURLToPath(new URL('./e2e/', import.meta.url)),
  projects,
});
