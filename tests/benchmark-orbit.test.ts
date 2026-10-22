import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { assertHiddenInterval, assertOrbitCamera, assertOrbitFrame, interpolateOrbitCamera, parseOrbitOptions,
  summarizeOrbitRafs, validateOrbitPhaseObservation, validateOrbitTrace,
  type CameraBoundary, type OrbitFrameObservation, type OrbitPhaseObservation } from '../tools/bench/orbit';
import type { Snapshot } from '../tools/bench/run';

const CAMERA=[0,0,0,0,0,24,1,45,1,0,1.6];
const revision={documentId:'actual-document',sourceGeneration:1,contentRevision:2,selectionRevision:3,draftRevision:4};
const framebuffer={width:1280,height:800,devicePixelRatio:1};
function traceFixture(){return{
  schemaVersion:1,kind:'splatview-benchmark-camera-trace',id:'orbit-fixed-v1',fixtureId:'dyadic-grid-256k-sh0-v1',status:'intended-actions-only',
  clock:'milliseconds-from-phase-start',samplePolicy:'absolute-state-linear-yaw-between-adjacent-samples',
  phaseBoundaryPolicy:'set-first-camera-state-before-starting-phase-clock',warmupMs:5000,durationMs:30000,idleHiddenMs:1000,
  framebuffer:{id:'standard-1280x800-dpr1',kind:'standard',cssWidth:1280,cssHeight:800,width:1280,height:800,dpr:1},
  projection:{camera:[...CAMERA],coordinateSystem:'RUB-right-up-backward'},measuredOverdraw:null,observedTimings:null,
  phases:['warmup','measured-orbit','idle-hidden'].map((kind,index)=>{
    const durationMs=[5000,30000,1000][index]!,intervals=index<2?durationMs/250:0;
    return{kind,durationMs,visible:index<2,samples:index<2?Array.from({length:intervals+1},(_,i)=>{
      const camera=[...CAMERA];camera[3]=2*Math.PI*(i/intervals);return{atMs:i*250,camera};
    }):[]};
  }),
};}
function loaded():Snapshot{return{schemaVersion:1,kind:'splatview-production-benchmark-snapshot',clock:{id:'performance.now:123',timeOrigin:123,now:1},
  runtime:{mode:'production-verified',appInputId:'a'.repeat(64),deploymentId:'b'.repeat(64),artifacts:[]},
  controller:{schemaVersion:1,kind:'splatview-controller-benchmark-observation',
    state:{ready:true,busy:false,error:null,bootstrapState:'ready',rendererState:'ready',runtimeMode:'production-verified',
      hasScene:true,hasClient:true,summary:{count:256000,sourceCount:256000,shDegree:0},documentRevision:{...revision}},
    framebuffer:{...framebuffer},renderer:{ready:true,negotiation:{status:'ready'}},camera:{state:[...CAMERA],view:[1],projection:[2]},
    observation:{enabled:true,disabledReason:null,lastFrameSequence:1,lastOperationSequence:1,droppedFrames:0,droppedOperations:0,droppedNegotiations:0,operations:[],frames:[]},
    memory:{logicalLedger:{bytes:1,peakBytes:1,allocations:1,overageBytes:0,categories:{}},nativeAccounts:[]},knownPending:{drawing:false}}};}
function action(camera:number[],cameraRevision:number,sequence:number,at:number){
  const boundary:CameraBoundary={schemaVersion:1,kind:'splatview-production-benchmark-camera',clock:{...loaded().clock,now:at+.01},
    runtime:loaded().runtime,controller:{schemaVersion:1,kind:'splatview-controller-benchmark-camera',capturedAtMs:at+.01,
      state:{ready:true,busy:false,error:null,bootstrapState:'ready',rendererState:'ready',runtimeMode:'production-verified',
        hasScene:true,hasClient:true,documentRevision:{...revision}},
      camera:{revision:cameraRevision,state:camera.map(Math.fround),view:[1,0,0,1],projection:[2,0,0,2],eye:[0,0,24]},
      framebuffer:{...framebuffer},renderer:{ready:true,deviceEpoch:1,frameSubmissionSequence:sequence-1},
      observation:{enabled:true,lastFrameSequence:sequence-1}}};
  const frame:OrbitFrameObservation={sequence,status:'completed',clock:'performance.now',rafAtMs:at,drawStartedAtMs:at+.02,
    submissionObservedAtMs:at+.03,submissionBoundary:'render-return-after-confirmed-queue-submit',queueSettledAtMs:at+.04,queueCompletedAtMs:at+.04,
    deviceEpoch:1,rendererSubmissionSequence:sequence,documentRevision:{...revision},sceneRevision:1,
    camera:structuredClone(boundary.controller.camera!),framebuffer:{...framebuffer},visibility:'visible',error:null,staleReason:null,
    presentation:{available:false,reason:'Queue completion does not observe presentation.'},gpuTimestamps:{available:false,reason:'No timestamp query.'}};
  return{status:'applied',rafAtMs:at as number|null,elapsedMs:0,requestedCamera:[...camera],boundary,frame,error:null};
}
function phaseFixture(){
  const phase=validateOrbitTrace(traceFixture()).phases[0]!,first=action([...CAMERA],7,2,10);
  first.rafAtMs=null;
  const firstUpdate=action(interpolateOrbitCamera(phase,250),8,3,350);firstUpdate.elapsedMs=250;
  const terminal=action(interpolateOrbitCamera(phase,5000),9,4,5100);terminal.elapsedMs=5000;
  const observation:OrbitPhaseObservation={kind:'warmup',status:'observed',durationMs:5000,startedAtMs:100,endedAtMs:5101,
    firstCamera:first,actions:[{...firstUpdate,frame:null},terminal],frames:[firstUpdate.frame,terminal.frame],frameDrops:0,
    rafTimes:[350,600,5100],rafDrops:0,actionDrops:0,error:null};
  return{phase,observation};
}
type HiddenSample=Parameters<typeof assertHiddenInterval>[0];
function hidden(now:number):HiddenSample{return{clock:{id:'performance.now:123',timeOrigin:123,now},hidden:true,visibilityState:'hidden',
  frameSequence:77,rendererSubmissionSequence:80,drawing:false,camera:{state:[...CAMERA],view:[1],projection:[2]},framebuffer:{...framebuffer},
  progress:{visibilityDrops:0,visibilityEvents:[{atMs:99,hidden:true,visibilityState:'hidden'}]}};}

