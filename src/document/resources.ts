export const MiB = 1024 * 1024;
export class AdmissionError extends Error {}
export type Category = 'source' | 'decoded' | 'work' | 'history' | 'render' | 'image' | 'recovery';
export type ResourceLease = (() => void) & { readonly bytes: number; resize(bytes: number): void };

/** Opaque identity only. The mutable reservation and its liveness stay private.
 * This draft addition lets a materialization barrier inspect multiple credits
 * without invoking a caller's lease.bytes getter between inspections. */
declare const resourceCreditBrand: unique symbol;
export type ResourceCredit = Readonly<{ readonly [resourceCreditBrand]: true }>;
type CreditState = { live: boolean; readonly bytes: number };
const leaseCredits = new WeakMap<ResourceLease, ResourceCredit>();
const creditStates = new WeakMap<ResourceCredit, CreditState>();

export function resourceLeaseCredit(lease: ResourceLease): ResourceCredit {
  const credit = leaseCredits.get(lease);
  if (!credit) throw new AdmissionError('The memory lease has no authenticated credit binding.');
  return credit;
}

/** Explicitly bind a cleanup/resize wrapper to the genuine reservation it owns.
 * Possession of a genuine lease (or an already bound wrapper) is required. This
 * invokes no wrapper hooks/getters and never moves or duplicates the credit.
 * Owners must reject duplicate credit identities even through distinct wrappers.
 */
export function bindResourceLeaseCredit(wrapper: ResourceLease, underlying: ResourceLease): ResourceLease {
  if (typeof wrapper !== 'function') throw new AdmissionError('Invalid memory lease wrapper.');
  const credit = resourceLeaseCredit(underlying), state = creditStates.get(credit)!;
  if (!state.live) throw new AdmissionError('Cannot bind a retired memory reservation.');
  const existing = leaseCredits.get(wrapper);
  if (existing && existing !== credit) throw new AdmissionError('The memory lease already owns another credit.');
  leaseCredits.set(wrapper, credit);
  return wrapper;
}

/** Trusted, hook-free observation. Released zero-byte credit is distinct from a
 * live zero-byte reservation; neither wrapper properties nor callbacks run. */
export function resourceCreditBytes(credit: ResourceCredit): number | undefined {
  const state = creditStates.get(credit);
  if (!state) throw new AdmissionError('Invalid authenticated memory credit.');
  return state.live ? state.bytes : undefined;
}

export function assertResourceCredit(credit: ResourceCredit, expectedBytes: number): void {
  checkedBytes(expectedBytes, 1);
  if (resourceCreditBytes(credit) !== expectedBytes)
    throw new AdmissionError('The authenticated memory credit changed or retired.');
}

export function checkedBytes(count: number, stride: number): number {
  if (!Number.isSafeInteger(count) || !Number.isSafeInteger(stride) || count < 0 || stride < 0 ||
    !Number.isSafeInteger(count * stride)) throw new AdmissionError('The requested allocation is too large.');
  return count * stride;
}
/** Browser-owned checkpoint bytes are external to the measured native heap.
 * Reserve both generations during replacement. Metadata includes the owner's
 * bounded immutable JSON/table estimate, not native serialization workspace.
 */
