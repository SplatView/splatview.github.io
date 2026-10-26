layout(location=0) out uvec4 next0;
layout(location=1) out uvec4 next1;
layout(location=2) out uvec4 next2;
layout(location=3) out uvec4 next3;
void main() {
  ivec2 p=canonicalPixel(); uvec4 sampleData=texelFetch(sampleTexture,glPixel(p),0);
  uvec4 entries[4]; bool duplicate=false;
  for(int k=0;k<4;k++) { entries[k]=historyEntry(p,k); duplicate=duplicate || (entries[k].x==sampleData.x && sampleData.x!=0u); }
  if(sampleData.x!=0u && !duplicate) {
    float alpha=alphaAt(p,vec2(p)+.5); vec4 occlusion=(1.-adjacentAlpha(p))/max(1.-alpha,1e-6);
    for(int k=3;k>0;k--) entries[k]=entries[k-1];
    entries[0]=uvec4(sampleData.xy,packHalf2x16(occlusion.xy),packHalf2x16(occlusion.zw));
  }
  next0=entries[0]; next1=entries[1]; next2=entries[2]; next3=entries[3];
}
