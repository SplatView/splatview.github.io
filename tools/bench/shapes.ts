/** Shared JSON Schema subset; exported schemas and runtime structural checks use these exact objects. */
export interface Shape {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  properties?: Record<string, Shape>;
  required?: string[];
  additionalProperties?: false | Shape;
  items?: Shape;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  enum?: (string | number | boolean)[];
  anyOf?: Shape[];
}
const text: Shape = { type: 'string', minLength: 1, maxLength: 2048 };
const id: Shape = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:/-]*$' };
const hash: Shape = { type: 'string', pattern: '^[0-9a-f]{64}$', minLength: 64, maxLength: 64 };
const number: Shape = { type: 'number', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const signedNumber: Shape = { type: 'number', minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER };
const integer: Shape = { ...number, type: 'integer' };
const positive: Shape = { ...integer, minimum: 1 };
const bool: Shape = { type: 'boolean' };
const enumeration = (...values: (string | number)[]): Shape => ({ enum: values });
const nullable = (shape: Shape): Shape => ({ anyOf: [shape, { type: 'null' }] });
const array = (items: Shape, minItems = 0, maxItems = 10000): Shape => ({ type: 'array', items, minItems, maxItems });
const object = (properties: Record<string, Shape>): Shape => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const map = (values: Shape): Shape => ({ type: 'object', additionalProperties: values });

export const buildShape = object({ appSha256: hash, coreSha256: hash, cameraSha256: hash, deploymentSha256: hash, protocol: positive, uiWorker: positive });
const fixture = object({ id, inputSha256: hash, manifestSha256: hash, sourceOrderSha256: hash, distributionSha256: hash, expectedSceneSha256: hash, sourceCount: integer, loadedCount: integer, shDegree: enumeration(0, 3), overdraw: enumeration('low', 'high') });
const trace = object({ id, sha256: hash, projectionSha256: hash, warmupMs: number, durationMs: number, idleHiddenMs: number });
const framebuffer = object({ id, kind: enumeration('standard', 'retina'), cssWidth: positive, cssHeight: positive, width: positive, height: positive, dpr: { ...number, minimum: 1 } });
const cell = object({ id, machineId: id, browserId: id, fixtureId: id, traceId: id, framebufferId: id });
const selection = object({ id, fixtureId: id, kind: enumeration('pick', 'query', 'amendment'), parametersSha256: hash, expectedMaskSha256: hash, expectedSelectedCount: integer });
const exporting = object({ id, fixtureId: id, format: id, scope: enumeration('all', 'selected', 'remainder'), parametersSha256: hash, capturedRevision: integer, expectedOutputSha256: nullable(hash), expectedRecordCount: integer,
  membership: object({ loadedCount: integer, selectedCount: integer, deletedCount: integer, selectedDeletedCount: integer, expectedMembershipSha256: hash }),
  precision: object({ mode: enumeration('exact', 'bounded'), absoluteTolerance: number, oracleSha256: hash, components: array(object({ id, unit: id, expected: signedNumber }), 0, 10000) }),
});
const threshold = object({ cellId: id, scenarioId: id, metric: id, statistic: enumeration('p50', 'p95'), unit: enumeration('ms', 'bytes', 'count'), maximum: number });
const memoryPoints = enumeration('baseline', 'load-peak', 'edit-peak', 'export-peak', 'capture-peak', 'post-close', 'final-cycle');
const memoryCategories = enumeration('ledgerLive', 'ledgerPeak', 'nativeLivePayload', 'wasmLinearCapacity', 'wasmLinearHighWater', 'jsHeapEstimate', 'browserProcess', 'workerProcess', 'gpuDriver');
const memoryCeiling = object({ cellId: id, point: memoryPoints, category: memoryCategories, maximumBytes: integer });
export const targetShape = object({
  schemaVersion: enumeration(1), id, scope: enumeration('tooling-only', 'w09-initial'), status: enumeration('pending', 'approved'),
  machines: array(object({ id, tier: enumeration('minimum', 'newer') }), 1, 16),
  browsers: array(object({ id, family: enumeration('Safari', 'Chrome') }), 1, 16),
  fixtures: array(fixture, 1, 100), traces: array(trace, 1, 16), framebuffers: array(framebuffer, 1, 16), cells: array(cell, 1, 1024),
  selectionCases: array(selection, 1, 1000), exportCases: array(exporting, 1, 1000), thresholds: nullable(array(threshold, 1, 100000)), memoryCeilings: nullable(array(memoryCeiling, 1, 100000)),
});
const environment = object({
  machineId: id, browserId: id, osFamily: enumeration('macOS', 'Windows', 'Linux'), osVersion: text, machineModel: text,
  ramBytes: positive, browserFamily: enumeration('Safari', 'Chrome'), browserVersion: text, adapterName: text,
  adapterFeatures: array(id, 0, 256), enabledFeatures: array(id, 0, 256), deviceLimits: map(integer), powerMode: text, cachePolicy: text,
  resolutionPolicy: enumeration('fixed'), crossOriginIsolated: bool, sharedArrayBufferAvailable: bool, framebuffer,
});
const measurement = object({
  unit: enumeration('ms', 'bytes', 'count'), method: enumeration('monotonic-cpu', 'raf-interval', 'queue-wall', 'gpu-timestamp', 'application-counter'),
  clockId: nullable(id), samples: nullable(array(number, 1, 250000)), sampleCount: integer, unavailableReason: nullable(text),
});
const summary = object({ sampleCount: integer, unavailableAttempts: integer, percentileMethod: enumeration('linear-r7'), p50: nullable(number), p95: nullable(number) });
const observation = object({
  bytes: nullable(integer), unavailableReason: nullable(text),
  method: enumeration('logical-ledger', 'native-summary', 'wasm-memory-buffer', 'js-heap-estimate', 'os-process-sample', 'driver-observation'),
  processIds: array(positive, 0, 256), samplingIntervalMs: nullable({ ...number, minimum: Number.MIN_VALUE }), attachmentSha256: nullable(hash),
});
const memory = object({
  point: memoryPoints,
  observations: object(Object.fromEntries(['ledgerLive', 'ledgerPeak', 'nativeLivePayload', 'wasmLinearCapacity', 'wasmLinearHighWater', 'jsHeapEstimate', 'browserProcess', 'workerProcess', 'gpuDriver'].map((key) => [key, observation]))),
  pendingRetirement: object({ gpuOwners: integer, blobOwners: integer, readOwners: integer }),
});
const correctness = object({
  oracle: enumeration('scene', 'source-mask', 'export', 'cycle'), expectedSha256: nullable(hash), actualSha256: hash,
  expectedCount: integer, actualCount: integer, capturedRevision: nullable(integer), absoluteError: number, membershipSha256: nullable(hash),
  numericOracle: nullable(object({ oracleSha256: hash, values: array(object({ id, actual: signedNumber }), 1, 10000) })),
});
const attempt = object({
  id, status: enumeration('completed', 'failed', 'refused', 'cancelled'), reason: nullable(text), retryOf: nullable(id),
  clock: object({ id, method: enumeration('performance.now'), unit: enumeration('ms') }),
  startedAtMs: number, operationSettledAtMs: number, resourcesRetiredAtMs: nullable(number), retirementUnavailableReason: nullable(text),
  retirementMeaning: enumeration('application-owner-joined'), warmupMs: number, idleHiddenMs: number,
  measurements: map(measurement), correctness: nullable(correctness), memory: array(memory, 0, 7),
});
const scenario = object({
  id, kind: enumeration('open-cold', 'open-warm', 'orbit', 'selection-cold', 'selection-warm', 'export', 'retention'), caseId: nullable(id), parametersSha256: hash,
  attempts: array(attempt, 1, 10000), counts: object({ total: integer, completed: integer, failed: integer, refused: integer, cancelled: integer }), summaries: map(summary),
});
export const reportShape = object({
  schemaVersion: enumeration(1), runId: id, startedAtUtc: text, endedAtUtc: text,
  evidenceClass: enumeration('synthetic-tooling', 'local-chromium', 'actual-mac'), purpose: enumeration('w09-initial-baseline'),
  target: object({ id, sha256: hash }), build: buildShape,
  cells: array(object({
    identity: cell, fixture, trace, environment,
    overdrawCheckpoints: array(object({ traceTimeMs: number, visibleProjectedSplats: integer, footprintAreaRatio: number, coveredPixelFraction: { ...number, maximum: 1 }, overlapP50: number, overlapP95: number }), 1, 10000),
    scenarios: array(scenario, 1, 1000),
  }), 1, 1024),
});
// Keep the v1 structural objects unchanged, including their additional-field
// refusal. V2 declares available observed cells instead of the legacy Mac matrix.
const observedEnvironment = object({ ...environment.properties!, browserHost: enumeration('automation', 'normal-launch') });
const observedHost = object(Object.fromEntries(Object.entries(observedEnvironment.properties!).filter(([name]) => name !== 'framebuffer')));
export const observedTargetShape = object({
  ...targetShape.properties!, schemaVersion: enumeration(2), scope: enumeration('observed-browser-initial'),
  machines: array(object({ id, tier: enumeration('observed') }), 1, 16), observedHosts: array(observedHost, 1, 256),
});
export const observedReportShape = object({
  ...reportShape.properties!, schemaVersion: enumeration(2), purpose: enumeration('observed-browser-initial-baseline'),
  evidenceClass: enumeration('synthetic-tooling', 'local-chromium', 'actual-mac', 'observed-browser'),
  cells: array(object({ ...reportShape.properties!.cells!.items!.properties!, environment: observedEnvironment }), 1, 1024),
});
export const anyTargetShape: Shape = { anyOf: [targetShape, observedTargetShape] };
export const anyReportShape: Shape = { anyOf: [reportShape, observedReportShape] };
export const expectedShape = object({ targetSha256: hash, build: buildShape });

/** Reject non-JSON objects/getters before reading values. Work is bounded independently of schema arrays. */
export function checkShape(value: unknown, shape: Shape, path: string): string[] {
  let nodes = 0;
  const preflight = (entry: unknown, depth: number): void => {
    if (++nodes > 5_000_000 || depth > 32) throw new Error('JSON node/depth bound exceeded');
    if (entry === null || typeof entry === 'string' || typeof entry === 'boolean') return;
    if (typeof entry === 'number' && Number.isFinite(entry)) return;
    if (typeof entry !== 'object') throw new Error('non-JSON value');
    const prototype = Object.getPrototypeOf(entry);
    if (prototype !== Object.prototype && prototype !== null && !Array.isArray(entry)) throw new Error('non-plain JSON object');
    if (Array.isArray(entry) && (prototype !== Array.prototype || entry.length > 250000)) throw new Error('array prototype/length bound');
    const keys = Reflect.ownKeys(entry);
    if (keys.length > 250001) throw new Error('JSON property count bound');
    if (Array.isArray(entry) && keys.length !== entry.length + 1) throw new Error('array holes/extra properties');
    for (const key of keys) {
      if (typeof key === 'symbol') throw new Error('symbol property');
      if (Array.isArray(entry) && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(entry, key)!;
      if (!descriptor.enumerable || !('value' in descriptor)) throw new Error('non-JSON property/accessor');
      preflight(descriptor.value, depth + 1);
    }
  };
  try { preflight(value, 0); } catch (error) { return [`${path}: ${error instanceof Error ? error.message : 'invalid JSON'}`]; }
  const errors: string[] = [];
  const visit = (entry: unknown, rule: Shape, at: string): void => {
    if (errors.length >= 100) return;
    const fail = (message: string): void => { errors.push(`${at}: ${message}`); };
    if (rule.anyOf) {
      const before = errors.length;
      for (const alternative of rule.anyOf) { visit(entry, alternative, at); if (errors.length === before) return; errors.splice(before); }
      fail('does not match nullable shape'); return;
    }
    if (rule.enum && !rule.enum.some((item) => item === entry)) { fail('unexpected enum value'); return; }
    if (!rule.type) return;
    if (rule.type === 'null') { if (entry !== null) fail('expected null'); return; }
    if (rule.type === 'array') {
      if (!Array.isArray(entry)) { fail('expected array'); return; }
      if (entry.length < (rule.minItems ?? 0) || entry.length > (rule.maxItems ?? Infinity)) { fail('array length out of bounds'); return; }
      for (let index = 0; index < entry.length; index++) visit(entry[index], rule.items!, `${at}[${index}]`);
      return;
    }
    if (rule.type === 'object') {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) { fail('expected object'); return; }
      const record = entry as Record<string, unknown>;
      for (const key of rule.required ?? []) if (!Object.hasOwn(record, key)) fail(`missing ${key}`);
      for (const [key, child] of Object.entries(record)) {
        const property = rule.properties && Object.hasOwn(rule.properties, key) ? rule.properties[key] : undefined;
        if (property) visit(child, property, `${at}.${key}`);
        else if (rule.additionalProperties && typeof rule.additionalProperties === 'object') visit(child, rule.additionalProperties, `${at}.${key}`);
        else fail(`unexpected ${key}`);
      }
      return;
    }
    if (rule.type === 'string') {
      if (typeof entry !== 'string') { fail('expected string'); return; }
      if (entry.length < (rule.minLength ?? 0) || entry.length > (rule.maxLength ?? Infinity) || (rule.pattern && !new RegExp(rule.pattern).test(entry))) fail('string out of bounds/pattern');
      return;
    }
    if (rule.type === 'boolean') { if (typeof entry !== 'boolean') fail('expected boolean'); return; }
    if (typeof entry !== 'number' || !Number.isFinite(entry) || (rule.type === 'integer' && !Number.isSafeInteger(entry)) || entry < (rule.minimum ?? -Infinity) || entry > (rule.maximum ?? Infinity)) fail('number out of bounds/type');
  };
  visit(value, shape, path);
  return errors;
}
