import { ensureRuntime, type RuntimeContext } from '../build/runtime';
import type { BuildArtifact, BuildDescriptor } from '../build/contracts';
import type { RuntimeVerificationMode } from '../build/bootstrap';
import type { BenchmarkFrameObservation, BenchmarkMaskObservation, DeepReadonly } from './benchmarkObservation';

export const BENCHMARK_QUERY_KEY = '__splatview_benchmark';
export const BENCHMARK_GLOBAL_KEY = '__SPLATVIEW_BENCHMARK_V1__';

/** Structural boundary for pure fake tests; installing the bridge never creates a controller. */
export interface BenchmarkBridgeController {
  enableBenchmarkObservation(options?: { maxFrames?: number }): () => void;
  benchmarkSnapshot(): unknown;
  benchmarkCameraSnapshot(): unknown;
  readBenchmarkMasks():Promise<BenchmarkMaskObservation>;
  joinBenchmarkQueries():Promise<void>;
  waitForBenchmarkFrame(afterSequence: number, timeoutMs?: number): Promise<BenchmarkFrameObservation>;
  camera?: { set(state: number[]): void };
  invalidate(): void;
  closeScene(): Promise<void>;
}
export interface BenchmarkBridgeClock { readonly timeOrigin: number; now(): number }
export type BenchmarkBridgeTarget = { [BENCHMARK_GLOBAL_KEY]?: unknown };
export interface BenchmarkRuntimeObservation {
  mode: RuntimeVerificationMode;
  descriptor: BuildDescriptor;
  appInputId: string;
  deploymentId: string | null;
  assetBase: string;
  entryUrl: string;
  artifacts: (BuildArtifact & { url: string })[];
}
export interface ProductionBenchmarkSnapshot {
  schemaVersion: 1;
  kind: 'splatview-production-benchmark-snapshot';
  clock: { id: string; timeOrigin: number; now: number; method: 'performance.now' };
  runtime: DeepReadonly<BenchmarkRuntimeObservation>;
  controller: unknown;
}
/** A lightweight actual boundary, not a submitted-frame or presentation receipt. */
export interface ProductionBenchmarkCameraSnapshot {
  schemaVersion: 1;
  kind: 'splatview-production-benchmark-camera';
  clock: ProductionBenchmarkSnapshot['clock'];
  runtime: Pick<BenchmarkRuntimeObservation, 'mode' | 'appInputId' | 'deploymentId'>;
  controller: unknown;
}
export interface ProductionBenchmarkMaskSnapshot {
  schemaVersion:1;kind:'splatview-production-benchmark-mask';clock:ProductionBenchmarkSnapshot['clock'];
  runtime:ProductionBenchmarkCameraSnapshot['runtime'];observation:BenchmarkMaskObservation;
}
export interface ProductionBenchmarkBridge {
  readonly schemaVersion: 1;
  readonly kind: 'splatview-production-benchmark-bridge';
  snapshot(): Promise<DeepReadonly<ProductionBenchmarkSnapshot>>;
  waitForFrame(afterSequence: number, timeoutMs?: number): Promise<BenchmarkFrameObservation>;
  /** Changes the actual camera; its returned snapshot does not establish a submitted or presented frame. */
  setCamera(state: unknown): Promise<DeepReadonly<ProductionBenchmarkSnapshot>>;
  /** Sets the actual camera and returns a bounded boundary without frame/operation histories. */
  applyCamera(state: unknown): Promise<DeepReadonly<ProductionBenchmarkCameraSnapshot>>;
  readMasks():Promise<DeepReadonly<ProductionBenchmarkMaskSnapshot>>;
  /** Awaits the actual public close boundary; prompts/refusals remain visible in the returned state. */
  closeScene(): Promise<DeepReadonly<ProductionBenchmarkSnapshot>>;
  stop(): Promise<DeepReadonly<ProductionBenchmarkSnapshot>>;
}
export interface BenchmarkBridgeOptions {
  search?: string;
  target?: BenchmarkBridgeTarget;
  runtime?: () => Promise<RuntimeContext>;
  clock?: BenchmarkBridgeClock;
  maxFrames?: number;
}

/** Accept one literal opt-in pair. Encoded aliases and repeated benchmark keys cannot enable instrumentation. */
export function benchmarkQueryEnabled(search: string): boolean {
  if (typeof search !== 'string' || search.includes('#')) return false;
  const query = search.startsWith('?') ? search.slice(1) : search;
  const parameters = new URLSearchParams(query);
  return parameters.getAll(BENCHMARK_QUERY_KEY).length === 1 && parameters.get(BENCHMARK_QUERY_KEY) === '1'
    && query.split('&').filter(pair => pair === `${BENCHMARK_QUERY_KEY}=1`).length === 1;
}

