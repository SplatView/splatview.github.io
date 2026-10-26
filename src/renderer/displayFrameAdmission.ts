import type { DisplayCompletion } from './contracts';

export type DisplayFrameIdentity = Readonly<{ owner: object; scene: object | undefined; width: number; height: number }>;
type Flight = DisplayFrameIdentity & { epoch: number; sequence: number };

/** Host admission metadata only: no submission, scheduling, cancellation or
 * retirement authority. Real backend completion releases each occupied slot. */
export class DisplayFrameAdmission {
  private readonly flights = new Set<Flight>();
  private readonly latest = new WeakMap<object, { epoch: number; sequence: number }>();
  constructor(readonly capacity: 1 | 2 = 2) {
    if (capacity !== 1 && capacity !== 2) throw new RangeError('Display capacity must be one or two.');
  }
  get inFlight() { return this.flights.size; }
  canSubmit(identity: DisplayFrameIdentity): boolean {
    if (![identity.width, identity.height].every(value => Number.isSafeInteger(value) && value > 0)) throw new RangeError('Invalid display dimensions.');
    return this.flights.size < this.capacity && [...this.flights].every(value =>
      value.owner === identity.owner && value.scene === identity.scene && value.width === identity.width && value.height === identity.height);
  }
  track(identity: DisplayFrameIdentity, checkpoint: DisplayCompletion): boolean {
    const previous = this.latest.get(identity.owner);
    if (previous?.epoch === checkpoint.deviceEpoch && previous.sequence >= checkpoint.submissionSequence) return false;
    if (!this.canSubmit(identity)) throw new Error('Display admission is full or belongs to an earlier view.');
    const flight = { ...identity, epoch: checkpoint.deviceEpoch, sequence: checkpoint.submissionSequence };
    this.latest.set(identity.owner, { epoch: flight.epoch, sequence: flight.sequence }); this.flights.add(flight);
    void checkpoint.done.then(() => { this.flights.delete(flight); }, () => { this.flights.delete(flight); });
    return true;
  }
}
