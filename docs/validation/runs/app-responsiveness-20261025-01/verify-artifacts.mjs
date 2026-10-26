import {readFileSync,writeFileSync,readdirSync,lstatSync} from 'node:fs';
import {resolve,relative,basename} from 'node:path';
import assert from 'node:assert/strict';
import {createDeploymentManifest,collectApplicationInputs,descriptorFromInputs,sha256} from '../../tools/web-build.mjs';
const manifest=JSON.parse(readFileSync('dist/build-manifest.json','utf8'));
const sourceInputs=collectApplicationInputs();
const build=descriptorFromInputs(sourceInputs,JSON.parse(readFileSync('native/wasm/runtime-contract.json','utf8')),JSON.parse(readFileSync('public/wasm/build-provenance.json','utf8')));
assert.deepEqual(build,manifest.build);
for(const record of manifest.artifacts) {const bytes=readFileSync(resolve('dist',record.path));assert.equal(bytes.length,record.bytes);assert.equal(sha256(bytes),record.sha256);}
assert.deepEqual(createDeploymentManifest(build,manifest.artifacts,manifest.artifacts.find(x=>x.role==='application-entry').path,manifest.artifacts.find(x=>x.role==='document-worker').path),manifest);
const files=[];
function walk(dir) {for(const entry of readdirSync(dir,{withFileTypes:true})) {const path=resolve(dir,entry.name);assert(!lstatSync(path).isSymbolicLink());if(entry.isDirectory())walk(path);else files.push(relative(resolve('dist'),path).replaceAll('\\','/'));}}
walk('dist');const maps=files.filter(path=>path.endsWith('.map'));
for(const path of maps) {const owner=path.slice(0,-4);assert(manifest.artifacts.some(x=>x.path===owner));assert(readFileSync(resolve('dist',owner),'utf8').includes(`sourceMappingURL=${basename(path)}`));const map=JSON.parse(readFileSync(resolve('dist',path),'utf8'));assert.equal(map.sources.length,map.sourcesContent.length);}
assert.deepEqual(files.sort(),[...manifest.artifacts.map(x=>x.path),...maps,'build-manifest.json'].sort());
const output={valid:true,deploymentId:manifest.deploymentId,appInputId:build.appInputId,artifacts:manifest.artifacts,distributionFiles:files,sourceMaps:maps,applicationInputs:sourceInputs};
writeFileSync('.build/app-responsiveness-20261025-01/artifacts.json',JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify({valid:true,artifacts:manifest.artifacts.length,files:files.length,maps:maps.length,inputs:sourceInputs.length,deploymentId:manifest.deploymentId,appInputId:build.appInputId}));