/** JSON-shaped detached values only. Executable buffers, prototypes, accessors and cycles are refused. */
function frozenCopy<T>(value: T): DeepReadonly<T> {
  const ancestors = new Set<object>();
  const clone = (current: unknown, depth: number): unknown => {
    if (depth > 128) throw new Error('Benchmark snapshot nesting bound exceeded.');
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return current;
    if (typeof current === 'number' && Number.isFinite(current)) return current;
    if (typeof current !== 'object' || current === null) throw new Error('Benchmark observation is not serializable plain data.');
    if (ancestors.has(current)) throw new Error('Benchmark observation contains a cycle.');
    const array = Array.isArray(current);
    if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(current)))
      throw new Error('Benchmark observation contains non-plain data.');
    ancestors.add(current);
    try {
      if (array) {
        const result: unknown[] = [];
        for (let index = 0; index < current.length; index++) {
          const property = Object.getOwnPropertyDescriptor(current, String(index));
          if (property && !('value' in property)) throw new Error('Benchmark observation contains an accessor.');
          result.push(!property || property.value === undefined ? null : clone(property.value, depth + 1));
        }
        return Object.freeze(result);
      }
      const result: Record<string, unknown> = {};
      for (const key of Reflect.ownKeys(current)) {
        if (typeof key !== 'string') throw new Error('Benchmark observation contains a symbol key.');
        const property = Object.getOwnPropertyDescriptor(current, key)!;
        if (!property.enumerable) continue;
        if (!('value' in property)) throw new Error('Benchmark observation contains an accessor.');
        if (property.value !== undefined) Object.defineProperty(result, key, {
          value: clone(property.value, depth + 1), enumerable: true, configurable: false, writable: false,
        });
      }
      return Object.freeze(result);
    } finally { ancestors.delete(current); }
  };
  return clone(value, 0) as DeepReadonly<T>;
}

function runtimeObservation(context: RuntimeContext): BenchmarkRuntimeObservation {
  const production = context.mode === 'production-verified';
  if (production && !context.verified) throw new Error('Verified production runtime metadata is unavailable.');
  const artifacts = production ? [...context.verified!.artifacts.values()] : [...context.artifacts.values()];
  return {
    mode: context.mode, descriptor: context.descriptor, appInputId: context.descriptor.appInputId,
    deploymentId: production ? context.verified!.manifest.deploymentId : null,
    assetBase: context.assetBase, entryUrl: context.entryUrl,
    // Whitelist metadata from every verified artifact, including non-retained runtime assets.
    // RuntimeContext.artifacts retains executable ArrayBuffers; those are never exposed here.
    artifacts: artifacts.map(({ artifact, url }) => ({
      role: artifact.role, path: artifact.path, bytes: artifact.bytes, sha256: artifact.sha256, url,
    })),
  };
}

function checkedCameraState(value: unknown): number[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length !== 11
    || Reflect.ownKeys(value).length !== 12) throw new Error('Benchmark camera requires eleven finite float32 values.');
  const result: number[] = [];
  for (let index = 0; index < 11; index++) {
    const property = Object.getOwnPropertyDescriptor(value, String(index));
    if (!property?.enumerable || !('value' in property) || typeof property.value !== 'number'
      || !Number.isFinite(property.value) || !Number.isFinite(Math.fround(property.value)))
      throw new Error('Benchmark camera requires eleven finite float32 values.');
    result.push(Math.fround(property.value));
  }
  if (result[5] <= 0 || result[6] <= 0 || result[10] <= 0
    || value[8] !== 0 && value[8] !== 1 || value[7] < 10 || value[7] > 120 || result[7] < 10 || result[7] > 120)
    throw new Error('Benchmark camera distance, speed, aspect, yUp or field of view is invalid.');
  return result;
}

