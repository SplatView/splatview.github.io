import {readFileSync,writeFileSync,openSync,closeSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const phase=resolve('.build/webgl-sort-20261025-01');
const old=JSON.parse(readFileSync('docs/validation/runs/standalone-renderer-20261025-01/browser-observations.json','utf8')).cohorts;
const statuses=[];
for(const [oldName,name,backend] of [
  ['app-renderer-lifecycle','renderer-regression',null],
  ['selection-browser','selection-browser',null],
  ['app-webgl2-output','outputs-webgl2','webgl2'],
  ['app-webgpu-output','outputs-webgpu','webgpu'],
  ['app-production-webgl2','production-webgl2','webgl2'],
  ['app-production-webgpu','production-webgpu','webgpu'],
]) {
  const command=old.find(c=>c.name===oldName).command.slice(2).map(a=>a.replace('standalone-renderer-20261025-01/production.config.ts','webgl-sort-20261025-01/production.config.ts'));
  if(name==='renderer-regression')command.push('--project','spec:fast-order.spec.ts','--project','spec:display-policy.spec.ts');
  const env={...process.env,PLAYWRIGHT_JSON_OUTPUT_FILE:resolve(phase,name+'.json')};
  if(backend)env.SPLATVIEW_TEST_BACKEND=backend;else delete env.SPLATVIEW_TEST_BACKEND;
  const log=openSync(resolve(phase,name+'.log'),'w');console.log('Starting',name);
  const result=spawnSync(process.execPath,[resolve('node_modules/@playwright/test/cli.js'),...command],{env,stdio:['ignore',log,log]});closeSync(log);
  statuses.push({name,command:['node','node_modules/@playwright/test/cli.js',...command],backend,exitCode:result.status,error:result.error?.message});
  writeFileSync(resolve(phase,'browser-run-status.json'),JSON.stringify(statuses,null,2)+'\n');
  console.log('Finished',name,result.status);if(result.status!==0)process.exit(result.status??1);
}
