import { describe, expect, it } from 'vitest';
import { DEFAULT_STEADY_SETTINGS, validateSteadySettings } from '../src/renderer/steadySettings';
import { invertMatrix, multiplyMatrices, SteadyFrameState, supportsSteadyProjection } from '../src/renderer/steadyState';
import { planSteadyResources } from '../src/renderer/webgpu/steadyState';
import { spatiotemporalBlueNoiseData } from '../src/renderer/steadyNoise';

const limits = { maxTextureDimension2D: 8192, maxBufferSize: 256 * 1024 ** 2,
  maxStorageBufferBindingSize: 128 * 1024 ** 2, maxComputeWorkgroupsPerDimension: 65535 };
const settings = { ...DEFAULT_STEADY_SETTINGS, mode: 'steady' as const };
const identity = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
const projection = [1,0,0,0,0,1,0,0,0,0,-1.001,-1,0,0,-.1001,0];
function fixture() {
  const floats = new Float32Array(80); floats.set(identity); floats.set(projection,16);
  return { scene: {}, revision: 1, uniform: new Uint32Array(floats.buffer), shade: 0 };
}
describe('SteadySplats display contract', () => {
  it('keeps sorted defaults and rejects invalid runtime settings', () => {
    expect(DEFAULT_STEADY_SETTINGS).toMatchObject({ mode: 'sorted', historyWeight: .7, convergenceFrames: 16 });
    for (const patch of [{ historyWeight: NaN },{ historyWeight: 1 },{ convergenceFrames: 0 },{ convergenceFrames: 1025 },{ convergenceFrames: 1.5 },{ animate: 1 },{ mode: 'unknown' }])
      expect(() => validateSteadySettings({ ...settings,...patch } as typeof settings)).toThrow();
  });
  it('admits all full-resolution bytes and stripes 1080p at the portable binding limit', () => {
    const plan = planSteadyResources(1920,1080,limits);
    expect(plan.stripes.length).toBeGreaterThan(1);
    expect(plan.bytes).toBe(1920*1080*136+65536+plan.stripes.length*240);
    expect(plan.stripes.reduce((sum,s) => sum+s.rows,0)).toBe(1080);
    for (const s of plan.stripes) expect(s.rows*1920*68).toBeLessThanOrEqual(limits.maxStorageBufferBindingSize);
    expect(plan.stripes[1].start).toBe(plan.stripes[0].rows);
    for (const size of [[0,1],[1,-1],[8193,1],[1.5,2]]) expect(() => planSteadyResources(size[0],size[1],limits)).toThrow();
    expect(() => planSteadyResources(4096,1,{ ...limits,maxStorageBufferBindingSize: 4096 })).toThrow();
  });
  it('requires a finite supported perspective projection', () => {
    expect(supportsSteadyProjection(projection)).toBe(true);
    expect(supportsSteadyProjection(identity)).toBe(false);
    for (const i of [1,2,3,4,6,7,11,15]) { const p=[...projection]; p[i]=.1; expect(supportsSteadyProjection(p)).toBe(false); }
    expect(supportsSteadyProjection([...projection.slice(0,15),NaN])).toBe(false);
  });
  it('reprojects with column-major inverse matrices', () => {
    const view=[...identity]; view[12]=2; view[13]=-3; view[14]=-5;
    const vp=multiplyMatrices(projection,view), inverse=invertMatrix(vp);
    const roundtrip=multiplyMatrices(vp,inverse);
    for (let i=0;i<16;i++) expect(roundtrip[i]).toBeCloseTo(identity[i],4);
    expect(() => invertMatrix(new Float32Array(16))).toThrow(/singular/);
  });
  it('refines exactly 16 stationary samples then retains its reconstructed image', () => {
    const state=new SteadyFrameState(), frame=fixture();
    expect(state.observe(frame,settings)).toMatchObject({ valid: false,still: false,restFrames: 0,needsMore: true });
    for (let i=1;i<=16;i++) expect(state.observe(frame,settings)).toMatchObject({ valid: true,still: true,restFrames: i,reconstruct: true,needsMore: i<16 });
    expect(state.observe(frame,settings)).toMatchObject({ reconstruct: false,needsMore: false,restFrames: 16 });
    expect(state.frame).toBe(17);
  });
  it('preserves moving-camera history and restarts the independent stationary average', () => {
    const state=new SteadyFrameState(), frame=fixture();
    state.observe(frame,settings); state.observe(frame,settings);
    frame.uniform[12]++; frame.uniform[32]++;
    expect(state.observe(frame,settings)).toMatchObject({ valid: true,still: false,restFrames: 0 });
    expect(state.observe(frame,settings)).toMatchObject({ valid: true,still: true,restFrames: 1 });
  });
  for (const field of ['scene','revision','shade',16,35,36,44,59,60,78,79] as const) it(`invalidates history after display dependency ${field}`, () => {
    const state=new SteadyFrameState(), frame=fixture(); state.observe(frame,settings); state.observe(frame,settings);
    if (typeof field==='number') frame.uniform[field]++;
    else if (field==='scene') frame.scene={}; else frame[field]++;
    expect(state.observe(frame,settings)).toMatchObject({ valid: false,still: false,restFrames: 0 });
  });
  it('does not read borrowed uniform mutations or request refinement with temporal reuse disabled', () => {
    const state=new SteadyFrameState(), frame=fixture(); state.observe(frame,settings);
    frame.uniform[44]++;
    expect(state.observe(frame,{ ...settings,historyWeight: 0 })).toMatchObject({ valid: false,needsMore: false,restFrames: 0 });
    expect(state.observe(frame,{ ...settings,animate: false })).toMatchObject({ sampleFrame: 0,needsMore: false });
    state.reset(); expect(state.valid).toBe(false); expect(state.frame).toBe(0);
  });
  it('decodes the pinned STBN volume with complete scalar ranks', () => {
    const data=spatiotemporalBlueNoiseData(); expect(data.byteLength).toBe(65536);
    const counts=new Uint32Array(256); for (const value of data) counts[value]++;
    expect(Array.from(counts).every(count => count===256)).toBe(true);
  });
});
