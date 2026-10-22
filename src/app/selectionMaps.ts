import { SelectionMapCache } from '../document/selectionMapCache';
import { AdmissionError, type ResourceLedger } from '../document/resources';
import { NEUTRAL_COLOR } from '../document/types';
import type { GaussianRenderer } from '../renderer/webgpu/renderer';
import { compositedSurface } from '../renderer/webgpu/surface';
import type { SurfaceChannels } from '../renderer/webgpu/surfaceQuery';
import { captureSelectionMapDependencies, type SelectionMapDependencyContext } from './selectionMapSnapshot';
export type SelectionMapDiagnosticEvent = {
  stage:'surface-create'|'native-adopt';status:'started'|'completed'|'failed';key:string;sourceCount:number;
  channels:{colors:boolean;visible:boolean};mapId?:number;attempts?:number;tileCapacity?:number;error?:string;elapsedMs?:number;
};

export type SelectionMapContext = SelectionMapDependencyContext & {
  ledger: ResourceLedger;
  grade?: number[];
  observe?: (event:SelectionMapDiagnosticEvent)=>void;
};

/** Browser query channels and the native map share one explicit cache owner. */
export class DocumentSelectionMaps {
  private cache = new SelectionMapCache();
  private resourceOwner?: { renderer: GaussianRenderer; ledger: ResourceLedger };
  diagnosticSnapshot(identity:(value:object)=>number){return this.cache.diagnosticSnapshot(identity);}

  request(context: SelectionMapContext, channels: SurfaceChannels = {}, signal?: AbortSignal) {
    const { client, scene, renderer, camera, ledger } = context;
    this.resourceOwner = { renderer, ledger };
    const admit = (bytes: number) => {
      try { return ledger.reserve('work', bytes); }
      catch (error) {
        if (!(error instanceof AdmissionError)) throw error;
        renderer.trimSurfaceResources(ledger);
        return ledger.reserve('work', bytes);
      }
    };
    const { key, assertCurrent: current, geometry, selectedOnly, geometrySelectedOnly, opacityScale, selectedOpacity } =
      captureSelectionMapDependencies(context);
    return this.cache.acquire({ key, sourceCount: scene.count, current,
      admit,
      create: options => {
        current(); renderer.render(scene, camera, context.grade ?? NEUTRAL_COLOR, false, [...geometry], selectedOnly,
          geometrySelectedOnly, opacityScale, selectedOpacity);
        if(context.observe){
          const event={stage:'surface-create' as const,key,sourceCount:scene.count,channels:{colors:!!options.colors,visible:!!options.visible}};
          return observeWork(context.observe,event,()=>compositedSurface(renderer,scene,{...options,reuseBuffers:true,poolOwner:ledger,admit}),
            map=>({attempts:map.attempts,tileCapacity:map.tileCapacity}));
        }
        return compositedSurface(renderer, scene, { ...options, reuseBuffers: true, poolOwner: ledger, admit });
      },
      adopt: (data, options) => {
        if(context.observe)return observeWork(context.observe,{stage:'native-adopt',key,sourceCount:scene.count,
          channels:{colors:!!data.colors,visible:!!data.visible}},()=>client.adoptSelectionMap(data,options),map=>({mapId:map.mapId}));
        return client.adoptSelectionMap(data, options);
      },
    }, channels, signal);
  }

  validate() { this.cache.validate(); }
  cancelPending() { return this.cache.cancelPending(); }
  async invalidate() {
    const owner = this.resourceOwner;
    await this.cache.invalidate();
    owner?.renderer.trimSurfaceResources(owner.ledger);
  }
}
function observeWork<T>(observe:(event:SelectionMapDiagnosticEvent)=>void,event:Omit<SelectionMapDiagnosticEvent,'status'>,
  run:()=>Promise<T>,completed:(value:T)=>Partial<SelectionMapDiagnosticEvent>):Promise<T>{
  const send=(value:SelectionMapDiagnosticEvent)=>{try{observe(value);}catch{/* Diagnostics cannot change surface ownership. */}};
  const startedAt = performance.now();
  send({...event,status:'started'});
  let work:Promise<T>;
  try{work=run();}catch(error){send({...event,status:'failed',error:(error instanceof Error?error.message:String(error)).slice(0,4096)});throw error;}
  return work.then(value=>{send({...event,...completed(value),status:'completed',elapsedMs:performance.now()-startedAt});return value;},error=>{
    send({...event,status:'failed',elapsedMs:performance.now()-startedAt,error:(error instanceof Error?error.message:String(error)).slice(0,4096)});throw error;
  });
}
