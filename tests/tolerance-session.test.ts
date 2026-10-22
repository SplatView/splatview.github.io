import { describe, expect, it } from 'vitest';
import { ToleranceSession } from '../src/input/toleranceSession';

function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise<void>(resolve => queueMicrotask(resolve));

describe('completed-pick tolerance scheduling', () => {
  it('waits for the completed pick, serializes amendments and retains only the latest waiting value', async () => {
    const ready = gate<boolean>(), first = gate<boolean>();
    const calls: number[] = [];
    const session = new ToleranceSession(ready.promise, async value => {
      calls.push(value); return calls.length === 1 ? first.promise : true;
    }, async () => {});
    session.update(.1); session.update(.2);
    await tick(); expect(calls).toEqual([]);
    ready.resolve(true); await tick(); await tick();
    expect(calls).toEqual([.2]);
    session.update(.3); session.update(.4);
    await tick(); expect(calls).toEqual([.2]);
    first.resolve(true); await session.flush();
    expect(calls).toEqual([.2, .4]);
  });

  it('ends after the in-flight amendment and releases once without applying a queued value', async () => {
    const first = gate<boolean>(), calls: string[] = [];
    const session = new ToleranceSession(Promise.resolve(true), async value => {
      calls.push(`apply ${value}`); return first.promise;
    }, async () => { calls.push('release'); });
    session.update(.1); await tick(); await tick(); session.update(.9);
    const ended = session.end(); expect(session.end()).toBe(ended);
    await tick(); expect(calls).toEqual(['apply 0.1']);
    first.resolve(true); await ended;
    session.update(.5); await tick();
    expect(calls).toEqual(['apply 0.1', 'release']);
  });

  it('permits a new tolerance after an allocation refusal and does not release a replaced checkpoint', async () => {
    const calls: number[] = []; let released = false;
    const session = new ToleranceSession(Promise.resolve(true), async value => {
      calls.push(value); return value !== .8;
    }, async () => { released = true; });
    session.update(.8); await session.flush(); session.update(.3); await session.flush();
    session.retire(); session.update(.7); await session.flush();
    expect(calls).toEqual([.8, .3]); expect(released).toBe(false);
  });

  it('drops adjustments if the initial pick was refused and still retires its owner', async () => {
    const ready = gate<boolean>(); let applied = false, released = false;
    const session = new ToleranceSession(ready.promise, async () => { applied = true; return true; },
      async () => { released = true; });
    session.update(.2); const ended = session.end(); ready.resolve(false); await ended;
    expect(applied).toBe(false); expect(released).toBe(true);
  });

  it('coalesces absolute tolerance and connected mode together while preserving the in-flight pair', async () => {
    type Pair = { tolerance: number; connected: boolean };
    const first = gate<boolean>(), calls: Pair[] = [];
    const session = new ToleranceSession<Pair>(Promise.resolve(true), async value => {
      calls.push(value); return calls.length === 1 ? first.promise : true;
    }, async () => {});
    session.update({ tolerance: .1, connected: true }); await tick(); await tick();
    session.update({ tolerance: .2, connected: false });
    session.update({ tolerance: .3, connected: true });
    expect(calls).toEqual([{ tolerance: .1, connected: true }]);
    first.resolve(false); await session.flush();
    expect(calls).toEqual([{ tolerance: .1, connected: true }, { tolerance: .3, connected: true }]);
    session.update({ tolerance: .3, connected: false }); await session.flush();
    expect(calls.at(-1)).toEqual({ tolerance: .3, connected: false });
  });

  it('discards queued mode changes on query cancellation without retiring the completed owner', async () => {
    const first = gate<boolean>(), calls: boolean[] = []; let released = false;
    const session = new ToleranceSession<boolean>(Promise.resolve(true), async value => {
      calls.push(value); return calls.length === 1 ? first.promise : true;
    }, async () => { released = true; });
    session.update(true); await tick(); await tick(); session.update(false);
    session.discardPending(); first.resolve(false); await session.flush();
    expect(calls).toEqual([true]); expect(released).toBe(false);
    session.update(false); await session.flush();
    expect(calls).toEqual([true, false]); expect(released).toBe(false);
  });
});
