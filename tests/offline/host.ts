/** Controls only the preconfigured loopback fixture host; never starts it. */
export type OfflineScope = 'root' | 'project';
export type OfflineFaultMode = 'corrupt' | 'truncate' | 'disconnect' | 'delay' | '503';
export interface OfflineFault {
  scope: OfflineScope;
  /** Exact artifact path relative to its mount, such as wasm/splatview-core.wasm. */
  path: string;
  mode: OfflineFaultMode;
  times?: number;
  delayMs?: number;
  bytes?: number;
}
export interface OfflineCounter {
  id: number;
  method: string;
  path: string;
  artifactPath: string;
  scope: OfflineScope;
  cohort: string;
  deploymentId: string;
  servedArtifact: boolean;
  fault: OfflineFaultMode | null;
  faultId: number | null;
  status: number;
  /** Payload bytes submitted to the HTTP response; excludes framing. */
  bytes: number;
  completed: boolean;
}
export interface OfflineCohortMetadata {
  id: string;
  directory: string;
  deploymentId: string;
  appInputId: string;
  coreNativeInputId: string;
  serviceWorkerSha256: string;
  manifestSha256: string;
  runtimeArtifacts: number;
  files: number;
}
export interface OfflineHostState {
  schemaVersion: 1;
  kind: 'splatview-offline-fixture-host';
  pid: number;
  origin: string;
  selected: Record<OfflineScope, string>;
  cohorts: Record<string, OfflineCohortMetadata>;
  faults: Array<Omit<OfflineFault, 'times'> & { id: number; remaining: number }>;
  counters: OfflineCounter[];
  counterGeneration: number;
  countersDropped: number;
  sequence: number;
}
export interface OfflineHostConfiguration {
  resetCounters?: boolean;
  clearFaults?: boolean;
  select?: Partial<Record<OfflineScope, string>>;
  /** Appends one-shot faults by default; clear an active fault before replacing it. */
  faults?: OfflineFault[];
}
/** Structural APIRequestContext subset: control requests bypass page service workers. */
export interface OfflineControlRequest {
  get(url: string): Promise<{ ok(): boolean; status(): number; json(): Promise<unknown>; text(): Promise<string> }>;
  post(url: string, options: { data: OfflineHostConfiguration }): Promise<{ ok(): boolean; status(): number; json(): Promise<unknown>; text(): Promise<string> }>;
}
export function offlineHost(request: OfflineControlRequest, origin = 'http://127.0.0.1:5373') {
  const host = new URL(origin);
  if (!['http:', 'https:'].includes(host.protocol) || !['127.0.0.1', 'localhost'].includes(host.hostname) ||
      host.pathname !== '/' || host.search || host.hash || host.username || host.password) throw new Error('Offline control requires a loopback origin');
  async function read(response: Awaited<ReturnType<OfflineControlRequest['get']>>): Promise<OfflineHostState> {
    if (!response.ok()) throw new Error(`Offline host control failed (${response.status()}): ${await response.text()}`);
    const state = await response.json() as OfflineHostState;
    if (state.schemaVersion !== 1 || state.kind !== 'splatview-offline-fixture-host' || !Number.isSafeInteger(state.pid) ||
        state.countersDropped !== 0) throw new Error('Invalid or truncated offline host evidence');
    return state;
  }
  const state = () => request.get(new URL('/__offline_test__/state', host).href).then(read);
  const configure = (configuration: OfflineHostConfiguration) => request.post(new URL('/__offline_test__/config', host).href, { data: configuration }).then(read);
  return { state, configure,
    reset: () => configure({ resetCounters: true, clearFaults: true }),
    select: (scope: OfflineScope, cohort: string) => configure({ select: { [scope]: cohort } }),
    fault: (...faults: OfflineFault[]) => configure({ faults }),
    clearFaults: () => configure({ clearFaults: true }),
    url: (scope: OfflineScope) => new URL(scope === 'project' ? '/project/' : '/', host).href,
  };
}
