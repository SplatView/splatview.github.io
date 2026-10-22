import type { SurfaceChannels, SurfaceMap, SurfaceRegion } from '../renderer/webgpu/surfaceQuery';
import { containsSurfaceRegion, unionSurfaceRegions } from '../renderer/webgpu/surfaceCoverage';
import type { ResourceLease } from './resources';
import type { AdoptedSelectionMap, SelectionMapData } from './selectionMap';

export type SelectionMapSource = {
  key: string;
  sourceCount: number;
  current(): void;
  create(options: SurfaceChannels & { signal: AbortSignal }): Promise<SurfaceMap>;
  admit(bytes: number): ResourceLease;
  adopt(data: SelectionMapData, options: { admit(bytes: number): ResourceLease; current(): void; signal?: AbortSignal }): Promise<AdoptedSelectionMap>;
};
export type CachedSelectionMap = {
  readonly mapId: number;
  readonly map: SurfaceMap;
  readonly sourceCount: number;
  assertCurrent(): void;
};
type Entry = CachedSelectionMap & { key: string; native: AdoptedSelectionMap; current(): void };
type Pending = {
  key: string; colors: boolean; visible: boolean; region?: SurfaceRegion; cancel: AbortController;
  source: SelectionMapSource; waiters: Set<symbol>; done: boolean; promise: Promise<Entry>;
};
const aborted = () => new DOMException('Surface query cancelled', 'AbortError');
const snapshotRegion = (region: SurfaceRegion | undefined): SurfaceRegion | undefined => {
  if (!region || ![region.x, region.y, region.width, region.height].every(value => Number.isSafeInteger(value) && value >= 0) ||
    !Number.isSafeInteger(region.x + region.width) || !Number.isSafeInteger(region.y + region.height)) return undefined;
  return Object.freeze({ ...region });
};

/** One admitted map owner. Callers borrow it; replacement/release retires it. */
export class SelectionMapCache {
  private entry?: Entry;
  private pending?: Pending;
  private generation = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private cleanup: Promise<void> = Promise.resolve();

  /** Read-only actual ownership; no cache request, validity repair or counters. */
  diagnosticSnapshot(identity:(value:object)=>number) {
    const entry=this.entry,pending=this.pending;let current:boolean|null=null,reason:string|null=null;
    if(entry)try{entry.assertCurrent();current=true;}catch(error){current=false;reason=error instanceof Error?error.message:String(error);}
    return{generation:this.generation,active:entry?{ownerId:identity(entry),surfaceOwnerId:identity(entry.map),nativeOwnerId:identity(entry.native),
      key:entry.key,mapId:entry.mapId,sourceCount:entry.sourceCount,current,unavailableReason:reason,
      channels:{colors:!!entry.map.colors,visible:!!entry.map.visible},region:entry.map.region,width:entry.map.width,height:entry.map.height,
      fullWidth:entry.map.fullWidth,fullHeight:entry.map.fullHeight,deviceEpoch:entry.map.deviceEpoch,
      attempts:entry.map.attempts,tileCapacity:entry.map.tileCapacity,allocationBytes:entry.map.allocationBytes}:null,
      pending:pending?{ownerId:identity(pending),key:pending.key,channels:{colors:pending.colors,visible:pending.visible},region:pending.region,
        waiters:pending.waiters.size,aborted:pending.cancel.signal.aborted,done:pending.done}:null,
      counters:{available:false,reason:'This cache does not instrument hit/miss or retirement counters.'}};
  }

  acquire(source: SelectionMapSource, channels: SurfaceChannels = {}, signal?: AbortSignal): Promise<CachedSelectionMap> {
    try { signal?.throwIfAborted(); source.current(); } catch (error) { return Promise.reject(error); }
    let colors = !!channels.colors, visible = !!channels.visible;
    // Color/Fill and global contributing-source visibility require a full map.
    let region = colors || visible ? undefined : snapshotRegion(channels.region);
    const entry = this.entry;
    let reusableEntry: Entry | undefined;
    if (entry && entry.key === source.key) {
      try { entry.assertCurrent(); reusableEntry = entry; } catch { /* Rebuild an expired owner. */ }
      if (reusableEntry && (!colors || entry.map.colors) && (!visible || entry.map.visible) &&
        containsSurfaceRegion(entry.map.region, region)) return Promise.resolve(entry);
    }
    let pending = this.pending;
    if (!pending || pending.key !== source.key || colors && !pending.colors || visible && !pending.visible ||
      !containsSurfaceRegion(pending.region, region) || pending.cancel.signal.aborted) {
      // Growing strokes recompute their union; they never mutate an existing map
      // or the parameters captured by a submitted GPU/native query.
      if (reusableEntry) {
        region = unionSurfaceRegions(region, reusableEntry.map.region);
        colors ||= !!reusableEntry.map.colors; visible ||= !!reusableEntry.map.visible;
      }
      if (pending?.key === source.key && !pending.cancel.signal.aborted) {
        region = unionSurfaceRegions(region, pending.region);
        colors ||= pending.colors; visible ||= pending.visible;
      }
      if (colors || visible) region = undefined;
      pending?.cancel.abort(aborted());
      const generation = ++this.generation;
      pending = { key: source.key, colors, visible, region, source, cancel: new AbortController(), waiters: new Set(), done: false,
        promise: undefined! };
      const task = pending;
      task.promise = this.tail.catch(() => undefined).then(() => this.build(task, generation)).finally(() => {
        task.done = true; if (this.pending === task) this.pending = undefined;
      });
      this.tail = task.promise.catch(() => undefined); this.pending = task;
    }
    return this.wait(pending, source, signal);
  }

