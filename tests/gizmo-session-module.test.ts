import { describe, expect, it } from 'vitest';
import { nativeModuleIdentity } from '../src/build/native';
import { BUILD_DESCRIPTOR } from '../src/generated/buildIdentity';

describe('native gizmo session capability identity', () => {
  it('requires proTransformSession2 while retaining numeric ABI, transport, receipt and checkpoint versions', () => {
    expect(BUILD_DESCRIPTOR.native.core.capabilities.proTransformSession).toBe(2);
    expect(BUILD_DESCRIPTOR.native.core.abi).toBe(24); expect(BUILD_DESCRIPTOR.protocolVersion).toBe(28);
    expect(BUILD_DESCRIPTOR.uiWorkerContract).toBe(23);
    expect(BUILD_DESCRIPTOR.native.core.capabilities.transactionReceipt).toBe(2);
    expect(BUILD_DESCRIPTOR.native.core.capabilities.recoveryCheckpoint).toBe(2);
    for (const version of [undefined, 0, 1, 3]) {
      const identity = structuredClone(BUILD_DESCRIPTOR.native.core);
      if (version === undefined) delete identity.capabilities.proTransformSession; else identity.capabilities.proTransformSession = version;
      expect(() => nativeModuleIdentity({ _sv_build_identity: () => 4, UTF8ToString: () => JSON.stringify(identity) }, BUILD_DESCRIPTOR.native.core))
        .toThrow(version === 0 ? 'invalid native capabilities.' : 'identity or required capabilities differ');
    }
  });
});
