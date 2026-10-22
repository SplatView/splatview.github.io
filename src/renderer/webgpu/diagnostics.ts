/** Creation observations only. No GPU timestamp queries or inferred hardware timings. */
export type RendererInitializationStage = 'start' | 'adapter-request' | 'adapter-observed' | 'device-request' |
  'device-observed' | 'shader-compilation' | 'pipeline-creation' | 'renderer-creation' | 'validation' | 'ready';
type Status = 'initializing' | 'ready' | 'failed';
export type RendererCapabilitiesObservation = Readonly<{
  features: readonly string[] | null;
  limits: Readonly<Record<string, number>> | null;
  featuresUnavailableReason: string | null;
  limitsUnavailableReason: string | null;
}>;
export type RendererAdapterObservation = RendererCapabilitiesObservation & Readonly<{
  info: Readonly<Record<string, string | number | boolean>> | null;
  infoUnavailableReason: string | null;
}>;
export type RendererNegotiationSnapshot = Readonly<{
  schemaVersion: 1;
  kind: 'splatview-renderer-negotiation';
  status: Status;
  stage: RendererInitializationStage;
  clock: 'performance.now';
  startedAtMs: number | null;
  observedAtMs: number | null;
  clockUnavailableReason: string | null;
  stages: readonly Readonly<{ stage: RendererInitializationStage; status: Status; atMs: number | null }>[];
  adapter: RendererAdapterObservation | null;
  requested: Readonly<{ features: readonly string[]; limits: Readonly<Record<string, number>> }> | null;
  device: RendererCapabilitiesObservation | null;
  failure: Readonly<{ stage: RendererInitializationStage; reason: string }> | null;
  gpuTimestamps: Readonly<{ available: false; reason: string }>;
}>;
export type RendererNegotiationObserver = (snapshot: RendererNegotiationSnapshot) => void;

// GPUSupportedLimits uses prototype accessors, so Object.entries(limits) misses
// actual browser values. Bound observations to the installed WebGPU contract.
const LIMIT_NAMES = [
  'maxTextureDimension1D', 'maxTextureDimension2D', 'maxTextureDimension3D', 'maxTextureArrayLayers',
  'maxBindGroups', 'maxBindGroupsPlusVertexBuffers', 'maxBindingsPerBindGroup',
  'maxDynamicUniformBuffersPerPipelineLayout', 'maxDynamicStorageBuffersPerPipelineLayout',
  'maxSampledTexturesPerShaderStage', 'maxSamplersPerShaderStage', 'maxStorageBuffersPerShaderStage',
  'maxStorageBuffersInVertexStage', 'maxStorageBuffersInFragmentStage', 'maxStorageTexturesPerShaderStage',
  'maxStorageTexturesInVertexStage', 'maxStorageTexturesInFragmentStage', 'maxUniformBuffersPerShaderStage',
  'maxUniformBufferBindingSize', 'maxStorageBufferBindingSize', 'minUniformBufferOffsetAlignment',
  'minStorageBufferOffsetAlignment', 'maxVertexBuffers', 'maxBufferSize', 'maxVertexAttributes',
  'maxVertexBufferArrayStride', 'maxInterStageShaderVariables', 'maxColorAttachments',
  'maxColorAttachmentBytesPerSample', 'maxComputeWorkgroupStorageSize', 'maxComputeInvocationsPerWorkgroup',
  'maxComputeWorkgroupSizeX', 'maxComputeWorkgroupSizeY', 'maxComputeWorkgroupSizeZ',
  'maxComputeWorkgroupsPerDimension', 'maxImmediateSize',
] as const;
const GPU_TIMESTAMPS = Object.freeze({ available: false as const,
  reason: 'GPU timestamp queries are not instrumented. Initialization observations use CPU performance.now wall time.' });

