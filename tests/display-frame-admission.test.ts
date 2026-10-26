import { expect, it } from 'vitest';
import { DisplayFrameAdmission } from '../src/renderer/displayFrameAdmission';
import type { DisplayCompletion } from '../src/renderer/contracts';

function deferred(sequence: number) {
  let resolve!: () => void, reject!: (error: Error) => void;
  const done = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { checkpoint: { deviceEpoch: 1, submissionSequence: sequence, done } satisfies DisplayCompletion, resolve, reject };
}
const key = () => ({ owner: {}, scene: {}, width: 640, height: 400 });

it('admits two matching actual submissions and keeps the next one blocked until a real completion', async () => {
  const admission = new DisplayFrameAdmission(), identity = key(), first = deferred(1), second = deferred(2);
  expect(admission.canSubmit(identity)).toBe(true);
  expect(admission.track(identity, first.checkpoint)).toBe(true);
  expect(admission.canSubmit(identity)).toBe(true);
  expect(admission.track(identity, second.checkpoint)).toBe(true);
  expect(admission.inFlight).toBe(2); expect(admission.canSubmit(identity)).toBe(false);
  expect(() => admission.track(identity, deferred(3).checkpoint)).toThrow();
  first.resolve(); await first.checkpoint.done; expect(admission.inFlight).toBe(1);
  expect(admission.canSubmit(identity)).toBe(true);
  second.resolve(); await second.checkpoint.done; expect(admission.inFlight).toBe(0);
});
it('drains a changed scene, renderer or viewport instead of releasing old work early', async () => {
  const admission = new DisplayFrameAdmission(), identity = key(), first = deferred(1);
  admission.track(identity, first.checkpoint);
  for (const changed of [{ ...identity, owner: {} }, { ...identity, scene: {} }, { ...identity, width: 641 }, { ...identity, height: 401 }]) {
    expect(admission.canSubmit(changed)).toBe(false);
  }
  first.resolve(); await first.checkpoint.done;
  expect(admission.canSubmit(key())).toBe(true);
});
it('deduplicates cached checkpoints before and after completion', async () => {
  const admission = new DisplayFrameAdmission(), identity = key(), first = deferred(1);
  admission.track(identity, first.checkpoint);
  expect(admission.track(identity, first.checkpoint)).toBe(false);
  first.resolve(); await first.checkpoint.done;
  expect(admission.track(identity, first.checkpoint)).toBe(false); expect(admission.inFlight).toBe(0);
});
it('snapshots mutable host metadata and releases only after rejected completion settles', async () => {
  const admission = new DisplayFrameAdmission(), identity = key(), original = { ...identity }, first = deferred(1);
  admission.track(identity, first.checkpoint); identity.width = 1;
  expect(admission.canSubmit(original)).toBe(true); expect(admission.canSubmit(identity)).toBe(false);
  first.reject(new Error('device lost')); await first.checkpoint.done.catch(() => undefined);
  expect(admission.inFlight).toBe(0); expect(admission.canSubmit(key())).toBe(true);
});
it('allows conservative single-flight use and rejects invalid capacities/dimensions', async () => {
  const admission = new DisplayFrameAdmission(1), first = deferred(1), identity = key();
  admission.track(identity, first.checkpoint); expect(admission.canSubmit(identity)).toBe(false);
  first.resolve(); await first.checkpoint.done;
  expect(() => new DisplayFrameAdmission(3 as 2)).toThrow();
  expect(() => admission.canSubmit({ ...identity, width: 0 })).toThrow();
});
