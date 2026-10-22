import type { NativeHeapSnapshot } from './nativeMemory';
import { AdmissionError } from './resources';

/** Observed C++ storage only. This diagnostic grants no admission coverage. */
export type NativeAllocationCensus = Readonly<{
  ok: true; version: 1; sequence: number; scope: 'scoped-cxx-v1';
  scenePayloadBytes: number; ownedRawBytes: number; overlapBytes: number;
  contextBytes: number; unionBytes: number; liveBlocks: number; liveContexts: number;
}>;

const fields = 'contextBytes,liveBlocks,liveContexts,ok,overlapBytes,ownedRawBytes,scenePayloadBytes,scope,sequence,unionBytes,version';
export function validateNativeAllocationCensus(value: unknown, heap: NativeHeapSnapshot,
  previous?: NativeAllocationCensus): NativeAllocationCensus {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Reflect.ownKeys(value).length !== 11 ||
      Object.keys(value).sort().join(',') !== fields)
    throw new AdmissionError('Invalid native allocation census.');
  // Copy each field once; callers retain no mutable authority over telemetry.
  const { ok, version, sequence, scope, scenePayloadBytes, ownedRawBytes, overlapBytes,
    contextBytes, unionBytes, liveBlocks, liveContexts } = value as NativeAllocationCensus;
  if (ok !== true || version !== 1 || scope !== 'scoped-cxx-v1')
    throw new AdmissionError('Unsupported native allocation census.');
  if (!Number.isSafeInteger(sequence) || sequence < 1 || previous && sequence <= previous.sequence)
    throw new AdmissionError('Invalid native allocation census sequence.');
  if (![scenePayloadBytes, ownedRawBytes, overlapBytes, contextBytes, unionBytes, liveBlocks, liveContexts]
    .every(number => Number.isSafeInteger(number) && number >= 0))
    throw new AdmissionError('Invalid native allocation census counters.');
  if (overlapBytes > scenePayloadBytes || overlapBytes > ownedRawBytes || contextBytes > ownedRawBytes ||
      scenePayloadBytes > Number.MAX_SAFE_INTEGER - (ownedRawBytes - overlapBytes) ||
      unionBytes !== scenePayloadBytes + (ownedRawBytes - overlapBytes) || unionBytes > heap.heapBytes)
    throw new AdmissionError('Invalid native allocation census union.');
  return Object.freeze({ ok, version, sequence, scope, scenePayloadBytes, ownedRawBytes, overlapBytes,
    contextBytes, unionBytes, liveBlocks, liveContexts });
}
