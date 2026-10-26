uniform usampler2D sampleTexture;
uniform sampler2D axesTexture;
uniform sampler2D opacityTexture;
uniform usampler2D fifo0;
uniform usampler2D fifo1;
uniform usampler2D fifo2;
uniform usampler2D fifo3;
uvec4 historyEntry(ivec2 pixel,int index) {
  if(sampleFlags.y==0u) return uvec4(0u);
  ivec2 q=glPixel(pixel);
  if(index==0) return texelFetch(fifo0,q,0);
  if(index==1) return texelFetch(fifo1,q,0);
  if(index==2) return texelFetch(fifo2,q,0);
  return texelFetch(fifo3,q,0);
}
float alphaAt(ivec2 source,vec2 pixel) {
  ivec2 q=glPixel(source); uvec4 sampleData=texelFetch(sampleTexture,q,0);
  if(sampleData.x==0u) return 1.;
  vec2 center=(uintBitsToFloat(sampleData.zw)*vec2(.5,-.5)+.5)*temporal.xy;
  vec2 delta=(pixel-center)*vec2(1.,-1.); vec4 axes=texelFetch(axesTexture,q,0);
  vec2 local=3.*vec2(dot(delta,axes.xy)/dot(axes.xy,axes.xy),dot(delta,axes.zw)/dot(axes.zw,axes.zw));
  return steadyAlpha(texelFetch(opacityTexture,q,0).r,local);
}
vec4 adjacentAlpha(ivec2 source) {
  vec4 values;
  for(int n=0;n<4;n++) values[n]=alphaAt(source,vec2(source+neighbors[n])+.5);
  return values;
}
vec4 outwardRatios(ivec2 p) {
  uvec4 sampleData=texelFetch(sampleTexture,glPixel(p),0);
  float depth=sampleData.x==0u?3.402823e38:uintBitsToFloat(sampleData.y);
  vec4 ratio=adjacentAlpha(p)/max(alphaAt(p,vec2(p)+.5),1e-20);
  for(int k=0;k<4;k++) {
    uvec4 entry=historyEntry(p,k);
    if(entry.x!=0u && entry.x!=sampleData.x && uintBitsToFloat(entry.y)<depth)
      ratio*=vec4(unpackHalf2x16(entry.z),unpackHalf2x16(entry.w));
  }
  return ratio;
}
