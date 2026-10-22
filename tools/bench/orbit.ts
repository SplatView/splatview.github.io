/** Raw production orbit/visibility observations; no performance-budget acceptance. */
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, Page } from '@playwright/test';
import { Workspace, digest, relativePath } from '../release/files.ts';
import { launchVisibilityBrowser } from './browser-host.ts';
import { KEY, parseProbeOptions, runProductionProbe, snapshot, assertProbeSnapshot, assertProbeClock,
  type ProbeOptions, type Snapshot, type ProductionProbeObservation, type ProductionProbeHooks } from './run.ts';

const PROGRESS_KEY = '__SPLATVIEW_ORBIT_CAPTURE_V1__';
const CAMERA = [0,0,0,0,0,24,1,45,1,0,1.6];
const FRAMEBUFFER = {id:'standard-1280x800-dpr1',kind:'standard',cssWidth:1280,cssHeight:800,width:1280,height:800,dpr:1};
type Json = Record<string, unknown>;
type Revision = NonNullable<Snapshot['controller']['state']['documentRevision']>;
/** Serialized observation DTO only. Node tools never import application implementation modules. */
export interface OrbitFrameObservation {
  sequence:number;status:'submitted'|'completed'|'failed'|'stale'|'disabled';clock:'performance.now';
  rafAtMs:number;drawStartedAtMs:number;submissionObservedAtMs:number;
  submissionBoundary:'render-return-after-confirmed-queue-submit';queueSettledAtMs:number|null;queueCompletedAtMs:number|null;
  deviceEpoch:number;rendererSubmissionSequence:number;documentRevision:Revision|null;sceneRevision:number|null;
  camera:{revision:number;state:number[];view:number[];projection:number[];eye:number[]};
  framebuffer:{width:number;height:number;devicePixelRatio:number};visibility:string;error:string|null;staleReason:string|null;
  presentation:{available:false;reason:string};gpuTimestamps:{available:false;reason:string};
}
export interface OrbitPhase { kind:'warmup'|'measured-orbit'|'idle-hidden'; durationMs:number; visible:boolean; samples:{atMs:number;camera:number[]}[] }
export interface OrbitTrace { schemaVersion:1; kind:string; id:string; fixtureId:string; phases:OrbitPhase[]; framebuffer:typeof FRAMEBUFFER;
  clock:string; samplePolicy:string; phaseBoundaryPolicy:string; warmupMs:number; durationMs:number; idleHiddenMs:number }
export interface CameraBoundary {
  schemaVersion:number;kind:string;clock:Snapshot['clock'];runtime:Pick<Snapshot['runtime'],'mode'|'appInputId'|'deploymentId'>;
  controller:{schemaVersion:number;kind:string;capturedAtMs:number;
    state:{ready:boolean;busy:boolean;error:string|null;bootstrapState:string;rendererState:string;runtimeMode:string|null;hasScene:boolean;hasClient:boolean;documentRevision:Revision|null};
    camera:{revision:number;state:number[];view:number[];projection:number[];eye:number[]}|null;
    framebuffer:{width:number;height:number;devicePixelRatio:number}|null;
    renderer:{ready:boolean;deviceEpoch:number;frameSubmissionSequence:number}|null;
    observation:{enabled:boolean;lastFrameSequence:number}};
}
interface OrbitBridge { applyCamera(state:number[]):Promise<CameraBoundary>; waitForFrame(after:number,timeout?:number):Promise<OrbitFrameObservation>; snapshot():Promise<Snapshot> }
interface OrbitAction { status:string;rafAtMs:number|null;elapsedMs:number;requestedCamera:number[];boundary:CameraBoundary|null;frame:OrbitFrameObservation|null;error:string|null }
export interface OrbitPhaseObservation { kind:string;status:string;durationMs:number;startedAtMs:number|null;endedAtMs:number|null;
  firstCamera:OrbitAction|null;actions:OrbitAction[];frames:OrbitFrameObservation[];frameDrops:number;
  rafTimes:number[];rafDrops:number;actionDrops:number;error:string|null }
interface BrowserProgress { status:string;clock:{id:string;timeOrigin:number};phases:OrbitPhaseObservation[];
  visibilityEvents:{atMs:number;hidden:boolean;visibilityState:string}[];visibilityDrops:number;
  longTasks:{available:boolean;reason:string|null;entries:{startTime:number;duration:number;name:string}[];drops:number};error:string|null }
