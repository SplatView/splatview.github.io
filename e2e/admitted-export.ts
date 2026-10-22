import type { CoreClient } from '../src/document/coreClient';
import { assertResourceCredit, MiB, ResourceLedger, resourceLeaseCredit, type ResourceLease } from '../src/document/resources';

const standaloneLedgers = new WeakMap<CoreClient, ResourceLedger>();

/** Diagnostic oracle copy; encoding itself uses the fixture's actual ledger. */
export async function admittedExport(client: CoreClient, format: number, scope: number, fixtureLedger?: ResourceLedger): Promise<ArrayBuffer> {
  const actual = (client.nativeMemory as unknown as { ledger?: ResourceLedger } | undefined)?.ledger;
  // Standalone transport fixtures have no native heap owner. Give their
  // diagnostic exports a real private ledger so map-only measurements stay
  // scoped to maps; these fixtures do not qualify App heap accounting.
  let ledger = actual ?? fixtureLedger ?? standaloneLedgers.get(client);
  if (!ledger) { ledger = new ResourceLedger(256 * MiB); standaloneLedgers.set(client, ledger); }
  const plan = await client.sceneExportPlan(format, scope), signal = new AbortController().signal;
  const output = await client.exportOwned(format, scope, plan, { signal, current() { signal.throwIfAborted(); },
    admitNative: bytes => ledger.reserve('work', bytes), admitOutput: bytes => ledger.reserve('image', bytes), onAccepted() {} });
  try { return output.bytes.slice(0); }
  finally { output.dispose(); }
}

/** Observe the exact surviving native-output owner separately from scratch. */
export function exportWorkObservation(client: CoreClient, ledger: ResourceLedger) {
  const actual = ledger as unknown as {
    entries: Map<symbol, { category: string; bytes: number }>;
    identities: WeakMap<ResourceLease, symbol>;
  };
  const native = client as unknown as {
    exportOutputLease?: ResourceLease;
    lastAllocation?: { exportOutputBytes?: number };
  };
  const owner = native.exportOutputLease, nativeBytes = native.lastAllocation?.exportOutputBytes ?? 0;
  let retainedId: symbol | undefined;
  if (owner) {
    assertResourceCredit(resourceLeaseCredit(owner), owner.bytes);
    retainedId = actual.identities.get(owner);
    const entry = retainedId === undefined ? undefined : actual.entries.get(retainedId);
    if (!ledger.owns(owner, 'work') || !entry || entry.category !== 'work' || entry.bytes !== owner.bytes ||
        owner.bytes !== nativeBytes || client.nativeMemory && !client.nativeMemory.covers(owner))
      throw new Error('The export observation has no matching retained native-output credit.');
  } else if (nativeBytes !== 0) throw new Error('Native export output has no observed retained credit.');
  const transient = { allocations: 0, bytes: 0 }, retainedExport = { allocations: 0, bytes: 0 };
  for (const [id, entry] of actual.entries) if (entry.category === 'work') {
    const target = id === retainedId ? retainedExport : transient;
    target.allocations++; target.bytes += entry.bytes;
  }
  const total = ledger.categorySnapshot.work;
  if (total.allocations !== transient.allocations + retainedExport.allocations || total.bytes !== transient.bytes + retainedExport.bytes)
    throw new Error('The export observation omitted a work credit.');
  return { transient, retainedExport, total };
}
