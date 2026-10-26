import type { RendererNegotiationSnapshot } from '../webgpu/diagnostics';
import type { WebglCapabilities } from './capabilities';

/** Actual GL observations use GL names; no synthetic GPUDevice or adapter. */
export function glNegotiation(startedAtMs:number,caps:WebglCapabilities):RendererNegotiationSnapshot {
  const limits=Object.freeze({MAX_TEXTURE_SIZE:caps.maxTextureSize,MAX_RENDERBUFFER_SIZE:caps.maxRenderbufferSize,
    MAX_VIEWPORT_WIDTH:caps.maxViewport[0],MAX_VIEWPORT_HEIGHT:caps.maxViewport[1],MAX_DRAW_BUFFERS:caps.maxDrawBuffers,
    MAX_COLOR_ATTACHMENTS:caps.maxColorAttachments,MAX_VERTEX_TEXTURE_IMAGE_UNITS:caps.maxVertexTextureUnits,
    MAX_TEXTURE_IMAGE_UNITS:caps.maxFragmentTextureUnits,MAX_COMBINED_TEXTURE_IMAGE_UNITS:caps.maxCombinedTextureUnits});
  const features=Object.freeze(caps.enabledExtensions.slice());
  const observed={features,limits,featuresUnavailableReason:null,limitsUnavailableReason:null};
  const at=performance.now();
  return Object.freeze({schemaVersion:1,kind:'splatview-renderer-negotiation',status:'ready',stage:'ready',clock:'performance.now',
    startedAtMs,observedAtMs:at,clockUnavailableReason:null,
    stages:Object.freeze([{stage:'start',status:'initializing',atMs:startedAtMs},{stage:'ready',status:'ready',atMs:at}] as const),
    adapter:Object.freeze({...observed,info:Object.freeze({backend:'webgl2',vendor:caps.vendor,description:caps.unmaskedRenderer??caps.renderer,
      version:caps.version,shadingLanguageVersion:caps.shadingLanguageVersion}),infoUnavailableReason:caps.unmaskedRenderer?null:'Unmasked renderer identification is unavailable.'}),
    requested:Object.freeze({features:Object.freeze([]),limits:Object.freeze({})}),device:Object.freeze(observed),failure:null,
    gpuTimestamps:Object.freeze({available:false,reason:'GPU timestamp queries are not instrumented. Initialization uses performance.now.'})});
}
