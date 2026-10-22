import type { BuildArtifact, BuildDescriptor, NativeIdentity, RuntimeManifest } from './contracts';
import type { NativeHeapSnapshot } from '../document/nativeMemory';
import type { NativeAllocationCensus } from '../document/allocationCensus';

export type RuntimeVerificationMode = 'production-verified' | 'development-module-graph';
export interface NativeSource {
  assetBase: string;
  glue: ArrayBuffer;
  wasm: ArrayBuffer;
  glueArtifact?: BuildArtifact;
  wasmArtifact?: BuildArtifact;
}
export interface WorkerInitialize {
  type: 'initialize';
  initializationId: string;
  build: BuildDescriptor;
  mode: RuntimeVerificationMode;
  assetBase: string;
  source?: NativeSource;
  manifest?: RuntimeManifest;
  manifestUrl?: string;
  entryUrl?: string;
}
export type WorkerBootstrapResponse =
  | { type: 'ready'; initializationId: string; build: BuildDescriptor; core: NativeIdentity;
      mode: RuntimeVerificationMode; heap: NativeHeapSnapshot; census: NativeAllocationCensus; allocation: null }
  | ({ type: 'initialization-failed'; initializationId: string; error: string; allocation: null } & (
      | { heap: NativeHeapSnapshot; census: NativeAllocationCensus; moduleInitializationId: string }
      | { heap: null; census: null; moduleInitializationId: null }));
