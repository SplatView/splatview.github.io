import { describe, expect, it } from 'vitest';
import { pumpEdit, yieldWorkerTask } from '../src/workers/editPump';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function edit(requiredSteps: number) {
  let completed = 0, publications = 0;
  return {
    initial: { pending: requiredSteps !== 0, progress: 0 },
    step(work: number) {
      expect(work).toBe(4096);
      if (completed >= requiredSteps) throw new Error('The terminal edit was stepped again.');
      completed++;
      if (completed === requiredSteps) publications++;
      return { pending: completed < requiredSteps, progress: completed / requiredSteps };
    },
    get completed() { return completed; },
    get publications() { return publications; },
  };
}

describe('cooperative native edit pump', () => {
  it('batches work by elapsed time, reports once per batch and stops at the terminal publication', async () => {
    const native = edit(11), boundaries: number[] = [], progress: number[] = [];
    let clock = 0;
    const terminal = await pumpEdit(native.initial, {
      async yieldTask() { boundaries.push(native.completed); },
      now: () => clock,
      checkCancelled() {},
      step(work) { clock += 2.5; return native.step(work); },
      progress(value) { progress.push(value.progress); },
    });
    expect(boundaries).toEqual([0, 4, 8]);
    expect(progress).toEqual([4 / 11, 8 / 11, 1]);
    expect(terminal).toEqual({ pending: false, progress: 1 });
    expect(native.completed).toBe(11);
    expect(native.publications).toBe(1);
  });

  it('still yields finite batches with a frozen clock', async () => {
    const native = edit(513), boundaries: number[] = [], progress: number[] = [];
    await pumpEdit(native.initial, {
      async yieldTask() { boundaries.push(native.completed); },
      now: () => 0,
      checkCancelled() {},
      step: work => native.step(work),
      progress(value) { progress.push(value.progress); },
    });
    expect(boundaries).toEqual([0, 256, 512]);
    expect(progress).toEqual([256 / 513, 512 / 513, 1]);
    expect(native.completed).toBe(513);
    expect(native.publications).toBe(1);
  });

  it('does not yield, step or report an edit that is already terminal', async () => {
    const initial = { pending: false, progress: 1 };
    const unexpected = () => { throw new Error('Unexpected work after completion.'); };
    expect(await pumpEdit(initial, { yieldTask: unexpected, now: unexpected,
      checkCancelled: unexpected, step: unexpected, progress: unexpected })).toBe(initial);
  });

  it('honors cancellation before scheduling the first batch', async () => {
    const native = edit(1), aborted = new DOMException('Edit cancelled', 'AbortError');
    let yields = 0, reports = 0;
    await expect(pumpEdit(native.initial, {
      async yieldTask() { yields++; },
      checkCancelled() { throw aborted; },
      step: work => native.step(work),
      progress() { reports++; },
    })).rejects.toBe(aborted);
    expect([yields, native.completed, native.publications, reports]).toEqual([0, 0, 0, 0]);
  });

  it('honors a cancellation message delivered during the first yield before any native step', async () => {
    const native = edit(1), gate = deferred(), aborted = new DOMException('Edit cancelled', 'AbortError');
    let cancelled = false, reports = 0;
    const pending = pumpEdit(native.initial, {
      yieldTask: () => gate.promise,
      checkCancelled() { if (cancelled) throw aborted; },
      step: work => native.step(work),
      progress() { reports++; },
    });
    cancelled = true; gate.resolve();
    await expect(pending).rejects.toBe(aborted);
    expect([native.completed, native.publications, reports]).toEqual([0, 0, 0]);
  });

  it('lets an external cancellation stop the next batch before the final publication', async () => {
    const native = edit(3), gates = [deferred(), deferred()];
    const aborted = new DOMException('Edit cancelled', 'AbortError');
    let clock = 0, cancelled = false, yields = 0;
    const progress: number[] = [];
    const pending = pumpEdit(native.initial, {
      yieldTask() { return gates[yields++].promise; },
      now: () => clock,
      checkCancelled() { if (cancelled) throw aborted; },
      step(work) { clock += 4; return native.step(work); },
      progress(value) { progress.push(value.progress); },
    });
    expect(yields).toBe(1);
    gates[0].resolve(); await Promise.resolve();
    expect(yields).toBe(2);
    expect(native.completed).toBe(2);
    cancelled = true; gates[1].resolve();
    await expect(pending).rejects.toBe(aborted);
    expect(progress).toEqual([2 / 3]);
    expect(native.completed).toBe(2);
    expect(native.publications).toBe(0);
  });

  it('checks cancellation between native steps within a batch', async () => {
    const native = edit(2), aborted = new DOMException('Edit cancelled', 'AbortError');
    let cancelled = false, reports = 0;
    await expect(pumpEdit(native.initial, {
      async yieldTask() {}, now: () => 0,
      checkCancelled() { if (cancelled) throw aborted; },
      step(work) { const value = native.step(work); cancelled = true; return value; },
      progress() { reports++; },
    })).rejects.toBe(aborted);
    expect([native.completed, native.publications, reports]).toEqual([1, 0, 0]);
  });

  it('propagates native failure without a progress or extra step', async () => {
    const failure = new Error('Native edit failed.');
    let steps = 0, reports = 0, yields = 0;
    await expect(pumpEdit({ pending: true }, {
      async yieldTask() { yields++; }, now: () => 0, checkCancelled() {},
      step() { steps++; throw failure; }, progress() { reports++; },
    })).rejects.toBe(failure);
    expect([yields, steps, reports]).toEqual([1, 1, 0]);
  });

  it('uses a task boundary that runs after the current microtask queue', async () => {
    const order: string[] = [];
    const pending = yieldWorkerTask().then(() => { order.push('task'); });
    queueMicrotask(() => { order.push('microtask'); });
    await Promise.resolve();
    expect(order).toEqual(['microtask']);
    await pending;
    expect(order).toEqual(['microtask', 'task']);
  });
});