  private wait(task: Pending, source: SelectionMapSource, signal?: AbortSignal): Promise<Entry> {
    const waiter = Symbol(); task.waiters.add(waiter);
    return new Promise<Entry>((resolve, reject) => {
      let finished = false;
      const finish = (entry?: Entry, error?: unknown) => {
        if (finished) return; finished = true;
        signal?.removeEventListener('abort', cancel); task.waiters.delete(waiter);
        if (!task.done && !task.waiters.size) task.cancel.abort(aborted());
        if (error !== undefined) reject(error); else resolve(entry!);
      };
      const cancel = () => finish(undefined, signal?.reason ?? aborted());
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) { cancel(); return; }
      task.promise.then(entry => {
        try { source.current(); entry.assertCurrent(); finish(entry); } catch (error) { finish(undefined, error); }
      }, error => finish(undefined, error));
    });
  }

  private async build(task: Pending, generation: number): Promise<Entry> {
    let map: SurfaceMap | undefined, native: AdoptedSelectionMap | undefined, published = false;
    const current = () => {
      task.cancel.signal.throwIfAborted(); task.source.current();
      if (generation !== this.generation) throw aborted();
    };
    try {
      current();
      map = await task.source.create({ colors: task.colors, visible: task.visible, region: task.region, signal: task.cancel.signal });
      current(); map.assertCurrent();
      if (!containsSurfaceRegion(map.region, task.region)) throw new Error('The surface query did not cover the requested region.');
      // After publication, a native owner follows its source/map dependencies,
      // rather than the superseded request generation that created it.
      const adoptedCurrent = () => {
        task.source.current(); map!.assertCurrent(); if (!published) current();
      };
      native = await task.source.adopt({ ...map, sourceCount: task.source.sourceCount },
        { admit: task.source.admit, current: adoptedCurrent, signal: task.cancel.signal });
      current(); map.assertCurrent(); native.assertCurrent();
      const owner = this;
      const entry: Entry = { key: task.key, map, native, sourceCount: task.source.sourceCount, mapId: native.mapId,
        current: task.source.current,
        assertCurrent() {
          if (owner.entry !== entry) throw new Error('The selection map was retired.');
          entry.current(); entry.map.assertCurrent(); entry.native.assertCurrent();
        } };
      const previous = this.entry;
      this.entry = entry; published = true; task.done = true;
      if (this.pending === task) this.pending = undefined;
      if (previous) await this.retire(previous);
      return entry;
    } finally {
      if (!published) { try { await native?.dispose(); } finally { map?.dispose(); } }
    }
  }

  private retire(entry: Entry): Promise<void> {
    const work = this.cleanup.catch(() => undefined).then(async () => {
      try { await entry.native.dispose(); } finally { entry.map.dispose(); }
    });
    this.cleanup = work; return work;
  }

  /** Discard dependencies promptly; submitted GPU work retires before release. */
  invalidate(): Promise<void> {
    this.generation++; this.pending?.cancel.abort(aborted());
    const pending = this.pending?.promise, entry = this.entry; this.entry = undefined;
    if (entry) void this.retire(entry).catch(() => undefined);
    return Promise.all([pending?.catch(() => undefined), this.cleanup]).then(() => undefined);
  }

  /** Mutations serialize against adoption without discarding a reusable map. */
  cancelPending(): Promise<void> {
    this.generation++; this.pending?.cancel.abort(aborted());
    return this.pending?.promise.then(() => undefined, () => undefined) ?? Promise.resolve();
  }

  /** Used on camera/scene changes even if no tool currently requests a map. */
  validate(): void {
    try { this.entry?.assertCurrent(); this.pending?.source.current(); }
    catch { void this.invalidate().catch(() => undefined); }
  }
}
