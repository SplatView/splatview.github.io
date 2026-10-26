import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,stat} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {buildComparison,sha} from './build.mjs';
async function fixture(){const root=await mkdtemp(resolve('.build/comparison-contract-'));await mkdir(join(root,'references'));return root;}
test('changed frozen reference bytes reject before SDK copying or bundling',async()=>{
  const root=await fixture();await writeFile(join(root,'references','module.js'),'changed');
  await writeFile(join(root,'references.json'),JSON.stringify({files:[{path:'module.js',bytes:8,sha256:sha(Buffer.from('original'))}]}));
  await assert.rejects(buildComparison(root),/Changed reference/);await assert.rejects(stat(join(root,'site')),e=>e.code==='ENOENT');
});
test('a reference cannot resolve outside the frozen source directory',async()=>{
  const root=await fixture(),bytes=Buffer.from('original');await writeFile(join(root,'outside.js'),bytes);
  await writeFile(join(root,'references.json'),JSON.stringify({files:[{path:'../outside.js',bytes:bytes.length,sha256:sha(bytes)}]}));
  await assert.rejects(buildComparison(root),/escapes frozen source/);
});
