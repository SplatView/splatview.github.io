import {readFile,writeFile,mkdir,cp,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,relative,isAbsolute,join} from 'node:path';
import {build} from 'vite';
import assert from 'node:assert/strict';

const root=resolve(import.meta.dirname,'../../..');
export const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function buildComparison(workspace){
  workspace=resolve(workspace);const allowed=await realpath(resolve(root,'.build')),actual=await realpath(workspace),within=relative(allowed,actual);
  assert(within&&!within.startsWith('..')&&!isAbsolute(within),'Comparison workspace must be a frozen directory inside .build.');
  const references=JSON.parse(await readFile(join(workspace,'references.json'),'utf8')),refRoot=join(workspace,'references');
  const realRefs=await realpath(refRoot);
  for(const entry of references.files){const file=resolve(refRoot,entry.path),within=relative(realRefs,await realpath(file));assert(!isAbsolute(within)&&!within.startsWith('..'),'Reference escapes frozen source directory.');
    const bytes=await readFile(file);assert(bytes.length===entry.bytes&&sha(bytes)===entry.sha256,`Changed reference: ${entry.path}`);}
  const engine=resolve(root,'dist-engine'),engineManifest=JSON.parse(await readFile(join(engine,'engine-manifest.json'),'utf8'));
  for(const entry of engineManifest.artifacts){const bytes=await readFile(join(engine,entry.path));assert(bytes.length===entry.bytes&&sha(bytes)===entry.sha256,`Changed SDK artifact: ${entry.path}`);}
  const site=join(workspace,'site');await mkdir(site,{recursive:true});await cp(engine,join(site,'engine'),{recursive:true});
  await cp(join(refRoot,'playcanvas/build/playcanvas.js'),join(site,'playcanvas.js'));
  const bridge=join(workspace,'gs-toolbox-bridge.mjs'),gs=join(refRoot,'colmapview-gs-toolbox/dist').replaceAll('\\','/');
  await writeFile(bridge,[
    `export {createGPUProjectionModule} from '${gs}/projection/gpu/index.js';`,
    `export {createGPUSortModule} from '${gs}/sort/gpu/index.js';`,
    `export {createGPURasterModule} from '${gs}/rasterization/gpu/index.js';`,
    `export {createGPUOutputModule} from '${gs}/output/gpu/index.js';`,
    `export {createRenderTargets,destroyRenderTargets} from '${gs}/pipeline.js';`,
  ].join('\n'));
  await build({configFile:false,publicDir:false,root,logLevel:'warn',resolve:{alias:{'frozen-colmapview':join(refRoot,'colmapview-configuration/gaussianRenderer.ts'),'gs-toolbox':bridge}},
    build:{outDir:site,emptyOutDir:false,target:'es2023',sourcemap:true,lib:{entry:resolve(import.meta.dirname,'browser.mjs'),formats:['es'],fileName:()=>'comparison.js'},
      rolldownOptions:{external:id=>id.startsWith('/engine/')}}});
  await writeFile(join(site,'index.html'),'<!doctype html><meta charset="utf-8"><title>Internal renderer comparison</title><script src="/playcanvas.js"></script><script type="module" src="/comparison.js"></script>');
  const receipt={schemaVersion:1,engineSourceId:engineManifest.sourceId,references,scope:'Internal benchmark output only; no shipping application assets or dependencies changed.'};
  await writeFile(join(workspace,'build.json'),JSON.stringify(receipt,null,2)+'\n');return{site,receipt};
}
if(process.argv[1]===new URL(import.meta.url).pathname||process.argv[1]?.replaceAll('\\','/').endsWith('/comparison/build.mjs')){
  const workspace=process.argv[2];if(!workspace)throw new Error('Usage: node tools/bench/comparison/build.mjs <frozen .build workspace>');
  const result=await buildComparison(workspace);console.log(result.site);
}
