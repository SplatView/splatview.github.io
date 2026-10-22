import { colorFields } from '../generated/desktop';

export type AutoColorMethod = 'enhance' | 'exposure' | 'contrast' | 'white_balance';
export type ColorBaseIdentity = Readonly<{ sessionId: number; baseId: number; epochId: number }>;
export type ColorSessionSummary = ColorBaseIdentity & Readonly<{
  version: 1; active: true; selectedOnly: boolean;
  values: readonly number[]; applied: readonly number[]; pending: boolean;
}>;
export function validateColorBaseIdentity(value: unknown): ColorBaseIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Object.keys(value).sort().join(',') !== 'baseId,epochId,sessionId')
    throw new Error('Invalid color-base stream identity.');
  const identity = value as ColorBaseIdentity;
  if ([identity.sessionId, identity.baseId, identity.epochId].some(id => !Number.isSafeInteger(id) || id < 1))
    throw new Error('Invalid color-base stream identity.');
  return Object.freeze({ sessionId: identity.sessionId, baseId: identity.baseId, epochId: identity.epochId });
}
export function colorValues(value: unknown): number[] {
  if (!Array.isArray(value) || value.length !== colorFields.length) throw new Error('Invalid color values.');
  const dense = Array.from(value);
  if (dense.some((v, i) =>
    typeof v !== 'number' || !Number.isFinite(v) || v < colorFields[i].low || v > colorFields[i].high))
    throw new Error('Invalid color values.');
  return dense;
}
export function validateColorSession(value: unknown): ColorSessionSummary | null {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'active,applied,baseId,epochId,pending,selectedOnly,sessionId,values,version')
    throw new Error('Invalid native color session.');
  const session = value as ColorSessionSummary;
  if (session.version !== 1 || session.active !== true || typeof session.selectedOnly !== 'boolean' ||
      typeof session.pending !== 'boolean' || [session.sessionId, session.baseId, session.epochId]
        .some(id => !Number.isSafeInteger(id) || id < 1)) throw new Error('Invalid native color identity.');
  return Object.freeze({ ...session, values: Object.freeze(colorValues(session.values)),
    applied: Object.freeze(colorValues(session.applied)) });
}
export function sameColorBase(a: ColorBaseIdentity, b: ColorBaseIdentity): boolean {
  return a.sessionId === b.sessionId && a.baseId === b.baseId && a.epochId === b.epochId;
}
