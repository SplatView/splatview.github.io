export const DEFERRED_POINTER_MAX_PRESSES = 32;
export const DEFERRED_POINTER_MAX_EVENTS = 65_536;
export const DEFERRED_POINTER_REPLAY_BATCH_SIZE = 512;

export type DeferredPointerKind = 'down' | 'move' | 'up' | 'mouse-down' | 'double';
export type DeferredPointerAppendResult = 'accepted' | 'refused' | 'overflow';

/**
 * Bounded physical input waiting for scene work to finish. The caller owns
 * pointer capture, packet snapshots, liveness and replay scheduling.
 *
 * Only `down` begins a physical press; mouse-down/double are companion records.
 * Closing preserves accepted presses and their continuations. Overflow retires
 * the entire queue, including further continuations, until an explicit clear.
 */
export class DeferredPointerQueue<T extends { readonly kind: DeferredPointerKind }> {
  private records: (T | undefined)[] = [];
  private head = 0;
  private count = 0;
  private pressCount = 0;
  private admissionClosed = false;
  private retired = false;

  get length(): number { return this.count; }
  get presses(): number { return this.pressCount; }
  get closed(): boolean { return this.admissionClosed; }

  append(event: T): DeferredPointerAppendResult {
    if (this.retired || event.kind === 'down' &&
      (this.admissionClosed || this.pressCount >= DEFERRED_POINTER_MAX_PRESSES)) return 'refused';
    if (this.count === DEFERRED_POINTER_MAX_EVENTS) {
      this.records = []; this.head = 0; this.count = 0; this.pressCount = 0;
      this.admissionClosed = true; this.retired = true;
      return 'overflow';
    }
    this.records[(this.head + this.count) % DEFERRED_POINTER_MAX_EVENTS] = event;
    this.count++;
    if (event.kind === 'down') this.pressCount++;
    return 'accepted';
  }

  peek(): T | undefined { return this.count ? this.records[this.head] : undefined; }

  shift(): T | undefined {
    if (!this.count) return undefined;
    const event = this.records[this.head]!;
    this.records[this.head] = undefined;
    this.head = (this.head + 1) % DEFERRED_POINTER_MAX_EVENTS;
    this.count--;
    if (event.kind === 'down') this.pressCount--;
    if (!this.count) { this.records = []; this.head = 0; }
    return event;
  }

  close(): void { this.admissionClosed = true; }

  clear(): void {
    this.records = []; this.head = 0; this.count = 0; this.pressCount = 0;
    this.admissionClosed = false; this.retired = false;
  }
}
