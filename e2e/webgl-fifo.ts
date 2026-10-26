import uniforms from '../src/renderer/webgl2/steadyUniform.glsl?raw';
import density from '../src/renderer/webgl2/steadyDensity.glsl?raw';
import history from '../src/renderer/webgl2/steadyHistory.frag.glsl?raw';
import { createProgram,framebuffer,FULLSCREEN_VERTEX,texture2d } from '../src/renderer/webgl2/gl';

export async function gpuFifoPacking() {
  const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});if(!adapter) throw new Error('Missing WebGPU packing oracle.');
  const device=await adapter.requestDevice(),input=device.createBuffer({size:8,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST}),output=device.createBuffer({size:4,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC}),readback=device.createBuffer({size:4,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
  try {
    device.queue.writeBuffer(input,0,new Float32Array([.5,.5*Math.exp(-.5)]));
    const module=device.createShaderModule({code:'@group(0) @binding(0) var<storage,read> alpha:array<f32>; @group(0) @binding(1) var<storage,read_write> output:array<u32>; @compute @workgroup_size(1) fn main(){let ratio=(1.0-alpha[1])/max(1.0-alpha[0],1e-6); output[0]=pack2x16float(vec2(ratio));}'});
    const pipeline=device.createComputePipeline({layout:'auto',compute:{module,entryPoint:'main'}}),group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:input}},{binding:1,resource:{buffer:output}}]});
    const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(1);pass.end();encoder.copyBufferToBuffer(output,0,readback,0,4);device.queue.submit([encoder.finish()]);await readback.mapAsync(GPUMapMode.READ);
    const word=new Uint32Array(readback.getMappedRange())[0];readback.unmap();return word;
  } finally {await device.queue.onSubmittedWorkDone();input.destroy();output.destroy();readback.destroy();device.destroy();}
}

/** Script source samples directly, so FIFO qualification is independent of noise. */
export function scriptedFifo(gl:WebGL2RenderingContext) {
  const textures:WebGLTexture[]=[],targets:WebGLFramebuffer[]=[],programs:WebGLProgram[]=[];
  const texture=(format:number)=>{const value=texture2d(gl,2,2,format);textures.push(value);return value;};
  const target=(colors:WebGLTexture[])=>{const value=framebuffer(gl,colors);targets.push(value);return value;};
  const program=(body:string)=>{const value=createProgram(gl,FULLSCREEN_VERTEX,'#version 300 es\n'+uniforms+density+body);programs.push(value);return value;};
  const buffer=gl.createBuffer()!,vao=gl.createVertexArray()!;
  try {
    const sample=texture(gl.RGBA32UI),axes=texture(gl.RGBA32F),opacity=texture(gl.R32F),sets=[[0,1,2,3].map(()=>texture(gl.RGBA32UI)),[0,1,2,3].map(()=>texture(gl.RGBA32UI))];
    const historyTargets=sets.map(target),weights=texture(gl.RGBA32F),weightTarget=target([weights]),historyProgram=program(history),weightProgram=program('layout(location=0) out vec4 value; void main(){value=outwardRatios(canonicalPixel());}');
    gl.bindTexture(gl.TEXTURE_2D,axes);gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,2,2,gl.RGBA,gl.FLOAT,new Float32Array([3,0,0,3,3,0,0,3,3,0,0,3,3,0,0,3]));
    gl.bindTexture(gl.TEXTURE_2D,opacity);gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,2,2,gl.RED,gl.FLOAT,new Float32Array(4).fill(.5));
    gl.bindBuffer(gl.UNIFORM_BUFFER,buffer);gl.bufferData(gl.UNIFORM_BUFFER,240,gl.DYNAMIC_DRAW);gl.bindBufferBase(gl.UNIFORM_BUFFER,1,buffer);
    gl.bindVertexArray(vao);gl.viewport(0,0,2,2);gl.disable(gl.BLEND);gl.disable(gl.DEPTH_TEST);gl.disable(gl.SCISSOR_TEST);
    const params=new Float32Array(60),words=new Uint32Array(params.buffer);params.set([2,2,.7,0],52);
    const bits=(value:number)=>new Uint32Array(new Float32Array([value]).buffer)[0];
    const trace:{id:number;depth:number;entries:number[][]}[]=[];let write=0;
    for(const [index,[id,depth]] of [[0x1000001,1],[8,2],[8,.1],[0,0],[9,3],[10,4],[11,5]].entries()) {
      const data=new Uint32Array(16);for(let pixel=0;pixel<4;pixel++) data.set([id,bits(depth),bits(-.5),bits(.5)],pixel*4);
      gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,sample);gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,2,2,gl.RGBA_INTEGER,gl.UNSIGNED_INT,data);
      words[49]=Number(index>0);gl.bindBuffer(gl.UNIFORM_BUFFER,buffer);gl.bufferSubData(gl.UNIFORM_BUFFER,0,params);
      const bind=(p:WebGLProgram)=>{
        gl.useProgram(p);gl.uniformBlockBinding(p,gl.getUniformBlockIndex(p,'SteadyParameters'),1);
        [[sample,'sampleTexture'],[axes,'axesTexture'],[opacity,'opacityTexture'],...sets[1-write].map((t,i)=>[t,`fifo${i}`])].forEach(([t,name],i)=>{
          gl.activeTexture(gl.TEXTURE0+i);gl.bindTexture(gl.TEXTURE_2D,t as WebGLTexture);gl.uniform1i(gl.getUniformLocation(p,name as string),i);
        });
      };
      gl.bindFramebuffer(gl.FRAMEBUFFER,historyTargets[write]);bind(historyProgram);gl.drawArrays(gl.TRIANGLES,0,3);
      const entries:number[][]=[];
      for(let k=0;k<4;k++) {const entry=new Uint32Array(4);gl.readBuffer(gl.COLOR_ATTACHMENT0+k);gl.readPixels(0,1,1,1,gl.RGBA_INTEGER,gl.UNSIGNED_INT,entry);entries.push(Array.from(entry));}
      trace.push({id,depth,entries});
      if(index===6) {
        gl.bindFramebuffer(gl.FRAMEBUFFER,weightTarget);bind(weightProgram);gl.drawArrays(gl.TRIANGLES,0,3);
        const value=new Float32Array(4);gl.readBuffer(gl.COLOR_ATTACHMENT0);gl.readPixels(0,1,1,1,gl.RGBA,gl.FLOAT,value);
        const error=gl.getError();return {trace,weights:Array.from(value),error};
      }
      write=1-write;
    }
    throw new Error('Missing scripted sample.');
  } finally {
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.bindVertexArray(null);gl.useProgram(null);
    for(const value of targets) gl.deleteFramebuffer(value);for(const value of textures) gl.deleteTexture(value);for(const value of programs) gl.deleteProgram(value);gl.deleteBuffer(buffer);gl.deleteVertexArray(vao);
  }
}
