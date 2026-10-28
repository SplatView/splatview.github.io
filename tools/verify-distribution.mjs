/** Independently qualify release bytes with the maintained build contract. */
import assert from 'node:assert/strict';
import { lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { collectApplicationInputs, createDeploymentManifest, descriptorFromInputs, sha256 } from './web-build.mjs';

export function verifyDistribution(source, directory, expectedVersion) {
  source = resolve(source); directory = resolve(directory);
  const json = path => JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(json(resolve(source, 'package.json')).version, expectedVersion, 'Release/source version differs');
  const manifest = json(resolve(directory, 'build-manifest.json'));
  const build = descriptorFromInputs(collectApplicationInputs(source),
    json(resolve(source, 'native/wasm/runtime-contract.json')),
    json(resolve(directory, 'wasm/build-provenance.json')));
  assert.deepEqual(manifest.build, build, 'Release does not match its source inputs');
  const one = role => {
    const records = manifest.artifacts.filter(record => record.role === role);
    assert.equal(records.length, 1, `Missing/duplicate ${role}`);
    return records[0].path;
  };
  assert.deepEqual(createDeploymentManifest(build, manifest.artifacts,
    one('application-entry'), one('document-worker')), manifest, 'Invalid deployment manifest');
  const files = [];
  function visit(path) {
    const stat = lstatSync(path);
    assert(!stat.isSymbolicLink(), 'Linked distribution member');
    if (stat.isDirectory()) for (const name of readdirSync(path).sort()) visit(resolve(path, name));
    else {
      assert(stat.isFile(), 'Non-file distribution member');
      files.push(relative(directory, path).replaceAll('\\', '/'));
    }
  }
  visit(directory);
  for (const record of manifest.artifacts) {
    const bytes = readFileSync(resolve(directory, record.path));
    assert.equal(bytes.length, record.bytes, `Size: ${record.path}`);
    assert.equal(sha256(bytes), record.sha256, `Checksum: ${record.path}`);
  }
  const maps = files.filter(name => name.endsWith('.map'));
  for (const name of maps) {
    const owner = name.slice(0, -4);
    assert(manifest.artifacts.some(record => record.path === owner), `Unowned map: ${name}`);
    assert(readFileSync(resolve(directory, owner), 'utf8').includes(`sourceMappingURL=${basename(name)}`));
    const map = json(resolve(directory, name));
    assert.equal(map.version, 3);
    assert(Array.isArray(map.sources) && Array.isArray(map.sourcesContent));
    assert.equal(map.sources.length, map.sourcesContent.length);
  }
  assert.deepEqual(files.sort(), [...manifest.artifacts.map(record => record.path), ...maps, 'build-manifest.json'].sort(),
    'Unreviewed or missing distribution files');
  return { deploymentId: manifest.deploymentId, appInputId: build.appInputId,
    files: files.map(path => { const bytes = readFileSync(resolve(directory, path));
      return { path, bytes: bytes.length, sha256: sha256(bytes) }; }) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [source, directory, version, output] = process.argv.slice(2);
  if (!output || process.argv.length !== 6) throw new Error('Usage: node tools/verify-distribution.mjs SOURCE DIST VERSION OUTPUT');
  const result = verifyDistribution(source, directory, version);
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  console.log(`Verified ${result.files.length} release files; deployment ${result.deploymentId}`);
}
