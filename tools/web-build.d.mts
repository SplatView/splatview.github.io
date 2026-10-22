import type { Plugin } from 'vite';
import type { OutputBundle, PreRenderedChunk } from 'rolldown';
import type { BuildDescriptor, RuntimeManifest } from '../src/build/contracts';

export interface InputRecord { path: string; bytes: number; sha256: string }
export interface BuildSnapshot {
  root: string;
  files: InputRecord[];
  descriptor: BuildDescriptor;
  generated: InputRecord;
  nativeFiles: InputRecord[];
}
export const SINGLETON_ROLES: readonly string[];
export function canonicalJson(value: unknown): string;
export function sha256(bytes: string | Uint8Array): string;
export function collectApplicationInputs(root?: string): InputRecord[];
export function descriptorFromInputs(files: InputRecord[], contract: unknown, provenance: unknown): BuildDescriptor;
export function prepareBuild(root?: string): BuildSnapshot;
export function assertBuildInputsUnchanged(snapshot: BuildSnapshot): void;
export function assertArtifactPath(path: string): void;
export function createDeploymentManifest(build: BuildDescriptor, records: InputRecord[], entryPath: string, workerPath: string): RuntimeManifest;
export function protectHtml(html: string, records: InputRecord[], entryPath: string): string;
export function copyQualifiedPublic(snapshot: BuildSnapshot, outDir: string): void;
export function writeDeploymentManifest(snapshot: BuildSnapshot, outDir: string, entryPath: string, workerPath: string, emittedPaths: readonly string[], serviceWorkerPath?: string): RuntimeManifest;
export function workerEntryFileName(chunk: Pick<PreRenderedChunk, 'facadeModuleId'>): string;
export function workerClosurePlugin(): Plugin;
export function assertApplicationClosure(bundle: OutputBundle): string;
export function emittedBundlePaths(bundle: OutputBundle): string[];
export function webBuildIdentityPlugin(): Plugin;
