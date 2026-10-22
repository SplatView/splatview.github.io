# Live-worker edit recovery references

The browser's operation protocol, fixed native receipt ledger, reconciliation
client, recovery UI and fault fixtures are authored for this repository.
No PlayCanvas or COLMAPView implementation was copied for this change.

The native edit and history semantics continue to come from the pinned desktop
SplatView sources recorded in `native/SOURCE_LOCK.json` and the existing source
capture. The receipt adapter wraps those desktop transactions; it does not
replay a committed edit or implement a separate browser history model.

Local design and implementation references:

- [Unknown edit outcomes](../../WEB_IMPLEMENTATION_DETAILS.md) describes the
  operation identity, receipt, retained resources, retry and publication contract.
- [Native adapter](../../native/wasm/bindings.cpp) owns identified transactions.
- [Fixed receipt ledger](../../native/wasm/operation_receipt.hpp) retains the
  terminal outcome before checkpoint release or response serialization.
- [Client protocol](../../src/document/operationProtocol.ts) validates owners,
  snapshots and terminal proof; [the worker](../../src/workers/document.worker.ts)
  preserves serial native execution while allowing independent status transport.
- [Native contracts](../../native/wasm/operation_receipt_contracts.cpp) and
  [browser faults](../../e2e/operation-recovery.spec.ts) exercise genuine native
  outcomes with missing, delayed and duplicate acknowledgements.

This covers a live worker whose transport acknowledgement was lost. Rebuilding
an actually terminated worker, offline updates, capacity benchmarks and browser
platform qualification remain separate work.
