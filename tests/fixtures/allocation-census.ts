// Independent transport fixture. Fake workers do not own actual C++ storage.
export function emptyCensus(sequence: number) {
  return { ok: true as const, version: 1 as const, sequence, scope: 'scoped-cxx-v1' as const,
    scenePayloadBytes: 0, ownedRawBytes: 0, overlapBytes: 0, contextBytes: 0,
    unionBytes: 0, liveBlocks: 0, liveContexts: 0 };
}
