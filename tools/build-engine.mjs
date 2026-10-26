import { cp, readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

// Uses the repository's locked compiler and bundler; no application/native build.
const root = resolve(import.meta.dirname, '..');
const { version } = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--config', 'vite.engine.config.ts'], { cwd: root, stdio: 'inherit' });
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '--project', 'tsconfig.engine.json'], { cwd: root, stdio: 'inherit' });
await cp(resolve(root, 'examples/standalone-renderer'), resolve(root, 'dist-engine/example'), { recursive: true });
await cp(resolve(root, 'docs/development/renderer-engine.md'), resolve(root, 'dist-engine/README.md'));
await cp(resolve(root, 'public/licenses/PlayCanvas-MIT.txt'), resolve(root, 'dist-engine/PlayCanvas-MIT.txt'));
await cp(resolve(root, 'docs/third-party/STEADY_SPLATS_REFERENCES.md'), resolve(root, 'dist-engine/RENDERING-REFERENCES.md'));
const manifest = JSON.parse(await readFile(resolve(root, 'dist-engine/engine-manifest.json'), 'utf8'));
await writeFile(resolve(root, 'dist-engine/package.json'), JSON.stringify({ name: '@splatview/renderer', version,
  private: true, type: 'module', exports: { '.': { types: './types/engine/index.d.ts', import: './splatview-renderer.js' } },
  splatviewSourceId: manifest.sourceId }, null, 2) + '\n');
const directory = resolve(root, 'dist-engine');
const paths = (await readdir(directory, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile())
  .map(entry => resolve(entry.parentPath, entry.name).slice(directory.length + 1).replaceAll('\\', '/'))
  .filter(path => path !== 'engine-manifest.json').sort();
manifest.artifacts = await Promise.all(paths.map(async path => {
  const bytes = await readFile(resolve(directory, path));
  return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}));
await writeFile(resolve(directory, 'engine-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
execFileSync(process.execPath, ['tools/check-engine.mjs'], { cwd: root, stdio: 'inherit' });
