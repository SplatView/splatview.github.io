import { AdmissionError, checkedBytes, ResourceLedger, type ResourceLease } from './resources';

export const WASM_PAGE_BYTES = 64 * 1024;
// Match native/wasm/CMakeLists.txt. This is a compiled ceiling, not capacity.
export const MAX_NATIVE_HEAP_BYTES = 2 * 1024 * 1024 * 1024;
export type NativeHeapSnapshot = Readonly<{ sequence: number; heapBytes: number }>;
export type NativeCoverageUpdate = Readonly<{
  lease: ResourceLease; nextLeaseBytes: number; nativeBytes: number;
}>;
export type NativeMemoryState = Readonly<{
  observed: boolean; active: boolean; retired: boolean; sequence: number;
  heapBytes: number; coveredBytes: number; remainderBytes: number;
  ledgerOverageBytes: number; unreconciledHeapBytes: number | null;
}>;

function heapBytes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < WASM_PAGE_BYTES ||
      value > MAX_NATIVE_HEAP_BYTES || value % WASM_PAGE_BYTES !== 0)
    throw new AdmissionError('Invalid native heap size.');
  return value;
}

export function validateNativeHeapSnapshot(value: unknown, previous?: NativeHeapSnapshot): NativeHeapSnapshot {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'heapBytes,sequence')
    throw new AdmissionError('Invalid native heap snapshot.');
  const snapshot = value as Record<string, unknown>;
  const { sequence, heapBytes: rawBytes } = snapshot;
  if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 1 ||
      previous && sequence <= previous.sequence)
    throw new AdmissionError('Invalid native heap sequence.');
  const bytes = heapBytes(rawBytes);
  if (previous && bytes < previous.heapBytes) throw new AdmissionError('Native heap size decreased.');
  return Object.freeze({ sequence, heapBytes: bytes });
}

/** One sampler per initialized module; callers refresh HEAPU8 after growth. */
export class NativeHeapSampler {
  private previous?: NativeHeapSnapshot;
  private module?: { readonly HEAPU8: Uint8Array<ArrayBuffer> };
  sample(module: { readonly HEAPU8: Uint8Array<ArrayBuffer> }): NativeHeapSnapshot {
    if (this.module && this.module !== module) throw new AdmissionError('The native heap sampler changed modules.');
    const view = module.HEAPU8;
    if (!(view instanceof Uint8Array) || !(view.buffer instanceof ArrayBuffer) ||
        view.byteOffset !== 0 || view.byteLength !== view.buffer.byteLength)
      throw new AdmissionError('The native heap view is invalid.');
    if (this.module && this.module !== module) throw new AdmissionError('The native heap sampler changed modules.');
    const snapshot = validateNativeHeapSnapshot({ sequence: (this.previous?.sequence ?? 0) + 1,
      heapBytes: view.buffer.byteLength }, this.previous);
    this.module = module; this.previous = snapshot;
    return snapshot;
  }
}

// A ledger lease cannot cover native memory in two clients, even when both
// clients share the controller's ledger. Weak keys do not retain dead owners.
const owners = new WeakMap<ResourceLease, NativeHeapAccounting>();

/** Per-client accounting foundation. Wire/finalizer integration owns when each
 * observation and coverage transition occurs; this class never reads a worker.
 * R=max(0,H-C), where C includes native portions only, not GPU/JS reservations.
 */
