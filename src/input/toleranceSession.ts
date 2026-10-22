// A completed pick owns its native history checkpoint. Tolerance and connected
// mode updates are absolute, so only the newest waiting value is evaluated.
export class ToleranceSession<T = number> {
  private latest?: T;
  private draining?: Promise<void>;
  private ending?: Promise<void>;
  private closed = false;
  constructor(private ready: Promise<boolean>, private apply: (value: T) => Promise<boolean>,
    private release: () => Promise<void>) {}

  update(value: T) {
    if (this.closed) return;
    this.latest = value;
    void this.drain();
  }
  discardPending() { this.latest = undefined; }
  private drain(): Promise<void> {
    if (this.draining) return this.draining;
    this.draining = (async () => {
      if (!await this.ready) { this.latest = undefined; return; }
      while (!this.closed && this.latest !== undefined) {
        const value = this.latest; this.latest = undefined;
        // Refusal leaves the preceding native amendment intact. A subsequent
        // value may retry without losing the completed pick's checkpoint.
        await this.apply(value);
      }
    })().finally(() => {
      this.draining = undefined;
      if (!this.closed && this.latest !== undefined) void this.drain();
    });
    return this.draining;
  }
  async flush() {
    await this.ready;
    while (this.draining) await this.draining;
  }
  // Replacement already releases the old native checkpoint atomically.
  retire() { this.closed = true; this.latest = undefined; }
  end(): Promise<void> {
    if (this.ending) return this.ending;
    this.retire();
    this.ending = (async () => {
      await this.flush();
      await this.release();
    })();
    return this.ending;
  }
}
