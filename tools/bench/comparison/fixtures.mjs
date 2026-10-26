// A common activated SH0 scene. Each renderer converts these same values into
// its own representation; no renderer's culling or sorting is used to generate it.
export const SH_C0=0.28209479177387814;
export const variants=['splatview-webgpu-32','splatview-webgpu-24','splatview-webgl2-32','splatview-webgl2-24','playcanvas-webgpu','playcanvas-webgl2','colmapview-webgpu-16'];
export const fixtures=[
  {id:'256k-sparse',count:262144,visibleFraction:.25,scale:.025,width:640,height:400},
  {id:'256k-dense',count:262144,visibleFraction:1,scale:.05,width:640,height:400},
  {id:'1m-sparse',count:1_000_000,visibleFraction:.25,scale:.025,width:640,height:400},
  {id:'1m-dense',count:1_000_000,visibleFraction:1,scale:.05,width:640,height:400},
];
export function fixture(id){const result=fixtures.find(x=>x.id===id);if(!result)throw new Error('Unknown comparison fixture.');return result;}
export function generateScene(options){
  const {count,visibleFraction=1,scale=.12}=options,isProbe=!!options.probe;
  if(!Number.isSafeInteger(count)||count<1||count>1_000_000)throw new RangeError('Comparison count must be 1..1,000,000.');
  const positions=new Float32Array(count*3),scales=new Float32Array(count*3),colors=new Float32Array(count*3),opacity=new Float32Array(count);
  let seed=0x5f3759df;const random=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return(seed>>>0)/4294967296;};
  const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
  for(let i=0;i<count;i++){
    const xyz=isProbe?(i<3?[(i-1)*.8,i===1?.25:-.15,-4-i]:[100,0,-6]):[(random()-.5)*5.5,(random()-.5)*3.5,-5-random()*3];
    if(i/count>=visibleFraction)xyz[0]+=100;
    positions.set(xyz,i*3);scales.set([scale,scale*.8,scale*.65],i*3);opacity[i]=isProbe?(i<3?.9:0):.18;
    for(let c=0;c<3;c++){colors[i*3+c]=isProbe?(c===i?.85:.12):.15+.7*random();min[c]=Math.min(min[c],xyz[c]);max[c]=Math.max(max[c],xyz[c]);}
  }
  const center=min.map((x,c)=>(x+max[c])/2),size=Math.hypot(...max.map((x,c)=>x-min[c]))/2;
  return{count,positions,scales,colors,opacity,bounds:{min,max,center,size}};
}
export function cameraFrame(width,height,angle=0){
  const near=.1,far=100,fy=1.6,c=Math.cos(angle),s=Math.sin(angle),aspect=width/height;
  return{angle,view:new Float32Array([c,0,-s,0,0,1,0,0,s,0,c,0,0,0,0,1]),
    projection:new Float32Array([fy/aspect,0,0,0,0,fy,0,0,0,0,-far/(far-near),-1,0,0,-far*near/(far-near),0]),
    glProjection:new Float32Array([fy/aspect,0,0,0,0,fy,0,0,0,0,-(far+near)/(far-near),-1,0,0,-2*far*near/(far-near),0]),
    eye:new Float32Array(3),revision:0,near,far,background:'black'};
}
export const motionAngle=frame=>Math.sin(frame*.09)*.24;
export function imageError(actual,reference){
  if(actual.length!==reference.length||actual.length%4)throw new Error('Mismatched image dimensions.');
  let square=0,absolute=0,maximum=0,samples=0,foregroundSquare=0,foregroundSamples=0;
  for(let i=0;i<actual.length;i+=4){
    const foreground=Math.max(...actual.subarray(i,i+3),...reference.subarray(i,i+3))>8;
    for(let c=0;c<3;c++){const delta=Math.abs(actual[i+c]-reference[i+c])/255;square+=delta*delta;absolute+=delta;maximum=Math.max(maximum,delta);samples++;
      if(foreground){foregroundSquare+=delta*delta;foregroundSamples++;}}
  }
  return{psnrDb:square? -10*Math.log10(square/samples):999,meanAbsoluteRgb:absolute/samples,maxAbsoluteRgb:maximum,
    foregroundPsnrDb:foregroundSquare?-10*Math.log10(foregroundSquare/foregroundSamples):999,foregroundSamples};
}