export class NativeHeapAccounting {
  private previous?: NativeHeapSnapshot;
  private unreconciled?: NativeHeapSnapshot;
  private coverage = new Map<ResourceLease, number>();
  private covered = 0;
  private remainderBytes: number;
  private active = false;
  private retired = false;
  constructor(private readonly ledger: ResourceLedger, readonly remainder: ResourceLease) {
    if (!ledger.owns(remainder, 'source') || owners.has(remainder))
      throw new AdmissionError('Invalid native heap remainder owner.');
    this.remainderBytes = remainder.bytes;
    owners.set(remainder, this);
  }
  get state(): NativeMemoryState {
    return Object.freeze({ observed: this.previous !== undefined, active: this.active, retired: this.retired,
      sequence: this.previous?.sequence ?? 0, heapBytes: this.previous?.heapBytes ?? 0,
      coveredBytes: this.covered, remainderBytes: this.remainder.bytes, ledgerOverageBytes: this.ledger.overageBytes,
      unreconciledHeapBytes: this.unreconciled?.heapBytes ?? null });
  }
  private current() {
    if (this.retired || !this.ledger.owns(this.remainder) || owners.get(this.remainder) !== this)
      throw new AdmissionError('The native heap owner was retired.');
    if (this.unreconciled) throw new AdmissionError('The unreconciled native candidate must be retired.');
    if (this.remainder.bytes !== this.remainderBytes)
      throw new AdmissionError('The native heap remainder changed outside its owner.');
    for (const [lease, bytes] of this.coverage) {
      if (!this.ledger.owns(lease) || owners.get(lease) !== this || lease.bytes < bytes)
        throw new AdmissionError('Native coverage was released outside its owner.');
    }
  }
  activate(): void {
    this.current();
    if (!this.previous || this.ledger.overageBytes > 0)
      throw new AdmissionError('An unqualified native heap cannot become active.');
    this.active = true;
  }
  observe(value: unknown): NativeMemoryState {
    return this.reconcile(value, []);
  }
  /** Measure newly allocated native payload and install its existing admission
   * in the same transition. Measuring H first would double-charge that payload.
   */
  reconcile(value: unknown, updates: readonly NativeCoverageUpdate[]): NativeMemoryState {
    this.current();
    const copied = validateNativeHeapSnapshot(value);
    return this.transition(updates, copied);
  }
  updateCoverage(updates: readonly NativeCoverageUpdate[]): NativeMemoryState {
    return this.transition(updates);
  }
  covers(lease: ResourceLease): boolean {
    return !this.retired && this.coverage.has(lease) && owners.get(lease) === this && this.ledger.owns(lease);
  }
  /** Only a redistribution of existing credit after allocation has completed.
   * No new H is accepted and total ledger admission may not increase. Actual
   * native portions remain the caller's measured payload responsibility.
   */
  transferCoverage(updates: readonly NativeCoverageUpdate[], maximumNativeBytes?: number): NativeMemoryState {
    this.current();
    if (!this.active || !this.previous) throw new AdmissionError('Only an active measured heap can transfer retained credit.');
    if (maximumNativeBytes !== undefined) checkedBytes(maximumNativeBytes, 1);
    return this.transition(updates, undefined, true, maximumNativeBytes);
  }
  private transition(updates: readonly NativeCoverageUpdate[], copied?: NativeHeapSnapshot, transfer = false, maximumNativeBytes?: number): NativeMemoryState {
    this.current();
    const prepared = updates.map(({ lease, nextLeaseBytes, nativeBytes }) => ({ lease, nextLeaseBytes, nativeBytes }));
    this.current();
    // Caller getters can reenter this owner. Compare against the latest sample
    // and registry only after all caller-controlled reads finish.
    const snapshot = copied ? validateNativeHeapSnapshot(copied, this.previous) : this.previous;
    const seen = new Set<ResourceLease>();
    let covered = this.covered;
    for (const { lease, nextLeaseBytes, nativeBytes } of prepared) {
      checkedBytes(nextLeaseBytes, 1); checkedBytes(nativeBytes, 1);
      if (lease === this.remainder || seen.has(lease) || !this.ledger.owns(lease) ||
          owners.has(lease) && owners.get(lease) !== this || nativeBytes > nextLeaseBytes)
        throw new AdmissionError('Invalid native coverage owner.');
      seen.add(lease); covered -= this.coverage.get(lease) ?? 0;
    }
    for (const { nativeBytes } of prepared) { covered += nativeBytes; checkedBytes(covered, 1); }
    if (snapshot && covered > snapshot.heapBytes)
      throw new AdmissionError('Native coverage exceeds the measured heap.');
    if (maximumNativeBytes !== undefined && covered > maximumNativeBytes)
      throw new AdmissionError('Native coverage exceeds the measured live payload.');
    const residual = snapshot ? Math.max(0, snapshot.heapBytes - covered) : this.remainder.bytes;
    const changes = prepared.map(({ lease, nextLeaseBytes }) => ({ lease, bytes: nextLeaseBytes }));
    try {
      if (transfer) this.ledger.transferRetainedNativeCoverage(this.remainder, residual, changes);
      else if (this.active && residual >= this.remainder.bytes &&
          prepared.every(({ lease, nextLeaseBytes }) => nextLeaseBytes <= lease.bytes)) {
        // Growth/free has already happened. Record retained H while preserving
        // committed owners; only existing admission may move to its remainder.
        this.ledger.retainObservedNativeHeap(this.remainder, residual, changes);
      } else this.ledger.rebalance([...changes, { lease: this.remainder, bytes: residual }]);
    } catch (error) {
      // A refused measured candidate can only terminate/join and retire; it
      // cannot reuse an older/smaller H to authorize later publication.
      if (copied) this.unreconciled = snapshot;
      throw error;
    }
    this.remainderBytes = residual; this.previous = snapshot;
    for (const { lease, nativeBytes } of prepared) { this.coverage.set(lease, nativeBytes); owners.set(lease, this); }
    this.covered = covered;
    return this.state;
  }
  releaseCovered(lease: ResourceLease): void {
    if (!this.coverage.has(lease)) throw new AdmissionError('Unknown native coverage owner.');
    this.updateCoverage([{ lease, nextLeaseBytes: 0, nativeBytes: 0 }]);
    this.coverage.delete(lease); owners.delete(lease); lease();
  }
  /** Caller must terminate/join this module before retirement. Covered scene,
   * history and GPU leases remain with their original retirement owners.
   */
  retire(): void {
    if (this.retired) return;
    this.retired = true;
    for (const lease of this.coverage.keys()) if (owners.get(lease) === this) owners.delete(lease);
    this.coverage.clear(); this.covered = 0;
    if (owners.get(this.remainder) === this) owners.delete(this.remainder);
    this.remainder();
  }
}
