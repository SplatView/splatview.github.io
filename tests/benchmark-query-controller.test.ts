import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppController } from '../src/app/controller';
import { BenchmarkObservation } from '../src/app/benchmarkObservation';
import { setApp, useApp } from '../src/app/store';
import { IDENTITY_MATRIX, NEUTRAL_COLOR } from '../src/renderer/defaults';
import { type NativeSummary } from '../src/document/types';
import type { SceneRenderer as GaussianRenderer, GaussianScene as GpuScene, RenderPick as GpuPick } from '../src/renderer/contracts';
import type { CameraController } from '../src/input/camera';
import type { CoreClient } from '../src/document/coreClient';

const initial=useApp.getState();
const revision={documentId:'query-document',sourceGeneration:1,contentRevision:1,selectionRevision:1,draftRevision:0};
const summary={count:3,sourceCount:3,duplicateRange:null,selected:1,visible:3,canUndo:true,canRedo:false,kind:0,pending:false} as NativeSummary;
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return{promise,resolve};}
type Internal={benchmarkObservation?:BenchmarkObservation;selectionPixelPick(path:'ordinary-single'|'ordinary-color',renderer:GaussianRenderer,scene:GpuScene,
  camera:CameraController,x:number,y:number,grade:number[],selectedOnly:boolean):Promise<GpuPick>;ledger:{usage:{bytes:number}}};
beforeEach(()=>{vi.stubGlobal('window',{devicePixelRatio:1});vi.stubGlobal('document',{hidden:false,visibilityState:'visible'});
  setApp({...initial,ready:true,busy:false,rendererState:'ready',bootstrapState:'ready',summary},true);});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();setApp(initial,true);});
function fixture(observed=true){
  const controller=new AppController(),internal=controller as unknown as Internal;
  const result:GpuPick={index:0,depth:24,opacity:.8,contribution:.7,deviceEpoch:2};
  const renderer={lost:false,deviceEpoch:2,frameSubmissionSequence:0,canvas:{width:1280,height:800},
    render:vi.fn(()=>{renderer.frameSubmissionSequence++;}),pick:vi.fn(async()=>result)};
  const scene={kind: 'gaussian', setDuplicateRange: vi.fn(), count:3,revision:1,sourceRevision:1,selectedRevision:0};
  const camera={revision:1,state:[0,0,0,0,0,24,1,45,1,0,1.6],view:Array(16).fill(0),projection:Array(16).fill(0),eye:[0,0,24]};
  const client={revision:{...revision},readMasks:vi.fn(async(receive:(value:ArrayBuffer)=>void)=>{receive(new Uint8Array([0,1,2]).buffer);return summary;})};
  controller.renderer=renderer as unknown as GaussianRenderer;controller.scene=scene as unknown as GpuScene;
  controller.camera=camera as unknown as CameraController;controller.client=client as unknown as CoreClient;
  if(observed)internal.benchmarkObservation=new BenchmarkObservation();
  const pick=()=>internal.selectionPixelPick('ordinary-single',controller.renderer!,controller.scene as GpuScene,controller.camera!,318.5,400.5,NEUTRAL_COLOR,false);
  return{controller,internal,renderer,scene,camera,client,result,pick};
}
describe('observing existing UI GPU picks',()=>{
  it('keeps the ordinary unobserved preparation arguments and returned pick promise',async()=>{
    const f=fixture(false),pending=Promise.resolve(f.result);f.renderer.pick.mockReturnValue(pending);
    expect(f.pick()).toBe(pending);expect(f.renderer.render).toHaveBeenCalledWith(f.scene,f.camera,NEUTRAL_COLOR,true,IDENTITY_MATRIX,false);
    expect(f.renderer.pick).toHaveBeenCalledWith(f.scene,318.5,400.5);expect(f.internal.benchmarkObservation).toBeUndefined();await pending;
  });
  it('captures the actual decoded result before the subsequent native edit and retains misses',async()=>{
    const f=fixture();expect(await f.pick()).toBe(f.result);
    const first=f.internal.benchmarkObservation!.snapshot().queries[0];expect(first).toMatchObject({status:'completed',path:'ordinary-single',
      request:{x:318.5,y:400.5,centerRadius:0,sample:{x:318.5,y:400.5}},result:f.result});
    expect(first.after!.rendererSubmissionSequence).toBe(1);expect(first.before.documentRevision).toEqual(revision);
    f.renderer.pick.mockResolvedValue({...f.result,index:null});await f.pick();
    expect(f.internal.benchmarkObservation!.snapshot().queries[1].result!.index).toBeNull();
  });
  it('retains late camera staleness and actual rejection without changing UI return behavior',async()=>{
    const f=fixture(),held=deferred<GpuPick>();f.renderer.pick.mockReturnValue(held.promise);
    const pending=f.pick();f.camera.revision++;held.resolve(f.result);expect(await pending).toBe(f.result);
    expect(f.internal.benchmarkObservation!.snapshot().queries[0]).toMatchObject({status:'stale',staleReason:'Query camera changed before completion.'});
    f.renderer.pick.mockRejectedValue(new Error('actual readback failed'));await expect(f.pick()).rejects.toThrow('actual readback failed');
    expect(f.internal.benchmarkObservation!.snapshot().queries[1]).toMatchObject({status:'failed',error:'actual readback failed',result:null});
  });
});
describe('bounded actual native state-mask diagnostics',()=>{
  it('reads the real client callback and retains detached summary and exact base64 bytes',async()=>{
    const f=fixture(),value=await f.controller.readBenchmarkMasks();expect(f.client.readMasks).toHaveBeenCalledTimes(1);
    expect(value).toMatchObject({status:'completed',sourceCount:3,byteLength:3,callbacks:1,encoding:'base64',bytesBase64:'AAEC',summary:{canUndo:true,canRedo:false}});
    expect(f.internal.ledger.usage.bytes).toBe(0);
  });
  it('retains bytes when document ownership changes during the actual callback request',async()=>{
    const f=fixture(),held=deferred<NativeSummary>();f.client.readMasks.mockImplementation(async receive=>{receive(new Uint8Array([0,1,2]).buffer);return held.promise;});
    const pending=f.controller.readBenchmarkMasks();f.client.revision.selectionRevision++;held.resolve(summary);
    expect(await pending).toMatchObject({status:'stale',bytesBase64:'AAEC',staleReason:'Query documentRevision changed before completion.'});
    expect(f.internal.ledger.usage.bytes).toBe(0);
  });
  it('rejects unobserved or overlapping requests and reports duplicate callback failures',async()=>{
    const unobserved=fixture(false);await expect(unobserved.controller.readBenchmarkMasks()).rejects.toThrow(/not active/);expect(unobserved.client.readMasks).not.toHaveBeenCalled();
    const f=fixture(),held=deferred<NativeSummary>();f.client.readMasks.mockImplementation(async receive=>{receive(new Uint8Array([0,1,2]).buffer);receive(new Uint8Array([0,1,2]).buffer);return held.promise;});
    const pending=f.controller.readBenchmarkMasks();await expect(f.controller.readBenchmarkMasks()).rejects.toThrow(/already pending/);held.resolve(summary);
    expect(await pending).toMatchObject({status:'failed',callbacks:2,bytesBase64:'AAEC'});expect(f.internal.ledger.usage.bytes).toBe(0);
  });
});
