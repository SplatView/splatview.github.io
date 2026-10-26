import frameSource from './frame.wgsl?raw';
import visibleSource from './visibleOrder.wgsl?raw';
import { planFastOrder } from './fastOrderLayout';
import type { GaussianRenderer, GpuScene } from './renderer';

const entries=['countVisible','publishVisible','scatterVisible'] as const;
type Pipelines=Record<typeof entries[number],GPUComputePipeline>;
type Stage={pipeline:GPUComputePipeline;group:GPUBindGroup;x:number};
const preparations=new WeakMap<GaussianRenderer,Promise<Pipelines>>();
async function prepare(renderer:GaussianRenderer):Promise<Pipelines> {
  let pending=preparations.get(renderer);
  if(!pending) {
    pending=renderer.checkedAllocation(()=>{
      const module=renderer.device.createShaderModule({label:'Stable visible draw order',code:frameSource+visibleSource});
      const task=Promise.all(entries.map(async entryPoint=>[entryPoint,await renderer.device.createComputePipelineAsync({
        label:`Visible order ${entryPoint}`,layout:'auto',compute:{module,entryPoint},
      })] as const));
      void task.catch(()=>undefined);return{task};
    },async value=>{await value.task.catch(()=>undefined);}).then(async value=>Object.fromEntries(await value.task) as Pipelines);
    preparations.set(renderer,pending);
  }
  try {const result=await pending;renderer.requireScene();return result;}
  catch(error){if(preparations.get(renderer)===pending)preparations.delete(renderer);throw error;}
}

/** Compacts an already sorted order. The renderer submits; the scene retires
 * buffers and credit. Private output cannot overwrite complete query pairs. */
export class FastOrder {
  private disposed=false;
  private readonly stages:Stage[];
  readonly indirect:GPUBuffer;
  readonly drawGroup:GPUBindGroup;
  constructor(renderer:GaussianRenderer,readonly allocationBytes:number,private readonly buffers:GPUBuffer[],
    private readonly release:()=>void,scene:GpuScene,pipelines:Pipelines,layout:ReturnType<typeof planFastOrder>) {
    const device=renderer.device;
    const extra=Object.fromEntries(Object.entries(layout.sizes).map(([name,size])=>{
      const usage=GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC|(name==='indirect'?GPUBufferUsage.INDIRECT:0);
      const buffer=device.createBuffer({label:`Fast depth ${name}`,size,usage});buffers.push(buffer);return[name,buffer];
    })) as Record<keyof typeof layout.sizes,GPUBuffer>;
    this.indirect=extra.indirect;
    const stage=(pipeline:GPUComputePipeline,bindings:[number,GPUBuffer][],x:number):Stage=>({pipeline,group:renderer.bind(pipeline,bindings),x});
    const b=scene.buffers,p=renderer.pipelines;
    this.stages=[
      stage(pipelines.countVisible,[[0,renderer.frame],[1,b.projected],[2,b.ranks],[3,extra.visibleCounts],[10,scene.ordered]],layout.groups),
      stage(p.local,[[0,scene.params[0]],[1,extra.visibleCounts],[2,extra.visibleOffsets],[3,extra.visibleSums]],layout.blocks),
      stage(p.blocks,[[0,scene.params[0]],[1,extra.visibleSums],[2,extra.visibleBlocks],[3,extra.visibleTotal]],1),
      stage(pipelines.publishVisible,[[5,extra.indirect],[9,extra.visibleTotal]],1),
      stage(pipelines.scatterVisible,[[0,renderer.frame],[2,b.ranks],[4,extra.compactA],[7,extra.visibleOffsets],[8,extra.visibleBlocks],[10,scene.ordered]],layout.groups),
    ];
    this.drawGroup=renderer.bind(renderer.raster,[[0,renderer.frame],[4,extra.compactA],[7,b.projected]]);
  }
  encode(encoder:GPUCommandEncoder) {
    if(this.disposed)throw new Error('The compact draw order was retired.');
    const pass=encoder.beginComputePass({label:'Compact visible draw order'});
    for(const stage of this.stages){pass.setPipeline(stage.pipeline);pass.setBindGroup(0,stage.group);pass.dispatchWorkgroups(stage.x);}
    pass.end();
  }
  dispose(){if(this.disposed)return;this.disposed=true;for(const buffer of this.buffers)buffer.destroy();this.release();}
}
export async function allocateFastOrder(renderer:GaussianRenderer,scene:GpuScene):Promise<FastOrder|undefined> {
  const limits=renderer.device.limits;
  if(scene.count<262144||!renderer.admitSortScratch||!(limits.maxComputeWorkgroupStorageSize>=1024))return;
  const layout=planFastOrder(scene.count);
  if(Object.values(layout.sizes).some(size=>size>limits.maxBufferSize||size>limits.maxStorageBufferBindingSize))return;
  let credit:(()=>void)|undefined,released=false;const buffers:GPUBuffer[]=[];
  let candidate:FastOrder|undefined;
  const release=()=>{if(!released){released=true;credit?.();}};
  try {
    credit=renderer.admitSortScratch(layout.bytes);const pipelines=await prepare(renderer);renderer.requireScene(scene);
    const result=await renderer.checkedAllocation(()=>candidate=new FastOrder(renderer,layout.bufferBytes,buffers,release,scene,pipelines,layout),value=>value.dispose());
    renderer.requireScene(scene);return result;
  }catch{
    if(candidate)candidate.dispose();else for(const buffer of buffers)buffer.destroy();release();return;
  }
}
