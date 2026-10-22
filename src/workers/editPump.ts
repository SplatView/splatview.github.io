type PendingEdit = { pending: boolean };

export type EditPumpOptions<Summary extends PendingEdit> = {
  step(work: number): Summary;
  /** The request owner checks cancellation and performs any native cleanup. */
  checkCancelled(): void;
  progress(summary: Summary): void;
  yieldTask?: () => Promise<void>;
  now?: () => number;
};

/** Yield a real worker task without the nested timer minimum delay. */
export function yieldWorkerTask(): Promise<void> {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const close = () => { channel.port1.close(); channel.port2.close(); };
    channel.port1.onmessage = () => { close(); resolve(); };
    try { channel.port2.postMessage(null); }
    catch (error) { close(); reject(error); }
  });
}

/** Keep native work bounded while allowing cancellation messages between batches. */
export async function pumpEdit<Summary extends PendingEdit>(initial: Summary,
  options: EditPumpOptions<Summary>): Promise<Summary> {
  const yieldTask = options.yieldTask ?? yieldWorkerTask;
  const now = options.now ?? (() => performance.now());
  let summary = initial;
  while (summary.pending) {
    options.checkCancelled();
    await yieldTask();
    options.checkCancelled();
    const started = now();
    // The count also bounds a batch when the clock is frozen or too coarse.
    for (let steps = 0; steps < 256 && summary.pending; steps++) {
      options.checkCancelled();
      summary = options.step(4096);
      if (!summary.pending || now() - started >= 8) break;
    }
    options.checkCancelled();
    options.progress(summary);
  }
  return summary;
}