describe('fixed production orbit recipe',()=>{
  it('checks all 142 intended keyframes and the exact phase/framebuffer recipe',()=>{
    const value=traceFixture();assert.equal(validateOrbitTrace(value).phases.reduce((n,phase)=>n+phase.samples.length,0),142);
    for(const corrupt of [
      (v:ReturnType<typeof traceFixture>)=>{v.phases[1]!.samples[120]!.camera[3]=0;},
      (v:ReturnType<typeof traceFixture>)=>{v.phases[1]!.samples[60]!.atMs++;},
      (v:ReturnType<typeof traceFixture>)=>{v.phases[0]!.durationMs++;},
      (v:ReturnType<typeof traceFixture>)=>{v.framebuffer.width=640;},
      (v:ReturnType<typeof traceFixture>)=>{v.phases[2]!.visible=true;},
    ]){const changed=traceFixture();corrupt(changed);assert.throws(()=>validateOrbitTrace(changed));}
  });
  it('interpolates the adjacent pinned yaw samples at actual elapsed page time',()=>{
    const phase=validateOrbitTrace(traceFixture()).phases[0]!;
    assert.deepEqual(interpolateOrbitCamera(phase,-10),phase.samples[0]!.camera);
    const midpoint=interpolateOrbitCamera(phase,125);assert.equal(midpoint[3],Math.PI/20);
    assert.equal(midpoint[6],1);assert.deepEqual(interpolateOrbitCamera(phase,9000),phase.samples.at(-1)!.camera);
    assert.throws(()=>interpolateOrbitCamera(phase,NaN));
  });
  it('summarizes real browser callbacks without inventing absent intervals or presentation counts',()=>{
    assert.equal(summarizeOrbitRafs([]).meanMs,null);assert.equal(summarizeOrbitRafs([100]).p95Ms,null);
    const summary=summarizeOrbitRafs([100,110,140,160]);assert.equal(summary.count,3);assert.equal(summary.p50Ms,20);assert.equal(summary.p95Ms,30);
    assert.equal(summary.meanMs,20);assert.match(summary.scope,/not-GPU-or-presentation/);
    for(const times of [[10,10],[10,9],[10,Infinity],[-1]])assert.throws(()=>summarizeOrbitRafs(times));
  });
});

