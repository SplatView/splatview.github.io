import { defineConfig, type Plugin } from 'vite';
import { createHash } from 'node:crypto';
import { lstatSync, realpathSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';

const root = import.meta.dirname;
const pureInputs = ['src/document/resources.ts', 'src/document/duplicateProtocol.ts',
  'src/document/selectionView.ts', 'src/io/image.ts', 'src/input/background.ts', 'src/build/contracts.ts', 'src/build/verification.ts'];
function files(directory: string): string[] {
  return readdirSync(resolve(root, directory), { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? files(`${directory}/${entry.name}`) : [`${directory}/${entry.name}`]);
}
const sources = [...files('src/renderer'), ...files('src/engine'), ...pureInputs, 'vite.engine.config.ts',
  'tsconfig.engine.json', 'tools/build-engine.mjs', 'tools/check-engine.mjs'].filter(path => !path.endsWith('webgl2/compute.worker.ts')).sort();
const digest = createHash('sha256');
for (const path of sources) digest.update(path).update('\0').update(readFileSync(resolve(root, path))).update('\0');
const sourceId = digest.digest('hex'), allowed = new Set(sources);
function assertOutput(directory: string) {
  const canonical = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
  if (canonical(directory) !== canonical(resolve(root, 'dist-engine'))) throw new Error('Standalone output must be the workspace dist-engine directory.');
  for (let current = directory;; current = dirname(current)) {
    try {
      if (!lstatSync(current).isDirectory() || lstatSync(current).isSymbolicLink() || canonical(realpathSync.native(current)) !== canonical(current)) {
        throw new Error(`Unsafe standalone output directory: ${current}`);
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (dirname(current) === current) break;
  }
  // Vite may empty this tree. Refuse links before any recursive filesystem work.
  try {
    if (readdirSync(directory, { recursive: true, withFileTypes: true }).some(entry => entry.isSymbolicLink())) {
      throw new Error('Standalone output contains a linked file or directory.');
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
function closure(): Plugin {
  return {
    name: 'standalone-renderer-closure',
    configResolved(config) { if (config.command === 'build') assertOutput(resolve(config.root, config.build.outDir)); },
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle).filter(output => output.type === 'chunk');
      if (chunks.length !== 1 || chunks[0].imports.length || chunks[0].dynamicImports.length) {
        throw new Error('The standalone renderer and worker must each be self-contained.');
      }
      for (const id of chunks[0].moduleIds) {
        if (id.startsWith('\0')) continue;
        const path = relative(root, id.split('?', 1)[0]).replaceAll('\\', '/');
        if (!allowed.has(path)) throw new Error(`Unreviewed standalone renderer dependency: ${path}`);
      }
    },
  };
}

export default defineConfig({
  base: './', publicDir: false, define: { __SPLATVIEW_ENGINE_SOURCE_ID__: JSON.stringify(sourceId) },
  plugins: [closure(), {
    name: 'standalone-renderer-manifest',
    generateBundle(_options, bundle) {
      const artifacts = Object.values(bundle).map(output => {
        const bytes = Buffer.from(output.type === 'chunk' ? output.code : output.source);
        return { path: output.fileName, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
      });
      this.emitFile({ type: 'asset', fileName: 'engine-manifest.json', source: JSON.stringify({ schemaVersion: 1,
        sourceId, protocolVersion: 1, sources: sources.map(path => {
          const bytes = readFileSync(resolve(root, path));
          return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
        }), artifacts }, null, 2) + '\n' });
    },
  }],
  worker: { format: 'es', plugins: () => [closure()], rolldownOptions: { output: { codeSplitting: false } } },
  build: { outDir: 'dist-engine', emptyOutDir: true, target: 'es2023', sourcemap: true,
    lib: { entry: resolve(root, 'src/engine/index.ts'), formats: ['es'], fileName: () => 'splatview-renderer.js' },
    rolldownOptions: { output: { codeSplitting: false } } },
});
