import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppController } from '../src/app/controller';
import { setApp, useApp } from '../src/app/store';
import { NEUTRAL_COLOR } from '../src/renderer/defaults';
import { type NativeSummary, type SceneCommand } from '../src/document/types';
import type { OperationOwner } from '../src/document/operationProtocol';
import type { ResourceLease, ResourceLedger } from '../src/document/resources';

const initial = useApp.getState(), cameraState = () => [0,0,0,0,0,3,1,45,0,0,1];
const flush = async () => { for (let index = 0; index < 100; index++) await Promise.resolve(); };
function gate<T>() { let resolve!: (value:T) => void; return { promise: new Promise<T>(yes => { resolve = yes; }), resolve }; }
const baseline = (): NativeSummary => ({ ok: true, duplicateRange: null, loaded:true, kind:0, count:3, sourceCount:3, selected:3, visible:3, shDegree:0,
  format:'PLY', canUndo:true, canRedo:true, revision:2, contentRevision:1, transaction:false, selectionDraft:false, sceneChanged:false,
  pending:false, progress:1, center:[0,0,0], radius:1, yUp:false, camera:cameraState(), memoryBytes:528,
  selectionMapId:null, pendingSelectionMapId:null, selectionMapBytes:0, selectionMapRetainedIds:[],
  colorSession:null, transformSession:null, opacitySession:null, filter:null, floor:null });
type Internal = {
  selectionBarriers:number; generation:number; ledger:ResourceLedger;
  closeToleranceSelection():Promise<void>; settleColorSession():Promise<boolean>;
  executeCommand(command:SceneCommand):Promise<boolean>;
  bindNativeCoverage(client:unknown,scene:ResourceLease,history?:ResourceLease):void;
};
function host() {
  const controller = new AppController(), internal = controller as unknown as Internal;
  const client = { revision:{documentId:'scope-document', sourceGeneration:1, contentRevision:1, selectionRevision:2, draftRevision:0},
    assertNativeAdmission:vi.fn(), setNativeCoveragePlanner:vi.fn() };
  const camera = { revision:1, state:cameraState(), clearInput:vi.fn() };
  const renderer = { lost:false, canvas:{width:400,height:400}, finish(): Promise<void> { return this.device.queue.onSubmittedWorkDone(); }, device:{queue:{onSubmittedWorkDone:vi.fn(async()=>{})}} };
  const scene = { kind: 'gaussian', setDuplicateRange: vi.fn(), count:3, allocationBytes:100, dispose:vi.fn(async()=>{}) };
  controller.client = client as unknown as NonNullable<AppController['client']>;
  controller.camera = camera as unknown as NonNullable<AppController['camera']>;
  controller.renderer = renderer as unknown as NonNullable<AppController['renderer']>;
  controller.scene = scene as unknown as NonNullable<AppController['scene']>;
  vi.spyOn(controller,'invalidate').mockImplementation(()=>{}); vi.spyOn(controller,'cancelAlignment').mockImplementation(()=>{});
  return {controller,internal,client,camera,renderer,scene};
}
beforeEach(()=>{
  vi.stubGlobal('document',{hidden:true,title:''});
  setApp({...initial,ready:true,busy:false,rendererState:'ready',summary:baseline(),currentViewOnly:false,
    grade:[...NEUTRAL_COLOR],appliedGrade:[...NEUTRAL_COLOR],colorSession:null,colorSelectedOnly:false,
    selectionOptionsRevision:0,navigationPrompt:false,settingsOpen:false,exportOpen:false,outputPending:false,savedViewChoices:[],
    pendingSelectionCount:0,selectionDragging:false,selectionRecovery:'idle',operationRecovery:'idle'},true);
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();setApp(initial,true);});

