import { expect, test } from '@playwright/test';
import type {} from './geometry-viewer-harness';

type InputFrame={sequence:number;startedMs:number;submittedMs:number;completedMs?:number;width:number;height:number;revision:number};
declare global { interface Window { renderingInputProbe: {
  inputAtMs:number;sequence:number;rows:InputFrame[];errors:string[];restore():void;current():boolean;
} } }

for (const backend of ['webgpu', 'webgl2'] as const) for (let repetition = 0; repetition < 3; repetition++) {
  test(`${backend} App wheel input completion repetition ${repetition + 1}`, async ({ page }, info) => {
    test.setTimeout(180000);
    await page.goto(`/e2e/backend-bench-harness.html?graphics=${backend}`);
    await page.waitForFunction(() => window.geometryViewer?.ready());
    await page.getByRole('button', { name: 'Open example', exact: true }).click();
    await expect(page).toHaveTitle('Bench example.sog — SplatView');
    await page.evaluate(() => {
      const app = window.geometryViewer.controllerForRendererNavigation();
      app.enableBenchmarkObservation({ maxFrames: 1024 });
      const r=app.renderer!,camera=app.camera!,scene=app.scene,render=r.render.bind(r),rows:InputFrame[]=[],errors:string[]=[];
      r.render=(...args)=>{
        const before=r.frameSubmissionSequence,startedMs=performance.now(),revision=args[1].revision;
        const record=()=>{
          const checkpoint=r.displayCompletion?.();if(!checkpoint||checkpoint.submissionSequence<=before)return;
          if(rows.length>=1024)throw new Error('Input fixture frame bound exceeded.');
          const row:InputFrame={sequence:checkpoint.submissionSequence,startedMs,submittedMs:performance.now(),revision,width:r.canvas.width,height:r.canvas.height};rows.push(row);
          void checkpoint.done.then(()=>{row.completedMs=performance.now();},error=>{errors.push(String(error));});
        };
        const task=render(...args);if(task)return task.then(record);record();
      };
      const input=()=>{window.renderingInputProbe.inputAtMs=performance.now();};
      document.addEventListener('wheel',input,{capture:true});
      window.renderingInputProbe={inputAtMs:0,sequence:0,rows,errors,
        current:()=>app.renderer===r&&app.camera===camera&&app.scene===scene,
        restore(){r.render=render;document.removeEventListener('wheel',input,{capture:true});}};
    });
    const canvas = page.locator('canvas').first(), bounds = await canvas.boundingBox();
    if (!bounds) throw new Error('App canvas unavailable.');
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    const samples: { inputToCompletionMs: number; drawMs: number; submissionMs: number; width: number; height: number }[] = [];
    for (let i = 0; i < 128; i++) {
      await page.mouse.wheel(0, i % 2 ? -2 : 2);
      const sample = await page.evaluate(async () => {
        const probe = window.renderingInputProbe,deadline=performance.now()+10000;
        for (;;) {
          if(!probe.current()||probe.errors.length)throw new Error('Input measurement owner/fence failed.');
          const frame=probe.rows.find(row=>row.sequence>probe.sequence&&row.completedMs!==undefined);
          if(frame){
            probe.sequence=frame.sequence;
            // An async GL submission may have started before this input. Its
            // immutable pose belongs to the previous input and must be skipped.
            if(frame.startedMs<probe.inputAtMs)continue;
            return {inputToCompletionMs:frame.completedMs!-probe.inputAtMs,drawMs:frame.completedMs!-frame.startedMs,
              submissionMs:frame.submittedMs-frame.startedMs,width:frame.width,height:frame.height};
          }
          if(performance.now()>deadline)throw new Error('Timed out waiting for the actual post-input frame fence.');
          await new Promise(requestAnimationFrame);
        }
      });
      if (i >= 8) samples.push(sample);
    }
    await page.evaluate(()=>window.renderingInputProbe.restore());
    await info.attach('app-input-completion.json', { body: JSON.stringify({ backend, repetition, samples,
      scope: 'Trusted wheel through actual App; actual display fence for a pose whose CPU draw started after that input. Camera may advance while its immutable submitted pose is pending. Historical sampler used submit-observed time instead; no matched latency improvement claim. Physical presentation unavailable.' }), contentType: 'application/json' });
    expect(samples).toHaveLength(120); expect(samples.every(sample => Number.isFinite(sample.inputToCompletionMs) && sample.inputToCompletionMs > 0)).toBe(true);
  });
}
