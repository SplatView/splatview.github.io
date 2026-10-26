import type { ComputeCheckpoint } from './radix';

const f=Math.fround,add=(a:number,b:number)=>f(a+b),mul=(a:number,b:number)=>f(a*b),div=(a:number,b:number)=>f(a/b);
const dot=(a:readonly number[],b:readonly number[])=>add(add(mul(a[0],b[0]),mul(a[1],b[1])),mul(a[2],b[2]));
export function halfFloat(word:number) {
  const sign=word&0x8000?-1:1,exponent=(word>>>10)&31,fraction=word&1023;
  return exponent===0?sign*fraction*2**-24:exponent===31?(fraction?NaN:sign*Infinity):sign*(1+fraction/1024)*2**(exponent-15);
}
export function queryOpacitySupport(a:number) {
  if(a>=f(.2141082512)) return 9;
  if(a>=f(.0289764008)) return a>=f(.0787660238)?a>=f(.1298632188)?8:7:a>=f(.0477740084)?6:5;
  if(a>=f(.0106598221)) return a>=f(.0175750755)?4:3;
  return a>=f(.0064655090)?2:1;
}
export function queryRawColor(words:Uint32Array,address:number,position:number[],frame:Float32Array) {
  const d=position.slice(0,3).map((value,i)=>f(value-frame[32+i])),length=Math.max(f(Math.sqrt(dot(d,d))),f(1e-20));
  const [x,y,z]=d.map(value=>div(value,length)),xx=mul(x,x),yy=mul(y,y),zz=mul(z,z);
  const b=[f(.2820947918),mul(f(-.4886025119),y),mul(f(.4886025119),z),mul(f(-.4886025119),x),
    mul(mul(f(1.0925484306),x),y),mul(mul(f(-1.0925484306),y),z),mul(f(.3153915653),f(f(mul(2,zz)-xx)-yy)),
    mul(mul(f(-1.0925484306),x),z),mul(f(.5462742153),f(xx-yy)),
    mul(mul(f(-.5900435899),y),f(mul(3,xx)-yy)),mul(mul(mul(f(2.8906114426),x),y),z),
    mul(mul(f(-.4570457995),y),f(f(mul(4,zz)-xx)-yy)),mul(mul(f(.3731763326),z),f(f(mul(2,zz)-mul(3,xx))-mul(3,yy))),
    mul(mul(f(-.4570457995),x),f(f(mul(4,zz)-xx)-yy)),mul(mul(f(1.4453057213),z),f(xx-yy)),mul(mul(f(-.5900435899),x),f(xx-mul(3,yy)))];
  const rgb=[.5,.5,.5],count=(frame[35]+1)**2;
  for(let j=0;j<count;j++) for(let channel=0;channel<3;channel++) {
    const i=j*3+channel,word=words[address+10+(i>>>1)],value=halfFloat((word>>>(i%2*16))&65535);
    rgb[channel]=add(rgb[channel],mul(b[j],value));
  }
  return rgb.map(value=>Math.max(0,value));
}

/** Same f32 operation order and 12-float record as the scalar query oracle.
 * Matrix/covariance scratch belongs to this job; no per-source vector arrays.
 */
const coordinate=(m:Float32Array,offset:number,row:number,x:number,y:number,z:number)=>
  add(add(add(mul(m[offset+row],x),mul(m[offset+row+4],y)),mul(m[offset+row+8],z)),m[offset+row+12]);