export interface HiddenHostAdapter {
  id:string;
  enter(page:Page,context:BrowserContext):Promise<{metadata:unknown;restore():Promise<void>}>;
}
export interface OrbitOptions extends ProbeOptions { trace:string }
export type OrbitHooks = Omit<ProductionProbeHooks,'observeLoaded'> & { hiddenHost?:HiddenHostAdapter };
function object(value:unknown):Json { assert(value!==null&&typeof value==='object'&&!Array.isArray(value),'Expected an orbit record.'); return value as Json; }
function errorText(error:unknown):string { try{return(error instanceof Error?error.stack??error.message:String(error)).slice(0,16384);}catch{return'Unserializable orbit failure.';} }

/** Independent fixed recipe validation; construction imports no production camera math. */
export function validateOrbitTrace(value:unknown):OrbitTrace {
  const trace=object(value);
  assert.equal(trace.schemaVersion,1);assert.equal(trace.kind,'splatview-benchmark-camera-trace');assert.equal(trace.id,'orbit-fixed-v1');
  assert.equal(trace.fixtureId,'dyadic-grid-256k-sh0-v1');assert.equal(trace.status,'intended-actions-only');
  assert.equal(trace.clock,'milliseconds-from-phase-start');assert.equal(trace.samplePolicy,'absolute-state-linear-yaw-between-adjacent-samples');
  assert.equal(trace.phaseBoundaryPolicy,'set-first-camera-state-before-starting-phase-clock');
  assert.equal(trace.warmupMs,5000);assert.equal(trace.durationMs,30000);assert.equal(trace.idleHiddenMs,1000);
  assert.deepEqual(trace.framebuffer,FRAMEBUFFER);const projection=object(trace.projection);assert.deepEqual(projection.camera,CAMERA);
  assert.equal(projection.coordinateSystem,'RUB-right-up-backward');assert.equal(trace.measuredOverdraw,null);assert.equal(trace.observedTimings,null);
  assert(Array.isArray(trace.phases)&&trace.phases.length===3);
  const names=['warmup','measured-orbit','idle-hidden'],durations=[5000,30000,1000];
  trace.phases.forEach((raw,index)=>{
    const phase=object(raw);assert.equal(phase.kind,names[index]);assert.equal(phase.durationMs,durations[index]);assert.equal(phase.visible,index<2);
    assert(Array.isArray(phase.samples));const intervals=index<2?durations[index]!/250:0;
    assert.equal(phase.samples.length,index<2?intervals+1:0);
    phase.samples.forEach((rawSample,sampleIndex)=>{
      const sample=object(rawSample),expected=[...CAMERA];expected[3]=2*Math.PI*(sampleIndex/intervals);
      assert.equal(sample.atMs,sampleIndex*250);assert.deepEqual(sample.camera,expected);
    });
  });
  return value as OrbitTrace;
}
export function interpolateOrbitCamera(phase:OrbitPhase,elapsedMs:number):number[] {
  assert(Number.isFinite(elapsedMs));assert(phase.samples.length>=2);
  const elapsed=Math.max(0,Math.min(phase.durationMs,elapsedMs));
  if(elapsed===phase.durationMs)return[...phase.samples.at(-1)!.camera];
  const index=Math.min(phase.samples.length-2,Math.floor(elapsed/250)),a=phase.samples[index]!,b=phase.samples[index+1]!;
  const camera=[...a.camera];camera[3]=a.camera[3]!+(b.camera[3]!-a.camera[3]!)*((elapsed-a.atMs)/(b.atMs-a.atMs));return camera;
}
export function summarizeOrbitRafs(times:readonly number[]) {
  const intervals:number[]=[];
  times.forEach((time,index)=>{assert(Number.isFinite(time)&&time>=0);if(index){assert(time>times[index-1]!,'Actual rAF times must increase.');intervals.push(time-times[index-1]!);}});
  const sorted=[...intervals].sort((a,b)=>a-b),n=sorted.length;
  return{clock:'page-performance.now',scope:'browser-rAF-callback-intervals-not-GPU-or-presentation',count:n,
    minimumMs:n?sorted[0]!:null,maximumMs:n?sorted[n-1]!:null,meanMs:n?intervals.reduce((a,b)=>a+b,0)/n:null,
    p50Ms:n?sorted[Math.ceil(.5*n)-1]!:null,p95Ms:n?sorted[Math.ceil(.95*n)-1]!:null,percentileMethod:'nearest-rank'};
}
export function assertOrbitCamera(boundary:CameraBoundary,requested:readonly number[],baseline:Snapshot):void {
  assert.equal(boundary.schemaVersion,1);assert.equal(boundary.kind,'splatview-production-benchmark-camera');
  assert.equal(boundary.clock.id,baseline.clock.id);assert.equal(boundary.clock.timeOrigin,baseline.clock.timeOrigin);
  assert.equal(boundary.runtime.mode,'production-verified');assert.equal(boundary.runtime.appInputId,baseline.runtime.appInputId);
  assert.equal(boundary.runtime.deploymentId,baseline.runtime.deploymentId);
  const value=boundary.controller;
  assert(Number.isFinite(value.capturedAtMs)&&Number.isFinite(boundary.clock.now)&&value.capturedAtMs<=boundary.clock.now);
  assert(value.state.ready&&!value.state.busy&&value.state.hasScene&&value.state.hasClient&&value.state.error===null);
  assert.equal(value.state.bootstrapState,'ready');assert.equal(value.state.rendererState,'ready');assert.equal(value.state.runtimeMode,'production-verified');
  assert.deepEqual(value.state.documentRevision,baseline.controller.state.documentRevision);assert(value.observation.enabled&&value.renderer?.ready&&value.camera);
  assert(Number.isSafeInteger(value.camera.revision)&&Number.isSafeInteger(value.observation.lastFrameSequence)&&Number.isSafeInteger(value.renderer.frameSubmissionSequence));
  assert.deepEqual(value.camera.state,requested.map(Math.fround));
  assert.deepEqual(value.framebuffer,{width:1280,height:800,devicePixelRatio:1});
}
export function assertOrbitFrame(frame:OrbitFrameObservation,boundary:CameraBoundary,requested:readonly number[],baseline:Snapshot,allowCameraStale=false):void {
  assertOrbitCamera(boundary,requested,baseline);const value=boundary.controller;
  assert(value.camera&&value.renderer);
  if(allowCameraStale&&frame.status==='stale')assert.equal(frame.staleReason,'Camera owner/revision changed before queue completion.');
  else assert.equal(frame.status,'completed');
  assert.equal(frame.error,null);
  assert.equal(frame.clock,'performance.now');assert.equal(frame.visibility,'visible');assert.equal(frame.deviceEpoch,value.renderer.deviceEpoch);
  assert(frame.sequence>value.observation.lastFrameSequence&&frame.rendererSubmissionSequence>value.renderer.frameSubmissionSequence);
  assert.deepEqual(frame.documentRevision,value.state.documentRevision);assert.equal(frame.camera.revision,value.camera.revision);
  assert.deepEqual(frame.camera.state,value.camera.state);assert.deepEqual(frame.camera.view,value.camera.view);assert.deepEqual(frame.camera.projection,value.camera.projection);
  assert.deepEqual(frame.camera.eye,value.camera.eye);assert.deepEqual(frame.framebuffer,{width:1280,height:800,devicePixelRatio:1});
  assert.deepEqual(frame.framebuffer,value.framebuffer);assert.equal(frame.presentation.available,false);assert.equal(frame.gpuTimestamps.available,false);
  assert(frame.queueCompletedAtMs!==null&&Number.isFinite(frame.queueCompletedAtMs)&&frame.drawStartedAtMs>=value.capturedAtMs&&
    frame.submissionObservedAtMs>=frame.drawStartedAtMs&&frame.queueCompletedAtMs>=frame.submissionObservedAtMs);
}
export function validateOrbitPhaseObservation(phase:OrbitPhase,observed:OrbitPhaseObservation,loaded:Snapshot){
  assert.equal(observed.kind,phase.kind);assert.equal(observed.status,'observed');assert.equal(observed.durationMs,phase.durationMs);
  assert.equal(observed.rafDrops,0);assert.equal(observed.actionDrops,0);assert.equal(observed.frameDrops,0);
  assert(observed.startedAtMs!==null&&observed.endedAtMs!==null&&Number.isFinite(observed.startedAtMs)&&Number.isFinite(observed.endedAtMs)&&
    observed.endedAtMs-observed.startedAtMs>=phase.durationMs);
  assert(observed.firstCamera?.boundary&&observed.firstCamera.frame);
  assertOrbitFrame(observed.firstCamera.frame,observed.firstCamera.boundary,phase.samples[0]!.camera,loaded);
  assert(observed.firstCamera.frame.queueCompletedAtMs!<=observed.startedAtMs);
  assert(observed.actions.length>=2&&observed.actions.at(-1)!.elapsedMs>=phase.durationMs,'Orbit did not reach its pinned terminal pose.');
  assert.equal(observed.actions[0]!.rafAtMs,observed.rafTimes[0],'First actual rAF camera opportunity was not retained.');
  const rafSet=new Set(observed.rafTimes),owners=new Map<number,OrbitAction>();let previousCamera=observed.firstCamera.frame.camera.revision;
  owners.set(previousCamera,observed.firstCamera);
  for(const action of observed.actions){
    assert.equal(action.status,'applied');assert(action.boundary&&action.boundary.controller.camera);
    assert(action.rafAtMs!==null&&rafSet.has(action.rafAtMs)&&action.elapsedMs===action.rafAtMs-observed.startedAtMs,'Camera action has no actual phase rAF timestamp.');
    assert.deepEqual(action.requestedCamera,interpolateOrbitCamera(phase,action.elapsedMs));
    assertOrbitCamera(action.boundary,action.requestedCamera,loaded);
    const camera=action.boundary.controller.camera;assert(camera.revision>previousCamera);
    assert.equal(action.boundary.controller.renderer!.deviceEpoch,observed.firstCamera.frame.deviceEpoch);
    assert(action.boundary.controller.capturedAtMs>=action.rafAtMs);
    owners.set(camera.revision,action);previousCamera=camera.revision;
  }
  const terminal=observed.actions.at(-1)!;assert(terminal.boundary&&terminal.frame);
  assertOrbitFrame(terminal.frame,terminal.boundary,terminal.requestedCamera,loaded);
  assert(terminal.frame.queueCompletedAtMs!<=observed.endedAtMs);
  let previousFrame=observed.firstCamera.frame.sequence,staleFrames=0;
  for(const frame of observed.frames){
    const owner=owners.get(frame.camera.revision);assert(owner?.boundary,'Rendered camera revision was never issued in this phase.');
    assertOrbitFrame(frame,owner.boundary,owner.requestedCamera,loaded,true);
    assert(frame.sequence===previousFrame+1&&frame.sequence<=terminal.frame.sequence,'Actual phase frame history has a sequence gap.');
    assert(frame.queueCompletedAtMs!<=observed.endedAtMs);previousFrame=frame.sequence;
    if(frame.status==='stale'){
      assert(observed.actions.some(action=>action.boundary!.controller.camera!.revision>frame.camera.revision&&
        action.boundary!.controller.capturedAtMs<=frame.queueCompletedAtMs!), 'Camera-stale frame has no later issued camera before queue completion.');staleFrames++;
    }
  }
  assert.equal(observed.frames.at(-1)?.sequence,terminal.frame.sequence,'Terminal queue frame is absent from actual phase history.');
  assert.deepEqual(observed.frames.at(-1),terminal.frame,'Terminal queue receipt differs from the retained actual frame history.');
  assert(observed.rafTimes.every(at=>at>=observed.startedAtMs!&&at<=observed.endedAtMs!));
  return{rafSummary:summarizeOrbitRafs(observed.rafTimes),actualDurationMs:observed.endedAtMs-observed.startedAtMs,
    actionSummary:{...summarizeOrbitRafs(observed.actions.map(action=>action.rafAtMs!)),scope:'camera-action-opportunity-rAF-intervals'},
    actionCount:observed.actions.length,rafCount:observed.rafTimes.length,rafTicksWithoutCameraAction:observed.rafTimes.length-observed.actions.length,
    scheduledQueueFrames:observed.frames.length,cameraStaleQueueFrames:staleFrames,
    missedFrameCount:{available:false,reason:'rAF callback intervals do not observe missed physical presentation frames.'}};
}

