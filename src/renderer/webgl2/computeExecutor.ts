import type { ComputeRequest, ComputeResponse,ComputeTiming } from './computeProtocol';
import { createRadixScratch,stableDepthOrder,type RadixScratch } from './radix';
import { packedStride } from '../../document/resources';
import { computePick,computeSurface } from './queryCompute';
import { SurfaceCapacityError } from '../webgpu/surfaceQuery';
import { assertComputeIdentity, type ComputeIdentity } from './computeIdentity';
import { planSortScratch, sortScratchLimit } from './sortScratchLayout';


export function installRenderComputeWorker(identity: ComputeIdentity) {
const scenes=new Map<number,{count:number;stride:number;packed:Float32Array<ArrayBuffer>}>();
const cancelled=new Set<number>(); let queue=Promise.resolve();
const active=new Set<number>();
const admissions=new Map<number,(value:{ok:boolean;message?:string})=>void>();
let scratch:RadixScratch|undefined;
let initialized=false;
const scope=self as unknown as DedicatedWorkerGlobalScope;
// A worker task boundary admits cancellation without nested timer clamping.
// The serial executor has exactly one outstanding cooperative continuation.
const yieldChannel=new MessageChannel();
let resumeYield:(()=>void)|undefined;
yieldChannel.port1.onmessage=()=>{const resume=resumeYield;resumeYield=undefined;resume?.();};
const yieldTask=()=>new Promise<void>(resolve=>{resumeYield=resolve;yieldChannel.port2.postMessage(null);});
scope.onmessage=({data}:{data:ComputeRequest|{action:'cancel';target:number}|{action:'admitted';target:number;ok:boolean;message?:string}}) => {
  if(data.action==='cancel') { if(active.has(data.target)) { cancelled.add(data.target); admissions.get(data.target)?.({ok:false,message:'The render query was cancelled.'}); } return; }
  if(data.action==='admitted') { admissions.get(data.target)?.(data); return; }
  const received=data.profile?performance.now():0;
  active.add(data.id);
  queue=queue.then(async () => {
    const started=data.profile?performance.now():0;
    const stages:NonNullable<ComputeTiming['stages']>|undefined=data.profile==='stages'?[]:undefined; let previous=started;
    const stage=stages?(name:string)=>{const now=performance.now();if(stages.length<32) stages.push({name,wallMs:now-previous});previous=now;}:undefined;
    const check=() => { if(cancelled.has(data.id)) throw new DOMException('The render computation was cancelled.','AbortError'); };
    const checkpoint=async () => { await yieldTask(); check(); };
    let response:ComputeResponse; const transfer:Transferable[]=[];
    try {
      check();
      if(data.action==='initialize') {
        if(initialized) throw new Error('The render executor is already initialized.');
        assertComputeIdentity(data.identity,identity); initialized=true; response={id:data.id,ok:true,identity};
      } else if(!initialized) throw new Error('The render executor must verify its build before accepting work.');
      else if(data.action==='create') {
        if(scenes.has(data.scene) || !Number.isSafeInteger(data.count) || data.count<1 || data.count>3_000_000 ||
          ![0,1,2,3].some(degree=>packedStride(degree)===data.stride)) throw new Error('Invalid render scene allocation.');
        scenes.set(data.scene,{count:data.count,stride:data.stride,packed:new Float32Array(data.count*data.stride/4)});
      } else if(data.action==='sortScratch') {
        const plan=planSortScratch(data.count);
        if(plan.bytes>sortScratchLimit) throw new Error('Invalid sort scratch allocation.');
        scratch=data.count?createRadixScratch(data.count,plan.histogramBins):undefined; response={id:data.id,ok:true,scratchBytes:plan.bytes};
      } else if(data.action==='drop') { scenes.delete(data.scene); if(!scenes.size) { scratch=undefined; response={id:data.id,ok:true,scratchBytes:0}; } }
      else if(data.action!=='barrier') {
        const scene=scenes.get(data.scene); if(!scene) throw new Error('The render scene was retired.');
        if(data.action==='upload') {
          if(![data.first,data.count].every(Number.isSafeInteger) || data.first<0 || data.count<1 || data.first+data.count>scene.count ||
            data.bytes.byteLength!==data.count*scene.stride) throw new Error('Invalid render scene upload.');
          scene.packed.set(new Float32Array(data.bytes),data.first*scene.stride/4);
        } else if(data.action==='sort') {
          if(data.frame.byteLength!==320 || data.transformTargets.byteLength!==scene.count) throw new Error('Invalid sort snapshot.');
          const order=await stableDepthOrder(scene.packed,scene.count,scene.stride/4,new Float32Array(data.frame),new Uint8Array(data.transformTargets),checkpoint,scratch && scratch.keys.length>=scene.count?scratch:undefined,undefined,stage,data.precision??32);
          const result=scratch && (order.buffer===scratch.input.buffer || order.buffer===scratch.output.buffer)?order.slice():order;
          check(); transfer.push(result.buffer); response={id:data.id,ok:true,order:result.buffer};
        } else {
          if(data.frame.byteLength!==320 || [data.canonical,data.transform,data.opacity].some(mask=>mask.byteLength!==scene.count)) throw new Error('Invalid query snapshot.');
          const input={frame:new Float32Array(data.frame),canonical:new Uint8Array(data.canonical),transform:new Uint8Array(data.transform),opacity:new Uint8Array(data.opacity)};
          if(data.action==='pick') response={id:data.id,ok:true,pick:await computePick(scene,input,data.x,data.y,data.radius,checkpoint,stage)};
          else {
            const admit=async(bytes:number) => {
              const result=await new Promise<{ok:boolean;message?:string}>(resolve=>{admissions.set(data.id,resolve); scope.postMessage({id:data.id,phase:'admit',bytes} satisfies ComputeResponse);});
              admissions.delete(data.id); check(); if(!result.ok) throw new Error(result.message??'The render query exceeds its admission.');
            };
            if(data.parameters.byteLength!==48) throw new Error('Invalid surface parameters.');
            const surface=await computeSurface(scene,input,new Uint32Array(data.parameters),data.maximum,admit,checkpoint,stage);
            transfer.push(surface.depths,surface.opacities); if(surface.colors) transfer.push(surface.colors); if(surface.visible) transfer.push(surface.visible);
            response={id:data.id,ok:true,surface};
          }
        }
      }
      response ??= {id:data.id,ok:true};
    } catch(error) { response={id:data.id,ok:false,name:error instanceof Error?error.name:'Error',message:error instanceof Error?error.message:String(error),
      capacity:error instanceof SurfaceCapacityError?{required:error.required,capacity:error.capacity}:undefined}; }
    finally { cancelled.delete(data.id); active.delete(data.id); admissions.delete(data.id); }
    if(data.profile) response.timing={queueMs:started-received,computeMs:performance.now()-started,...(stages?{stages}:{})};
    scope.postMessage(response,transfer);
  });
};

}
