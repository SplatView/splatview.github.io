import {createServer} from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join,extname,relative,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {buildComparison} from './build.mjs';
import {variants,fixtures} from './fixtures.mjs';

const args=process.argv.slice(2),workspace=resolve(args.find(a=>!a.startsWith('--'))??'.build/renderer-comparison-20261025-01'),probeOnly=args.includes('--probe'),smoke=args.includes('--smoke');
const selected=args.find(a=>a.startsWith('--variants='))?.slice(11).split(',')??variants;
assert(selected.length&&new Set(selected).size===selected.length&&selected.every(v=>variants.includes(v)),'Unknown or duplicate comparison variant.');
const label=args.find(a=>a.startsWith('--label='))?.slice(8)??`run-${Date.now()}`;assert(/^[a-zA-Z0-9-]+$/.test(label),'Invalid run label.');
const {site,receipt}=await buildComparison(workspace),reports=join(workspace,'reports',label);await mkdir(join(workspace,'reports'),{recursive:true});await mkdir(reports,{recursive:false});
const mime={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.json':'application/json','.wasm':'application/wasm','.png':'image/png','.map':'application/json'};
const server=createServer(async(req,res)=>{
  try{const url=new URL(req.url,'http://localhost'),path=resolve(site,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname)),within=relative(site,path);
    if(isAbsolute(within)||within.startsWith('..'))throw new Error('Outside benchmark site.');
    const bytes=await readFile(path);res.writeHead(200,{'content-type':mime[extname(path)]??'application/octet-stream','cache-control':'no-store'});res.end(bytes);
  }catch{res.writeHead(404);res.end('Not found');}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({channel:'chromium',headless:true,args:['--enable-unsafe-webgpu']});
const result={schemaVersion:1,kind:'renderer-comparison',startedAt:new Date().toISOString(),browser:browser.version(),origin,build:receipt,probes:[],cases:[],errors:[],
  label,dataRoot:`reports/${label}`,plannedVariants:selected,
  scope:'Renderer cores/sessions; no feature parity target. Shared scene/camera/framebuffer, renderer-specific algorithms/packing and async sort policy recorded. No presentation FPS claim.'};
const references=new Map();
async function save(){const bytes=JSON.stringify(result,null,2)+'\n';await writeFile(join(workspace,probeOnly?'probe.json':smoke?'smoke.json':'results.json'),bytes);await writeFile(join(workspace,label+'.json'),bytes);}
function validateProbe(value){
  const image=value.images[0],pixels=Buffer.from(image.rgba,'base64'),centers=[];
  for(let c=0;c<3;c++){
    let weight=0,x=0,y=0;
    for(let i=0;i<pixels.length;i+=4){const a=pixels[i+c],other=Math.max(pixels[i+(c+1)%3],pixels[i+(c+2)%3]);if(a>32&&a>other*1.5){const w=a-other;weight+=w;x+=(i/4%image.width)*w;y+=Math.floor(i/4/image.width)*w;}}
    assert(weight>100,`${value.variant}: missing color ${c}`);const xyz=[(c-1)*.8,c===1?.25:-.15,-4-c],expected=[(xyz[0]*1.6/(image.width/image.height)/-xyz[2]*.5+.5)*image.width,(.5-xyz[1]*1.6/-xyz[2]*.5)*image.height];
    const centroid=[x/weight,y/weight];assert(Math.hypot(centroid[0]-expected[0],centroid[1]-expected[1])<6,`${value.variant}: camera/color probe mismatch ${centroid} vs ${expected}`);centers.push({color:c,centroid,expected});
  }
  return centers;
}
async function execute(variant,fixtureId,repetition,probe=false){
  const context=await browser.newContext({viewport:{width:800,height:600},deviceScaleFactor:1}),page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  try{
    await page.goto(origin);await page.waitForFunction(()=>!!window.rendererComparison,{timeout:30000});
    const value=await page.evaluate(options=>window.rendererComparison.measure(options),{variant,fixtureId,probe,frames:smoke?8:60,quality:!probe&&repetition===0});
    assert.deepEqual(value.errors,[],variant);assert.deepEqual(value.lost,[],variant);assert.deepEqual(errors,[],variant);
    const id=probe?`probe-${variant}`:`${fixtureId}-${variant}-r${repetition+1}`;
    if(probe)value.probeCentroids=validateProbe(value);
    const imageRecords=[];
    for(const image of value.images){
      if(!probe){const pixels=Buffer.from(image.rgba,'base64');let visible=0;for(let i=0;i<pixels.length;i+=4)if(Math.max(pixels[i],pixels[i+1],pixels[i+2])>8)visible++;
        assert(visible>image.width*image.height*.05,`${variant}: degenerate/empty output cannot qualify a fast rendering result.`);}
      const key=`${fixtureId}/${image.phase}/${image.index}`,bytes=Buffer.from(image.png,'base64'),name=`${id}-${image.phase}-${image.index}.png`;
      await writeFile(join(reports,name),bytes);const reference=references.get(key);
      const quality=reference?await page.evaluate(({actual,reference})=>window.rendererComparison.compare(actual,reference),{actual:image.rgba,reference}):null;
      if(variant==='splatview-webgpu-32'&&!probe)references.set(key,image.rgba);
      imageRecords.push({phase:image.phase,index:image.index,angle:image.angle,path:`reports/${label}/${name}`,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),qualityVsSplatView32:quality});
    }
    value.images=imageRecords;value.repetition=repetition;await writeFile(join(reports,id+'.json'),JSON.stringify(value,null,2)+'\n');
    (probe?result.probes:result.cases).push({id,path:`reports/${label}/${id}.json`,variant,fixtureId,repetition,passed:true});
    console.log('PASS',id,`startup ${value.startupMs.toFixed(1)} ms`);return value;
  }catch(error){const id=probe?`probe-${variant}`:`${fixtureId}-${variant}-r${repetition+1}`;result.errors.push({id,message:error.stack??String(error),pageErrors:errors});
    await page.screenshot({path:join(reports,id+'-failure.png')}).catch(()=>{});console.error('FAIL',id,error.message);throw error;
  }finally{await context.close();await save();}
}
try{
  for(const variant of selected)await execute(variant,null,0,true);
  if(!probeOnly)for(let repetition=0;repetition<(smoke?1:3);repetition++)for(const config of (smoke?fixtures.slice(0,1):fixtures)){
    const rotation=selected===variants?3:1;
    const order=repetition===0?selected:repetition===1?[...selected.slice(rotation),...selected.slice(0,rotation)]:[...selected].reverse();
    for(const variant of order)await execute(variant,config.id,repetition);
  }
  result.finishedAt=new Date().toISOString();await save();
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
