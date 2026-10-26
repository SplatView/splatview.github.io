import workerEntry from '../renderer/webgl2/compute.worker.ts?worker&url';
import { RenderComputeClient } from '../renderer/webgl2/computeClient';
import { ensureRuntime } from '../build/runtime';
import { fetchExact, verifyArtifactBytes } from '../build/verification';
import { BUILD_DESCRIPTOR } from '../generated/buildIdentity';

/** Application loading policy. A standalone renderer never enters this gate. */
export async function createVerifiedRenderCompute(): Promise<RenderComputeClient> {
  const runtime = await ensureRuntime();
  let blobUrl: string | undefined;
  try {
    let worker: Worker;
    if (runtime.mode === 'development-module-graph' && import.meta.env.DEV) {
      worker = new Worker(workerEntry, { type: 'module', name: 'splatview-render-compute' });
    } else {
      const url = new URL(workerEntry, runtime.entryUrl).href, record = runtime.verified?.artifacts.get(url);
      if (!record || record.artifact.role !== 'runtime-asset') throw new Error('The verified render executor is missing.');
      const bytes = await fetchExact(record.url, undefined, record.artifact.bytes);
      await verifyArtifactBytes(bytes, record.artifact);
      blobUrl = URL.createObjectURL(new Blob([bytes], { type: 'text/javascript' }));
      worker = new Worker(blobUrl, { type: 'module', name: 'splatview-render-compute' });
    }
    return await RenderComputeClient.connect(worker, { kind: 'application', build: BUILD_DESCRIPTOR });
  } finally { if (blobUrl) URL.revokeObjectURL(blobUrl); }
}
