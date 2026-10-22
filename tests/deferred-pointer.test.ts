import { describe, expect, it } from 'vitest';
import {
  DEFERRED_POINTER_MAX_EVENTS, DEFERRED_POINTER_MAX_PRESSES,
  DEFERRED_POINTER_REPLAY_BATCH_SIZE, DeferredPointerQueue, type DeferredPointerKind,
} from '../src/input/deferredPointer';

interface Packet {
  readonly kind: DeferredPointerKind;
  readonly ordinal: number;
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
}

const packet = (kind: DeferredPointerKind, ordinal: number, pointerId = 7): Packet =>
  ({ kind, ordinal, pointerId, x: ordinal, y: -ordinal });
const drain = (queue: DeferredPointerQueue<Packet>): Packet[] => {
  const events: Packet[] = [];
  let event: Packet | undefined;
  while ((event = queue.shift()) !== undefined) events.push(event);
  return events;
};
const fillEvents = (queue: DeferredPointerQueue<Packet>, start = 0, count = DEFERRED_POINTER_MAX_EVENTS): void => {
  for (let ordinal = start; ordinal < start + count; ordinal++) {
    if (queue.append(packet('move', ordinal)) !== 'accepted') throw new Error(`Refused event ${ordinal}`);
  }
};

describe('deferred physical pointer FIFO', () => {
  it('replays every packet in arrival order across presses and companion mouse events', () => {
    const queue = new DeferredPointerQueue<Packet>();
    const events = [packet('down', 0), packet('mouse-down', 1), packet('move', 2), packet('up', 3),
      packet('down', 4, 9), packet('mouse-down', 5, 9), packet('double', 6, 9), packet('up', 7, 9)];
    for (const event of events) expect(queue.append(event)).toBe('accepted');
    expect(queue.peek()).toBe(events[0]);
    expect(queue.peek()).toBe(events[0]);
    expect(drain(queue)).toEqual(events);
    expect(queue.peek()).toBeUndefined();
    expect(queue.shift()).toBeUndefined();
    expect(queue.presses).toBe(0);
  });

  it('keeps repeated and identical movement samples without coalescing or mutation', () => {
    const queue = new DeferredPointerQueue<Packet>();
    const down = Object.freeze(packet('down', 0));
    const repeatedMove = Object.freeze(packet('move', 1));
    const up = Object.freeze(packet('up', 2));
    for (const event of [down, repeatedMove, repeatedMove, repeatedMove, up]) expect(queue.append(event)).toBe('accepted');
    const actual = drain(queue);
    expect(actual).toHaveLength(5);
    expect(actual[0]).toBe(down);
    for (const event of actual.slice(1, 4)) expect(event).toBe(repeatedMove);
    expect(actual[4]).toBe(up);
    expect(repeatedMove).toEqual({ kind: 'move', ordinal: 1, pointerId: 7, x: 1, y: -1 });
  });

  it('refuses the thirty-third buffered press without discarding earlier accepted presses or releases', () => {
    expect(DEFERRED_POINTER_MAX_PRESSES).toBe(32);
    const queue = new DeferredPointerQueue<Packet>();
    const accepted: Packet[] = [];
    for (let press = 0; press < 32; press++) {
      const events = [packet('down', press * 2), packet('up', press * 2 + 1)];
      for (const event of events) { expect(queue.append(event)).toBe('accepted'); accepted.push(event); }
    }
    expect(queue.append(packet('down', 64))).toBe('refused');
    const continuation = packet('move', 65);
    expect(queue.append(continuation)).toBe('accepted');
    expect(queue.presses).toBe(32);
    expect(drain(queue)).toEqual([...accepted, continuation]);
  });

  it('reopens one press slot only after its down record has been replayed', () => {
    const queue = new DeferredPointerQueue<Packet>();
    const prefix = [packet('move', 0), packet('up', 1), packet('mouse-down', 2), packet('double', 3)];
    const downs = Array.from({ length: 32 }, (_, index) => packet('down', index + 4));
    for (const event of [...prefix, ...downs]) expect(queue.append(event)).toBe('accepted');
    for (const event of prefix) {
      expect(queue.shift()).toBe(event);
      expect(queue.append(packet('down', 36))).toBe('refused');
    }
    expect(queue.shift()).toBe(downs[0]);
    const next = packet('down', 37);
    expect(queue.append(next)).toBe('accepted');
    expect(queue.append(packet('down', 38))).toBe('refused');
    expect(queue.presses).toBe(32);
    expect(drain(queue)).toEqual([...downs.slice(1), next]);
    expect(queue.append(packet('down', 39))).toBe('accepted');
  });

  it.each(['move', 'up', 'mouse-down', 'double'] as const)('accepts an admitted %s continuation after closing, without admitting a new press', kind => {
    const queue = new DeferredPointerQueue<Packet>();
    const down = packet('down', 0), continuation = packet(kind, 1);
    expect(queue.append(down)).toBe('accepted');
    queue.close(); queue.close();
    expect(queue.append(packet('down', 2))).toBe('refused');
    expect(queue.append(continuation)).toBe('accepted');
    expect(drain(queue)).toEqual([down, continuation]);
    expect(queue.closed).toBe(true);
    expect(queue.append(packet('down', 3))).toBe('refused');
  });

  it('keeps accepted continuations ordered across bounded replay batches after admission closes', () => {
    expect(DEFERRED_POINTER_REPLAY_BATCH_SIZE).toBe(512);
    const queue = new DeferredPointerQueue<Packet>();
    const events = [packet('down', 0), ...Array.from({ length: 1_100 }, (_, index) => packet('move', index + 1))];
    for (const event of events) expect(queue.append(event)).toBe('accepted');
    queue.close();
    const replayed: Packet[] = [], batchSizes: number[] = [];
    while (queue.length) {
      let batchSize = 0;
      while (batchSize < DEFERRED_POINTER_REPLAY_BATCH_SIZE && queue.length) {
        replayed.push(queue.shift()!); batchSize++;
      }
      batchSizes.push(batchSize);
      if (batchSizes.length === 1) {
        const release = packet('up', 1_101);
        expect(queue.append(release)).toBe('accepted'); events.push(release);
        expect(queue.append(packet('down', 1_102))).toBe('refused');
      }
    }
    expect(batchSizes).toEqual([512, 512, 78]);
    expect(replayed).toEqual(events);
    expect(queue.closed).toBe(true);
  });

  it('accepts exactly 65,536 uncoalesced raw events, including the final release', () => {
    expect(DEFERRED_POINTER_MAX_EVENTS).toBe(65_536);
    const queue = new DeferredPointerQueue<Packet>();
    const down = packet('down', 0), up = packet('up', 65_535);
    expect(queue.append(down)).toBe('accepted');
    fillEvents(queue, 1, 65_534);
    expect(queue.append(up)).toBe('accepted');
    expect(queue.length).toBe(65_536);
    expect(queue.peek()).toBe(down);
    const actual = drain(queue);
    expect(actual[0]).toBe(down);
    expect(actual.at(-1)).toBe(up);
    expect(actual.map(event => event.ordinal)).toEqual(Array.from({ length: 65_536 }, (_, ordinal) => ordinal));
  });

  it('retires all records on raw-event overflow and refuses every kind until explicitly cleared', () => {
    const queue = new DeferredPointerQueue<Packet>();
    expect(queue.append(packet('down', 0))).toBe('accepted');
    fillEvents(queue, 1, 65_535);
    expect(queue.append(packet('up', 65_536))).toBe('overflow');
    expect(queue.length).toBe(0);
    expect(queue.presses).toBe(0);
    expect(queue.closed).toBe(true);
    expect(queue.peek()).toBeUndefined();
    expect(queue.shift()).toBeUndefined();
    queue.close();
    for (const kind of ['down', 'move', 'up', 'mouse-down', 'double'] as const) {
      expect(queue.append(packet(kind, 65_537))).toBe('refused');
    }
    queue.clear();
    const next = [packet('down', 65_538), packet('up', 65_539)];
    for (const event of next) expect(queue.append(event)).toBe('accepted');
    expect(drain(queue)).toEqual(next);
    expect(queue.closed).toBe(false);
  });

  it('refuses a closed new down at raw capacity without retiring earlier accepted events', () => {
    const queue = new DeferredPointerQueue<Packet>();
    fillEvents(queue);
    const first = queue.peek();
    queue.close();
    expect(queue.append(packet('down', 65_536))).toBe('refused');
    expect(queue.length).toBe(65_536);
    expect(queue.shift()).toBe(first);
    const up = packet('up', 65_537);
    expect(queue.append(up)).toBe('accepted');
    const remaining = drain(queue);
    expect(remaining.map(event => event.ordinal)).toEqual([
      ...Array.from({ length: 65_535 }, (_, index) => index + 1), 65_537,
    ]);
    expect(remaining.at(-1)).toBe(up);
  });

  it('refuses a press-cap down at raw capacity while allowing a continuation to trigger explicit overflow', () => {
    const queue = new DeferredPointerQueue<Packet>();
    for (let ordinal = 0; ordinal < 32; ordinal++) expect(queue.append(packet('down', ordinal))).toBe('accepted');
    fillEvents(queue, 32, 65_504);
    const first = queue.peek();
    expect(queue.append(packet('down', 65_536))).toBe('refused');
    expect(queue.peek()).toBe(first);
    expect(queue.presses).toBe(32);
    expect(queue.length).toBe(65_536);
    expect(queue.append(packet('move', 65_537))).toBe('overflow');
    expect(queue.shift()).toBeUndefined();
    expect(queue.append(packet('up', 65_538))).toBe('refused');
  });

  it('reuses replayed slots at the event bound without reordering wrapped records', () => {
    const queue = new DeferredPointerQueue<Packet>();
    fillEvents(queue);
    const actual: Packet[] = [];
    for (let index = 0; index < 512; index++) actual.push(queue.shift()!);
    fillEvents(queue, 65_536, 512);
    expect(queue.length).toBe(65_536);
    expect(queue.peek()?.ordinal).toBe(512);
    const replayed = [...actual, ...drain(queue)];
    expect(replayed.map(event => event.ordinal)).toEqual(Array.from({ length: 66_048 }, (_, ordinal) => ordinal));
    const next = packet('down', 66_048);
    expect(queue.append(next)).toBe('accepted');
    expect(queue.shift()).toBe(next);
  });

  it('clears a partially replayed closed queue before accepting an unrelated press', () => {
    const queue = new DeferredPointerQueue<Packet>();
    const previous = [packet('down', 0), packet('move', 1), packet('up', 2), packet('down', 3, 8)];
    for (const event of previous) expect(queue.append(event)).toBe('accepted');
    expect(queue.shift()).toBe(previous[0]);
    queue.close(); queue.clear(); queue.clear();
    expect(queue.peek()).toBeUndefined();
    const next = [packet('down', 4, 9), packet('move', 5, 9), packet('up', 6, 9)];
    for (const event of next) expect(queue.append(event)).toBe('accepted');
    expect(queue.presses).toBe(1);
    expect(drain(queue)).toEqual(next);
  });
});
