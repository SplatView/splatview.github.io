// Test-only pass clocks. Resolve once, after the actual submitted work has
// finished, so encoders from an engine can be interleaved without resolving
// timestamps that have not executed yet. No guessed presentation timestamps.
export function installGpuClock(device){
  if(!device.features.has('timestamp-query'))return{setFrame(){},async finish(){return{available:false,reason:'timestamp-query unavailable'};},dispose(){}};
  const capacity=4096,blocks=[],records=[];
  const allocate=()=>{if(blocks.length>=4)throw new Error('Comparison timestamp capacity exceeded.');const block={slot:0,
    query:device.createQuerySet({type:'timestamp',count:capacity}),
    resolved:device.createBuffer({size:capacity*8,usage:GPUBufferUsage.QUERY_RESOLVE|GPUBufferUsage.COPY_SRC}),
    mapped:device.createBuffer({size:capacity*8,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ})};blocks.push(block);return block;};
  allocate();const original=device.createCommandEncoder.bind(device);let frame=null;
  device.createCommandEncoder=descriptor=>{
    const encoder=original(descriptor),compute=encoder.beginComputePass.bind(encoder),render=encoder.beginRenderPass.bind(encoder);
    const timestamps=label=>{
      if(!frame)return undefined;let block=blocks.at(-1);if(block.slot+2>capacity)block=allocate();
      const result={querySet:block.query,beginningOfPassWriteIndex:block.slot,endOfPassWriteIndex:block.slot+1};records.push({...frame,label,slot:block.slot,block:blocks.length-1});block.slot+=2;return result;
    };
    encoder.beginComputePass=d=>compute({...d,timestampWrites:timestamps(String(d?.label??'compute'))});
    encoder.beginRenderPass=d=>render({...d,timestampWrites:timestamps(String(d.label??'raster'))});return encoder;
  };
  return{setFrame(value){frame=value;},async finish(){
    frame=null;await device.queue.onSubmittedWorkDone();const samples=[];
    for(const [index,block] of blocks.entries()){
      if(!block.slot)continue;const encoder=original();encoder.resolveQuerySet(block.query,0,block.slot,block.resolved,0);encoder.copyBufferToBuffer(block.resolved,0,block.mapped,0,block.slot*8);device.queue.submit([encoder.finish()]);
      await block.mapped.mapAsync(GPUMapMode.READ);const values=new DataView(block.mapped.getMappedRange());
      samples.push(...records.filter(r=>r.block===index).map(r=>({...r,ms:Number(values.getBigUint64((r.slot+1)*8,true)-values.getBigUint64(r.slot*8,true))/1e6})));block.mapped.unmap();
    }
    return{available:true,samples,scope:'GPU pass timestamps; sum of recorded passes, excludes CPU sorting, queue idle, readback and presentation.'};
  },dispose(){device.createCommandEncoder=original;for(const b of blocks){b.query.destroy();b.resolved.destroy();b.mapped.destroy();}}};
}
