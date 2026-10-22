import type { SceneCommand } from '../document/types';

export type SelectionRunResult = boolean | { kind: 'computation-failed'; version: 1 };
type SelectionUpdate = SceneCommand | (() => Promise<SceneCommand | undefined>);
type PendingUpdate = { value: SelectionUpdate; revision: number; livePreview: boolean };

function isComputationFailure(value: unknown): value is Exclude<SelectionRunResult, boolean> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    'kind' in value && value.kind === 'computation-failed' && 'version' in value && value.version === 1;
}

// Updates are absolute shapes/full brush paths. Coalescing never drops a stroke
// segment, and every result is evaluated against the native gesture baseline.
export class SelectionSession {
  private latest?: PendingUpdate;
  private draining?: Promise<void>;
  private started?: Promise<SelectionRunResult | undefined>;
  private finishing?: Promise<boolean>;
  private cancellation?: Promise<boolean>;
  private restoration?: Promise<boolean>;
  private cancelled = false;
  private failed = false;
  private deferredComputation = false;
  private refusedRestoration = false;
  private last?: SelectionUpdate;
  private operation?: number;
  private operationVersion = 0;
  private updating = false;
  private resetting = false;
  private requested = 0;
  private published = 0;
  private applied?: SceneCommand;
  closed = false;
  constructor(private run: (command: SceneCommand, livePreview?: boolean) => Promise<SelectionRunResult>, private interrupt?: () => void,
    operation?: number, lazy = false, private onComputationFailure?: () => void) {
    this.operation = operation;
    if (!lazy) this.begin();
  }
  get pending() { return !!this.latest || !!this.draining || this.resetting; }
  get restoring() { return !!this.restoration; }
  get hasFailed() { return this.failed; }
  get computationFailed() { return this.deferredComputation; }
  // A settlement observer must retain this owner for explicit recovery rather
  // than silently retrying an already refused or unknown restoration.
  get restorationFailed() { return this.refusedRestoration; }
  // A lost acknowledgment is not proof that native code did not begin. Keep
  // this authority until cancellation or confirmation positively closes it.
  get cleanupNeeded() { return !!this.started; }
  get requestedRevision() { return this.requested; }
  get publishedRevision() { return this.published; }
  get appliedCommand() { return this.applied; }
  get complete() { return !!this.applied && !this.pending && !this.failed && !this.deferredComputation && this.requested === this.published; }
  // Physical admission/native/publication failure remains fatal even when a
  // new operation concurrently superseded the result. Aborts use generation
  // checks instead, so they can restore and restart the same baseline.
  fail() { this.failed = true; this.latest = undefined; this.resetting = false; }
  private enqueue(value: SelectionUpdate, livePreview = true) {
    this.last = value; this.latest = { value, revision: ++this.requested, livePreview };
  }
  private deferPreview() {
    this.deferredComputation = true;
    // A release may already own the newest slot. Discard obsolete previews
    // without discarding that one final evaluation.
    if (this.latest?.livePreview) this.latest = undefined;
    this.last = undefined; this.applied = undefined; this.published = 0;
    this.onComputationFailure?.();
  }
  update(command: SceneCommand) {
    if (this.closed || this.failed || this.deferredComputation) return;
    this.enqueue({ ...command, fromBaseline: true }); void this.drain();
  }
  updateQuery(query: () => Promise<SceneCommand | undefined>) {
    if (this.closed || this.failed || this.deferredComputation) return Promise.resolve();
    this.enqueue(query); return this.drain();
  }
  setOperation(operation: number) {
    if (this.closed || this.failed || operation === this.operation) return;
    this.operation = operation; this.operationVersion++;
    if (this.deferredComputation) return;
    // Explicit Combine replaces the operation captured at press, even when
    // the persistent preference itself was already that value. A superseded
    // preview rolls back without failing the original gesture/baseline.
    if (this.updating) this.interrupt?.();
    if (this.last) { this.enqueue(this.last); void this.drain(); }
  }
  // Stop Polygon's old worker, join publication/rollback, restore its original
  // baseline, then lazily begin the replacement requested by the new profile.
  restart(operation: number, command?: SceneCommand): Promise<void> {
    if (this.closed || this.failed) return this.draining ?? Promise.resolve();
    this.operation = operation; this.operationVersion++;
    if (this.deferredComputation) return this.flush();
    this.resetting = true;
    this.last = this.latest = undefined; this.requested++;
    if (this.updating) this.interrupt?.();
    if (command) this.enqueue({ ...command, fromBaseline: true });
    return this.drain();
  }
  // Only an accepted new Polygon vertex may resume deferred live computation.
  // A queued update still joins the in-flight baseline restoration in drain().
  resumePreview() {
    if (this.closed || this.failed) return;
    this.deferredComputation = false;
  }
  private begin() {
    // Preserve the original Promise's fulfillment timing: a queued release
    // must not replace a press query merely because begin gained another then.
    try { this.started = Promise.resolve(this.run({ command: 'beginSelection' }, false)); }
    catch { this.fail(); this.started = Promise.resolve(undefined); }
    // A deferred/lazy owner may not drain immediately. The drain/restore paths
    // inspect this rejection themselves; observing it here avoids an unhandled
    // rejection without turning an unknown outcome into a refused begin.
    void this.started.catch(() => {});
  }
  private restore(): Promise<boolean> {
    if (this.restoration) return this.restoration;
    const restoration = (async () => {
      const started = this.started;
      let began: SelectionRunResult | undefined;
      try { began = started ? await started : false; }
      catch { this.fail(); }
      if (began !== true && began !== false) this.fail();
      if (began !== false) {
        let restored = false;
        try { restored = await this.run({ command: 'cancelSelection' }, false) === true; }
        catch { /* Native ownership is unknown until a later acknowledged cleanup. */ }
        if (!restored) { this.refusedRestoration = true; this.fail(); return false; }
        this.refusedRestoration = false;
      }
      if (this.started === started) this.started = undefined;
      this.applied = undefined; this.published = 0;
      return true;
    })().finally(() => {
      if (this.restoration === restoration) this.restoration = undefined;
    });
    this.restoration = restoration;
    return restoration;
  }
  private drain(): Promise<void> {
    if (this.draining) return this.draining;
    // Observation and terminal joins cannot retry an already refused or
    // unknown restoration. Only explicit cancel() may try that owner again.
    if (this.failed && this.refusedRestoration) return Promise.resolve();
    this.draining = (async () => {
      let restorationAttempted = false;
      // Read the newest absolute update after the eager begin command settles.
      if (this.started) {
        try { if (await this.started !== true) { this.fail(); return; } }
        catch { this.fail(); return; }
      }
      while ((this.latest || this.resetting) && !this.cancelled && !this.failed) {
        if (this.resetting) {
          this.resetting = false; restorationAttempted = true; await this.restore(); continue;
        }
        if (!this.started) {
          this.begin(); restorationAttempted = false;
          try { if (await this.started !== true) { this.fail(); return; } }
          catch { this.fail(); return; }
        }
        if (this.resetting || this.cancelled || this.failed) continue;
        const next = this.latest;
        if (!next) continue;
        const version = this.operationVersion; this.latest = undefined;
        this.updating = true;
        try {
          const command = typeof next.value === 'function' ? await next.value() : next.value;
          if (this.cancelled) return;
          if (version !== this.operationVersion) continue;
          const update = command && { ...command, fromBaseline: true,
            ...(this.operation === undefined ? {} : { operation: this.operation }) };
          const result = update ? await this.run(update, next.livePreview) : false;
          if (isComputationFailure(result)) {
            if (!next.livePreview) this.fail();
            else if (!this.cancelled && !this.failed && version === this.operationVersion) {
              // The live run and its publication/rollback have settled. A
              // final shape must join strict restoration rather than abort it
              // as though the obsolete preview were still running.
              this.updating = false;
              this.deferPreview();
              restorationAttempted = true;
              await this.restore();
            }
          } else if (result !== true) {
            // A superseded false is the established interruption result.
            // Unknown acknowledgments remain fatal across supersession.
            if (result !== false || version === this.operationVersion) this.fail();
          } else if (!this.failed && version === this.operationVersion) {
            this.applied = update; this.published = next.revision;
            if (!next.livePreview) this.deferredComputation = false;
          }
        } finally { this.updating = false; }
      }
      // A fatal preview can arrive after restart has already interrupted it.
      // Transaction rollback restores the previous preview, not the original
      // gesture baseline. Join that rollback and end the draft here even when
      // no later finish/cancel is pending; never run the discarded replacement.
      if (this.failed && !this.cancelled && !restorationAttempted) await this.restore();
    })().catch(async () => {
      // A lost query/preview acknowledgment is fatal. Join restoration once;
      // never automatically rerun a possibly applied native command.
      this.fail();
      if (!this.cancelled) await this.restore();
    }).finally(() => {
      this.draining = undefined;
      if ((this.latest || this.resetting) && !this.closed && !this.cancelled && !this.failed) void this.drain();
    });
    return this.draining;
  }
  async flush(): Promise<void> {
    do { await this.drain(); }
    while ((this.latest || this.resetting) && !this.cancelled && !this.failed);
  }
  finish(command: SceneCommand): Promise<boolean> { return this.completeWith({ ...command, fromBaseline: true }); }
  finishQuery(query: () => Promise<SceneCommand | undefined>): Promise<boolean> { return this.completeWith(query); }
  // Stationary Single and exact completed Polygon confirm the published result
  // without another query. A null contributor is still a valid command.
  confirm(): Promise<boolean> { return this.completeWith(); }
  finishFromBaseline(command: SceneCommand): Promise<boolean> {
    if (!this.closed && !this.failed) {
      this.operationVersion++; this.resetting = true;
      if (this.updating) this.interrupt?.();
    }
    return this.completeWith({ ...command, fromBaseline: true });
  }
  private completeWith(update?: SelectionUpdate): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    this.closed = true;
    if (update && !this.failed) this.enqueue(update, false);
    this.finishing = (async () => {
      await this.flush();
      if (this.cancelled) return false;
      let accepted = false;
      try {
        if (!this.failed && this.applied) {
          accepted = await this.run({ command: 'confirmSelection' }, false) === true;
          if (!accepted) this.fail();
        }
      }
      catch { this.fail(); }
      // Confirmation has authoritatively ended the native draft. A later
      // cancel must not try to restore this already committed selection.
      if (accepted) this.started = undefined;
      if (!accepted && !this.cancelled && !this.refusedRestoration) await this.restore();
      return accepted;
    })();
    return this.finishing;
  }
  cancel(): Promise<boolean> {
    if (this.cancellation) return this.cancellation;
    this.closed = true; this.cancelled = true; this.latest = undefined; this.resetting = false;
    const cancellation = (async () => {
      if (this.draining) await this.draining;
      // Confirmation may itself be awaiting GPU publication. Cancel only after
      // it resolves/rolls back, so restoration cannot be refused as busy.
      if (this.finishing) await this.finishing;
      return this.restore();
    })();
    this.cancellation = cancellation;
    void cancellation.then(restored => {
      // Share one in-flight attempt. Refusal must not become a permanently
      // cached success: only a later explicit cancel may retry restoration.
      if (!restored && this.cancellation === cancellation) this.cancellation = undefined;
    });
    return cancellation;
  }
}
