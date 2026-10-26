import { requireWebGpuRenderer } from './gaussian-harness-scene';
// Test-only observation of the actual App, native worker and WebGPU buffers.
import './geometry-viewer-harness';
import { useApp } from '../src/app/store';
import type { SelectionFilterKind, SelectionFilterParameters } from '../src/document/filterProtocol';
import { requireGaussianScene } from './gaussian-harness-scene';
import { admittedExport } from './admitted-export';

const controller = () => window.geometryViewer.controllerForSourceNavigation();
const positions = [[0, 0, 0], [.5, 0, 0], [0, .5, 0], [0, 0, -2]];
function fixture() {
  const names = ['x','y','z','f_dc_0','f_dc_1','f_dc_2','opacity','scale_0','scale_1','scale_2','rot_0','rot_1','rot_2','rot_3'];
  // PLY is RDF; the core converts Y/Z to the desktop's world frame on load.
  // Encode these independent world-space oracle positions in that source frame.
  const rows = positions.map((point, index) => [point[0], -point[1], -point[2], .5, .2, .1,
    Math.log([.2,.8,.8,.4][index] / (1 - [.2,.8,.8,.4][index])),
    ...[1, .7, .5].map(axis => Math.log([.1,.3,.6,1.2][index] * axis)), 1,0,0,0].join(' '));
  return new TextEncoder().encode(['ply','format ascii 1.0','element vertex 4',
    ...names.map(name => `property float ${name}`),'end_header',...rows,''].join('\n'));
}
function state() {
  const value = useApp.getState(), app = controller();
  return { busy: value.busy, error: value.error, filter: value.filter ? structuredClone(value.filter) : null,
    summary: value.summary, tool: value.tool, mode: value.mode, filterActive: app.filterActive,
    centerPicking: value.filterCenterPicking, centerPending: value.filterCenterPending,
    selectionRecovery: value.selectionRecovery, rendererState: value.rendererState,
    enabled: app.filterControlsEnabled, finishEnabled: app.filterFinishEnabled, previewPending: app.filterPreviewPending };
}
async function gpuBytes(buffer: GPUBuffer, size: number) {
  const renderer = requireWebGpuRenderer(controller().renderer), readback = renderer.device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  try {
    const encoder = renderer.device.createCommandEncoder(); encoder.copyBufferToBuffer(buffer,0,readback,0,size);
    renderer.device.queue.submit([encoder.finish()]); await readback.mapAsync(GPUMapMode.READ);
    const bytes=readback.getMappedRange().slice(0); readback.unmap(); return bytes;
  } finally { readback.destroy(); }
}
async function snapshot() {
  const app = controller(), scene = requireGaussianScene(app.scene), summary = await app.client!.command({command:'summary'});
  let nativeMasks: number[] = [];
  await app.client!.readMasks(bytes => { nativeMasks = Array.from(new Uint8Array(bytes)); });
  const gpu = await gpuBytes(scene.buffers.splats,scene.count * scene.stride), view = new DataView(gpu);
  return { ...state(), summary, nativeMasks, gpuMasks: Array.from(new Uint32Array(await gpuBytes(scene.buffers.states,scene.count * 4))),
    positions: positions.map((_point,index) => [0,4,8].map(offset => view.getFloat32(index * scene.stride + offset,true))),
    camera: app.camera!.state, cameraRevision: app.camera!.revision, sourceFingerprint: app.sourceFingerprint };
}
let held: { release():void; joined():Promise<boolean>; restore():void } | undefined;
function gate() { let enter!:()=>void, release!:()=>void; return { entered:new Promise<void>(resolve => {enter=resolve;}),
  held:new Promise<void>(resolve => {release=resolve;}),enter:()=>enter(),release:()=>release() }; }
async function holdPreview(phase:'native'|'gpu') {
  if(held) throw new Error('An observation gate already exists.');
  const app=controller(), client=app.client!, scene=requireGaussianScene(app.scene), wait=gate();
  const originalCommand=client.command, originalMasks=scene.stageMasks; let intercepted=false;
  if(phase==='native') client.command=async function(...args) {
    const result=await originalCommand.apply(this,args);
    if(args[0].command==='previewFilter'&&!intercepted) { intercepted=true;wait.enter();await wait.held; }
    return result;
  };
  else scene.stageMasks=async function(...args) {
    const result=await originalMasks.apply(this,args);
    if(!intercepted) { intercepted=true;wait.enter();await wait.held; }
    return result;
  };
  const operation=app.previewFilter();
  held={release:wait.release,joined:()=>operation,restore:()=> {client.command=originalCommand;scene.stageMasks=originalMasks;}};
  await wait.entered;
  return state();
}
const harness = {
  ready:()=>window.geometryViewer.ready(), state, snapshot,
  async load() { const app=controller(); await app.openFiles([new File([fixture()],'filter-literals.ply')]);
    if(useApp.getState().navigationPrompt) await app.discardAndContinue();
    if(useApp.getState().summary?.count!==4) throw new Error(useApp.getState().error??'Literal filter source not published.'); },
  select:(kind:SelectionFilterKind,initial=true)=>controller().selectFilter(kind,initial),
  patch:(patch:Partial<SelectionFilterParameters>)=>controller().setFilterParameters(patch),
  operation:(operation:number)=>controller().setFilterOperation(operation),
  preview:()=>controller().previewFilter(), confirm:()=>controller().confirmFilter(), cancel:()=>controller().cancelFilter(),
  command:(command:Parameters<ReturnType<typeof controller>['command']>[0])=>controller().command(command),
  view:()=>controller().camera!.filterView(),
  holdPreview,
  async finishGate(action:'cancel'|'confirm') { if(!held) throw new Error('No held observation.'); const captured=held;
    const requested=action==='cancel'?controller().cancelFilter():controller().confirmFilter();
    captured.release(); try { return {preview:await captured.joined(),finished:await requested,state:state()}; }
    finally {captured.restore();if(held===captured)held=undefined;} },
  async releaseGate() { if(!held) throw new Error('No held observation.'); const captured=held;captured.release();
    try {return await captured.joined();} finally {captured.restore();if(held===captured)held=undefined;} },
  async refuseMaskUpload() { const scene=requireGaussianScene(controller().scene),original=scene.stageMasks;
    scene.stageMasks=async()=>{throw new Error('Injected mask staging refusal');};
    try {return await controller().previewFilter();} finally {scene.stageMasks=original;} },
  async restrictions() { const app=controller(), client=app.client!, commands=['selectAll','selectNone','invert','delete','restore','undo','redo'] as const;
    const refused=[];for(const command of commands) refused.push(await app.command({command}));
    const nativeExports=[];for(let id=0;id<9;id++) {try {await admittedExport(client,id,0);nativeExports.push(false);}catch{nativeExports.push(true);}}
    let captureRefused=false;try{await app.capture('image/png');}catch{captureRefused=true;}
    let planRefused=false;try{await client.exportPlan();}catch{planRefused=true;}
    return {refused,nativeExports,captureRefused,planRefused}; },
};
declare global { interface Window {filterHarness:typeof harness} }
window.filterHarness=harness;