export function estimateRecoveryCheckpointBytes(byteLength: number, maximumChunkBytes: number,
  metadataBytes: number): Readonly<{ retainedBytes: number; workBytes: number; totalBytes: number }> {
  checkedBytes(byteLength, 1); checkedBytes(metadataBytes, 1);
  if (byteLength < 1 || !Number.isSafeInteger(maximumChunkBytes) || maximumChunkBytes < 1 || maximumChunkBytes > MiB)
    throw new AdmissionError('Invalid recovery checkpoint size.');
  const chunkBytes = Math.min(byteLength, maximumChunkBytes);
  const chunks = Math.ceil(byteLength / maximumChunkBytes);
  const retainedBytes = checkedBytes(byteLength + metadataBytes + checkedBytes(chunks, 256) + 16 * 1024, 1);
  // One admitted incoming/transfer copy, one Web Crypto input copy, and bounded
  // canonical metadata/hash work. Payload retention is charged separately.
  const workBytes = checkedBytes(checkedBytes(chunkBytes, 2) + checkedBytes(metadataBytes, 2) + 64 * 1024, 1);
  return Object.freeze({ retainedBytes, workBytes, totalBytes: checkedBytes(retainedBytes + workBytes, 1) });
}
export function packedStride(degree: number): number {
  if (!Number.isInteger(degree) || degree < 0 || degree > 3) throw new AdmissionError('Unsupported SH degree.');
  return 40 + 4 * Math.ceil(3 * (degree + 1) ** 2 / 2);
}
export function estimateSceneBytes(count: number, degree: number): number {
  // CPU, packed GPU, two sort-pair buffers, rank, projected data, masks and
  // prefix workspace. Targets/inputs/history are admitted separately.
  return checkedBytes(count, 144 + packedStride(degree) + 16 + 4 + 48 + 6) +
    checkedBytes(Math.ceil(count / 256), 16 * 8) + 4 * MiB;
}
// Retained browser controls/owner metadata are separate from native scratch.
export const FLOOR_VIEW_BOOKKEEPING_BYTES = 16 * 1024;
export function estimateFloorWorkBytes(count: number): number {
  if (!Number.isSafeInteger(count) || count < 0 || count > 1_000_000)
    throw new AdmissionError('Floor detection supports at most one million loaded splats.');
  // Three doubles per sample and two double sorting arrays, plus fixed job,
  // response and allocator allowance. The measured heap remains charged too.
  return checkedBytes(Math.min(count, 50_000), 40) + 8 * MiB + FLOOR_VIEW_BOOKKEEPING_BYTES;
}
export function estimateCaptureBytes(width: number, height: number, depth = false): number {
  const pixels = checkedBytes(width, height);
  const row = checkedBytes(Math.ceil(checkedBytes(width, 4) / 256), 256);
  // Color attachment, unpadded pixels and OffscreenCanvas backing, plus the
  // actual padded mapped buffer. Read-only geometry adds a separate depth.
  return checkedBytes(checkedBytes(pixels, depth ? 16 : 12) + checkedBytes(row, height), 1);
}
export class ResourceLedger {
  private entries = new Map<symbol, { category: Category; bytes: number }>();
  private used = 0;
  private peak = 0;
  private identities = new WeakMap<ResourceLease, symbol>();
  constructor(readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new AdmissionError('Invalid memory budget.');
  }
  get usage() { return { bytes: this.used, peakBytes: this.peak, allocations: this.entries.size }; }
  /** Logical reservations only; this does not measure physical JS/GPU memory. */
  get categorySnapshot(): Readonly<Record<Category, Readonly<{ bytes: number; allocations: number }>>> {
    const result: Record<Category, { bytes: number; allocations: number }> = {
      source: { bytes: 0, allocations: 0 }, decoded: { bytes: 0, allocations: 0 }, work: { bytes: 0, allocations: 0 },
      history: { bytes: 0, allocations: 0 }, render: { bytes: 0, allocations: 0 }, image: { bytes: 0, allocations: 0 }, recovery: { bytes: 0, allocations: 0 },
    };
    for (const entry of this.entries.values()) { result[entry.category].bytes += entry.bytes; result[entry.category].allocations++; }
    for (const value of Object.values(result)) Object.freeze(value);
    return Object.freeze(result);
  }
  get overageBytes() { return Math.max(0, this.used - this.limit); }
  owns(lease: ResourceLease, category?: Category): boolean {
    const identity = this.identities.get(lease);
    const entry = identity === undefined ? undefined : this.entries.get(identity);
    return entry !== undefined && (category === undefined || entry.category === category);
  }
  reserve(category: Category, bytes: number): ResourceLease {
    checkedBytes(bytes, 1);
    if (bytes > this.limit - this.used) throw new AdmissionError('This operation exceeds the available scene budget. Close a scene or load fewer splats.');
    const identity = Symbol(category);
    const entry = { category, bytes };
    this.entries.set(identity, entry);
    const state = { live: true, get bytes() { return entry.bytes; } };
    const credit = Object.freeze({}) as ResourceCredit;
    creditStates.set(credit, state);
    this.used += bytes; this.peak = Math.max(this.peak, this.used);
    const release = (() => {
      const allocation = this.entries.get(identity);
      if (!allocation) return;
      this.used -= allocation.bytes; this.entries.delete(identity); state.live = false;
    }) as ResourceLease;
    this.identities.set(release, identity);
    leaseCredits.set(release, credit);
    Object.defineProperty(release, 'bytes', { get: () => this.entries.get(identity)?.bytes ?? 0 });
    release.resize = next => this.rebalance([{ lease: release, bytes: next }]);
    return release;
  }
  // Move peak reservations into retained history/GPU retirements atomically.
  // A refused redistribution leaves every previous reservation intact.
  private stage(updates: readonly { lease: ResourceLease; bytes: number }[]) {
    const seen = new Set<symbol>();
    const staged = updates.map(({ lease, bytes }) => {
      checkedBytes(bytes, 1);
      const identity = this.identities.get(lease), entry = identity && this.entries.get(identity);
      if (!identity || !entry || seen.has(identity)) throw new AdmissionError('Invalid memory reservation.');
      seen.add(identity); return { entry, bytes };
    });
    let next = this.used;
    for (const { entry } of staged) next -= entry.bytes;
    for (const { bytes } of staged) { next += bytes; checkedBytes(next, 1); }
    return { staged, next };
  }
  private commit({ staged, next }: ReturnType<ResourceLedger['stage']>) {
    for (const { entry, bytes } of staged) entry.bytes = bytes;
    this.used = next; this.peak = Math.max(this.peak, this.used);
  }
  rebalance(updates: readonly { lease: ResourceLease; bytes: number }[]) {
    const change = this.stage(updates);
    // Once an observed native heap exceeds the budget, release remains legal.
    // Ordinary redistribution cannot authorize another allocation while over.
    if (change.next > this.limit && change.staged.some(({ entry, bytes }) => bytes > entry.bytes))
      throw new AdmissionError('This operation exceeds the available scene budget.');
    this.commit(change);
  }
  /** Record memory that already exists, never admission for new native work.
   * Only the measured heap remainder may increase; all other owners must shrink.
   * NativeHeapAccounting supplies and validates the same-client H/C evidence.
   */
  retainObservedNativeHeap(remainder: ResourceLease, bytes: number,
    reductions: readonly { lease: ResourceLease; bytes: number }[] = []) {
    const change = this.stage([{ lease: remainder, bytes }, ...reductions]);
    if (change.staged[0].entry.category !== 'source' || bytes < change.staged[0].entry.bytes ||
        change.staged.slice(1).some(({ entry, bytes: next }) => next > entry.bytes))
      throw new AdmissionError('Invalid retained native heap reconciliation.');
    this.commit(change);
  }
  /** Redistribute existing retained native credit at an unchanged measured H.
   * The accounting owner proves actual payload coverage; this cannot add any
   * aggregate admission while an active heap is over the configured budget.
   */
  transferRetainedNativeCoverage(remainder: ResourceLease, bytes: number,
    updates: readonly { lease: ResourceLease; bytes: number }[]) {
    const change = this.stage([{ lease: remainder, bytes }, ...updates]);
    if (change.staged[0].entry.category !== 'source' || change.next > this.used)
      throw new AdmissionError('A native coverage transfer cannot increase admitted memory.');
    this.commit(change);
  }
}
