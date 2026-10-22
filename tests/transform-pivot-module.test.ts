import { describe, expect, it } from 'vitest';
import { nativeModuleIdentity } from '../src/build/native';
import { BUILD_DESCRIPTOR } from '../src/generated/buildIdentity';

describe('additive transform pivot runtime identity', () => {
  it('requires transformPivot2 while preserving the existing C ABI and worker protocol', () => {
    expect(BUILD_DESCRIPTOR.protocolVersion).toBe(28); expect(BUILD_DESCRIPTOR.uiWorkerContract).toBe(23);
    expect(BUILD_DESCRIPTOR.native.core.abi).toBe(24); expect(BUILD_DESCRIPTOR.native.core.capabilities.transformPivot).toBe(2);
    const identity = structuredClone(BUILD_DESCRIPTOR.native.core);
    const module = { _sv_build_identity: () => 4, UTF8ToString: () => JSON.stringify(identity) };
    expect(nativeModuleIdentity(module, BUILD_DESCRIPTOR.native.core)).toEqual(identity);
    for (const version of [undefined, 1, 3]) {
      if (version === undefined) delete identity.capabilities.transformPivot; else identity.capabilities.transformPivot = version;
      expect(() => nativeModuleIdentity(module, BUILD_DESCRIPTOR.native.core)).toThrow('identity or required capabilities differ');
      expect(identity.abi).toBe(24);
    }
  });
});