describe('current-view toggle publication',()=>{
  function fixture() {
    const f=host(),trace:string[]=[];
    vi.spyOn(f.controller,'endOpacitySession').mockImplementation(async()=>{trace.push('opacity');return true;});
    vi.spyOn(f.controller,'endTransformSession').mockImplementation(async()=>{trace.push('transform');return true;});
    vi.spyOn(f.internal,'closeToleranceSelection').mockImplementation(async()=>{trace.push('tolerance');});
    vi.spyOn(f.controller,'cancelSelectionGesture').mockImplementation(async()=>{trace.push('gesture');return true;});
    const settle=vi.spyOn(f.internal,'settleColorSession').mockImplementation(async()=>{trace.push('color');return true;});
    const execute=vi.spyOn(f.internal,'executeCommand').mockImplementation(async()=>{trace.push('clip');return true;});
    return {...f,trace,settle,execute};
  }
  it('joins all old owners before clipping and publishes the accepted global flag once',async()=>{
    const f=fixture(),held=gate<boolean>(); f.execute.mockReturnValue(held.promise);
    const toggling=f.controller.setCurrentViewOnly(true); await flush();
    expect(f.trace).toEqual(['opacity','transform','tolerance','gesture','color']);
    expect(f.execute).toHaveBeenCalledWith({command:'clipSelection',selectionView:cameraState()});
    expect(useApp.getState().currentViewOnly).toBe(false); expect(useApp.getState().selectionOptionsRevision).toBe(0);
    expect(f.internal.selectionBarriers).toBe(1); held.resolve(true); expect(await toggling).toBe(true);
    expect(useApp.getState().currentViewOnly).toBe(true);expect(useApp.getState().selectionOptionsRevision).toBe(1);
    expect(f.internal.selectionBarriers).toBe(0);
  });
  it.each(['settlement','clip','replacement'] as const)('%s refusal preserves the previous flag and option revision',async phase=>{
    const f=fixture(); if(phase==='settlement')f.settle.mockResolvedValue(false);
    if(phase==='clip')f.execute.mockResolvedValue(false);
    if(phase==='replacement')f.settle.mockImplementation(async()=>{f.internal.generation++;return true;});
    expect(await f.controller.setCurrentViewOnly(true)).toBe(false);
    expect(useApp.getState().currentViewOnly).toBe(false);expect(useApp.getState().selectionOptionsRevision).toBe(0);
    expect(useApp.getState().summary).toEqual(baseline());expect(f.internal.selectionBarriers).toBe(0);
  });
  it('disabling settles without restoring outside selection or issuing a clip command',async()=>{
    const f=fixture();setApp({currentViewOnly:true,summary:{...baseline(),selected:1}});
    expect(await f.controller.setCurrentViewOnly(false)).toBe(true);expect(f.execute).not.toHaveBeenCalled();
    expect(useApp.getState().summary?.selected).toBe(1);expect(useApp.getState().currentViewOnly).toBe(false);
  });
  it('a real selection draft refuses a toggle before any settlement',async()=>{
    const f=fixture();setApp({summary:{...baseline(),selectionDraft:true}});
    expect(f.controller.currentViewOnlyControlsEnabled).toBe(false);expect(await f.controller.setCurrentViewOnly(true)).toBe(false);expect(f.trace).toEqual([]);
  });
});

