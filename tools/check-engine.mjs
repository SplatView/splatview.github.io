import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '..'), output = resolve(root, 'dist-engine');
const manifest = JSON.parse(await readFile(resolve(output, 'engine-manifest.json'), 'utf8'));
const packageInfo = JSON.parse(await readFile(resolve(output, 'package.json'), 'utf8'));
assert.equal(packageInfo.version, JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')).version, 'Standalone package version');
for (const file of manifest.artifacts) {
  const bytes = await readFile(resolve(output, file.path));
  assert.equal(bytes.length, file.bytes, file.path);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, file.path);
}
const directory = resolve(root, '.build/engine-consumer');
await mkdir(directory, { recursive: true });
await writeFile(resolve(directory, 'consumer.ts'), `
import { createRenderer, ResourceLedger, type RenderCamera, type SurfaceMap } from '../../dist-engine/types/engine/index';
async function host(canvas: HTMLCanvasElement, camera: RenderCamera, packed: ArrayBuffer) {
  const renderer = await createRenderer(canvas, { preference: 'auto' });
  const budget = new ResourceLedger(128 * 1024 ** 2);
  renderer.admitWork = bytes => budget.reserve('work', bytes);
  const scene = await renderer.allocateScene(3, 0);
  await scene.upload(0, 3, packed); await renderer.render(scene, camera);
  const map: SurfaceMap = await renderer.surface(scene, { admit: bytes => budget.reserve('work', bytes) });
  map.dispose(); await scene.dispose(); await renderer.close();
}
void host;
`);
await writeFile(resolve(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
  target: 'ES2023', lib: ['ES2023', 'DOM'], module: 'ESNext', moduleResolution: 'Bundler',
  strict: true, noEmit: true, skipLibCheck: false, types: [],
}, include: ['consumer.ts'] }, null, 2));
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '--project', '.build/engine-consumer/tsconfig.json'], { cwd: root, stdio: 'inherit' });
console.log(`Verified ${manifest.artifacts.length} standalone artifacts and an isolated TypeScript consumer (${manifest.sourceId}).`);
