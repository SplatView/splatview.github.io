import type { NativeIdentity } from '../build/contracts';
import { canonicalJson } from '../build/verification';
import type { RecoveryCheckpointBinding, RecoveryCheckpointPlan, RecoveryCheckpointRange } from './recoveryCheckpoint';
import { validateRecoveryCheckpointBinding, validateRecoveryCheckpointPlan } from './recoveryCheckpoint';
import { sameOperationOwner, validateOperationOwner } from './operationProtocol';
import { validateMapEnvelope } from './selectionMap';
import { sameRevision, type Envelope, type NativeSummary } from './types';

export const RECOVERY_CONTROL_TIMEOUT_MS = 60_000;
export type RecoveryStart =
  | { type: 'recovery-export'; recoveryId: string; binding: RecoveryCheckpointBinding }
  | { type: 'recovery-restore'; recoveryId: string; binding: RecoveryCheckpointBinding; plan: RecoveryCheckpointPlan; budgetBytes: number };
export type RecoveryControl =
  | { type: 'recovery-proceed'; recoveryId: string }
  | { type: 'recovery-release'; recoveryId: string }
  | ({ type: 'recovery-ack'; recoveryId: string } & RecoveryCheckpointRange)
  | ({ type: 'recovery-range'; recoveryId: string; bytes: ArrayBuffer } & RecoveryCheckpointRange);
export type RecoveryIntermediate =
  | { type: 'recovery-plan'; recoveryId: string; plan: RecoveryCheckpointPlan; summary: NativeSummary }
  | ({ type: 'recovery-chunk'; recoveryId: string; bytes: ArrayBuffer } & RecoveryCheckpointRange)
  | { type: 'recovery-exported'; recoveryId: string }
  | ({ type: 'recovery-range-request'; recoveryId: string } & RecoveryCheckpointRange)
  | ({ type: 'recovery-range-consumed'; recoveryId: string } & RecoveryCheckpointRange);
export type RecoveryTerminal = { type: 'recovery-result'; recoveryId: string; action: 'export' | 'restore'; summary: NativeSummary };
export type RecoveryPhase = 'proceed' | 'ack' | 'range' | 'release';

const bufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const bufferResizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;
function fields(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype)
    throw new Error('Invalid recovery message object.');
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' || !required.includes(key) && !optional.includes(key)) ||
      required.some(key => !keys.includes(key))) throw new Error('Invalid recovery message fields.');
  const result: Record<string, unknown> = {};
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error('Invalid recovery message fields.');
    result[key] = descriptor.value;
  }
  return result;
}
export function validateRecoveryId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value))
    throw new Error('Invalid recovery identity.');
  return value;
}
export function recoveryRange(plan: RecoveryCheckpointPlan, index: number): RecoveryCheckpointRange | null {
  if (!Number.isSafeInteger(index) || index < 0 || Object.is(index, -0)) throw new Error('Invalid recovery chunk index.');
  const offset = index * plan.maximumChunkBytes;
  if (!Number.isSafeInteger(offset)) throw new Error('Invalid recovery chunk offset.');
  return offset >= plan.byteLength ? null : Object.freeze({ index, offset,
    length: Math.min(plan.maximumChunkBytes, plan.byteLength - offset) });
}
export function validateRecoveryRange(value: unknown, expected: RecoveryCheckpointRange | null): RecoveryCheckpointRange {
  const data = fields(value, ['index', 'offset', 'length']);
  if (!expected || ['index', 'offset', 'length'].some(key => typeof data[key] !== 'number' ||
      !Number.isSafeInteger(data[key]) || Object.is(data[key], -0) || data[key] !== expected[key as keyof RecoveryCheckpointRange]))
    throw new Error('Invalid recovery chunk range.');
  return expected;
}
export function validateRecoveryBuffer(value: unknown, length: number): ArrayBuffer {
  try {
    if (bufferLength.call(value) !== length || bufferResizable?.call(value)) throw new Error();
    new Uint8Array(value as ArrayBuffer); // The intrinsic also rejects detached empty buffers.
  } catch { throw new Error('Recovery requires a fixed, attached ArrayBuffer of the granted length.'); }
  return value as ArrayBuffer;
}
export function validateRecoveryStart(value: Envelope & RecoveryStart, core: NativeIdentity): Envelope & RecoveryStart {
  const required = ['protocolVersion', 'buildId', 'requestId', 'base', 'type', 'recoveryId', 'binding'];
  const type = value && Object.getOwnPropertyDescriptor(value, 'type');
  const data = fields(value, [...required, ...(type && 'value' in type && type.value === 'recovery-restore' ? ['plan', 'budgetBytes'] : [])], ['assetBase', 'operationOwner']);
  validateMapEnvelope(value); validateRecoveryId(data.recoveryId);
  if (data.type !== 'recovery-export' && data.type !== 'recovery-restore') throw new Error('Invalid recovery request type.');
  const binding = validateRecoveryCheckpointBinding(data.binding);
  if (canonicalJson(binding.core) !== canonicalJson(core) || !sameRevision(binding.revision, value.base))
    throw new Error('The recovery checkpoint belongs to another native core or public revision.');
  if (value.operationOwner) {
    const owner = validateOperationOwner(value.operationOwner);
    if (owner.documentId !== value.base.documentId || owner.sourceGeneration !== value.base.sourceGeneration)
      throw new Error('The recovery operation belongs to another source.');
  }
  if (data.type === 'recovery-restore') {
    validateRecoveryCheckpointPlan(data.plan);
    if (typeof data.budgetBytes !== 'number' || !Number.isSafeInteger(data.budgetBytes) ||
        data.budgetBytes < 1 || data.budgetBytes > 0xffff_ffff)
      throw new Error('Invalid recovery native budget.');
  }
  return value;
}
/** Authentication is deliberately separate from phase validation. Foreign or
 * stale controls never acquire the authority to cancel the current pump. */
export function authenticRecoveryControl(value: Envelope & { recoveryId?: unknown }, request: Envelope & RecoveryStart): boolean {
  try {
    validateMapEnvelope(value, request);
    if (value.recoveryId !== request.recoveryId) return false;
    return request.operationOwner ? !!value.operationOwner &&
      sameOperationOwner(validateOperationOwner(value.operationOwner), request.operationOwner) : value.operationOwner === undefined;
  } catch { return false; }
}
export function validateRecoveryControl(value: Envelope & RecoveryControl, request: Envelope & RecoveryStart,
  phase: RecoveryPhase, expected: RecoveryCheckpointRange | null = null): RecoveryControl {
  if (!authenticRecoveryControl(value, request)) throw new Error('The recovery control belongs to another owner.');
  const extras = value.type === 'recovery-ack' ? ['index', 'offset', 'length'] :
    value.type === 'recovery-range' ? ['index', 'offset', 'length', 'bytes'] : [];
  fields(value, ['protocolVersion', 'buildId', 'requestId', 'base', 'type', 'recoveryId', ...extras], ['assetBase', 'operationOwner']);
  if (value.type !== `recovery-${phase}`) throw new Error('Invalid recovery transfer phase.');
  if (value.type === 'recovery-ack' || value.type === 'recovery-range') {
    validateRecoveryRange({ index: value.index, offset: value.offset, length: value.length }, expected);
    if (value.type === 'recovery-range') validateRecoveryBuffer(value.bytes, expected!.length);
  }
  return value;
}
export function isRecoveryControlType(type: unknown): type is RecoveryControl['type'] {
  return typeof type === 'string' && ['recovery-proceed', 'recovery-ack', 'recovery-range', 'recovery-release'].includes(type);
}
export function isRecoveryIntermediateType(type: unknown): type is RecoveryIntermediate['type'] {
  return typeof type === 'string' && ['recovery-plan', 'recovery-chunk', 'recovery-exported', 'recovery-range-request', 'recovery-range-consumed'].includes(type);
}