describe('scoped first color preview and GPU publication',()=>{
  function fixture() {
    const f=host(),canonical={destroy:vi.fn(),size:12},target={destroy:vi.fn(),size:12};
    let native=baseline(),checkpoint:NativeSummary|undefined,documentMask=[1,1,1],checkpointMask:number[]|undefined,
      gpuMask=[1,1,1],gpuTarget:number[]|undefined,failStage=false,sequence=0,active:OperationOwner|undefined;
    let heldStage: ReturnType<typeof gate<void>> | undefined;
    const source=f.internal.ledger.reserve('decoded',1000),history=f.internal.ledger.reserve('history',96);
    const assertOwner=(owner:OperationOwner)=>{expect(owner).toBe(active);};
    let transferred:unknown[]=[];
    const update=(updates:readonly {lease:ResourceLease;nextLeaseBytes:number}[])=>{
      f.internal.ledger.rebalance(updates.map(value=>({lease:value.lease,bytes:value.nextLeaseBytes})));
    };
    const command=vi.fn(async(request:SceneCommand)=>{
      if(request.command==='beginColor')native={...native,memoryBytes:800,colorSession:{version:1,active:true,sessionId:1,baseId:2,epochId:1,
        selectedOnly:true,pending:false,values:[...NEUTRAL_COLOR],applied:[...NEUTRAL_COLOR]}};
      else if(request.command==='grade'){
        documentMask=[0,0,1];const values=[...(request.values as number[])];
        native={...native,selected:1,revision:native.revision+1,contentRevision:native.contentRevision+1,sceneChanged:true,
          colorSession:{...native.colorSession!,epochId:native.colorSession!.epochId+1,values,applied:[...values]}};
      } else if(request.command==='endColor') native={...native,colorSession:null};
      return native;
    });
    const ownedClient=Object.assign(f.client,{command,updateNativeCoverage:vi.fn(update),transferNativeCoverage:vi.fn((updates:readonly {lease:ResourceLease;nextLeaseBytes:number}[])=>{transferred=[...updates];update(updates);}),
      setNativeWork:vi.fn(),releaseNativeCoverage:vi.fn((lease:ResourceLease)=>lease()),
      createOperation:vi.fn(()=>{expect(active).toBeUndefined();return active={version:1,documentId:f.client.revision.documentId,sourceGeneration:1,
        clientGeneration:'00000000-0000-4000-8000-000000000001',operationId:++sequence};}),
      beginOperation:vi.fn(async(owner:OperationOwner)=>{assertOwner(owner);checkpoint=structuredClone(native);checkpointMask=[...documentMask];native={...native,transaction:true};return native;}),
      commitOperation:vi.fn(async(owner:OperationOwner)=>{assertOwner(owner);native={...native,transaction:false,sceneChanged:false};checkpoint=undefined;return native;}),
      rollbackOperation:vi.fn(async(owner:OperationOwner)=>{assertOwner(owner);native=checkpoint!;documentMask=checkpointMask!;return native;}),
      finishOperation:vi.fn(async(owner:OperationOwner)=>{assertOwner(owner);active=undefined;}),
      readMasks:vi.fn(async(callback:(bytes:ArrayBuffer)=>void,channel='document')=>{callback(new Uint8Array(channel==='colorBase'?[0,0,1]:documentMask).buffer);return native;}),
      stream:vi.fn(async(chunk:(first:number,count:number,bytes:ArrayBuffer)=>Promise<void>,masks:(bytes:ArrayBuffer)=>void)=>{
        await chunk(0,3,new ArrayBuffer(144));masks(new Uint8Array(documentMask).buffer);return native;
      })});
    const staged={kind: 'gaussian', setDuplicateRange: vi.fn(), count:3,allocationBytes:100,upload:vi.fn(async()=>{}),masks:vi.fn(),dispose:vi.fn(async()=>{})};
    Object.assign(f.renderer,{allocateScene:vi.fn(async()=>staged)});
    Object.assign(f.scene,{buffers:{states:canonical},previewMask:vi.fn(()=>gpuTarget?target:canonical),hasPreviewMask:()=>gpuTarget,
      stageMasks:vi.fn(async(bytes:ArrayBuffer,targets:Record<string,ArrayBuffer|null>)=>{
        if(heldStage){const held=heldStage;heldStage=undefined;await held.promise;}
        if(failStage)throw new Error('Independent GPU target staging failure');
        const next=[...new Uint8Array(bytes)],effective=targets.colorBase?[...new Uint8Array(targets.colorBase)]:undefined;
        const retirementBytes=gpuTarget?27:15;let published=false;
        return{allocationBytes:27,retirementBytes,retirementBuffers:[canonical],
          publish(){published=true;gpuMask=next;gpuTarget=effective;return canonical;},dispose:vi.fn(()=>{expect(published||gpuTarget===undefined).toBe(true);})};
      })});
    Object.defineProperty(f.scene,'allocationBytes',{get:()=>100+(gpuTarget?12:0)});
    f.internal.bindNativeCoverage(f.client,source,history);
    Object.assign(f.internal,{releaseScene:source,releaseHistory:history});
    return {...f,client:ownedClient,command,source,history,mask:()=>gpuMask,target:()=>gpuTarget,native:()=>native,transferred:()=>transferred,
      fail(){failStage=true;},hold(){heldStage=gate<void>();return heldStage;},finish(){source();history();}};
  }
  it('captures the first preview before publishing its grade, preserving full masks and fixed targets across orbit and rebake',async()=>{
    const f=fixture();setApp({currentViewOnly:true});const warm=[...NEUTRAL_COLOR];warm[0]=Math.fround(1.2);
    f.controller.setGrade(warm);expect(useApp.getState().grade).toEqual(NEUTRAL_COLOR);await flush();
    expect(f.command.mock.calls[0][0]).toEqual({command:'beginColor',selectedOnly:true,selectionView:cameraState()});
    expect(f.mask()).toEqual([1,1,1]);expect(f.target()).toEqual([0,0,1]);expect(useApp.getState().grade).toEqual(warm);
    expect(f.source.bytes).toBe(1012);expect(useApp.getState().summary?.selected).toBe(3);
    f.camera.state[0]=100;f.camera.revision++;const warmer=[...warm];warmer[0]=Math.fround(1.4);f.controller.setGrade(warmer);
    expect(await f.controller.commitGrade()).toBe(true);
    expect(f.command.mock.calls.at(-1)![0]).toEqual({command:'grade',values:warmer,selectedOnly:true});
    expect(f.mask()).toEqual([0,0,1]);expect(f.target()).toEqual([0,0,1]);expect(f.native().selected).toBe(1);
    expect(f.source.bytes).toBe(1012);expect(f.internal.ledger.categorySnapshot.work.bytes).toBe(0);f.finish();
  });
  it('target staging refusal rolls native ownership back and publishes neither grade nor masks nor persistent GPU credit',async()=>{
    const f=fixture();setApp({currentViewOnly:true});f.fail();const before=structuredClone(useApp.getState().summary),warm=[...NEUTRAL_COLOR];warm[0]=1.2;
    f.controller.setGrade(warm);await flush();
    expect(f.client.rollbackOperation).toHaveBeenCalledOnce();expect(f.client.commitOperation).not.toHaveBeenCalled();
    expect(useApp.getState().grade).toEqual(NEUTRAL_COLOR);expect(useApp.getState().summary).toEqual(before);
    expect(f.mask()).toEqual([1,1,1]);expect(f.target()).toBeUndefined();expect(f.source.bytes).toBe(1000);
    expect(f.internal.ledger.categorySnapshot.work.bytes).toBe(0);expect(useApp.getState().error).toContain('Independent GPU target');f.finish();
  });
  it('a boundary waiting on held first-preview ownership consumes the latest grade under its own barrier before ending color',async()=>{
    const f=fixture();setApp({currentViewOnly:true});const held=f.hold(),warm=[...NEUTRAL_COLOR],latest=[...NEUTRAL_COLOR];
    warm[0]=Math.fround(1.2);latest[0]=Math.fround(1.6);f.controller.setGrade(warm);await flush();f.controller.setGrade(latest);
    f.internal.selectionBarriers++;const settling=f.internal.settleColorSession();await flush();
    expect(useApp.getState().grade).toEqual(NEUTRAL_COLOR);expect(f.command.mock.calls.map(([value])=>value.command)).toEqual(['beginColor']);
    held.resolve();expect(await settling).toBe(true);f.internal.selectionBarriers--;
    expect(f.command.mock.calls.map(([value])=>value.command)).toEqual(['beginColor','grade','endColor']);
    expect(f.command.mock.calls[1][0]).toMatchObject({values:latest,selectedOnly:true});
    expect(useApp.getState().summary?.selected).toBe(1);expect(useApp.getState().colorSession).toBeNull();
    expect(f.source.bytes).toBe(1000);expect(f.internal.selectionBarriers).toBe(0);expect(f.internal.ledger.categorySnapshot.work.bytes).toBe(0);f.finish();
  });
});