function reason(error: unknown): string {
  try {
    const message = error instanceof Error ? error.message : String(error);
    return message.slice(0, 2048) || 'Observation unavailable without an error message.';
  } catch { return 'Observation unavailable; error text could not be read.'; }
}
function object(value: unknown): object {
  if (value === null || typeof value !== 'object') throw new Error('WebGPU observation object is unavailable.');
  return value;
}
function features(value: unknown): readonly string[] {
  object(value);
  const result = new Set<string>(); let count = 0;
  for (const feature of value as Iterable<unknown>) {
    if (++count > 128 || typeof feature !== 'string' || feature.length > 128)
      throw new Error('WebGPU feature observation exceeds its bounded contract.');
    result.add(feature);
  }
  return Object.freeze([...result].sort());
}
function limits(value: unknown): Readonly<Record<string, number>> {
  const source = object(value), result: Record<string, number> = {};
  for (const name of LIMIT_NAMES) {
    const observed: unknown = Reflect.get(source, name);
    if (observed === undefined) continue; // Optional/new limits may be absent.
    if (typeof observed !== 'number' || !Number.isSafeInteger(observed) || observed < 0)
      throw new Error(`WebGPU limit ${name} is not an observed finite safe integer.`);
    result[name] = observed;
  }
  return Object.freeze(result);
}
/** Copies values immediately, including prototype getters; no live GPU object is retained. */
export function captureRendererCapabilities(source: unknown): RendererCapabilitiesObservation {
  let capturedFeatures: readonly string[] | null = null, capturedLimits: Readonly<Record<string, number>> | null = null;
  let featuresUnavailableReason: string | null = null, limitsUnavailableReason: string | null = null;
  try { capturedFeatures = features(Reflect.get(object(source), 'features')); }
  catch (error) { featuresUnavailableReason = reason(error); }
  try { capturedLimits = limits(Reflect.get(object(source), 'limits')); }
  catch (error) { limitsUnavailableReason = reason(error); }
  return Object.freeze({ features: capturedFeatures, limits: capturedLimits, featuresUnavailableReason, limitsUnavailableReason });
}
function captureAdapter(source: unknown): RendererAdapterObservation {
  let info: RendererAdapterObservation['info'] = null, infoUnavailableReason: string | null = null;
  try {
    const actual = object(Reflect.get(object(source), 'info')), result: Record<string, string | number | boolean> = {};
    for (const name of ['vendor', 'architecture', 'device', 'description']) {
      const value: unknown = Reflect.get(actual, name);
      if (typeof value !== 'string' || value.length > 2048) throw new Error(`Adapter info ${name} is unavailable or exceeds its text bound.`);
      result[name] = value;
    }
    for (const name of ['subgroupMinSize', 'subgroupMaxSize']) {
      const value: unknown = Reflect.get(actual, name);
      if (value === undefined) continue;
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid adapter info ${name}.`);
      result[name] = value;
    }
    const fallback: unknown = Reflect.get(actual, 'isFallbackAdapter');
    if (typeof fallback === 'boolean') result.isFallbackAdapter = fallback;
    info = Object.freeze(result);
    if (!result.vendor && !result.architecture && !result.device && !result.description)
      infoUnavailableReason = 'Adapter identification fields are empty or redacted.';
  } catch (error) { infoUnavailableReason = reason(error); }
  return Object.freeze({ ...captureRendererCapabilities(source), info, infoUnavailableReason });
}

/** One renderer-create lifetime. At most ten small snapshots, including failure. */
export class RendererNegotiation {
  private stage: RendererInitializationStage = 'start';
  private status: Status = 'initializing';
  private events: RendererNegotiationSnapshot['stages'][number][] = [];
  private adapter: RendererAdapterObservation | null = null;
  private requested: RendererNegotiationSnapshot['requested'] = null;
  private device: RendererCapabilitiesObservation | null = null;
  private failure: RendererNegotiationSnapshot['failure'] = null;
  private startedAtMs: number | null = null;
  private observedAtMs: number | null = null;
  private clockUnavailableReason: string | null = null;
  private current!: RendererNegotiationSnapshot;
  constructor(private readonly observer?: RendererNegotiationObserver,
    private readonly now: () => number = () => performance.now()) { this.publish('start'); }
  get snapshot(): RendererNegotiationSnapshot { return this.current; }
  observeAdapter(adapter: unknown): void { this.adapter = captureAdapter(adapter); this.advance('adapter-observed'); }
  observeRequest(descriptor: { requiredFeatures?: Iterable<string>; requiredLimits?: object }): void {
    // The renderer supplies its actual descriptor. This observation never adds
    // a feature/limit to the descriptor sent to requestDevice.
    this.requested = Object.freeze({ features: features(descriptor.requiredFeatures ?? []), limits: limits(descriptor.requiredLimits ?? {}) });
    this.advance('device-request');
  }
  observeDevice(device: unknown): void { this.device = captureRendererCapabilities(device); this.advance('device-observed'); }
  advance(stage: RendererInitializationStage): void {
    // Reserve one event for ready/failure even if a caller repeats stages.
    if (this.status !== 'initializing' || this.events.length >= 9 && stage !== 'ready') return;
    if (stage === 'ready') this.status = 'ready';
    this.publish(stage);
  }
  fail(error: unknown): void {
    if (this.status !== 'initializing') return;
    this.status = 'failed'; this.failure = Object.freeze({ stage: this.stage, reason: reason(error) });
    this.publish(this.stage);
  }
  private publish(stage: RendererInitializationStage): void {
    this.stage = stage;
    let atMs: number | null = null;
    try {
      const actual = this.now();
      if (!Number.isFinite(actual) || actual < 0) throw new Error('performance.now did not return an observed finite nonnegative time.');
      atMs = actual;
    } catch (error) { this.clockUnavailableReason = reason(error); }
    if (this.events.length === 0) this.startedAtMs = atMs;
    this.observedAtMs = atMs;
    const event = Object.freeze({ stage, status: this.status, atMs });
    if (this.events.length < 10) this.events.push(event); else this.events[this.events.length - 1] = event;
    this.current = Object.freeze({ schemaVersion: 1, kind: 'splatview-renderer-negotiation', status: this.status, stage,
      clock: 'performance.now', startedAtMs: this.startedAtMs, observedAtMs: this.observedAtMs,
      clockUnavailableReason: this.clockUnavailableReason, stages: Object.freeze([...this.events]),
      adapter: this.adapter, requested: this.requested, device: this.device, failure: this.failure, gpuTimestamps: GPU_TIMESTAMPS });
    if (this.observer) {
      // Sync and async observer failures grant no setup/teardown authority.
      try { void Promise.resolve(this.observer(this.current)).catch(() => undefined); } catch { /* Observation only. */ }
    }
  }
}
