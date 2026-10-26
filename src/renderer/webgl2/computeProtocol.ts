export type ComputeCommand =
  | {action:'initialize';identity:import('./computeIdentity').ComputeIdentity}
  | {action:'create';scene:number;count:number;stride:number}
  | {action:'upload';scene:number;first:number;count:number;bytes:ArrayBuffer}
  | {action:'sort';scene:number;frame:ArrayBuffer;transformTargets:ArrayBuffer;precision?:import('../sortPrecision').SortPrecision}
  | {action:'pick';scene:number;frame:ArrayBuffer;canonical:ArrayBuffer;transform:ArrayBuffer;opacity:ArrayBuffer;x:number;y:number;radius:number}
  | {action:'surface';scene:number;frame:ArrayBuffer;canonical:ArrayBuffer;transform:ArrayBuffer;opacity:ArrayBuffer;parameters:ArrayBuffer;maximum?:number}
  | {action:'drop';scene:number}
  | {action:'sortScratch';count:number}
  | {action:'barrier'};
export type ComputeRequest = ComputeCommand & {id:number;profile?:boolean|'stages'};
export type ComputeSurfaceResult={depths:ArrayBuffer;opacities:ArrayBuffer;colors?:ArrayBuffer;visible?:ArrayBuffer;
  sortScratchBytes:number;candidateBytes:number;candidateEntries:number;tileCapacity:number;tileCount:number;occupiedTiles:number;sortComparisons:number};
export type ComputeStage=(name:string)=>void;
export type ComputeTiming={queueMs:number;computeMs:number;stages?:{name:string;wallMs:number}[]};
export type ComputeResponse = ({id:number;phase:'admit';bytes:number} |
  {id:number;ok:true;identity?:import('./computeIdentity').ComputeIdentity;order?:ArrayBuffer;pick?:{index:number|null;depth:number;opacity:number;contribution:number};surface?:ComputeSurfaceResult} |
  {id:number;ok:false;name:string;message:string;capacity?:{required:number;capacity:number}}) & {timing?:ComputeTiming;scratchBytes?:number};
