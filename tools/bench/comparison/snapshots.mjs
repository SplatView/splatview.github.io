export function toBase64(bytes){let s='';for(let i=0;i<bytes.length;i+=8192)s+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(s);}
export async function snapshot(canvas,device,format){
  const width=canvas.width,height=canvas.height,pixels=new Uint8Array(width*height*4);
  if(device){
    const stride=Math.ceil(width*4/256)*256,buffer=device.createBuffer({size:stride*height,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
    try{const encoder=device.createCommandEncoder();encoder.copyTextureToBuffer({texture:canvas.getContext('webgpu').getCurrentTexture()},{buffer,bytesPerRow:stride},[width,height]);device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);const source=new Uint8Array(buffer.getMappedRange());
      for(let y=0;y<height;y++)pixels.set(source.subarray(y*stride,y*stride+width*4),y*width*4);buffer.unmap();
      if(format.startsWith('bgra'))for(let i=0;i<pixels.length;i+=4)[pixels[i],pixels[i+2]]=[pixels[i+2],pixels[i]];
    }finally{buffer.destroy();}
  }else{
    const gl=canvas.getContext('webgl2'),source=new Uint8Array(pixels.length);gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.readPixels(0,0,width,height,gl.RGBA,gl.UNSIGNED_BYTE,source);
    for(let y=0;y<height;y++)pixels.set(source.subarray(y*width*4,(y+1)*width*4),(height-y-1)*width*4);
    if(gl.getError()!==gl.NO_ERROR)throw new Error('Comparison GL readback failed.');
  }
  const output=new OffscreenCanvas(width,height);output.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(pixels),width,height),0,0);
  const blob=await output.convertToBlob({type:'image/png'});return{width,height,rgba:toBase64(pixels),png:toBase64(new Uint8Array(await blob.arrayBuffer()))};
}
