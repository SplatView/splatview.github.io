import { describe, expect, it } from 'vitest';
import { assertProbeSnapshot, assertProbeClock, assertProbeClosed, completedProbeFrame, settledProbeOpen,
  triggerProbeEvent, preserveProbeExport, acknowledgeProbeExport, joinProbeCleanup, parseProbeOptions, readResponseBounded, waitProbeReady } from '../tools/bench/run';

const args = ['--base-url','http://127.0.0.1:4173/project/','--fixture','.build/bench-fixtures/pinned/fixture.splat','--out','.build/bench-runs/run-01'];
const build = {appInputId:'a'.repeat(64),deploymentId:'b'.repeat(64)};
type ProbeSnapshot = Parameters<typeof settledProbeOpen>[0];
const revision = {documentId:'actual-document',sourceGeneration:1,contentRevision:2,selectionRevision:3,draftRevision:4};
function observed(): ProbeSnapshot {
  const counts = ['sourceLoadTasks','collectionCleanupTasks','thumbnailTasks','savedViewTransferTasks','imageTasks','filterTasks',
    'transformTasks','opacityTasks','floorTasks','tolerancePickTasks','releasedSelectionOwners','selectionBarriers','viewDownloadCallbacks',
    'imageDownloadCallbacks','exportDownloadCallbacks'];
  const flags = ['candidateClient','bootstrapClient','collectionIntakeOwner','recoveryTask','closeRequest','closeDocumentTask','editOperation',
    'exportOperation','filterOwner','transformOwner','opacityOwner','floorOwner','selectionCleanupOwner','opacityEntryTask','transformGradeTask',
    'transformNumericTask','releasedSelectionDrain'];
  return {schemaVersion:1,kind:'splatview-production-benchmark-snapshot',clock:{id:'performance.now:123',timeOrigin:123,now:45},
    runtime:{mode:'production-verified',...build,artifacts:[]},controller:{schemaVersion:1,kind:'splatview-controller-benchmark-observation',
      state:{runtimeMode:'production-verified',error:null,ready:true,busy:false,bootstrapState:'ready',rendererState:'ready',
        hasScene:false,hasClient:false,summary:null,documentRevision:null},renderer:{ready:true,negotiation:{status:'ready'}},camera:null,framebuffer:null,
      observation:{enabled:true,disabledReason:null,lastFrameSequence:0,lastOperationSequence:0,droppedFrames:0,droppedOperations:0,droppedNegotiations:0,operations:[],frames:[]},
      memory:{logicalLedger:{bytes:0,peakBytes:32*1024*1024,allocations:0,overageBytes:0,
        categories:Object.fromEntries(['source','decoded','work','history','render','image','recovery'].map(name=>[name,{bytes:0,allocations:0}]))},nativeAccounts:[]},
      knownPending:{scope:'named-controller-owned-sets-and-flags-only',unavailable:['private cleanup chains'],drawing:true,scheduledAnimationFrame:true,
        ...Object.fromEntries(counts.map(name=>[name,0])),...Object.fromEntries(flags.map(name=>[name,false]))}}};
}
function loaded() {
  const value = observed(), controller = value.controller;
  controller.state.hasScene=true; controller.state.hasClient=true; controller.state.documentRevision={...revision};
  controller.state.summary={count:256000,sourceCount:256000,shDegree:0}; controller.observation.lastOperationSequence=1;
  controller.observation.lastFrameSequence=2;
  controller.observation.operations.push({sequence:1,kind:'open-files',status:'settled',startedAtMs:10,settledAtMs:20,closed:null,
    after:{hasScene:true,hasClient:true,documentRevision:{...revision}}});
  controller.observation.frames.push({sequence:2,status:'completed',drawStartedAtMs:21,submissionObservedAtMs:22,queueCompletedAtMs:23,
    documentRevision:{...revision},presentation:{available:false}});
  return value;
}
function closed() {
  const value = observed();
  value.controller.observation.operations.push({sequence:2,kind:'close-scene',status:'settled',startedAtMs:30,settledAtMs:40,closed:true,
    after:{hasScene:false,hasClient:false,documentRevision:null}});
  value.controller.observation.lastOperationSequence=2; return value;
}
describe('production observation collector boundaries',()=>{
  it('awaits actual asynchronous bridge readiness before resolving startup',async()=>{
    let publish!: (value: ProbeSnapshot | null)=>void, settled=false;
    const delayed=new Promise<ProbeSnapshot | null>(resolve=>{publish=resolve;});
    const pending=waitProbeReady(()=>delayed,false).then(()=>{settled=true;});
    await Promise.resolve(); await Promise.resolve(); expect(settled).toBe(false);
    publish(observed()); await pending; expect(settled).toBe(true);
    let reads=0;
    await waitProbeReady(async()=>++reads===1?null:observed(),false,2000);
    expect(reads).toBe(2);
  });
  it('retains a project subpath and declares a bounded initial probe',()=>{
    expect(parseProbeOptions(args)).toEqual({baseUrl:'http://127.0.0.1:4173/project/',manifest:'tests/fixtures/bench/manifest-v1.json',fixture:args[3],build:'dist/build-manifest.json',output:args[5],attempts:3});
    expect(parseProbeOptions([...args,'--attempts','1']).attempts).toBe(1);
  });
  it.each(['https://user:pass@example.org/','https://example.org/?mode=other','https://example.org/#other','http://example.org/','file:///C:/fixture/'])('refuses ambiguous or insecure nonlocal base %s',base=>{
    expect(()=>parseProbeOptions(['--base-url',base,...args.slice(2)])).toThrow();
  });
  it.each(['dist/probe','.build/bench-runs/../escape','.build/bench-runs/CON','.build/bench-runs/name/extra','.build/bench-runs/name.'])('refuses output path %s',output=>{
    expect(()=>parseProbeOptions([...args.slice(0,5),output])).toThrow();
  });
  it('refuses duplicate flags, missing values, and unbounded repeat requests',()=>{
    expect(()=>parseProbeOptions([...args,'--out','.build/bench-runs/other'])).toThrow();
    expect(()=>parseProbeOptions([...args,'--attempts'])).toThrow();
    for(const value of ['0','31','1.5','03','NaN']) expect(()=>parseProbeOptions([...args,'--attempts',value])).toThrow();
  });
  it('requires actual production identities and complete retained observation history',()=>{
    expect(()=>assertProbeSnapshot(observed(),build)).not.toThrow();
    const wrongBuild=observed(); wrongBuild.runtime.appInputId='c'.repeat(64);
    expect(()=>assertProbeSnapshot(wrongBuild,build)).toThrow();
    const dev=observed(); dev.runtime.mode='development-module-graph';
    expect(()=>assertProbeSnapshot(dev,build)).toThrow();
    const lost=observed(); lost.controller.observation.droppedFrames=1;
    expect(()=>assertProbeSnapshot(lost,build)).toThrow();
    const noDevice=observed(); noDevice.controller.renderer!.negotiation.status='failed';
    expect(()=>assertProbeSnapshot(noDevice,build)).toThrow();
  });
  it('compares all actual verified artifact metadata against supplied shipping roles',()=>{
    const artifact={role:'application-entry',path:'assets/main.js',bytes:17,sha256:'d'.repeat(64)};
    const value={...observed(),runtime:{...observed().runtime,artifacts:[{...artifact,url:'http://127.0.0.1:4173/assets/main.js'}]}};
    expect(()=>assertProbeSnapshot(value,{...build,artifacts:[artifact]})).not.toThrow();
    value.runtime.artifacts[0]!.sha256='e'.repeat(64);
    expect(()=>assertProbeSnapshot(value,{...build,artifacts:[artifact]})).toThrow();
  });
  it('bounds actual streamed manifest bytes rather than trusting a response header',async()=>{
    const response=new Response(new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array([1,2]));controller.enqueue(new Uint8Array([3,4]));controller.close();}}),{headers:{'Content-Length':'1'}});
    await expect(readResponseBounded(response,3)).rejects.toThrow(/bound/);
    expect([...await readResponseBounded(new Response(new Uint8Array([1,2,3])),3)]).toEqual([1,2,3]);
  });
  it('requires current renderer/state readiness even when earlier negotiation succeeded',()=>{
    const lost=observed(); lost.controller.renderer!.ready=false;
    expect(()=>assertProbeSnapshot(lost,build)).toThrow();
    const recovering=observed(); recovering.controller.state.rendererState='recovering';
    expect(()=>assertProbeSnapshot(recovering,build)).toThrow();
    const pending=observed(); pending.controller.state.busy=true;
    expect(()=>assertProbeSnapshot(pending,build)).toThrow();
    const disabled=observed(); disabled.controller.observation.enabled=false;
    expect(()=>assertProbeSnapshot(disabled,build)).toThrow();
  });
  it('waits for the actual public open settlement after busy:false and rejects a different full revision',()=>{
    const value=loaded(), operation=value.controller.observation.operations[0]!;
    operation.status='pending'; operation.settledAtMs=null;
    expect(settledProbeOpen(value,0)).toBeNull();
    operation.status='settled'; operation.settledAtMs=20;
    expect(settledProbeOpen(value,0)).toBe(operation); expect(settledProbeOpen(value,1)).toBeNull();
    operation.after!.documentRevision!.contentRevision++;
    expect(()=>settledProbeOpen(value,0)).toThrow(/revision/);
  });
  it('preserves a failed open instead of selecting an older settled operation',()=>{
    const value=loaded(); value.controller.observation.operations.push({...value.controller.observation.operations[0]!,sequence:2,status:'failed'});
    expect(()=>settledProbeOpen(value,0)).toThrow(/failed/);
  });
  it('waits for a matching loaded frame rather than accepting a completed background or earlier revision',()=>{
    const value=loaded(), operation=settledProbeOpen(value,0)!;
    expect(completedProbeFrame(value,0,operation)).toBe(value.controller.observation.frames[0]);
    value.controller.observation.frames[0]!.documentRevision!.sourceGeneration++;
    expect(completedProbeFrame(value,0,operation)).toBeNull();
    value.controller.observation.frames[0]!.documentRevision=null;
    expect(completedProbeFrame(value,0,operation)).toBeNull();
  });
  it('refuses failed loaded frames and reversed actual queue boundaries',()=>{
    const value=loaded(), operation=settledProbeOpen(value,0)!, frame=value.controller.observation.frames[0]!;
    frame.queueCompletedAtMs=21;
    expect(()=>completedProbeFrame(value,0,operation)).toThrow(/ordered/);
    frame.queueCompletedAtMs=23; frame.status='failed';
    value.controller.observation.frames.push({...frame,sequence:3,status:'completed'});
    expect(()=>completedProbeFrame(value,0,operation)).toThrow(/failed/);
  });
  it('keeps browser clock domains explicit across all probe boundaries',()=>{
    const baseline=observed(), value=loaded(); expect(()=>assertProbeClock(value,baseline)).not.toThrow();
    value.clock.timeOrigin=456; expect(()=>assertProbeClock(value,baseline)).toThrow();
    value.clock.timeOrigin=123; value.clock.id='performance.now:456'; expect(()=>assertProbeClock(value,baseline)).toThrow();
  });
  it('requires zero retained ledger bytes, allocations and categories while allowing historical peaks and empty clear frames',()=>{
    const value=closed(); expect(assertProbeClosed(value,1).sequence).toBe(2);
    value.controller.memory.logicalLedger.bytes=1024; expect(()=>assertProbeClosed(value,1)).toThrow();
    value.controller.memory.logicalLedger.bytes=0; value.controller.memory.logicalLedger.allocations=1;
    expect(()=>assertProbeClosed(value,1)).toThrow();
    value.controller.memory.logicalLedger.allocations=0; value.controller.memory.logicalLedger.categories.image!.allocations=1;
    expect(()=>assertProbeClosed(value,1)).toThrow(/image/);
  });
  it('rejects closed pointers with retained named owners/tasks, unavailable category accounting or an old close receipt',()=>{
    const value=closed(); value.controller.knownPending.exportDownloadCallbacks=1;
    expect(()=>assertProbeClosed(value,1)).toThrow(/exportDownloadCallbacks/);
    value.controller.knownPending.exportDownloadCallbacks=0; value.controller.knownPending.bootstrapClient=true;
    expect(()=>assertProbeClosed(value,1)).toThrow(/bootstrapClient/);
    value.controller.knownPending.bootstrapClient=false; delete value.controller.memory.logicalLedger.categories.recovery;
    expect(()=>assertProbeClosed(value,1)).toThrow();
    expect(()=>assertProbeClosed(closed(),2)).toThrow(/join/);
  });
  it('starts observing download before the action and handles a late event rejection after a failed action',async()=>{
    let rejectEvent!: (error: Error)=>void; const order:string[]=[];
    const event=new Promise<string>((_resolve,reject)=>{rejectEvent=reject;});
    const pending=triggerProbeEvent(()=>{order.push('wait');return event;},async()=>{order.push('click');throw new Error('actual click failed');});
    await expect(pending).rejects.toThrow('actual click failed'); expect(order).toEqual(['wait','click']);
    rejectEvent(new Error('actual context closed')); await Promise.resolve(); await Promise.resolve();
    await expect(triggerProbeEvent(async()=> 'actual download',async()=>undefined)).resolves.toBe('actual download');
  });
  it('retains actual export artifact before a refusing independent oracle executes',async()=>{
    const target:Record<string,unknown>={}, bytes=new Uint8Array([7,8,9]), artifact={path:'actual-export.splat',bytes:3,sha256:'actual hash'};
    const events:string[]=[];
    await expect(preserveProbeExport(target,bytes,async actual=>{expect(actual).toBe(bytes);events.push('persist');return artifact;},actual=>{
      expect(actual).toBe(bytes); expect(target.artifact).toBe(artifact); events.push('oracle'); throw new Error('actual attribute mismatch');
    })).rejects.toThrow('actual attribute mismatch');
    expect(events).toEqual(['persist','oracle']); expect(target.artifact).toBe(artifact); expect(target.oracleStatus).toBe('failed');
    expect(target.independentOracle).toBeNull(); expect(target.oracleError).toContain('actual attribute mismatch');
  });
  it('acknowledges only after persistence and oracle success, and waits for the actual receipt action to settle',async()=>{
    const target:Record<string,unknown>={}, events:string[]=[], bytes=new Uint8Array(8_192_000);
    const artifact={path:'.build/bench-runs/unit-ack/attempt-01.splat',bytes:bytes.length,sha256:'a'.repeat(64)};
    await preserveProbeExport(target,bytes,async actual=>{
      expect(actual).toBe(bytes);events.push('persist');return artifact;
    },actual=>{expect(actual).toBe(bytes);expect(target.artifact).toBe(artifact);events.push('oracle');return{encodedSha256:artifact.sha256};});
    let release!:()=>void;const actualReceipt=new Promise<void>(resolve=>{release=resolve;});
    const pending=acknowledgeProbeExport(target,async()=>{
      expect(target.oracleStatus).toBe('passed');expect(target.artifact).toBe(artifact);events.push('ack');await actualReceipt;
    });
    await Promise.resolve();expect(events).toEqual(['persist','oracle','ack']);
    expect(target.outputAcknowledgement).toEqual({status:'pending',control:'I have kept the file',artifact,error:null});
    release();await pending;
    expect(target.outputAcknowledgement).toEqual({status:'acknowledged',control:'I have kept the file',artifact,error:null});
  });
  it('refuses acknowledgement for unvalidated, absent, unbound or malformed saved artifacts before clicking',async()=>{
    const artifact={path:'.build/bench-runs/unit-ack/attempt-01.splat',bytes:8_192_000,sha256:'a'.repeat(64)};
    const ready=()=>({oracleStatus:'passed',oracleError:null,artifact:{...artifact},independentOracle:{encodedSha256:artifact.sha256}} as Record<string,unknown>);
    const corruptions=[
      (value:Record<string,unknown>)=>{value.oracleStatus='pending';},
      (value:Record<string,unknown>)=>{value.oracleStatus='failed';value.oracleError='actual mismatch';},
      (value:Record<string,unknown>)=>{delete value.artifact;},
      (value:Record<string,unknown>)=>{(value.artifact as Record<string,unknown>).bytes=3;},
      (value:Record<string,unknown>)=>{(value.artifact as Record<string,unknown>).sha256='not-a-sha';},
      (value:Record<string,unknown>)=>{(value.artifact as Record<string,unknown>).path='dist/attempt-01.splat';},
      (value:Record<string,unknown>)=>{(value.independentOracle as Record<string,unknown>).encodedSha256='b'.repeat(64);},
    ];
    for(const corrupt of corruptions){
      const value=ready();corrupt(value);let clicked=false;
      await expect(acknowledgeProbeExport(value,async()=>{clicked=true;})).rejects.toThrow();
      expect(clicked).toBe(false);expect((value.outputAcknowledgement as Record<string,unknown>).status).toBe('failed');
      expect((value.outputAcknowledgement as Record<string,unknown>).error).toEqual(expect.any(String));
    }
  });
  it('retains failed actual acknowledgement without claiming closure or losing the validated export',async()=>{
    const artifact={path:'.build/bench-runs/unit-ack/attempt-01.splat',bytes:8_192_000,sha256:'a'.repeat(64)};
    const target:Record<string,unknown>={oracleStatus:'passed',oracleError:null,artifact,independentOracle:{encodedSha256:artifact.sha256}};
    await expect(acknowledgeProbeExport(target,async()=>{throw new Error('actual receipt did not disappear');})).rejects.toThrow('actual receipt did not disappear');
    expect(target.artifact).toBe(artifact);expect(target.oracleStatus).toBe('passed');
    expect(target.outputAcknowledgement).toEqual({status:'failed',control:'I have kept the file',artifact,error:expect.stringContaining('actual receipt did not disappear')});
    expect(target).not.toHaveProperty('closeObservation');expect(target).not.toHaveProperty('browserContextJoined');
  });
  it('records cleanup rejection and awaits actual cleanup settlement before claiming a join',async()=>{
    const failed=await joinProbeCleanup(async()=>{throw new Error('actual browser close failed');});
    expect(failed.joined).toBe(false); expect(failed.error).toContain('actual browser close failed');
    let release!:()=>void, settled=false; const owner=new Promise<void>(resolve=>{release=resolve;});
    const pending=joinProbeCleanup(()=>owner).then(value=>{settled=true;return value;});
    await Promise.resolve(); expect(settled).toBe(false); release();
    await expect(pending).resolves.toEqual({joined:true,error:null});
  });
});
