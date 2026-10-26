import type { ComputeCommand, ComputeResponse,ComputeTiming } from './computeProtocol';
import { StaleRenderQueryError } from '../contracts';
import { SurfaceCapacityError } from '../webgpu/surfaceQuery';
import { assertComputeIdentity, type ComputeIdentity } from './computeIdentity';
import { planSortScratch, sortScratchLimit } from './sortScratchLayout';

/** One executor, with acknowledged cancellation; no document/history authority. */
export class RenderComputeClient {
  private sequence=0;
  private closed=false;
  private sortScratch?:{count:number;release:()=>void};
  private scratchPreparation?:Promise<boolean>;
  private scratchUsers=0;
  private scratchTrimRequested=false;
  private scratchRetirement?:Promise<void>;
  get sortScratchSnapshot() { return {bytes:this.sortScratch?planSortScratch(this.sortScratch.count).bytes:0,users:this.scratchUsers,retiring:!!this.scratchRetirement,preparing:!!this.scratchPreparation}; }
  private readonly pending=new Map<number,{resolve:(value:Extract<ComputeResponse,{ok:true}>)=>void;reject:(reason:unknown)=>void;admit?:(bytes:number)=>void}>();
  /** Test/agent-only diagnostics. No clocks or records while disabled. */
  observeStages=false;
  observeWork?: (event:ComputeTiming & {action:ComputeCommand['action'];roundTripMs:number;transportAndWakeupMs:number;transferredArrayBufferBytes:number})=>void;
  onFailure?: (message:string)=>void;
  private constructor(private readonly worker:Worker) {
    this.worker.onmessage=({data}:{data:ComputeResponse}) => {
      const job=this.pending.get(data.id); if(!job) return;
      if('phase' in data) {
        try { if(!job.admit) throw new Error('Render query admission is unavailable.'); job.admit(data.bytes); this.worker.postMessage({action:'admitted',target:data.id,ok:true}); }
        catch(error) { this.worker.postMessage({action:'admitted',target:data.id,ok:false,message:error instanceof Error?error.message:String(error)}); }
        return;
      }
      this.pending.delete(data.id);
      if(data.scratchBytes===0) { this.sortScratch?.release(); this.sortScratch=undefined; }
      if(data.ok) job.resolve(data);
      else job.reject(data.capacity?new SurfaceCapacityError(data.capacity.required,data.capacity.capacity):data.name==='AbortError' ? new DOMException(data.message,'AbortError'):new Error(data.message));
    };
    this.worker.onerror=event => { event.preventDefault(); this.fail(event.message || 'The rendering worker failed.'); };
    this.worker.onmessageerror=() => this.fail('The rendering worker returned an unreadable message.');
  }
  /** Takes worker ownership immediately, including initialization failure. */
  static async connect(worker: Worker, identity: ComputeIdentity, timeoutMs = 45000) {
    const client = new RenderComputeClient(worker);
    const timeout = setTimeout(() => client.close('The render executor could not verify this build in time.'), timeoutMs);
    try {
      const response = await client.request({ action: 'initialize', identity });
      assertComputeIdentity(response.identity, identity); return client;
    } catch (error) { client.close(); throw error; }
    finally { clearTimeout(timeout); }
  }
  request(command:ComputeCommand, transfer:Transferable[]=[], signal?:AbortSignal,admit?:(bytes:number)=>void) {
    if(this.closed) return Promise.reject(new StaleRenderQueryError('The rendering worker is unavailable.'));
    signal?.throwIfAborted(); const id=++this.sequence, observe=this.observeWork, started=observe?performance.now():0;
    const sent=observe?transfer.reduce<number>((sum,value)=>sum+(value instanceof ArrayBuffer?value.byteLength:0),0):0;
    const cancel=() => this.worker.postMessage({action:'cancel',target:id});
    const promise=new Promise<Extract<ComputeResponse,{ok:true}>>((resolve,reject) => {
      this.pending.set(id,{resolve,reject,admit});
      try { this.worker.postMessage({...command,id,...(observe?{profile:this.observeStages?'stages' as const:true}:{})},transfer); } catch(error) { this.pending.delete(id); reject(error); }
    });
    signal?.addEventListener('abort',cancel,{once:true});
    return promise.then(value=>{
      if(observe && value.timing) { const roundTripMs=performance.now()-started;
        try { observe({action:command.action,roundTripMs,...value.timing,transferredArrayBufferBytes:sent+(value.order?.byteLength??0)+(value.surface?[value.surface.depths,value.surface.opacities,value.surface.colors,value.surface.visible].reduce((sum,buffer)=>sum+(buffer?.byteLength??0),0):0),transportAndWakeupMs:Math.max(0,roundTripMs-value.timing.queueMs-value.timing.computeMs)}); } catch { /* Diagnostics cannot affect ownership. */ }
      } return value;
    }).finally(() => signal?.removeEventListener('abort',cancel));
  }
  /** Retained worker arrays have an independent lease, including while idle. */
  private ensureSortScratch(count:number,admit?:((bytes:number)=>()=>void)):Promise<boolean> {
    if(this.scratchPreparation) return this.scratchPreparation.then(()=>!!this.sortScratch && this.sortScratch.count>=count);
    if(this.sortScratch) return Promise.resolve(this.sortScratch.count>=count);
    const {bytes}=planSortScratch(count);
    if(!admit || !bytes || bytes>sortScratchLimit) return Promise.resolve(false);
    let release:()=>void; try { release=admit(bytes); } catch { return Promise.resolve(false); }
    const task=this.request({action:'sortScratch',count}).then(()=>{
      if(this.closed) { release(); return false; } this.sortScratch={count,release}; return true;
    },()=>{release();return false;}).finally(()=>{if(this.scratchPreparation===task) this.scratchPreparation=undefined;});
    this.scratchPreparation=task; return task;
  }
  async acquireSortScratch(count:number,admit?:((bytes:number)=>()=>void)) {
    if(this.scratchRetirement) { await this.scratchRetirement; return undefined; }
    if(this.sortScratch && this.sortScratch.count!==count && !this.scratchUsers) await this.trimSortScratch();
    const ready=await this.ensureSortScratch(count,admit);
    if(this.scratchRetirement) { await this.scratchRetirement; return undefined; }
    if(!ready || this.closed || !this.sortScratch || this.sortScratch.count<count) return undefined;
    this.scratchUsers++; let released=false;
    return ()=>{if(released) return; released=true; this.scratchUsers--;
      if(!this.scratchUsers && this.scratchTrimRequested) { this.scratchTrimRequested=false; void this.trimSortScratch().catch(()=>undefined); }
    };
  }
  async trimSortScratch():Promise<void> {
    await this.scratchPreparation; if(!this.sortScratch || this.closed) return;
    if(this.scratchUsers) { this.scratchTrimRequested=true; return; }
    if(this.scratchRetirement) return this.scratchRetirement;
    const task=this.request({action:'sortScratch',count:0}).then(()=>undefined).finally(()=>{if(this.scratchRetirement===task) this.scratchRetirement=undefined;});
    this.scratchRetirement=task; return task;
  }
  barrier() { return this.request({action:'barrier'}).then(() => undefined); }
  private fail(message:string) { this.close(message); this.onFailure?.(message); }
  close(message='The rendering worker was retired.') {
    if(this.closed) return; this.closed=true; this.worker.terminate();
    this.sortScratch?.release(); this.sortScratch=undefined;
    for(const job of this.pending.values()) job.reject(new StaleRenderQueryError(message)); this.pending.clear();
  }
}
