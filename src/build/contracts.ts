/** Shared bootstrap data. Native document envelopes start only after this gate. */
export interface NativeIdentity {
  schemaVersion: 1;
  kind: 'core' | 'camera';
  abi: number;
  variant: 'scalar';
  nativeInputId: string;
  mapLayoutVersion?: number;
  capabilities: Record<string, number>;
}

export interface BuildDescriptor {
  schemaVersion: 1;
  appInputId: string;
  protocolVersion: number;
  uiWorkerContract: number;
  native: { core: NativeIdentity; camera: NativeIdentity };
}

export type ArtifactRole = 'html' | 'application-entry' | 'document-worker' |
  'core-glue' | 'core-wasm' | 'camera-glue' | 'camera-wasm' |
  'build-provenance' | 'stylesheet' | 'runtime-asset';

export interface BuildArtifact {
  role: ArtifactRole;
  path: string;
  bytes: number;
  sha256: string;
}

export interface RuntimeManifest {
  schemaVersion: 1;
  deploymentId: string;
  build: BuildDescriptor;
  artifacts: BuildArtifact[];
}

export const SINGLETON_ROLES: readonly ArtifactRole[] = [
  'html', 'application-entry', 'document-worker', 'core-glue', 'core-wasm',
  'camera-glue', 'camera-wasm', 'build-provenance',
];
