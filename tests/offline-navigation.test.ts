import { afterEach, describe, expect, it, vi } from 'vitest';
import { commitUpdateNavigation, UPDATE_NAVIGATION_TIMEOUT_MS, type UpdateNavigationEnvironment } from '../src/offline/navigation';

function fixture() {
  const events = new Map<string, Set<() => void>>();
  const environment: UpdateNavigationEnvironment = {
    location: { assign: vi.fn() }, stop: vi.fn(),
    addEventListener: (type, listener) => { const bucket = events.get(type) ?? new Set(); bucket.add(listener); events.set(type, bucket); },
    removeEventListener: (type, listener) => { events.get(type)?.delete(listener); },
  };
  return { environment, emit: (type: string) => { for (const listener of events.get(type) ?? []) listener(); },
    listeners: () => [...events.values()].reduce((count, bucket) => count + bucket.size, 0) };
}
afterEach(() => vi.useRealTimers());
describe('owned application-update navigation', () => {
  it('keeps navigation pending until a real commit acknowledgement', async () => {
    const f = fixture(); let commit!: () => void;
    const committed = new Promise<void>(resolve => { commit = resolve; });
    f.environment.navigation = { navigate: vi.fn(() => ({ committed, finished: committed })) };
    let done = false;
    const pending = commitUpdateNavigation('https://example.test/project/?__splatview_update=ticket', f.environment).then(() => { done = true; });
    await Promise.resolve(); expect(done).toBe(false);
    expect(f.environment.location.assign).not.toHaveBeenCalled();
    commit(); await pending; expect(done).toBe(true); expect(f.listeners()).toBe(0);
  });
  it('reports browser cancellation without claiming a reload or stopping other work', async () => {
    const f = fixture(), cancelled = Promise.reject(new DOMException('Navigation cancelled', 'AbortError'));
    f.environment.navigation = { navigate: () => ({ committed: cancelled, finished: cancelled }) };
    await expect(commitUpdateNavigation('https://example.test/', f.environment)).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.environment.stop).not.toHaveBeenCalled(); expect(f.listeners()).toBe(0);
  });
  it('uses pagehide acknowledgement on browsers with the older location API', async () => {
    const f = fixture(); let done = false;
    const pending = commitUpdateNavigation('https://example.test/project/', f.environment).then(() => { done = true; });
    expect(f.environment.location.assign).toHaveBeenCalledExactlyOnceWith('https://example.test/project/');
    await Promise.resolve(); expect(done).toBe(false);
    f.emit('pagehide'); await pending; expect(done).toBe(true); expect(f.listeners()).toBe(0);
  });
  it('actively stops an uncommitted legacy navigation before returning a bounded refusal', async () => {
    vi.useFakeTimers(); const f = fixture(), order: string[] = [];
    f.environment.stop = vi.fn(() => { order.push('stopped'); });
    const pending = commitUpdateNavigation('https://example.test/', f.environment).catch(error => { order.push('refused'); throw error; });
    const refusal = expect(pending).rejects.toThrow('was stopped');
    await vi.advanceTimersByTimeAsync(UPDATE_NAVIGATION_TIMEOUT_MS); await refusal;
    expect(order).toEqual(['stopped', 'refused']); expect(f.listeners()).toBe(0);
  });
  it('does not stop a successful pagehide later when the old deadline elapses', async () => {
    vi.useFakeTimers(); const f = fixture(), pending = commitUpdateNavigation('https://example.test/', f.environment);
    f.emit('pagehide'); await pending; await vi.advanceTimersByTimeAsync(UPDATE_NAVIGATION_TIMEOUT_MS);
    expect(f.environment.stop).not.toHaveBeenCalled(); expect(f.listeners()).toBe(0);
  });
  it('cleans up an inactive document refusal from the navigation API', async () => {
    const f = fixture();
    f.environment.navigation = { navigate: () => { throw new DOMException('Inactive document', 'InvalidStateError'); } };
    await expect(commitUpdateNavigation('https://example.test/', f.environment)).rejects.toMatchObject({ name: 'InvalidStateError' });
    expect(f.listeners()).toBe(0);
  });
  it('refuses a navigation result without a commit promise', async () => {
    const f = fixture();
    f.environment.navigation = { navigate: () => ({}) };
    await expect(commitUpdateNavigation('https://example.test/', f.environment)).rejects.toThrow('did not start');
    expect(f.listeners()).toBe(0); expect(f.environment.stop).not.toHaveBeenCalled();
  });
});