describe('actual camera and queue-frame ownership',()=>{
  it('joins the actual f32 acknowledgment, current document, device and framebuffer',()=>{
    const value=action([...CAMERA],7,2,10);assertOrbitCamera(value.boundary,value.requestedCamera,loaded());
    assertOrbitFrame(value.frame,value.boundary,value.requestedCamera,loaded());
    assert.notEqual(value.boundary.controller.camera!.state[10],value.requestedCamera[10]);
  });
  it('rejects an unrelated revision, source generation, framebuffer, epoch or clock',()=>{
    const value=action([...CAMERA],7,2,10);
    for(const mutate of [
      (v:typeof value)=>{v.boundary.controller.camera!.revision++;},
      (v:typeof value)=>{v.boundary.controller.state.documentRevision!.sourceGeneration++;},
      (v:typeof value)=>{v.boundary.controller.framebuffer!.width=640;},
      (v:typeof value)=>{v.boundary.controller.renderer!.deviceEpoch++;},
      (v:typeof value)=>{v.boundary.clock.timeOrigin++;},
      (v:typeof value)=>{v.boundary.controller.capturedAtMs=100;},
    ]){const changed=structuredClone(value);mutate(changed);assert.throws(()=>assertOrbitFrame(changed.frame,changed.boundary,changed.requestedCamera,loaded()));}
  });
  it('retains camera-stale queue completion while refusing other stale/failure causes',()=>{
    const value=action([...CAMERA],7,2,10),stale={...value.frame,status:'stale' as const,staleReason:'Camera owner/revision changed before queue completion.'};
    assertOrbitFrame(stale,value.boundary,value.requestedCamera,loaded(),true);
    assert.throws(()=>assertOrbitFrame(stale,value.boundary,value.requestedCamera,loaded()));
    assert.throws(()=>assertOrbitFrame({...stale,staleReason:'Document owner changed.'},value.boundary,value.requestedCamera,loaded(),true));
    assert.throws(()=>assertOrbitFrame({...stale,status:'failed',error:'device lost'},value.boundary,value.requestedCamera,loaded(),true));
  });
  it('separates per-rAF camera input, unconsumed callbacks and naturally coalesced queue frames',()=>{
    const {phase,observation}=phaseFixture(),summary=validateOrbitPhaseObservation(phase,observation,loaded());
    assert.equal(summary.rafCount,3);assert.equal(summary.actionCount,2);assert.equal(summary.rafTicksWithoutCameraAction,1);
    assert.equal(summary.scheduledQueueFrames,2);assert.equal(summary.actionSummary.count,1);assert.equal(summary.rafSummary.count,2);
    assert.equal(summary.missedFrameCount.available,false);
    const stale={...observation.frames[0]!,status:'stale' as const,staleReason:'Camera owner/revision changed before queue completion.',queueSettledAtMs:5100.03,queueCompletedAtMs:5100.03};
    observation.frames[0]=stale;assert.equal(validateOrbitPhaseObservation(phase,observation,loaded()).cameraStaleQueueFrames,1);
  });
  it('rejects missing terminal poses, invented action times, ring drops and missing actual frames',()=>{
    for(const mutate of [
      (v:OrbitPhaseObservation)=>{v.actions.pop();},
      (v:OrbitPhaseObservation)=>{v.actions[0]!.rafAtMs=351;},
      (v:OrbitPhaseObservation)=>{v.frameDrops=1;},
      (v:OrbitPhaseObservation)=>{v.rafDrops=1;},
      (v:OrbitPhaseObservation)=>{v.frames.shift();},
      (v:OrbitPhaseObservation)=>{v.actions[1]!.boundary!.controller.renderer!.deviceEpoch=2;},
    ]){const {phase,observation}=phaseFixture();mutate(observation);assert.throws(()=>validateOrbitPhaseObservation(phase,observation,loaded()));}
  });
  it('requires an actually issued later camera to explain a stale queue completion',()=>{
    const {phase,observation}=phaseFixture();observation.frames[0]={...observation.frames[0]!,status:'stale',staleReason:'Camera owner/revision changed before queue completion.'};
    assert.throws(()=>validateOrbitPhaseObservation(phase,observation,loaded()));
  });
});

describe('genuine hidden boundary',()=>{
  it('requires native hidden state for the actual page-clock interval and both submission counters',()=>{
    assertHiddenInterval(hidden(100),hidden(1200));
    for(const mutate of [
      (v:HiddenSample)=>{v.hidden=false;},(v:HiddenSample)=>{v.visibilityState='visible';},
      (v:HiddenSample)=>{v.frameSequence++;},(v:HiddenSample)=>{v.rendererSubmissionSequence++;},
      (v:HiddenSample)=>{v.drawing=true;},(v:HiddenSample)=>{v.clock.timeOrigin++;},
      (v:HiddenSample)=>{v.clock.now=1099;},(v:HiddenSample)=>{v.progress!.visibilityDrops=1;},
      (v:HiddenSample)=>{v.progress!.visibilityEvents.push({atMs:500,hidden:false,visibilityState:'visible'});},
    ]){const last=hidden(1200);mutate(last);assert.throws(()=>assertHiddenInterval(hidden(100),last));}
  });
  it('does not mislabel the legitimate restored-visible frame as a hidden submission',()=>{
    const last=hidden(1200);last.progress!.visibilityEvents.push({atMs:1300,hidden:false,visibilityState:'visible'});
    assertHiddenInterval(hidden(100),last);
  });
});

describe('orbit CLI bounds',()=>{
  const args=['--base-url','http://127.0.0.1:4173/app/','--fixture','.build/bench-fixtures/pinned/scene.splat','--out','.build/bench-runs/orbit-01'];
  it('reuses the parent production lifecycle defaults and accepts one pinned trace',()=>{
    const options=parseOrbitOptions([...args,'--trace','.build/bench-fixtures/pinned/orbit-trace.json']);assert.equal(options.attempts,3);assert.equal(options.trace,'.build/bench-fixtures/pinned/orbit-trace.json');
  });
  it('rejects missing, duplicate and escaping trace paths',()=>{
    assert.throws(()=>parseOrbitOptions(args));assert.throws(()=>parseOrbitOptions([...args,'--trace','../trace.json']));
    assert.throws(()=>parseOrbitOptions([...args,'--trace','trace.json','--trace','other.json']));
  });
});