/** Serialized by Playwright: references only its parameters and real page APIs. */
async function browserOrbit(input:{key:string;progressKey:string;trace:OrbitTrace}):Promise<BrowserProgress> {
  const host=window as unknown as Record<string,unknown>,api=host[input.key] as OrbitBridge;
  if(!api||typeof api.applyCamera!=='function')throw new Error('Current production lean camera bridge is unavailable.');
  const progress:BrowserProgress={status:'pending',clock:{id:`performance.now:${performance.timeOrigin}`,timeOrigin:performance.timeOrigin},
    phases:[],visibilityEvents:[],visibilityDrops:0,longTasks:{available:false,reason:'Long task observation is unsupported.',entries:[],drops:0},error:null};
  const onVisibility=()=>{const row={atMs:performance.now(),hidden:document.hidden,visibilityState:document.visibilityState};
    if(progress.visibilityEvents.length<64)progress.visibilityEvents.push(row);else progress.visibilityDrops++;};
  Object.defineProperty(host,input.progressKey,{value:{progress,detach:()=>document.removeEventListener('visibilitychange',onVisibility)},configurable:true});
  document.addEventListener('visibilitychange',onVisibility);onVisibility();
  const text=(error:unknown)=>(error instanceof Error?error.stack??error.message:String(error)).slice(0,4096);
  const check=(condition:unknown,message:string)=>{if(!condition)throw new Error(message);};
  const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
  let longTaskObserver:PerformanceObserver|undefined;
  const longTasks=(entries:PerformanceEntry[])=>{for(const entry of entries){
    if(progress.longTasks.entries.length<512)progress.longTasks.entries.push({startTime:entry.startTime,duration:entry.duration,name:entry.name.slice(0,256)});
    else progress.longTasks.drops++;
  }};
  try{if(typeof PerformanceObserver!=='undefined'&&PerformanceObserver.supportedEntryTypes.includes('longtask')){
    longTaskObserver=new PerformanceObserver(list=>longTasks(list.getEntries()));longTaskObserver.observe({entryTypes:['longtask']});
    progress.longTasks.available=true;progress.longTasks.reason=null;
  }}catch(error){progress.longTasks.reason=text(error);}
  const pose=(phase:OrbitPhase,elapsedMs:number)=>{
    const elapsed=Math.max(0,Math.min(phase.durationMs,elapsedMs));if(elapsed===phase.durationMs)return[...phase.samples.at(-1)!.camera];
    const index=Math.min(phase.samples.length-2,Math.floor(elapsed/250)),a=phase.samples[index]!,b=phase.samples[index+1]!,camera=[...a.camera];
    camera[3]=a.camera[3]!+(b.camera[3]!-a.camera[3]!)*((elapsed-a.atMs)/(b.atMs-a.atMs));return camera;
  };
  let totalActions=0;
  const nextRaf=()=>new Promise<number>((resolve,reject)=>{
    let handle=0;const timer=setTimeout(()=>{cancelAnimationFrame(handle);reject(new Error('Timed out waiting for an actual visible page rAF.'));},5000);
    handle=requestAnimationFrame(at=>{clearTimeout(timer);resolve(at);});
  });
  const act=async(requestedCamera:number[],rafAtMs:number|null,elapsedMs:number,target:OrbitAction)=>{
    target.requestedCamera=requestedCamera;target.rafAtMs=rafAtMs;target.elapsedMs=elapsedMs;
    try{
      if(++totalActions>3600)throw new Error('Bounded orbit action inventory is full.');
      check(!document.hidden&&document.visibilityState==='visible','Orbit action is not actually visible.');
      const boundary=await api.applyCamera(requestedCamera);target.boundary=boundary;
      const current=boundary.controller;check(current.camera&&current.renderer?.ready&&current.observation.enabled,'Current camera/renderer observation is unavailable.');
      check(same(current.camera!.state,requestedCamera.map(Math.fround)),'Actual camera acknowledgment differs from requested pose.');
      target.status='applied';
    }catch(error){target.status='failed';target.error=text(error);throw error;}
  };
  // Only phase boundary poses join the GPU queue. Continuous camera updates may
  // naturally coalesce while the ordinary production draw fence is pending.
  const join=async(target:OrbitAction):Promise<Snapshot>=>{
    const deadline=performance.now()+15000,boundary=target.boundary!;let cursor=boundary.controller.observation.lastFrameSequence;
    for(;;){
      try{await api.waitForFrame(cursor,Math.max(1,Math.min(1000,Math.ceil(deadline-performance.now()))));}catch{/* The earlier in-flight camera may settle stale. */}
      const value=await api.snapshot(),frames=value.controller.observation.frames as unknown as OrbitFrameObservation[];
      const frame=frames.find(item=>item.sequence>boundary.controller.observation.lastFrameSequence&&item.status==='completed'&&
        item.camera.revision===boundary.controller.camera!.revision&&same(item.camera.state,boundary.controller.camera!.state));
      if(frame&&value.controller.knownPending.drawing===false){target.frame=frame;return value;}
      check(performance.now()<deadline,'Timed out joining the actual terminal camera frame.');
      check(value.controller.observation.enabled,'Production frame observation became unavailable.');cursor=value.controller.observation.lastFrameSequence;
      await new Promise(resolve=>setTimeout(resolve,0));
    }
  };
  const blank=():OrbitAction=>({status:'pending',rafAtMs:null,elapsedMs:0,requestedCamera:[],boundary:null,frame:null,error:null});
  try{
    for(const phase of input.trace.phases.filter(value=>value.visible)){
      const observed:OrbitPhaseObservation={kind:phase.kind,status:'pending',durationMs:phase.durationMs,startedAtMs:null,endedAtMs:null,
        firstCamera:null,actions:[],frames:[],frameDrops:0,rafTimes:[],rafDrops:0,actionDrops:0,error:null};progress.phases.push(observed);
      let observerHandle=0,observerError:string|null=null;
      try{
        observed.firstCamera=blank();await act([...phase.samples[0]!.camera],null,0,observed.firstCamera);await join(observed.firstCamera);
        observed.startedAtMs=performance.now();
        const observe=(atMs:number)=>{
          if(observed.rafTimes.length===8192){observed.rafDrops++;observerError='Bounded actual rAF inventory is full.';return;}
          observed.rafTimes.push(atMs);
          if(document.hidden||document.visibilityState!=='visible'){observerError='Document became hidden during visible orbit.';return;}
          observerHandle=requestAnimationFrame(observe);
        };observerHandle=requestAnimationFrame(observe);
        for(;;){
          const atMs=await nextRaf();if(observerError)throw new Error(observerError);
          const elapsed=atMs-observed.startedAtMs;if(observed.actions.length===3598){observed.actionDrops++;throw new Error('Bounded phase action inventory is full.');}
          const action=blank();observed.actions.push(action);await act(pose(phase,elapsed),atMs,elapsed,action);
          if(elapsed>=phase.durationMs)break;
        }
        const finalSnapshot=await join(observed.actions.at(-1)!);
        observed.frames=(finalSnapshot.controller.observation.frames as unknown as OrbitFrameObservation[]).filter(frame=>
          frame.sequence>observed.firstCamera!.frame!.sequence&&frame.sequence<=observed.actions.at(-1)!.frame!.sequence);
        observed.frameDrops=finalSnapshot.controller.observation.droppedFrames;
        observed.status='observed';
      }catch(error){observed.status='failed';observed.error=text(error);throw error;}
      finally{
        cancelAnimationFrame(observerHandle);observed.endedAtMs=performance.now();
        if(observed.status==='failed')try{
          const partial=await api.snapshot();observed.frames=(partial.controller.observation.frames as unknown as OrbitFrameObservation[])
            .filter(frame=>frame.sequence>(observed.firstCamera?.frame?.sequence??observed.firstCamera?.boundary?.controller.observation.lastFrameSequence??0));
          observed.frameDrops=partial.controller.observation.droppedFrames;
        }catch(error){observed.error=`${observed.error??''}\nPartial frame snapshot failed: ${text(error)}`.slice(0,8192);}
      }
    }
    progress.status='observed';
  }catch(error){progress.status='failed';progress.error=text(error);}
  finally{if(longTaskObserver){longTasks(longTaskObserver.takeRecords());longTaskObserver.disconnect();}}
  return progress;
}

