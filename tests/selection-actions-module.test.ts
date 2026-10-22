import { describe, expect, it } from 'vitest';
import { nativeModuleIdentity } from '../src/build/native';
import { BUILD_DESCRIPTOR } from '../src/generated/buildIdentity';

describe('additive native selection action metadata contracts', () => {
  it('requires filter2 and selectionActions2 without changing receipt, Range, pivot or transport versions', () => {
    expect(BUILD_DESCRIPTOR.native.core.capabilities.selectionFilter).toBe(2);
    expect(BUILD_DESCRIPTOR.native.core.capabilities.selectionActions).toBe(2);
    expect(BUILD_DESCRIPTOR.native.core.capabilities.colorFillRange).toBe(1);
    expect(BUILD_DESCRIPTOR.native.core.capabilities.transformPivot).toBe(2);
    expect(BUILD_DESCRIPTOR.native.core.capabilities.transactionReceipt).toBe(2);
    expect(BUILD_DESCRIPTOR.native.core.abi).toBe(24); expect(BUILD_DESCRIPTOR.protocolVersion).toBe(28);
    expect(BUILD_DESCRIPTOR.uiWorkerContract).toBe(23);
    for (const [name, version] of [['selectionFilter', undefined], ['selectionFilter', 1], ['selectionFilter', 3],
      ['selectionActions', undefined], ['selectionActions', 0], ['selectionActions', 1], ['selectionActions', 3]] as const) {
      const identity = structuredClone(BUILD_DESCRIPTOR.native.core);
      if (version === undefined) delete identity.capabilities[name]; else identity.capabilities[name] = version;
      const module = { _sv_build_identity: () => 4, UTF8ToString: () => JSON.stringify(identity) };
      expect(() => nativeModuleIdentity(module, BUILD_DESCRIPTOR.native.core)).toThrow(
        version === 0 ? 'invalid native capabilities.' : 'identity or required capabilities differ');
    }
  });
});
