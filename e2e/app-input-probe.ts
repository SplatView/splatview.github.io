import type { AppController } from '../src/app/controller';
import { GlRenderer } from '../src/renderer/webgl2/renderer';

export type CameraGesture = 'orbit' | 'pan' | 'zoom';
export type InputResponse = { inputId: number; attempt: number; inputToCompletionMs: number };
type Input = { id: number; atMs: number; eventAtMs: number; trusted: boolean; beforeRevision: number; x: number; y: number; deltaY: number };
type Frame = { attempt: number; inputId: number; startedMs: number; submittedMs: number; completedMs?: number;
  revision: number; revisionAtSubmission: number; revisionAtCompletion?: number; sequence: number; pending: number; precision: number;
  view: number[]; width: number; height: number };

/** Fixture-only observation. Never schedules App draws or replaces its fences. */
export function installAppInputProbe(app: AppController, gesture: CameraGesture) {
  const renderer=app.renderer,camera=app.camera,scene=app.scene,client=app.client;
  if(!renderer || !camera || !scene || !client || scene.kind!=='gaussian') throw new Error('The actual App Gaussian scene is required.');
  const epoch=renderer.deviceEpoch,width=renderer.canvas.width,height=renderer.canvas.height,revision={...client.revision};
  const inputs:Input[]=[],frames:Frame[]=[],errors:string[]=[],raf:number[]=[],joins:Promise<void>[]=[],work:object[]=[];
  let attempt=0,pending=0,rafId=0,closed=false,currentFrame:Frame|undefined;
  const original=renderer.render,compute=renderer instanceof GlRenderer?renderer.compute:undefined,observe=compute?.observeWork;
  if(compute) compute.observeWork=event=>{
    if(event.action==='sort') {
      if(work.length>=2048) throw new Error('Input worker observation bound exceeded.');
      work.push({...event,attempt:currentFrame?.attempt??null,inputId:currentFrame?.inputId??null});
    }
    observe?.(event);
  };
  const current=()=>app.renderer===renderer && app.camera===camera && app.scene===scene && app.client===client &&
    renderer.deviceEpoch===epoch && !renderer.lost && renderer.canvas.width===width && renderer.canvas.height===height &&
    JSON.stringify(client.revision)===JSON.stringify(revision);
  const input=(event:Event)=>{
    if(closed || event.target!==renderer.canvas) return;
    const pointer=event as PointerEvent,wheel=event as WheelEvent;
    if(gesture!=='zoom' && !(pointer.buttons&(gesture==='pan'?2:4))) return;
    if(inputs.length>=2048) {errors.push('Input observation bound exceeded.');return;}
    inputs.push({id:inputs.length+1,atMs:performance.now(),eventAtMs:event.timeStamp,trusted:event.isTrusted,
      beforeRevision:camera.revision,x:pointer.clientX,y:pointer.clientY,deltaY:gesture==='zoom'?wheel.deltaY:0});
  };
  const inputEvent=gesture==='zoom'?'wheel':'pointermove';
  document.addEventListener(inputEvent,input,{capture:true});
  const record=(frame:Frame,before:number)=>{
    const checkpoint=renderer.displayCompletion?.();
    if(!checkpoint || checkpoint.submissionSequence<=before) {currentFrame=undefined;return;}
    frame.submittedMs=performance.now();frame.revisionAtSubmission=camera.revision;
    frame.sequence=checkpoint.submissionSequence;frame.pending=++pending;
    if(frames.length>=2048) throw new Error('Input frame observation bound exceeded.');
    frames.push(frame);currentFrame=undefined;
    joins.push(checkpoint.done.then(()=>{frame.completedMs=performance.now();frame.revisionAtCompletion=camera.revision;},error=>{
      errors.push(String(error));
    }).finally(()=>{pending--;}));
  };
  renderer.render=(...args)=>{
    const before=renderer.frameSubmissionSequence;
    const frame:Frame={attempt:++attempt,inputId:inputs.at(-1)?.id??0,startedMs:performance.now(),submittedMs:0,
      revision:args[1].revision,revisionAtSubmission:0,sequence:0,pending:0,precision:renderer.displaySortPrecision,
      view:Array.from(args[1].view),width,height};
    currentFrame=frame;
    const task=original.apply(renderer,args);
    if(task) return task.then(()=>record(frame,before));
    record(frame,before);
  };
  const heartbeat=(time:number)=>{
    if(closed)return;
    if(raf.length>=4096) {errors.push('rAF observation bound exceeded.');return;}
    raf.push(time);rafId=requestAnimationFrame(heartbeat);
  };
  rafId=requestAnimationFrame(heartbeat);
  const check=()=>{if(!current() || errors.length) throw new Error(`Input owner/fence failed: ${errors.join('; ')}`);};
  return {
    inputs,frames,work,raf,errors,current,
    async waitForInput(id:number):Promise<InputResponse> {
      const deadline=performance.now()+10000;
      for(;;) {
        check();const event=inputs[id-1];
        const frame=event&&frames.find(f=>f.inputId===id && f.startedMs>=event.atMs && f.revision>event.beforeRevision && f.completedMs!==undefined);
        if(frame) return {inputId:id,attempt:frame.attempt,inputToCompletionMs:frame.completedMs!-event.atMs};
        if(performance.now()>deadline) throw new Error(`No changed post-input pose/fence for ${gesture} input ${id} (${inputs.length} inputs, ${frames.length} frames).`);
        await new Promise(requestAnimationFrame);
      }
    },
    async finish() {
      await waitForAppInputIdle(app);await Promise.all(joins);check();
      return {inputs,frames,work,raf,errors,gesture,framebuffer:{width,height,dpr:devicePixelRatio},
        scene:{count:scene.count,degree:scene.degree,sourceRevision:scene.sourceRevision},documentRevision:revision,
        environment:{userAgent:navigator.userAgent,secureContext:isSecureContext,crossOriginIsolated,visibility:document.visibilityState},
        scope:'Trusted App input; immutable pose at render entry, confirmed submission and its real display fence. rAF observer adds one callback/frame. Physical presentation and physical dropped frames unavailable.'};
    },
    restore() {
      if(closed)return;closed=true;cancelAnimationFrame(rafId);renderer.render=original;
      if(compute)compute.observeWork=observe;
      document.removeEventListener(inputEvent,input,{capture:true});
    },
  };
}

export async function waitForAppInputIdle(app: AppController) {
  const deadline=performance.now()+10000;
  for(;;) {
    const snapshot=app.benchmarkSnapshot();
    if(snapshot.state.error)throw new Error(snapshot.state.error);
    if(!snapshot.knownPending.drawing && !snapshot.knownPending.scheduledAnimationFrame && !app.camera!.active && app.renderer!.displaySortPrecision===32) {
      await app.renderer!.finish();return;
    }
    if(performance.now()>deadline)throw new Error('Actual App did not refine to exact idle.');
    await new Promise(requestAnimationFrame);
  }
}

declare global { interface Window { appInputProbe: ReturnType<typeof installAppInputProbe> } }