/** A real tab switch is attempted; native hidden state remains mandatory. */
export const tabHiddenHost:HiddenHostAdapter={id:'actual-default-context-tab-switch',async enter(page,context){
  let helper:Page|undefined;
  try{helper=await context.newPage();await helper.goto('about:blank');await helper.bringToFront();}
  catch(error){await helper?.close().catch(()=>undefined);throw error;}
  return{metadata:{method:'Page.bringToFront',focusOverride:'not-added-by-orbit-adapter',helperUrl:helper.url()},async restore(){
    try{await page.bringToFront();}finally{await helper!.close();}}};
}};

async function visibilitySample(page:Page){return page.evaluate(async({key,progressKey})=>{
  const host=window as unknown as Record<string,unknown>,api=host[key] as OrbitBridge;
  const value=await api.snapshot(),capturedAtMs=performance.now(),progress=(host[progressKey] as {progress:BrowserProgress}|undefined)?.progress;
  return{clock:{id:`performance.now:${performance.timeOrigin}`,timeOrigin:performance.timeOrigin,now:capturedAtMs},hidden:document.hidden,
    visibilityState:document.visibilityState,frameSequence:value.controller.observation.lastFrameSequence,
    rendererSubmissionSequence:(value.controller.renderer as unknown as {frameSubmissionSequence:number}).frameSubmissionSequence,
    drawing:value.controller.knownPending.drawing,camera:value.controller.camera,framebuffer:value.controller.framebuffer,
    progress:progress?{visibilityEvents:progress.visibilityEvents,visibilityDrops:progress.visibilityDrops}:null};
},{key:KEY,progressKey:PROGRESS_KEY});}
export function assertHiddenInterval(first:Awaited<ReturnType<typeof visibilitySample>>,last:Awaited<ReturnType<typeof visibilitySample>>):void{
  for(const value of [first,last])assert(Number.isFinite(value.clock.now)&&Number.isFinite(value.clock.timeOrigin)&&
    Number.isSafeInteger(value.frameSequence)&&value.frameSequence>=0&&Number.isSafeInteger(value.rendererSubmissionSequence)&&value.rendererSubmissionSequence>=0&&value.camera&&value.framebuffer);
  assert(first.hidden&&last.hidden&&first.visibilityState==='hidden'&&last.visibilityState==='hidden','A real hidden document was not observed.');
  assert.equal(first.clock.id,last.clock.id);assert.equal(first.clock.timeOrigin,last.clock.timeOrigin);
  assert(last.clock.now-first.clock.now>=1000,'Actual hidden interval is shorter than the pinned duration.');
  assert.equal(first.frameSequence,last.frameSequence);assert.equal(first.rendererSubmissionSequence,last.rendererSubmissionSequence);
  assert.equal(first.drawing,false);assert.equal(last.drawing,false);assert.deepEqual(first.camera,last.camera);assert.deepEqual(first.framebuffer,last.framebuffer);
  assert.equal(first.progress?.visibilityDrops,0);assert.equal(last.progress?.visibilityDrops,0);
  const events=last.progress?.visibilityEvents??[];assert(!events.some(row=>row.atMs>first.clock.now&&row.atMs<last.clock.now&&(!row.hidden||row.visibilityState!=='hidden')),'Document became visible within hidden interval.');
}
async function observeOrbit(input:ProductionProbeObservation,trace:OrbitTrace,hiddenHost:HiddenHostAdapter):Promise<void>{
  const {page,context,baseline,loaded,attempt}=input,observed:Json={status:'pending',visible:null,hidden:{status:'pending',host:hiddenHost.id},error:null};
  attempt.orbitObservation=observed;
  try{
    const visible=await page.evaluate(browserOrbit,{key:KEY,progressKey:PROGRESS_KEY,trace});observed.visible=visible;
    assert.equal(visible.status,'observed',visible.error??'Actual visible orbit failed.');assert.equal(visible.clock.id,baseline.clock.id);
    for(let index=0;index<2;index++){
      const phase=visible.phases[index]!;Object.assign(phase,validateOrbitPhaseObservation(trace.phases[index]!,phase,loaded),{
        longTasks:visible.longTasks.available?{available:true,entries:visible.longTasks.entries.filter(entry=>entry.startTime>=phase.startedAtMs!&&entry.startTime<=phase.endedAtMs!),
          inventoryDrops:visible.longTasks.drops,scope:'actual-longtask-entries-starting-within-visible-phase'}:{available:false,reason:visible.longTasks.reason},
      });
    }
    const after=await snapshot(page);assertProbeSnapshot(after,{appInputId:loaded.runtime.appInputId,deploymentId:loaded.runtime.deploymentId!});
    assert.deepEqual(after.runtime.artifacts,loaded.runtime.artifacts);assertProbeClock(after,baseline);
    observed.renderedFrames=after.controller.observation.frames;observed.frameDrops=after.controller.observation.droppedFrames;
    assert.equal(after.controller.knownPending.drawing,false,'Join the last displayed frame before hidden observation.');
    const hidden=observed.hidden as Json;let owner:Awaited<ReturnType<HiddenHostAdapter['enter']>>|undefined;
    try{
      owner=await hiddenHost.enter(page,context);hidden.metadata=owner.metadata;
      const deadline=performance.now()+5000;let first=await visibilitySample(page);hidden.firstRead=first;
      while((!first.hidden||first.visibilityState!=='hidden')&&performance.now()<deadline){await new Promise(resolve=>setTimeout(resolve,100));first=await visibilitySample(page);hidden.firstRead=first;}
      assert(first.hidden&&first.visibilityState==='hidden','Host mechanism did not produce actual document.hidden.');
      assert.equal(first.clock.id,baseline.clock.id);assert.equal(first.clock.timeOrigin,baseline.clock.timeOrigin);
      assert.deepEqual(first.camera,after.controller.camera);assert.deepEqual(first.framebuffer,after.controller.framebuffer);
      hidden.started=first;await new Promise(resolve=>setTimeout(resolve,1100));const last=await visibilitySample(page);hidden.ended=last;
      assertHiddenInterval(first,last);hidden.status='observed';hidden.actualDurationMs=last.clock.now-first.clock.now;
    }catch(error){hidden.status='failed';hidden.error=errorText(error);throw error;}
    finally{if(owner){try{await owner.restore();hidden.restored=true;}catch(error){hidden.restored=false;hidden.restoreError=errorText(error);throw error;}}}
    const restored=await visibilitySample(page);hidden.restoredRead=restored;assert(!restored.hidden&&restored.visibilityState==='visible','Actual visible state was not restored.');
    assert.equal(restored.progress?.visibilityDrops,0);observed.status='observed';
  }catch(error){observed.status='failed';observed.error=errorText(error);
    try{observed.partial=await page.evaluate(key=>(window as unknown as Record<string,{progress:BrowserProgress}|undefined>)[key]?.progress??null,PROGRESS_KEY);}catch{/* Preserve the last returned raw observations. */}
    throw error;
  }finally{try{await page.evaluate(key=>{const host=window as unknown as Record<string,{detach():void}|undefined>;host[key]?.detach();delete host[key];},PROGRESS_KEY);}
    catch(error){observed.observerCleanupError=errorText(error);}}
}
export async function runProductionOrbit(options:OrbitOptions,hooks:OrbitHooks={}):Promise<{status:string;report:string;attempts:number}>{
  const workspace=new Workspace(process.cwd()),traceInput=await workspace.read(options.trace);assert(traceInput.bytes.length<=1024*1024);
  const manifestInput=await workspace.read(options.manifest),manifest=object(JSON.parse(new TextDecoder().decode(manifestInput.bytes)));
  assert.equal(object(manifest.identity).traceSha256,digest(traceInput.bytes));const trace=validateOrbitTrace(JSON.parse(new TextDecoder().decode(traceInput.bytes)));
  const {hiddenHost=tabHiddenHost,...probeHooks}=hooks;
  const runId=options.output.split('/').at(-1)!;
  const createBrowserOwner:NonNullable<ProductionProbeHooks['createBrowserOwner']>=probeHooks.createBrowserOwner??(({id,metadata})=>
    launchVisibilityBrowser({directory:`.build/bench-hosts/${runId}/${id}`,metadata}));
  const probe=await runProductionProbe(options,{...probeHooks,createBrowserOwner,observeLoaded:input=>observeOrbit(input,trace,hiddenHost)});
  const parent=await workspace.read(probe.report),packet=object(JSON.parse(new TextDecoder().decode(parent.bytes)));
  const report=`${options.output}/orbit-observation.json`;
  await workspace.writeExclusive(report,{schemaVersion:1,kind:'splatview-production-orbit-hidden-observation',status:probe.status,scope:'raw-production-orbit-hidden-only',
    source:{probe:parent.reference,trace:traceInput.reference,manifest:manifestInput.reference},attempts:probe.attempts,
    performanceAccepted:false,capacityQualified:false,sustainedQualified:false,
    rawObservations:'Parent probe attempt.orbitObservation contains every retained actual rAF timestamp, per-rAF interpolated camera acknowledgment and scheduled queue frame, including camera-stale completions and failed partial phases.',
    exportedSceneProof:'Parent probe retains the actual post-orbit full-scene SPLAT download and independent attribute/membership oracle.',
    host:packet.host,limitations:['Not the complete 214-attempt v2 matrix.','Browser rAF intervals and GPU queue completion are not physical presentation or GPU timestamp timings.',
      'Camera acknowledgments and rAF intervals are distinct. Continuous updates can coalesce while the ordinary draw queue is pending; missed physical presentation frames remain unavailable.','Selection masks, projected overdraw, approved budgets and sustained memory qualification remain pending.',
      'The pinned trace labels camera field 6 as speed; frozen native camera ABI interprets that unchanged positive value as radius.']});
  return{status:probe.status,report,attempts:probe.attempts};
}
export function parseOrbitOptions(args:string[]):OrbitOptions{
  const filtered:string[]=[];let trace:string|undefined;
  for(let index=0;index<args.length;index+=2){if(args[index]==='--trace'){assert(trace===undefined&&args[index+1],'Expected one trace path.');trace=relativePath(args[index+1]!);}else filtered.push(args[index]!,args[index+1]!);}
  assert(trace,'Supply --trace with the pinned generated orbit-trace.json.');return{...parseProbeOptions(filtered),trace};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  runProductionOrbit(parseOrbitOptions(process.argv.slice(2))).then(value=>{process.stdout.write(JSON.stringify(value)+'\n');process.exitCode=value.status==='observed'?0:2;},error=>{process.stderr.write(errorText(error)+'\n');process.exitCode=1;});
}
