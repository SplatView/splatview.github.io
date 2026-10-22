import { describe, expect, it } from 'vitest';
import { nativeModuleIdentity } from '../src/build/native';
import { BUILD_DESCRIPTOR } from '../src/generated/buildIdentity';

describe('additive Color/Fill Range runtime identity', () => {
  it('refuses older modules while preserving the ABI, transport, pivot and receipt contracts', () => {
    expect(BUILD_DESCRIPTOR.native.core.capabilities.colorFillRange).toBe(1);
    expect(BUILD_DESCRIPTOR.native.core.abi).toBe(24); expect(BUILD_DESCRIPTOR.protocolVersion).toBe(28);
    expect(BUILD_DESCRIPTOR.uiWorkerContract).toBe(23); expect(BUILD_DESCRIPTOR.native.core.capabilities.transformPivot).toBe(2);
    expect(BUILD_DESCRIPTOR.native.core.capabilities.transactionReceipt).toBe(2);
    const identity = structuredClone(BUILD_DESCRIPTOR.native.core);
    const module = { _sv_build_identity: () => 4, UTF8ToString: () => JSON.stringify(identity) };
    expect(nativeModuleIdentity(module, BUILD_DESCRIPTOR.native.core)).toEqual(identity);
    for (const version of [undefined, 0, 2]) {
      if (version === undefined) delete identity.capabilities.colorFillRange; else identity.capabilities.colorFillRange = version;
      expect(() => nativeModuleIdentity(module, BUILD_DESCRIPTOR.native.core)).toThrow(version === 0 ? 'invalid native capabilities' : 'identity or required capabilities differ');
    }
  });
});