/** Optional instrumentation failure cannot prevent normal UI initialization or disposal. */
export function installProductionBenchmarkBridge(controller: BenchmarkBridgeController, options: BenchmarkBridgeOptions = {}): () => void {
  const search = options.search ?? (typeof location === 'undefined' ? '' : location.search);
  if (!benchmarkQueryEnabled(search)) return () => undefined;
  let detach: () => void = () => undefined;
  try {
    const target = options.target ?? (typeof window === 'undefined' ? undefined : window as unknown as BenchmarkBridgeTarget);
    if (!target || Reflect.has(target, BENCHMARK_GLOBAL_KEY)) return detach;
    const maxFrames = options.maxFrames ?? 4096;
    if (!Number.isSafeInteger(maxFrames) || maxFrames < 1 || maxFrames > 8192) return detach;
    const unsubscribe = controller.enableBenchmarkObservation({ maxFrames });
    let active = true, stopping = false, closing = false;
    const maskReads=new Set<Promise<DeepReadonly<ProductionBenchmarkMaskSnapshot>>>();
    let stopPromise: Promise<DeepReadonly<ProductionBenchmarkSnapshot>> | undefined;
    let api: ProductionBenchmarkBridge;
    const ownsGlobal = () => Object.getOwnPropertyDescriptor(target, BENCHMARK_GLOBAL_KEY)?.value === api;
    detach = () => {
      if (!active) return;
      active = false;
      try { unsubscribe(); } catch { /* Instrumentation cleanup cannot interrupt viewer disposal. */ }
      try { if (ownsGlobal()) Reflect.deleteProperty(target, BENCHMARK_GLOBAL_KEY); } catch { /* Preserve another owner. */ }
    };
    const assertActive = (allowStopping = false) => {
      if (!active || !ownsGlobal() || stopping && !allowStopping) throw new Error('Benchmark bridge is inactive or no longer owns its global.');
    };
    const snapshot = async (allowStopping = false): Promise<DeepReadonly<ProductionBenchmarkSnapshot>> => {
      assertActive(allowStopping);
      const context = await (options.runtime ?? ensureRuntime)();
      assertActive(allowStopping);
      const runtime = runtimeObservation(context), observedController = controller.benchmarkSnapshot();
      const clock = options.clock ?? performance, timeOrigin = clock.timeOrigin, now = clock.now();
      if (!Number.isFinite(timeOrigin) || !Number.isFinite(now) || now < 0) throw new Error('Benchmark clock observation is invalid.');
      return frozenCopy({
        schemaVersion: 1, kind: 'splatview-production-benchmark-snapshot',
        clock: { id: `performance.now:${timeOrigin}`, timeOrigin, now, method: 'performance.now' },
        runtime, controller: observedController,
      } as ProductionBenchmarkSnapshot);
    };
    api = Object.freeze({
      schemaVersion: 1 as const, kind: 'splatview-production-benchmark-bridge' as const,
      snapshot: () => snapshot(),
      waitForFrame: async (afterSequence: number, timeoutMs = 10000) => {
        assertActive();
        if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
          throw new Error('Benchmark frame sequence or timeout is invalid.');
        const frame = await controller.waitForBenchmarkFrame(afterSequence, timeoutMs);
        assertActive(); return frozenCopy(frame);
      },
      setCamera: async (state: unknown) => {
        assertActive(); const checked = checkedCameraState(state), camera = controller.camera;
        if (!camera) throw new Error('Benchmark camera is not initialized.');
        camera.set(checked); controller.invalidate(); return snapshot();
      },
      applyCamera: async (state: unknown) => {
        assertActive(); const checked = checkedCameraState(state);
        const context = await (options.runtime ?? ensureRuntime)(); assertActive();
        if (context.mode === 'production-verified' && !context.verified) throw new Error('Verified production runtime metadata is unavailable.');
        const camera = controller.camera;
        if (!camera) throw new Error('Benchmark camera is not initialized.');
        camera.set(checked); controller.invalidate();
        const observed = controller.benchmarkCameraSnapshot(), clock = options.clock ?? performance;
        const timeOrigin = clock.timeOrigin, now = clock.now();
        if (!Number.isFinite(timeOrigin) || !Number.isFinite(now) || now < 0) throw new Error('Benchmark clock observation is invalid.');
        return frozenCopy({ schemaVersion: 1, kind: 'splatview-production-benchmark-camera',
          clock: { id: `performance.now:${timeOrigin}`, timeOrigin, now, method: 'performance.now' },
          runtime: { mode: context.mode, appInputId: context.descriptor.appInputId,
            deploymentId: context.mode === 'production-verified' ? context.verified!.manifest.deploymentId : null },
          controller: observed } as ProductionBenchmarkCameraSnapshot);
      },
      readMasks:()=>{
        try{assertActive();if(closing)throw new Error('Benchmark scene close is pending.');}catch(error){return Promise.reject(error);}
        const task=(async()=>{
          const context=await(options.runtime??ensureRuntime)();assertActive(true);
          if(context.mode!=='production-verified'||!context.verified)throw new Error('Verified production runtime metadata is unavailable.');
          const observed=await controller.readBenchmarkMasks();assertActive(true);
          const clock=options.clock??performance,timeOrigin=clock.timeOrigin,now=clock.now();
          if(!Number.isFinite(timeOrigin)||!Number.isFinite(now)||now<0)throw new Error('Benchmark clock observation is invalid.');
          return frozenCopy({schemaVersion:1,kind:'splatview-production-benchmark-mask',
            clock:{id:`performance.now:${timeOrigin}`,timeOrigin,now,method:'performance.now'},
            runtime:{mode:context.mode,appInputId:context.descriptor.appInputId,deploymentId:context.verified.manifest.deploymentId},
            observation:observed} as ProductionBenchmarkMaskSnapshot);
        })();maskReads.add(task);void task.finally(()=>maskReads.delete(task)).catch(()=>undefined);return task;
      },
      closeScene: async () => { assertActive();closing=true;try{if(maskReads.size)await Promise.allSettled([...maskReads]);await controller.closeScene();assertActive();return snapshot();}finally{closing=false;} },
      stop: () => {
        if (stopPromise) return stopPromise;
        try { assertActive(); } catch (error) { return Promise.reject(error); }
        stopping = true; stopPromise = Promise.allSettled([...maskReads]).then(()=>controller.joinBenchmarkQueries()).then(()=>snapshot(true)).finally(detach); return stopPromise;
      },
    });
    Object.defineProperty(target, BENCHMARK_GLOBAL_KEY, { value: api, configurable: true, writable: false, enumerable: false });
    return detach;
  } catch {
    detach(); return () => undefined;
  }
}
