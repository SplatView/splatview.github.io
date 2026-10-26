import type { BuildDescriptor } from '../../build/contracts';
import { assertBuildDescriptor } from '../../build/verification';

/** Application deployments keep their full descriptor; standalone builds have
 * their own source digest. Neither executor accepts the other host's identity. */
export type ComputeIdentity =
  | { kind: 'application'; build: BuildDescriptor }
  | { kind: 'standalone'; protocolVersion: 1; sourceId: string };

export function assertComputeIdentity(actual: unknown, expected: ComputeIdentity): void {
  if (!actual || typeof actual !== 'object') throw new Error('Invalid render executor identity.');
  const value = actual as Record<string, unknown>;
  if (value.kind !== expected.kind) throw new Error('The render executor belongs to a different host.');
  if (expected.kind === 'application') {
    if (Object.keys(value).some(key => key !== 'kind' && key !== 'build')) throw new Error('Invalid render executor identity.');
    assertBuildDescriptor(value.build, expected.build);
  } else if (Object.keys(value).some(key => !['kind', 'protocolVersion', 'sourceId'].includes(key)) ||
      value.protocolVersion !== expected.protocolVersion || !/^[a-f0-9]{64}$/.test(String(value.sourceId)) || value.sourceId !== expected.sourceId) {
    throw new Error('The render executor does not match this standalone module.');
  }
}
