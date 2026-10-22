import { AdmissionError, checkedBytes, MiB, type ResourceLease } from '../../document/resources';

type Entry = { owner: object; buffer: GPUBuffer; size: number; usage: GPUBufferUsageFlags;
  credit: ResourceLease; busy: boolean; cacheable: boolean };
export type SurfaceScratch = {
  readonly buffer: GPUBuffer;
  readonly reused: boolean;
  /** The caller must join submitted uploads/commands before releasing. */
  release(retain?: boolean): void;
};

/** One renderer's exact-size scratch cache. Every physical buffer keeps its own
 * admission, including while idle. Only fully retired, unmapped buffers may be
 * returned; callers must clear counters/padding before reusing their contents.
 */
export class SurfaceScratchPool {
  private readonly entries = new Set<Entry>();
  private disposed = false;
  private reused = 0;
  private created = 0;
  constructor(private readonly device: GPUDevice, readonly maximumIdleBytes = 16 * MiB,
    readonly maximumIdleBuffers = 32) {
    checkedBytes(maximumIdleBytes, 1); checkedBytes(maximumIdleBuffers, 1);
  }
  get snapshot() {
    let allocatedBytes = 0, idleBytes = 0, idleBuffers = 0, activeBuffers = 0;
    for (const entry of this.entries) {
      allocatedBytes += entry.size;
      if (entry.busy) activeBuffers++;
      else { idleBytes += entry.size; idleBuffers++; }
    }
    return { allocatedBytes, idleBytes, idleBuffers, activeBuffers, createdBuffers: this.created, reusedBuffers: this.reused };
  }
  acquire(owner: object, label: string, size: number, usage: GPUBufferUsageFlags,
    admit: (bytes: number) => ResourceLease): SurfaceScratch {
    if (this.disposed) throw new AdmissionError('The surface scratch owner was retired.');
    checkedBytes(size, 1);
    if (size < 4 || size % 4 || size > this.device.limits.maxBufferSize)
      throw new AdmissionError('The surface scratch buffer exceeds the graphics device limit.');
    let entry = [...this.entries].find(value => !value.busy && value.owner === owner && value.size === size &&
      value.usage === usage && value.buffer.mapState === 'unmapped');
    const reused = !!entry;
    if (entry) { entry.buffer.label = label; entry.busy = true; this.reused++; }
    else {
      let credit: ResourceLease;
      try { credit = admit(size); }
      catch (error) {
        if (!(error instanceof AdmissionError) || !this.evictIdle()) throw error;
        credit = admit(size);
      }
      let buffer: GPUBuffer;
      try { buffer = this.device.createBuffer({ label, size, usage }); }
      catch (error) { credit(); throw error; }
      entry = { owner, buffer, size, usage, credit, busy: true, cacheable: true };
      this.entries.add(entry); this.created++;
    }
    const acquired = entry;
    let released = false;
    return { buffer: acquired.buffer, reused, release: (retain = true) => {
      if (released) return; released = true;
      if (!this.entries.has(acquired)) return;
      acquired.busy = false;
      if (!retain || !acquired.cacheable || acquired.buffer.mapState !== 'unmapped' ||
        acquired.size > this.maximumIdleBytes || !this.maximumIdleBuffers) this.destroy(acquired);
      else {
        // Keep the most recently returned buffers when shape changes. Active
        // entries are never candidates for eviction or reuse.
        while (this.snapshot.idleBytes > this.maximumIdleBytes || this.snapshot.idleBuffers > this.maximumIdleBuffers) {
          const oldest = [...this.entries].find(value => !value.busy && value !== acquired);
          if (!oldest) { this.destroy(acquired); break; }
          this.destroy(oldest);
        }
      }
      // Preserve a bounded LRU ordering independently of checkout order.
      if (this.entries.delete(acquired)) this.entries.add(acquired);
    } };
  }
  /** Pressure/scene invalidation evicts idle buffers now. Active buffers keep
   * their credit and are discarded only after their caller joins retirement.
   */
  trim(owner?: object): void {
    for (const entry of this.entries) if (!owner || entry.owner === owner) {
      if (entry.busy) entry.cacheable = false;
      else this.destroy(entry);
    }
  }
  private evictIdle(): number {
    let released = 0;
    for (const entry of this.entries) if (!entry.busy) { released += entry.size; this.destroy(entry); }
    return released;
  }
  private destroy(entry: Entry): void {
    if (!this.entries.delete(entry)) return;
    try { entry.buffer.destroy(); } finally { entry.credit(); }
  }
  /** Call only after device loss or device.destroy() has retired its work. */
  dispose(): void {
    if (this.disposed) return; this.disposed = true;
    for (const entry of this.entries) this.destroy(entry);
  }
}
