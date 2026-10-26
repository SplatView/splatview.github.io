import { cooperativeSort } from './cooperativeSort';
import { planSurfaceTiles } from '../webgpu/surfaceLayout';
import { SurfaceCapacityError,SURFACE_FLAGS,SURFACE_TILE_SIZE } from '../webgpu/surfaceQuery';
import { projectQuery,queryBounds,queryFragmentAlpha } from './queryProjection';
import { stableDepthOrder,type ComputeCheckpoint } from './radix';
import type { ComputeSurfaceResult,ComputeStage } from './computeProtocol';

export type QuerySource={count:number;stride:number;packed:Float32Array<ArrayBuffer>};
export type QueryInputs={frame:Float32Array;canonical:Uint8Array;transform:Uint8Array;opacity:Uint8Array};
const f=Math.fround;
export async function computePick(source:QuerySource,input:QueryInputs,x:number,y:number,radius:number,checkpoint:ComputeCheckpoint,stage?:ComputeStage) {
  const {count,stride,packed}=source,{frame}=input,width=frame[36],height=frame[37];
  const projected=await projectQuery(packed,count,stride/4,frame,input,width,height,1,false,undefined,checkpoint);
  stage?.('pick-projection');
  const candidates=new Uint32Array(count); let candidateCount=0;
  for(let id=0;id<count;id++) {
    if(queryFragmentAlpha(projected,id,x,y,width,height,false)) candidates[candidateCount++]=id;
    if((id&8191)===8191) await checkpoint();
  }
  stage?.('pick-candidates');
  const order=await stableDepthOrder(packed,count,stride/4,frame,input.transform,checkpoint,undefined,candidates.subarray(0,candidateCount),stage);
  let transmission=1,strongest=0,winner:number|null=null,depth=0,opacity=0;
  for(let reverse=order.length-1;reverse>=0;reverse--) {
    if((reverse&8191)===0) await checkpoint();
    const id=order[reverse],at=id*12,alpha=queryFragmentAlpha(projected,id,x,y,width,height,false); if(!alpha) continue;
    const weight=f(transmission*alpha),cx=f(f(f(projected[at]+1)*.5)*width),cy=f(f(f(1-projected[at+1])*.5)*height);
    const dx=f(x-cx),dy=f(y-cy),eligible=radius<=0 || f(f(dx*dx)+f(dy*dy))<=f(radius*radius);
    if(eligible && weight>strongest && weight>=(radius>0?f(1/255):0)) { strongest=weight; winner=id; }
    depth=f(depth+f(weight*projected[at+2])); opacity=f(opacity+weight); transmission=f(transmission*f(1-alpha));
    if(transmission<f(1e-5)) break;
  }
  stage?.('pick-composite');
  return {index:winner,depth:f(depth/Math.max(opacity,f(1e-20))),opacity,contribution:strongest};
}

