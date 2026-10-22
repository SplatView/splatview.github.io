import assert from 'node:assert/strict';
import { test } from 'vitest';
import { BENCHMARK_GLOBAL_KEY, benchmarkQueryEnabled, installProductionBenchmarkBridge,
  type BenchmarkBridgeController, type BenchmarkBridgeOptions, type BenchmarkBridgeTarget, type ProductionBenchmarkBridge } from '../src/app/benchmarkBridge';
import type { BenchmarkFrameObservation, BenchmarkMaskObservation } from '../src/app/benchmarkObservation';
import type { RuntimeContext } from '../src/build/runtime';
import type { BuildArtifact, BuildDescriptor } from '../src/build/contracts';

const FLAG = '?__splatview_benchmark=1';
const CAMERA = [0, 0, 0, 0, 0, 24, 1, 45, 1, 0, 1.6];
function runtimeFixture(): RuntimeContext {
  const descriptor: BuildDescriptor = {
    schemaVersion: 1, appInputId: 'a'.repeat(64), protocolVersion: 24, uiWorkerContract: 20,
    native: {
      core: { schemaVersion: 1, kind: 'core', abi: 18, variant: 'scalar', nativeInputId: 'b'.repeat(64), mapLayoutVersion: 1, capabilities: { test: 1 } },
      camera: { schemaVersion: 1, kind: 'camera', abi: 4, variant: 'scalar', nativeInputId: 'b'.repeat(64), capabilities: { test: 1 } },
    },
  };
  const artifacts: BuildArtifact[] = Array.from({ length: 97 }, (_, index) => ({
    role: index === 0 ? 'application-entry' : 'runtime-asset', path: `assets/test-${index}.js`, bytes: index + 100, sha256: 'c'.repeat(64),
  }));
  return {
    mode: 'production-verified', descriptor, assetBase: 'https://example.test/viewer/', entryUrl: 'https://example.test/viewer/assets/test-0.js',
    verified: {
      manifest: { schemaVersion: 1, deploymentId: 'd'.repeat(64), build: descriptor, artifacts },
      manifestUrl: 'https://example.test/viewer/build-manifest.json', assetBase: 'https://example.test/viewer/',
      artifacts: new Map(artifacts.map(artifact => [artifact.path, { artifact, url: `https://example.test/viewer/${artifact.path}` }])),
    },
    artifacts: new Map([['application-entry', { artifact: artifacts[0]!, url: 'https://example.test/viewer/assets/test-0.js', bytes: new Uint8Array([99, 88, 77]).buffer }]]),
  };
}
function frameFixture(): BenchmarkFrameObservation {
  return {
    sequence: 7, status: 'completed', clock: 'performance.now', rafAtMs: 10, drawStartedAtMs: 11,
    submissionObservedAtMs: 12, submissionBoundary: 'render-return-after-confirmed-queue-submit', queueSettledAtMs: 13, queueCompletedAtMs: 13,
    deviceEpoch: 1, rendererSubmissionSequence: 5, documentRevision: null, sceneRevision: 2,
    camera: { revision: 4, state: [...CAMERA], view: [1], projection: [2], eye: [0, 0, 24] },
    framebuffer: { width: 1280, height: 800, devicePixelRatio: 1 }, visibility: 'visible', error: null, staleReason: null,
    presentation: { available: false, reason: 'unobserved presentation' }, gpuTimestamps: { available: false, reason: 'unavailable GPU clock' },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function maskFixture():BenchmarkMaskObservation{
  const owner={clientOwnerId:1,rendererOwnerId:2,sceneOwnerId:3,cameraOwnerId:4,documentRevision:null,camera:null,scene:null,
    deviceEpoch:1,rendererSubmissionSequence:5,framebuffer:{width:1280,height:800,devicePixelRatio:1},visibility:'visible'};
  return{schemaVersion:1,kind:'splatview-controller-benchmark-mask',status:'completed',clock:'performance.now',startedAtMs:10,settledAtMs:11,
    before:owner,after:structuredClone(owner),sourceCount:3,byteLength:3,encoding:'base64',bytesBase64:'AAEC',callbacks:1,
    summary:{canUndo:true,canRedo:false},error:null,staleReason:null};
}
function setup(overrides: BenchmarkBridgeOptions = {}) {
  const target: BenchmarkBridgeTarget = {}, context = runtimeFixture();
  const counts = { enabled: 0, disabled: 0, runtime: 0, clock: 0, snapshots: 0, cameraSnapshots: 0, invalidated: 0, closed: 0 };
  const events: string[] = [], cameraCalls: number[][] = [], waitCalls: number[][] = [];
  const state = { enabled: false, hasScene: true, navigationPrompt: false, nested: { owners: [1, 2] } };
  let close: () => Promise<void> = async () => { state.hasScene = false; };
  let wait: () => Promise<BenchmarkFrameObservation> = async () => frameFixture();
  const capacities: (number | undefined)[] = [];
  const controller: BenchmarkBridgeController = {
    enableBenchmarkObservation(options) { counts.enabled++; capacities.push(options?.maxFrames); state.enabled = true; events.push('enable');
      return () => { counts.disabled++; state.enabled = false; events.push('disable'); }; },
    benchmarkSnapshot() { counts.snapshots++; events.push('snapshot'); return state; },
    benchmarkCameraSnapshot() { counts.cameraSnapshots++; events.push('camera-snapshot'); return { camera: { revision: cameraCalls.length,
      state: [...cameraCalls.at(-1)!], view: [1, 0], projection: [2, 0], eye: [0, 0, 24] },
      observation: { enabled: state.enabled, lastFrameSequence: 6 }, renderer: { deviceEpoch: 1, frameSubmissionSequence: 5 } }; },
    async readBenchmarkMasks(){throw new Error('No mask fixture was installed.');},
    async joinBenchmarkQueries(){},
    waitForBenchmarkFrame(after, timeout) { waitCalls.push([after, timeout!]); return wait(); },
    camera: { set(value) { cameraCalls.push(value); events.push('camera'); } },
    invalidate() { counts.invalidated++; events.push('invalidate'); },
    async closeScene() { counts.closed++; events.push('close'); await close(); },
  };
  const options: BenchmarkBridgeOptions = {
    search: FLAG, target,
    runtime: async () => { counts.runtime++; return context; },
    clock: { timeOrigin: 1700000000000, now: () => { counts.clock++; return 100 + counts.clock; } },
    ...overrides,
  };
  const detach = installProductionBenchmarkBridge(controller, options);
  const api = target[BENCHMARK_GLOBAL_KEY] as ProductionBenchmarkBridge | undefined;
  return { target, context, counts, events, capacities, cameraCalls, waitCalls, state, controller, options, detach, api,
    setClose(value: () => Promise<void>) { close = value; }, setWait(value: () => Promise<BenchmarkFrameObservation>) { wait = value; } };
}

test('benchmark opt-in requires one literal exact flag while preserving unrelated query parameters', () => {
  assert.equal(benchmarkQueryEnabled(FLAG), true);
  assert.equal(benchmarkQueryEnabled('?scene=example&__splatview_benchmark=1&other=value'), true);
  for (const query of ['', '?', '?__splatview_benchmark', '?__splatview_benchmark=0', '?__splatview_benchmark=true',
    '?__splatview_benchmark=01', '?__splatview_benchmark=1&__splatview_benchmark=1',
    '?__splatview_benchmark=1&%5F_splatview_benchmark=1', '?%5F_splatview_benchmark=1',
    '?__splatview_benchmark=%31', '?__SPLATVIEW_BENCHMARK=1', '?other=__splatview_benchmark=1', '#__splatview_benchmark=1'])
    assert.equal(benchmarkQueryEnabled(query), false, query);
});

test('ordinary URLs create no global, controller observation, runtime fetch or clock reads', () => {
  const fixture = setup({ search: '?scene=example' }); fixture.detach(); fixture.detach();
  assert.equal(fixture.api, undefined); assert.deepEqual(Object.getOwnPropertyNames(fixture.target), []);
  assert.deepEqual(fixture.counts, { enabled: 0, disabled: 0, runtime: 0, clock: 0, snapshots: 0, cameraSnapshots: 0, invalidated: 0, closed: 0 });
});

test('native mask bridge returns bounded detached bytes and actual summary without a full controller snapshot',async()=>{
  const fixture=setup(),value=maskFixture();fixture.controller.readBenchmarkMasks=async()=>value;
  const result=await fixture.api!.readMasks();assert.equal(result.kind,'splatview-production-benchmark-mask');
  assert.equal(result.observation.bytesBase64,'AAEC');assert.deepEqual(result.observation.summary,{canUndo:true,canRedo:false});
  assert.equal(fixture.counts.snapshots,0);assert.equal(result.runtime.appInputId,fixture.context.descriptor.appInputId);
  value.before.framebuffer!.width=1;assert.equal(result.observation.before.framebuffer!.width,1280);assert(Object.isFrozen(result.observation));fixture.detach();
});
test('stop joins the admitted native mask read before detaching its observer',async()=>{
  const fixture=setup(),held=deferred<BenchmarkMaskObservation>();let entered=false;
  fixture.controller.readBenchmarkMasks=()=>{entered=true;return held.promise;};
  const read=fixture.api!.readMasks();await Promise.resolve();await Promise.resolve();assert(entered);
  let stopped=false;const stop=fixture.api!.stop().then(()=>{stopped=true;});await Promise.resolve();assert.equal(stopped,false);
  await assert.rejects(fixture.api!.readMasks(),/inactive/);held.resolve(maskFixture());await read;await stop;
  assert.equal(fixture.counts.disabled,1);assert.equal(fixture.target[BENCHMARK_GLOBAL_KEY],undefined);
});
test('close joins an admitted mask read while preserving the immediate empty-read public boundary',async()=>{
  const fixture=setup(),held=deferred<BenchmarkMaskObservation>();let entered=false;
  fixture.controller.readBenchmarkMasks=()=>{entered=true;return held.promise;};
  const read=fixture.api!.readMasks();await Promise.resolve();await Promise.resolve();assert(entered);
  const close=fixture.api!.closeScene();assert.equal(fixture.counts.closed,0);
  await assert.rejects(fixture.api!.readMasks(),/close is pending/);
  held.resolve(maskFixture());await read;await close;assert.equal(fixture.counts.closed,1);fixture.detach();
});

test('installation is immediate, bounded, frozen and non-enumerable without reading clocks or awaiting runtime', () => {
  const fixture = setup();
  assert.equal(fixture.counts.enabled, 1); assert.deepEqual(fixture.capacities, [4096]);
  assert.equal(fixture.counts.runtime, 0); assert.equal(fixture.counts.clock, 0);
  assert.equal(fixture.api!.schemaVersion, 1); assert.equal(fixture.api!.kind, 'splatview-production-benchmark-bridge');
  assert(Object.isFrozen(fixture.api)); assert.deepEqual(Object.keys(fixture.target), []);
  assert.equal(Object.getOwnPropertyDescriptor(fixture.target, BENCHMARK_GLOBAL_KEY)!.writable, false);
  fixture.detach(); assert.equal(fixture.counts.disabled, 1);
});

test('explicit observation limits pass through while invalid limits enable nothing', () => {
  const bounded = setup({ maxFrames: 8192 }); assert.deepEqual(bounded.capacities, [8192]); bounded.detach();
  for (const maxFrames of [0, -1, 8193, 1.5, NaN, Infinity]) {
    const fixture = setup({ maxFrames }); assert.equal(fixture.api, undefined); assert.equal(fixture.counts.enabled, 0);
  }
});

test('duplicate installation preserves another global and does not create a second observation owner', () => {
  const fixture = setup(), first = fixture.api;
  const duplicate = installProductionBenchmarkBridge(fixture.controller, fixture.options);
  assert.equal(fixture.target[BENCHMARK_GLOBAL_KEY], first); assert.equal(fixture.counts.enabled, 1);
  duplicate(); assert.equal(fixture.target[BENCHMARK_GLOBAL_KEY], first); assert.equal(fixture.counts.disabled, 0);
  fixture.detach(); assert.equal(fixture.counts.disabled, 1);
});

test('inherited or explicitly undefined globals also retain their existing ownership', () => {
  for (const target of [Object.create({ [BENCHMARK_GLOBAL_KEY]: { owner: 'prototype' } }) as BenchmarkBridgeTarget,
    { [BENCHMARK_GLOBAL_KEY]: undefined }]) {
    const fixture = setup({ target }); assert.equal(fixture.counts.enabled, 0); fixture.detach();
    assert(Reflect.has(target, BENCHMARK_GLOBAL_KEY));
  }
});

test('cleanup is idempotent, refuses stale handles, and preserves a replacement global', async () => {
  const fixture = setup(), replacement = Object.freeze({ owner: 'replacement' });
  Object.defineProperty(fixture.target, BENCHMARK_GLOBAL_KEY, { value: replacement, configurable: true });
  await assert.rejects(fixture.api!.snapshot(), /inactive|owns/); assert.equal(fixture.counts.runtime, 0);
  fixture.detach(); fixture.detach();
  assert.equal(fixture.target[BENCHMARK_GLOBAL_KEY], replacement); assert.equal(fixture.counts.disabled, 1);
  await assert.rejects(fixture.api!.setCamera(CAMERA), /inactive|owns/); assert.equal(fixture.cameraCalls.length, 0);
});

test('installation failures and throwing instrumentation cleanup do not escape into viewer lifecycle', () => {
  const blocked = setup({ target: Object.preventExtensions({}) });
  assert.equal(blocked.counts.enabled, 1); assert.equal(blocked.counts.disabled, 1); assert.equal(blocked.api, undefined);
  const fixture = setup(); fixture.detach();
  fixture.controller.enableBenchmarkObservation = () => { throw new Error('observer failed'); };
  assert.doesNotThrow(() => installProductionBenchmarkBridge(fixture.controller, fixture.options)());
  fixture.controller.enableBenchmarkObservation = () => () => { throw new Error('unsubscribe failed'); };
  const cleanup = installProductionBenchmarkBridge(fixture.controller, fixture.options);
  assert.doesNotThrow(cleanup); assert.equal(fixture.target[BENCHMARK_GLOBAL_KEY], undefined);
});

test('snapshot binds actual runtime provider identities and all verified artifact metadata without executable buffers', async () => {
  const fixture = setup(), snapshot = await fixture.api!.snapshot();
  assert.equal(snapshot.runtime.mode, 'production-verified'); assert.equal(snapshot.runtime.appInputId, 'a'.repeat(64));
  assert.equal(snapshot.runtime.deploymentId, 'd'.repeat(64)); assert.equal(snapshot.runtime.artifacts.length, 97);
  assert.deepEqual(snapshot.runtime.artifacts[96], { ...fixture.context.verified!.manifest.artifacts[96], url: 'https://example.test/viewer/assets/test-96.js' });
  assert.deepEqual(snapshot.clock, { id: 'performance.now:1700000000000', timeOrigin: 1700000000000, now: 101, method: 'performance.now' });
  assert.equal(fixture.counts.runtime, 1); assert.equal(fixture.counts.clock, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(snapshot.runtime.artifacts[0], 'buffer'), false);
  assert.equal(JSON.stringify(snapshot).includes('99,88,77'), false);
  fixture.detach();
});

test('snapshot recursively detaches and freezes live descriptor, metadata and controller values', async () => {
  const fixture = setup(), snapshot = await fixture.api!.snapshot();
  assert(Object.isFrozen(snapshot)); assert(Object.isFrozen(snapshot.runtime.descriptor.native.core.capabilities));
  assert(Object.isFrozen(snapshot.runtime.artifacts)); assert(Object.isFrozen(snapshot.runtime.artifacts[0]));
  const observed = snapshot.controller as typeof fixture.state;
  assert(Object.isFrozen(observed.nested.owners)); assert.notEqual(observed.nested.owners, fixture.state.nested.owners);
  fixture.state.nested.owners.push(3); fixture.context.descriptor.native.core.capabilities.test = 9;
  fixture.context.verified!.manifest.artifacts[0]!.bytes = 999;
  assert.deepEqual(observed.nested.owners, [1, 2]); assert.equal(snapshot.runtime.descriptor.native.core.capabilities.test, 1);
  assert.equal(snapshot.runtime.artifacts[0]!.bytes, 100); assert.equal(Object.isFrozen(fixture.state), false);
  assert.throws(() => { observed.nested.owners.push(4); }); fixture.detach();
});

test('development runtime stays distinct and cannot acquire a production deployment identity', async () => {
  const fixture = setup(); fixture.context.mode = 'development-module-graph'; fixture.context.verified = undefined;
  const snapshot = await fixture.api!.snapshot(); assert.equal(snapshot.runtime.mode, 'development-module-graph');
  assert.equal(snapshot.runtime.deploymentId, null); assert.equal(snapshot.runtime.artifacts.length, 1); fixture.detach();
});

test('production snapshot fails when actual verified metadata is absent', async () => {
  const fixture = setup(); fixture.context.verified = undefined;
  await assert.rejects(fixture.api!.snapshot(), /metadata is unavailable/); fixture.detach();
});

test('a snapshot awaiting runtime cannot read controller state after its bridge was detached', async () => {
  const pending = deferred<RuntimeContext>(), fixture = setup({ runtime: () => pending.promise });
  const result = fixture.api!.snapshot(); fixture.detach(); pending.resolve(fixture.context);
  await assert.rejects(result, /inactive|owns/); assert.equal(fixture.counts.snapshots, 0); assert.equal(fixture.counts.clock, 0);
});

test('frame wait delegates the actual sequence/timeout and detaches returned observation data', async () => {
  const fixture = setup(), original = frameFixture(); fixture.setWait(async () => original);
  const frame = await fixture.api!.waitForFrame(4, 2500);
  assert.deepEqual(fixture.waitCalls, [[4, 2500]]); assert.deepEqual(frame, original); assert.notEqual(frame, original);
  assert(Object.isFrozen(frame.camera.state)); assert.notEqual(frame.camera.state, original.camera.state);
  assert.equal(frame.presentation.available, false); assert.equal(frame.queueCompletedAtMs, 13); fixture.detach();
});

test('invalid frame wait parameters never reach controller wait ownership', async () => {
  const fixture = setup();
  for (const [after, timeout] of [[-1, 100], [1.5, 100], [NaN, 100], [0, 0], [0, 60001], [0, Infinity]])
    await assert.rejects(fixture.api!.waitForFrame(after!, timeout!), /sequence|timeout/);
  assert.deepEqual(fixture.waitCalls, []); fixture.detach();
});

test('completed frame from an obsolete bridge handle is rejected after awaiting', async () => {
  const pending = deferred<BenchmarkFrameObservation>(), fixture = setup(); fixture.setWait(() => pending.promise);
  const result = fixture.api!.waitForFrame(0); fixture.detach(); pending.resolve(frameFixture());
  await assert.rejects(result, /inactive|owns/);
});

test('camera commands normalize float32 values, mutate actual camera and invalidate without waiting for a frame', async () => {
  const fixture = setup(), camera = [...CAMERA]; camera[3] = 0.1;
  const snapshot = await fixture.api!.setCamera(camera);
  assert.equal(fixture.cameraCalls.length, 1); assert.equal(fixture.cameraCalls[0]![3], Math.fround(0.1));
  assert.notEqual(fixture.cameraCalls[0], camera); assert.equal(fixture.counts.invalidated, 1); assert.deepEqual(fixture.waitCalls, []);
  assert.equal(snapshot.kind, 'splatview-production-benchmark-snapshot'); assert.equal(camera[3], 0.1); fixture.detach();
});

test('invalid camera types, descriptors, numeric ranges and float32 underflow never mutate controller state', async () => {
  const fixture = setup(), invalid: unknown[] = [null, {}, new Float32Array(CAMERA), CAMERA.slice(0, 10), [...CAMERA, 1]];
  for (const [index, value] of [[0, NaN], [1, Infinity], [2, Number.MAX_VALUE], [5, 0], [5, -1], [5, Number.MIN_VALUE],
    [6, 0], [10, 0], [10, Number.MIN_VALUE], [7, 9], [7, 121], [8, 0.5], [8, 1 + Number.EPSILON]]) {
    const state = [...CAMERA]; state[index!] = value!; invalid.push(state);
  }
  const hole = [...CAMERA]; delete hole[0]; invalid.push(hole);
  const accessor = [...CAMERA]; Object.defineProperty(accessor, '0', { get() { throw new Error('getter must not execute'); }, enumerable: true }); invalid.push(accessor);
  const extra = [...CAMERA]; Object.defineProperty(extra, 'extra', { value: 1 }); invalid.push(extra);
  const inherited = [...CAMERA]; Object.setPrototypeOf(inherited, {}); invalid.push(inherited);
  for (const state of invalid) {
    await assert.rejects(fixture.api!.setCamera(state), /Benchmark camera/);
    await assert.rejects(fixture.api!.applyCamera(state), /Benchmark camera/);
  }
  assert.deepEqual(fixture.cameraCalls, []); assert.equal(fixture.counts.invalidated, 0); assert.equal(fixture.counts.runtime, 0); fixture.detach();
});

test('uninitialized camera fails visibly without invalidation', async () => {
  const fixture = setup(); fixture.controller.camera = undefined;
  await assert.rejects(fixture.api!.setCamera(CAMERA), /not initialized/); assert.equal(fixture.counts.invalidated, 0); fixture.detach();
});

test('lean camera boundary copies actual camera identity without copying frame history or artifact metadata', async () => {
  const fixture = setup(), camera = [...CAMERA]; camera[3] = .1;
  fixture.controller.benchmarkSnapshot = () => { throw new Error('Full history must not be read.'); };
  Object.defineProperty(fixture.context.verified!, 'artifacts', { get() { throw new Error('Artifact inventory must not be copied per action.'); } });
  const observed = await fixture.api!.applyCamera(camera);
  assert.equal(observed.kind, 'splatview-production-benchmark-camera');
  assert.deepEqual(observed.runtime, { mode: 'production-verified', appInputId: 'a'.repeat(64), deploymentId: 'd'.repeat(64) });
  const data = observed.controller as { camera: { revision: number; state: number[] }; observation: { lastFrameSequence: number } };
  assert.equal(data.camera.revision, 1); assert.equal(data.camera.state[3], Math.fround(.1));
  assert.equal(data.observation.lastFrameSequence, 6); assert(Object.isFrozen(data.camera.state));
  assert.equal(fixture.counts.cameraSnapshots, 1); assert.equal(fixture.counts.snapshots, 0); assert.deepEqual(fixture.waitCalls, []);
  fixture.cameraCalls[0]![3] = 999; assert.equal(data.camera.state[3], Math.fround(.1)); fixture.detach();
});

test('lean camera mutation awaiting runtime cannot outlive its observation owner', async () => {
  const pending = deferred<RuntimeContext>(), fixture = setup({ runtime: () => pending.promise });
  const result = fixture.api!.applyCamera(CAMERA); fixture.detach(); pending.resolve(fixture.context);
  await assert.rejects(result, /inactive|owns/); assert.deepEqual(fixture.cameraCalls, []); assert.equal(fixture.counts.cameraSnapshots, 0);
});

test('lean camera commands refuse missing verified metadata before mutating the actual camera', async () => {
  const fixture = setup(); fixture.context.verified = undefined;
  await assert.rejects(fixture.api!.applyCamera(CAMERA), /metadata is unavailable/);
  assert.deepEqual(fixture.cameraCalls, []); assert.equal(fixture.counts.invalidated, 0); fixture.detach();
});

test('closeScene awaits the actual public boundary and retains a refused close in returned state', async () => {
  const pending = deferred<void>(), fixture = setup(); fixture.setClose(() => pending.promise);
  const result = fixture.api!.closeScene(); assert.equal(fixture.counts.closed, 1); assert.equal(fixture.counts.snapshots, 0);
  fixture.state.navigationPrompt = true; pending.resolve();
  const snapshot = await result, state = snapshot.controller as typeof fixture.state;
  assert.equal(state.hasScene, true); assert.equal(state.navigationPrompt, true); fixture.detach();
});

test('stop snapshots before observation cleanup, removes only its global, and preserves the detached final data', async () => {
  const fixture = setup(), snapshot = await fixture.api!.stop();
  assert.equal((snapshot.controller as typeof fixture.state).enabled, true); assert.equal(fixture.state.enabled, false);
  assert.deepEqual(fixture.events, ['enable', 'snapshot', 'disable']); assert.equal(fixture.target[BENCHMARK_GLOBAL_KEY], undefined);
  fixture.detach(); assert.equal(fixture.counts.disabled, 1); await assert.rejects(fixture.api!.snapshot(), /inactive|owns/);
});

test('stop joins cleanup even when the runtime snapshot fails', async () => {
  const fixture = setup({ runtime: async () => { throw new Error('actual runtime unavailable'); } });
  await assert.rejects(fixture.api!.stop(), /actual runtime unavailable/);
  assert.equal(fixture.counts.disabled, 1); assert.equal(fixture.target[BENCHMARK_GLOBAL_KEY], undefined);
});