function covarianceDot(ax:number,ay:number,az:number,m:Float32Array,bx:number,by:number,bz:number) {
  const x=add(add(mul(m[0],bx),mul(m[3],by)),mul(m[6],bz));
  const y=add(add(mul(m[1],bx),mul(m[4],by)),mul(m[7],bz));
  const z=add(add(mul(m[2],bx),mul(m[5],by)),mul(m[8],bz));
  return add(add(mul(ax,x),mul(ay,y)),mul(az,z));
}
export async function projectQuery(packed:Float32Array,count:number,stride:number,frame:Float32Array,
  masks:{canonical:Uint8Array;transform:Uint8Array;opacity:Uint8Array},width:number,height:number,scale:number,
  colors:boolean,visibleRadius:Float32Array|undefined,checkpoint:ComputeCheckpoint) {
  const projected=new Float32Array(count*12),sourceWords=new Uint32Array(packed.buffer,packed.byteOffset,packed.length),flags=new Uint32Array(frame.buffer,frame.byteOffset,frame.length);
  const covariance=new Float32Array(9),left=new Float32Array(9);
  const rx=frame[0],ry=frame[4],rz=frame[8],ux=frame[1],uy=frame[5],uz=frame[9],zx=frame[2],zy=frame[6],zz=frame[10];
  const fx=div(mul(frame[38],width),frame[36]),fy=div(mul(frame[39],height),frame[37]);
  const lowPass=mul(mul(f(.3),scale),scale),floor=mul(mul(f(.01),scale),scale),limit=mul(1536,scale);
  for(let i=0;i<count;i++) {
    if((i&2047)===2047) await checkpoint();
    if(masks.canonical[i]&2) continue;
    const at=i*stride,transforming=!!flags[76] && (!flags[77] || !!(masks.transform[i]&1));
    let px=packed[at],py=packed[at+1],pz=packed[at+2],opacity=packed[at+3];
    if((flags[79]&1) && (!(flags[79]&2) || (masks.opacity[i]&1)))
      opacity=Math.max(0,Math.min(1,frame[59]<=1?mul(opacity,frame[59]):add(opacity,div(mul(f(1-opacity),f(frame[59]-1)),2))));
    if(transforming) { const x=px,y=py,z=pz; px=coordinate(frame,60,0,x,y,z); py=coordinate(frame,60,1,x,y,z); pz=coordinate(frame,60,2,x,y,z); }
    const vx=coordinate(frame,0,0,px,py,pz),vy=coordinate(frame,0,1,px,py,pz),vz=coordinate(frame,0,2,px,py,pz);
    if(vz>=f(-.001) || opacity<f(.0039)) continue;
    covariance[0]=packed[at+4]; covariance[1]=covariance[3]=packed[at+5]; covariance[2]=covariance[6]=packed[at+6];
    covariance[4]=packed[at+7]; covariance[5]=covariance[7]=packed[at+8]; covariance[8]=packed[at+9];
    if(transforming) {
      for(let col=0;col<3;col++) for(let row=0;row<3;row++) left[col*3+row]=add(add(mul(frame[60+row],covariance[col*3]),mul(frame[64+row],covariance[col*3+1])),mul(frame[68+row],covariance[col*3+2]));
      for(let col=0;col<3;col++) for(let row=0;row<3;row++) covariance[col*3+row]=add(add(mul(left[row],frame[60+col]),mul(left[row+3],frame[64+col])),mul(left[row+6],frame[68+col]));
    }
    if(visibleRadius) visibleRadius[i]=mul(3,f(Math.sqrt(Math.max(0,covarianceDot(zx,zy,zz,covariance,zx,zy,zz)))));
    const depth=f(-vz),fxd=div(fx,depth),fyd=div(fy,depth),xd=div(vx,depth),yd=div(vy,depth);
    const jxx=mul(fxd,add(rx,mul(xd,zx))),jxy=mul(fxd,add(ry,mul(xd,zy))),jxz=mul(fxd,add(rz,mul(xd,zz)));
    const jyx=mul(fyd,add(ux,mul(yd,zx))),jyy=mul(fyd,add(uy,mul(yd,zy))),jyz=mul(fyd,add(uz,mul(yd,zz)));
    const a=add(covarianceDot(jxx,jxy,jxz,covariance,jxx,jxy,jxz),lowPass),b=covarianceDot(jxx,jxy,jxz,covariance,jyx,jyy,jyz),c=add(covarianceDot(jyx,jyy,jyz,covariance,jyx,jyy,jyz),lowPass);
    const middle=mul(add(a,c),.5),difference=f(a-c),delta=f(Math.sqrt(Math.max(0,add(mul(mul(difference,difference),.25),mul(b,b)))));
    const l1=Math.max(floor,add(middle,delta)),l2=Math.max(floor,f(middle-delta));
    let ax=a>=c?1:0,ay=a>=c?0:1;
    if(Math.abs(b)>f(.00001)) { const y=f(l1-a),length=f(Math.sqrt(add(mul(b,b),mul(y,y)))); ax=div(b,length); ay=div(y,length); }
    const r1=Math.min(limit,mul(3,f(Math.sqrt(l1)))),r2=Math.min(limit,mul(3,f(Math.sqrt(l2))));
    const a0=mul(ax,r1),a1=mul(ay,r1),a2=mul(-ay,r2),a3=mul(ax,r2);
    const cx=coordinate(frame,16,0,vx,vy,vz),cy=coordinate(frame,16,1,vx,vy,vz),cz=coordinate(frame,16,2,vx,vy,vz),cw=coordinate(frame,16,3,vx,vy,vz);
    if(cz<0 || cz>cw) continue;
    if(Math.abs(cx)>add(cw,mul(div(mul(add(add(Math.abs(a0),Math.abs(a2)),1),2),width),cw)) ||
      Math.abs(cy)>add(cw,mul(div(mul(add(add(Math.abs(a1),Math.abs(a3)),1),2),height),cw))) continue;
    const out=i*12; projected[out]=div(cx,cw); projected[out+1]=div(cy,cw); projected[out+2]=depth; projected[out+3]=1;
    projected[out+4]=a0; projected[out+5]=a1; projected[out+6]=a2; projected[out+7]=a3; projected[out+11]=opacity;
    if(colors) projected.set(queryRawColor(sourceWords,at,[px,py,pz,1],frame),out+8);
  }
  return projected;
}
const topLeft=(x:number,y:number)=>y<0 || y===0 && x>0;
export function queryFragmentAlpha(g:Float32Array,id:number,x:number,y:number,width:number,height:number,quad=true) {
  const at=id*12; if(g[at+3]===0) return 0;
  const cx=mul(mul(add(g[at],1),.5),width),cy=mul(mul(f(1-g[at+1]),.5),height),dx=f(x-cx),dy=f(cy-y);
  const ax=g[at+4],ay=g[at+5],bx=g[at+6],by=g[at+7];
  const lx=mul(3,div(add(mul(dx,ax),mul(dy,ay)),add(mul(ax,ax),mul(ay,ay)))),ly=mul(3,div(add(mul(dx,bx),mul(dy,by)),add(mul(bx,bx),mul(by,by))));
  if(quad && (Math.abs(lx)>3 || Math.abs(ly)>3 || lx===-3 && !topLeft(bx,-by) || lx===3 && !topLeft(-bx,by) || ly===3 && !topLeft(ax,-ay) || ly===-3 && !topLeft(-ax,ay))) return 0;
  const r=add(mul(lx,lx),mul(ly,ly)),opacity=g[at+11]; if(r>Math.min(9,add(queryOpacitySupport(opacity),f(.001)))) return 0;
  const alpha=Math.min(f(.99),mul(opacity,f(Math.exp(mul(-.5,r))))); return alpha>=f(1/255)?alpha:0;
}

/** Conservative whole-quad bounds; exact alpha/quad acceptance remains above. */
export function queryBounds(g:Float32Array,id:number,width:number,height:number) {
  const at=id*12; if(!g[at+3]) return;
  const cx=(g[at]+1)*.5*width,cy=(1-g[at+1])*.5*height;
  const ex=Math.abs(g[at+4])+Math.abs(g[at+6]),ey=Math.abs(g[at+5])+Math.abs(g[at+7]);
  const padding=(Math.abs(cx)+Math.abs(cy)+ex+ey+1)*.000004+.001;
  const x0=Math.max(0,Math.floor(cx-ex-padding)),y0=Math.max(0,Math.floor(cy-ey-padding)),x1=Math.min(width-1,Math.floor(cx+ex+padding)),y1=Math.min(height-1,Math.floor(cy+ey+padding));
  if(x0>x1 || y0>y1) return; return {x0,y0,x1,y1};
}