/** Bounded, compact tiled execution. It does not request a global display sort. */
export async function computeSurface(source:QuerySource,input:QueryInputs,parameters:Uint32Array,maximum:number|undefined,
  admitCandidates:(bytes:number)=>Promise<void>,checkpoint:ComputeCheckpoint,stage?:ComputeStage):Promise<ComputeSurfaceResult> {
  const fullWidth=parameters[0],fullHeight=parameters[1],width=parameters[2],height=parameters[3],tilesX=parameters[4],tilesY=parameters[5];
  const flags=parameters[8],scale=new Float32Array(parameters.buffer,parameters.byteOffset,parameters.length)[10],colors=!!(flags&SURFACE_FLAGS.colors),visible=!!(flags&SURFACE_FLAGS.visible);
  const downsampled=width!==fullWidth || height!==fullHeight;
  const region=flags&SURFACE_FLAGS.region ? {x:parameters[6]&65535,y:parameters[6]>>>16,x1:parameters[11]&65535,y1:parameters[11]>>>16}:undefined;
  const radius=visible?new Float32Array(source.count):undefined;
  const projected=await projectQuery(source.packed,source.count,source.stride/4,input.frame,input,width,height,scale,colors,downsampled?undefined:radius,checkpoint);
  stage?.('map-projection');
  const full=visible && downsampled ? await projectQuery(source.packed,source.count,source.stride/4,input.frame,input,fullWidth,fullHeight,1,false,radius,checkpoint):projected;
  stage?.('map-full-frame-projection');
  const counts=new Uint32Array(tilesX*tilesY);
  const footprint=(id:number) => {
    const bounds=queryBounds(projected,id,width,height); if(!bounds) return;
    const x0=Math.max(bounds.x0,region?.x??0),y0=Math.max(bounds.y0,region?.y??0),x1=Math.min(bounds.x1,(region?.x1??width)-1),y1=Math.min(bounds.y1,(region?.y1??height)-1);
    if(x0>x1 || y0>y1) return;
    return {x0:Math.floor(x0/SURFACE_TILE_SIZE),y0:Math.floor(y0/SURFACE_TILE_SIZE),x1:Math.floor(x1/SURFACE_TILE_SIZE),y1:Math.floor(y1/SURFACE_TILE_SIZE)};
  };
  for(let id=0;id<source.count;id++) {
    const span=footprint(id); if(span) for(let y=span.y0;y<=span.y1;y++) for(let x=span.x0;x<=span.x1;x++) counts[y*tilesX+x]++;
    if((id&2047)===2047) await checkpoint();
  }
  stage?.('map-count-candidates');
  if(maximum!==undefined) { let required=0; for(const n of counts) required=Math.max(required,n); if(required>maximum) throw new SurfaceCapacityError(required,maximum); }
  const layout=planSurfaceTiles(counts,0xfffffffc,maximum);
  let largestDenseTile=0; for(const count of counts) if(count>2048) largestDenseTile=Math.max(largestDenseTile,count);
  const sortScratchBytes=largestDenseTile*4;
  stage?.('map-plan');
  await admitCandidates(layout.candidateBytes+sortScratchBytes); await checkpoint(); stage?.('map-admission');
  const sortScratch=new Uint32Array(largestDenseTile);
  const candidates=new Uint32Array(layout.candidateBytes/4); counts.fill(0);
  for(let id=0;id<source.count;id++) {
    const span=footprint(id); if(span) for(let y=span.y0;y<=span.y1;y++) for(let x=span.x0;x<=span.x1;x++) {
      const tile=y*tilesX+x; candidates[layout.spans[tile*2]+counts[tile]++]=id;
    }
    if((id&2047)===2047) await checkpoint();
  }
  stage?.('map-scatter-candidates');
  let comparisons=0;
  for(let tile=0;tile<counts.length;tile++) {
    const offset=layout.spans[tile*2],count=counts[tile];
    await cooperativeSort(candidates.subarray(offset,offset+count),sortScratch,(a,b)=>{comparisons++; return projected[a*12+2]-projected[b*12+2] || b-a;},checkpoint);
    if((tile&63)===63) await checkpoint();
  }
  stage?.('map-sort-tiles');
  const depths=new Float32Array(width*height),opacities=new Float32Array(width*height),rgb=colors?new Float32Array(width*height*3):undefined;
  for(let y=region?.y??0;y<(region?.y1??height);y++) {
    for(let x=region?.x??0;x<(region?.x1??width);x++) {
      const tile=Math.floor(y/SURFACE_TILE_SIZE)*tilesX+Math.floor(x/SURFACE_TILE_SIZE),offset=layout.spans[tile*2],count=counts[tile],pixel=y*width+x;
      let transmission=1,depth=0,opacity=0,red=0,green=0,blue=0;
      for(let i=0;i<count;i++) {
        const id=candidates[offset+i],at=id*12,alpha=queryFragmentAlpha(projected,id,x+.5,y+.5,width,height); if(!alpha) continue;
        const weight=f(transmission*alpha);
        depth=f(depth+f(weight*projected[at+2])); opacity=f(opacity+weight); transmission=f(transmission*f(1-alpha));
        if(colors) { red=f(red+f(weight*projected[at+8])); green=f(green+f(weight*projected[at+9])); blue=f(blue+f(weight*projected[at+10])); }
        // Every surviving fragment contributes; no pick-style transmission exit.
      }
      const normalized=f(depth/Math.max(opacity,f(1e-20)));
      depths[pixel]=opacity>=f(1/255) && Number.isFinite(normalized) && normalized>0?normalized:0;
      opacities[pixel]=Math.max(0,Math.min(1,opacity));
      if(rgb && opacity>=f(1/255)) rgb.set([red,green,blue].map(value=>Math.max(0,Math.min(1,f(value/Math.max(opacity,f(1e-20)))))),pixel*3);
    }
    if((y&7)===7) await checkpoint();
  }
  stage?.('map-composite');
  const visibleBits=visible?new Uint32Array(Math.ceil(source.count/32)):undefined;
  if(visibleBits) for(let id=0;id<source.count;id++) {
    if((id&255)===255) await checkpoint();
    const bounds=queryBounds(full,id,fullWidth,fullHeight); if(!bounds) continue;
    let found=false,steps=0;
    for(let y=bounds.y0;y<=bounds.y1 && !found;y++) for(let x=bounds.x0;x<=bounds.x1;x++) {
      if((++steps&8191)===0) await checkpoint();
      if(!queryFragmentAlpha(full,id,x+.5,y+.5,fullWidth,fullHeight)) continue;
      const mx=Math.min(width-1,Math.floor(f(f(x+.5)*width)/fullWidth)),my=Math.min(height-1,Math.floor(f(f(y+.5)*height)/fullHeight)),at=my*width+mx;
      if(opacities[at]<f(1/255) || full[id*12+2]<=f(f(depths[at]+radius![id])+f(full[id*12+2]*f(.005)))) { found=true; break; }
    }
    if(found) visibleBits[id>>>5]|=1<<(id&31);
  }
  stage?.('map-visibility');
  return {depths:depths.buffer,opacities:opacities.buffer,colors:rgb?.buffer,visible:visibleBits?.buffer,
    sortScratchBytes,candidateBytes:layout.candidateBytes,candidateEntries:layout.candidateEntries,tileCapacity:layout.tileCapacity,tileCount:layout.tileCount,occupiedTiles:layout.occupiedTiles,sortComparisons:comparisons};
}
