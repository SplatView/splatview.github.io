import { expect, it } from 'vitest';
import { SelectionSession, type SelectionRunResult } from '../src/input/selectionSession';
import type { SceneCommand } from '../src/document/types';

function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(value => { resolve = value; });
  return { promise, resolve };
}

it('coalesces queued previews while retaining the final complete brush path', async () => {
  const opened = gate<boolean>(), commands: SceneCommand[] = [];
  const session = new SelectionSession(async command => {
    commands.push(command); return command.command === 'beginSelection' ? opened.promise : true;
  });
  session.update({ command: 'brush', points: [[1, 1]] });
  session.update({ command: 'brush', points: [[1, 1], [5, 8]] });
  const path = [[1, 1], [5, 8], [11, 2]];
  const finishing = session.finish({ command: 'brush', points: path });
  opened.resolve(true); expect(await finishing).toBe(true);
  expect(commands).toEqual([{ command: 'beginSelection' }, { command: 'brush', points: path, fromBaseline: true }, { command: 'confirmSelection' }]);
});

it('waits for an interrupted confirmation before restoring the native gesture', async () => {
  const confirming = gate<void>(), completed = gate<boolean>(), commands: string[] = [];
  let busy = false;
  const session = new SelectionSession(async command => {
    if (busy) throw new Error('Concurrent native commands');
    commands.push(command.command); busy = true;
    try {
      if (command.command === 'confirmSelection') { confirming.resolve(); return await completed.promise; }
      return true;
    } finally { busy = false; }
  });
  const finishing = session.finish({ command: 'rectangle' }); await confirming.promise;
  const cancelling = session.cancel(); expect(session.cancel()).toBe(cancelling);
  expect(commands).toEqual(['beginSelection', 'rectangle', 'confirmSelection']);
  completed.resolve(false); expect(await finishing).toBe(false); await cancelling;
  expect(commands).toEqual(['beginSelection', 'rectangle', 'confirmSelection', 'cancelSelection']);
});

it('restores a draft when confirmation cannot publish', async () => {
  const commands: string[] = [];
  const session = new SelectionSession(async command => { commands.push(command.command); return command.command !== 'confirmSelection'; });
  expect(await session.finish({ command: 'polygon' })).toBe(false);
  expect(commands).toEqual(['beginSelection', 'polygon', 'confirmSelection', 'cancelSelection']);
});

it('does not mutate selection when starting a gesture is refused', async () => {
  const commands: string[] = [];
  const session = new SelectionSession(async command => { commands.push(command.command); return false; });
  session.update({ command: 'rectangle' }); expect(await session.finish({ command: 'rectangle' })).toBe(false);
  await session.cancel(); expect(commands).toEqual(['beginSelection']);
});

it('serializes asynchronous picks with publication and flushes the final release pick', async () => {
  const picked = gate<SceneCommand | undefined>(), published = gate<boolean>(), commands: SceneCommand[] = [];
  const session = new SelectionSession(async command => {
    commands.push(command);
    return command.index === 1 ? published.promise : true;
  });
  session.updateQuery(() => picked.promise);
  await Promise.resolve();
  let queriedRelease = false;
  const finished = session.finishQuery(async () => { queriedRelease = true; return { command: 'single', index: 2 }; });
  picked.resolve({ command: 'single', index: 1 });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(queriedRelease).toBe(false);
  published.resolve(true); expect(await finished).toBe(true);
  expect(commands).toEqual([{ command: 'beginSelection' }, { command: 'single', index: 1, fromBaseline: true },
    { command: 'single', index: 2, fromBaseline: true }, { command: 'confirmSelection' }]);
});

it('discards an in-flight pick when its gesture is cancelled', async () => {
  const picked = gate<SceneCommand | undefined>(), commands: string[] = [];
  const session = new SelectionSession(async command => { commands.push(command.command); return true; });
  session.updateQuery(() => picked.promise); await Promise.resolve();
  const cancelled = session.cancel(); picked.resolve({ command: 'single', index: 1 }); await cancelled;
  expect(commands).toEqual(['beginSelection', 'cancelSelection']);
});

it('restores the baseline when the final pick is obsolete', async () => {
  const commands: string[] = [];
  const session = new SelectionSession(async command => { commands.push(command.command); return true; });
  expect(await session.finishQuery(async () => undefined)).toBe(false);
  expect(commands).toEqual(['beginSelection', 'cancelSelection']);
});

it('joins a stationary press query and publication before confirming without a release query', async () => {
  const picked = gate<SceneCommand | undefined>(), publishing = gate<void>(), published = gate<boolean>();
  const commands: SceneCommand[] = [];
  const session = new SelectionSession(async command => {
    commands.push(command);
    if (command.command === 'single') { publishing.resolve(); return published.promise; }
    return true;
  });
  session.updateQuery(() => picked.promise);
  const finished = session.confirm();
  picked.resolve({ command: 'single', index: 2, operation: 0 }); await publishing.promise;
  expect(session.pending).toBe(true); expect(session.complete).toBe(false);
  expect(commands.map(command => command.command)).toEqual(['beginSelection', 'single']);
  published.resolve(true); expect(await finished).toBe(true);
  expect(commands.map(command => command.command)).toEqual(['beginSelection', 'single', 'confirmSelection']);
  expect(session.complete).toBe(true); expect(session.publishedRevision).toBe(session.requestedRevision);
});

it('keeps a deferred Polygon unallocated until it has native work', async () => {
  const commands: string[] = [];
  const session = new SelectionSession(async command => { commands.push(command.command); return true; }, undefined, 0, true);
  expect(session.pending).toBe(false); expect(session.complete).toBe(false);
  await session.flush(); expect(await session.confirm()).toBe(false); await session.cancel();
  expect(commands).toEqual([]);
});

it('confirms a published null contributor as a valid empty Single result', async () => {
  const commands: SceneCommand[] = [];
  const session = new SelectionSession(async command => { commands.push(command); return true; }, undefined, 0);
  await session.updateQuery(async () => ({ command: 'single', index: null }));
  expect(session.complete).toBe(true); expect(session.appliedCommand?.index).toBeNull();
  expect(await session.confirm()).toBe(true);
  expect(commands).toEqual([{ command: 'beginSelection' }, { command: 'single', index: null, operation: 0, fromBaseline: true },
    { command: 'confirmSelection' }]);
});

it('joins a superseded Polygon publication before restoring and restarting its original baseline', async () => {
  const entering = gate<void>(), oldPublication = gate<boolean>(), commands: SceneCommand[] = [];
  let interruptions = 0;
  const session = new SelectionSession(async command => {
    commands.push(command);
    if (command.command === 'polygon' && command.overlap === false) { entering.resolve(); return oldPublication.promise; }
    return true;
  }, () => { interruptions++; }, 0, true);
  session.update({ command: 'polygon', points: [[1, 1], [9, 1], [9, 9]], overlap: false }); await entering.promise;
  const restarting = session.restart(2, { command: 'polygon', points: [[1, 1], [9, 1], [9, 9]], overlap: true });
  expect(interruptions).toBe(1); expect(session.complete).toBe(false);
  expect(commands.map(command => command.command)).toEqual(['beginSelection', 'polygon']);
  oldPublication.resolve(false); await restarting; await session.flush();
  expect(session.hasFailed).toBe(false); expect(session.complete).toBe(true);
  expect(session.appliedCommand).toMatchObject({ command: 'polygon', operation: 2, overlap: true });
  expect(await session.confirm()).toBe(true);
  expect(commands.map(command => command.command)).toEqual(['beginSelection', 'polygon', 'cancelSelection',
    'beginSelection', 'polygon', 'confirmSelection']);
});

it('restores a pending Polygon before a final evaluation with current options', async () => {
  const entering = gate<void>(), oldPublication = gate<boolean>(), commands: SceneCommand[] = [];
  const session = new SelectionSession(async command => {
    commands.push(command);
    if (command.command === 'polygon' && command.overlap === false) { entering.resolve(); return oldPublication.promise; }
    return true;
  }, undefined, 2, true);
  session.update({ command: 'polygon', points: [[1, 1], [9, 1], [9, 9]], overlap: false }); await entering.promise;
  const finished = session.finishFromBaseline({ command: 'polygon', points: [[1, 1], [9, 1], [9, 9]], overlap: true });
  oldPublication.resolve(false); expect(await finished).toBe(true);
  expect(commands.map(command => command.command)).toEqual(['beginSelection', 'polygon', 'cancelSelection',
    'beginSelection', 'polygon', 'confirmSelection']);
  expect(commands.at(-2)).toMatchObject({ operation: 2, overlap: true, fromBaseline: true });
});

it('preserves a physical publication refusal across supersession without retrying the final shape', async () => {
  const entering = gate<void>(), rejected = gate<void>(), commands: string[] = [];
  const session = new SelectionSession(async command => {
    commands.push(command.command);
    if (command.command === 'polygon') { entering.resolve(); await rejected.promise; session.fail(); return false; }
    return true;
  }, undefined, 0, true);
  session.update({ command: 'polygon', points: [[1, 1], [9, 1], [9, 9]], overlap: false }); await entering.promise;
  const restarting = session.restart(2, { command: 'polygon', overlap: true });
  rejected.resolve(); await restarting;
  expect(session.hasFailed).toBe(true); expect(session.complete).toBe(false);
  // Fatal restart cleanup must restore the original draft before a later key
  // or pointer event; finish must not be the event that finally repairs it.
  expect(commands).toEqual(['beginSelection', 'polygon', 'cancelSelection']);
  expect(await session.finishFromBaseline({ command: 'polygon', overlap: true })).toBe(false);
  expect(commands).toEqual(['beginSelection', 'polygon', 'cancelSelection']);
});

it('retains failed draft ownership through finish and restores it only on explicit cancellation after admission recovers', async () => {
  const commands: string[] = [];
  let admissionRefused = true, nativeDraft = false;
  const session = new SelectionSession(async command => {
    commands.push(command.command);
    if (command.command === 'beginSelection') { nativeDraft = true; return true; }
    if (command.command === 'cancelSelection') {
      if (admissionRefused) return false;
      nativeDraft = false; return true;
    }
    return false;
  });
  session.update({ command: 'volume', points: [[12, 8]], radius: 24 });
  await session.flush();
  expect(session.hasFailed).toBe(true); expect(nativeDraft).toBe(true);
  expect(commands).toEqual(['beginSelection', 'volume', 'cancelSelection']);
  admissionRefused = false;
  expect(await session.finish({ command: 'volume', points: [[12, 8]], radius: 24 })).toBe(false);
  expect(nativeDraft).toBe(true); expect(session.restorationFailed).toBe(true);
  expect(commands).toEqual(['beginSelection', 'volume', 'cancelSelection']);
  expect(await session.cancel()).toBe(true);
  expect(nativeDraft).toBe(false);
  expect(commands).toEqual(['beginSelection', 'volume', 'cancelSelection', 'cancelSelection']);
});

it('joins a refused terminal cancellation and retries only on a later explicit cancellation', async () => {
  const entered = gate<void>(), refused = gate<boolean>(), commands: string[] = [];
  let allowCleanup = false, nativeDraft = false, selected = [0, 2];
  const session = new SelectionSession(async command => {
    commands.push(command.command);
    if (command.command === 'beginSelection') { nativeDraft = true; return true; }
    if (command.command === 'rectangle') { selected = [1]; return true; }
    if (command.command === 'cancelSelection') {
      if (!allowCleanup) { entered.resolve(); return refused.promise; }
      nativeDraft = false; selected = [0, 2]; return true;
    }
    throw new Error('Unexpected confirmation');
  });
  session.update({ command: 'rectangle' }); await session.flush();
  const first = session.cancel(); await entered.promise;
  expect(session.cancel()).toBe(first);
  refused.resolve(false); expect(await first).toBe(false);
  expect(session.cleanupNeeded).toBe(true); expect(nativeDraft).toBe(true); expect(selected).toEqual([1]);
  session.update({ command: 'rectangle' });
  expect(await session.confirm()).toBe(false);
  await Promise.resolve();
  expect(commands).toEqual(['beginSelection', 'rectangle', 'cancelSelection']);
  allowCleanup = true;
  const recovered = session.cancel(); expect(recovered).not.toBe(first);
  expect(await recovered).toBe(true); expect(session.cancel()).toBe(recovered);
  expect(session.cleanupNeeded).toBe(false); expect(nativeDraft).toBe(false); expect(selected).toEqual([0, 2]);
  expect(commands).toEqual(['beginSelection', 'rectangle', 'cancelSelection', 'cancelSelection']);
});

it.each(['throw', undefined, 1, 'accepted'])('retains terminal cleanup authority after a %s cancellation acknowledgment', async outcome => {
  const commands: string[] = [];
  let recovered = false, nativeDraft = false;
  const session = new SelectionSession(async command => {
    commands.push(command.command);
    if (command.command === 'beginSelection') { nativeDraft = true; return true; }
    if (command.command === 'cancelSelection') {
      if (!recovered) {
        if (outcome === 'throw') throw new Error('Cancellation acknowledgment lost');
        return outcome as unknown as boolean;
      }
      nativeDraft = false; return true;
    }
    return true;
  });
  expect(await session.cancel()).toBe(false);
  expect(session.cleanupNeeded).toBe(true); expect(nativeDraft).toBe(true);
  recovered = true;
  expect(await session.cancel()).toBe(true);
  expect(session.cleanupNeeded).toBe(false); expect(nativeDraft).toBe(false);
  expect(commands).toEqual(['beginSelection', 'cancelSelection', 'cancelSelection']);
});

it.each(['throw', undefined])('requires cancellation after an unknown %s begin acknowledgment', async outcome => {
  const commands: string[] = [];
  let nativeDraft = false;
  const session = new SelectionSession(async command => {
    commands.push(command.command);
    if (command.command === 'beginSelection') {
      // The native side may have begun before the transport acknowledgment was lost.
      nativeDraft = true;
      if (outcome === 'throw') throw new Error('Begin acknowledgment lost');
      return outcome as unknown as boolean;
    }
    if (command.command === 'cancelSelection') { nativeDraft = false; return true; }
    throw new Error('A preview must not run after an unknown begin');
  });
  session.update({ command: 'rectangle' }); await session.flush();
  expect(session.hasFailed).toBe(true); expect(session.cleanupNeeded).toBe(true); expect(nativeDraft).toBe(true);
  expect(await session.cancel()).toBe(true);
  expect(session.cleanupNeeded).toBe(false); expect(nativeDraft).toBe(false);
  expect(commands).toEqual(['beginSelection', 'cancelSelection']);
});

it('retains cleanup after a thrown preview and never reruns that failed preview', async () => {
  const commands: string[] = [];
  let allowCleanup = false, nativeDraft = false;
  const session = new SelectionSession(async command => {
    commands.push(command.command);
    if (command.command === 'beginSelection') { nativeDraft = true; return true; }
    if (command.command === 'rectangle') throw new Error('Preview acknowledgment lost');
    if (command.command === 'cancelSelection') {
      if (!allowCleanup) return false;
      nativeDraft = false; return true;
    }
    throw new Error('Unexpected confirmation');
  });
  session.update({ command: 'rectangle' }); await session.flush();
  expect(session.hasFailed).toBe(true); expect(session.cleanupNeeded).toBe(true); expect(nativeDraft).toBe(true);
  expect(commands).toEqual(['beginSelection', 'rectangle', 'cancelSelection']);
  allowCleanup = true;
  expect(await session.cancel()).toBe(true);
  expect(session.cleanupNeeded).toBe(false); expect(nativeDraft).toBe(false);
  expect(commands).toEqual(['beginSelection', 'rectangle', 'cancelSelection', 'cancelSelection']);
});

it('retires cleanup authority after an acknowledged confirmation', async () => {
  const commands: string[] = [];
  let nativeDraft = false;
  const session = new SelectionSession(async command => {
    commands.push(command.command);
    if (command.command === 'beginSelection') nativeDraft = true;
    if (command.command === 'confirmSelection') nativeDraft = false;
    return true;
  });
  expect(await session.finish({ command: 'rectangle' })).toBe(true);
  expect(session.complete).toBe(true); expect(session.cleanupNeeded).toBe(false); expect(nativeDraft).toBe(false);
  expect(await session.cancel()).toBe(true);
  expect(commands).toEqual(['beginSelection', 'rectangle', 'confirmSelection']);
});

it.each(['throw', undefined, 1])('restores after a %s confirmation acknowledgment without confirming twice', async outcome => {
  const commands: string[] = [];
  let allowCleanup = false, nativeDraft = false;
  const session = new SelectionSession(async command => {
    commands.push(command.command);
    if (command.command === 'beginSelection') { nativeDraft = true; return true; }
    if (command.command === 'rectangle') return true;
    if (command.command === 'confirmSelection') {
      if (outcome === 'throw') throw new Error('Confirmation acknowledgment lost');
      return outcome as unknown as boolean;
    }
    if (command.command === 'cancelSelection') {
      if (!allowCleanup) return false;
      nativeDraft = false; return true;
    }
    throw new Error('Unexpected command');
  });
  expect(await session.finish({ command: 'rectangle' })).toBe(false);
  expect(session.cleanupNeeded).toBe(true); expect(nativeDraft).toBe(true);
  expect(await session.confirm()).toBe(false);
  expect(commands).toEqual(['beginSelection', 'rectangle', 'confirmSelection', 'cancelSelection']);
  allowCleanup = true;
  expect(await session.cancel()).toBe(true);
  expect(session.cleanupNeeded).toBe(false); expect(nativeDraft).toBe(false);
  expect(commands).toEqual(['beginSelection', 'rectangle', 'confirmSelection', 'cancelSelection', 'cancelSelection']);
});

it('does not immediately repeat a refused restoration during a Polygon restart', async () => {
  const commands: string[] = [];
  let allowCleanup = false, nativeDraft = false;
  const session = new SelectionSession(async command => {
    commands.push(command.command);
    if (command.command === 'beginSelection') { nativeDraft = true; return true; }
    if (command.command === 'polygon') return true;
    if (command.command === 'cancelSelection') {
      if (!allowCleanup) return false;
      nativeDraft = false; return true;
    }
    throw new Error('A failed restart must not confirm');
  }, undefined, 0, true);
  session.update({ command: 'polygon', overlap: false }); await session.flush();
  await session.restart(2, { command: 'polygon', overlap: true });
  expect(session.hasFailed).toBe(true); expect(session.cleanupNeeded).toBe(true); expect(nativeDraft).toBe(true);
  expect(commands).toEqual(['beginSelection', 'polygon', 'cancelSelection']);
  allowCleanup = true;
  expect(await session.cancel()).toBe(true);
  expect(commands).toEqual(['beginSelection', 'polygon', 'cancelSelection', 'cancelSelection']);
  expect(session.cleanupNeeded).toBe(false); expect(nativeDraft).toBe(false);
});

it('joins an interrupted preview and performs one explicit cancellation after its thrown acknowledgment', async () => {
  const entered = gate<void>(), release = gate<void>(), cancelling = gate<void>(), cancelled = gate<boolean>();
  const commands: string[] = [];
  let running = false;
  const session = new SelectionSession(async command => {
    if (running) throw new Error('Concurrent native commands');
    running = true; commands.push(command.command);
    try {
      if (command.command === 'rectangle') { entered.resolve(); await release.promise; throw new Error('Lost preview acknowledgment'); }
      if (command.command === 'cancelSelection') { cancelling.resolve(); return await cancelled.promise; }
      return true;
    } finally { running = false; }
  });
  session.update({ command: 'rectangle' }); await entered.promise;
  const cleanup = session.cancel(); expect(session.cancel()).toBe(cleanup);
  expect(commands).toEqual(['beginSelection', 'rectangle']);
  release.resolve(); await cancelling.promise;
  expect(commands).toEqual(['beginSelection', 'rectangle', 'cancelSelection']);
  expect(session.cancel()).toBe(cleanup);
  cancelled.resolve(true); expect(await cleanup).toBe(true);
  expect(session.cleanupNeeded).toBe(false);
  expect(commands).toEqual(['beginSelection', 'rectangle', 'cancelSelection']);
});

const computationFailure = { kind: 'computation-failed', version: 1 } as const;

it.each([false, true])('restores the original selection and Redo after a typed failure with prior preview %s', async priorPreview => {
  const commands: string[] = [], events: string[] = [];
  let selected = [0, 2], redo = ['original-redo'];
  const session = new SelectionSession(async (command, livePreview) => {
    commands.push(command.command);
    if (command.command === 'polygon') {
      expect(livePreview).toBe(true);
      if (command.overlap) return computationFailure;
      selected = [1]; redo = []; return true;
    }
    if (command.command === 'cancelSelection') {
      events.push('restore'); selected = [0, 2]; redo = ['original-redo'];
    }
    return true;
  }, undefined, 0, true, () => {
    events.push('failure');
    expect(selected).toEqual(priorPreview ? [1] : [0, 2]);
    expect(session.computationFailed).toBe(true);
    expect(session.appliedCommand).toBeUndefined(); expect(session.publishedRevision).toBe(0);
  });
  if (priorPreview) {
    session.update({ command: 'polygon', overlap: false }); await session.flush();
    expect(session.complete).toBe(true);
  }
  session.update({ command: 'polygon', overlap: true }); await session.flush();
  expect(events).toEqual(['failure', 'restore']);
  expect(selected).toEqual([0, 2]); expect(redo).toEqual(['original-redo']);
  expect(session.computationFailed).toBe(true); expect(session.hasFailed).toBe(false);
  expect(session.closed).toBe(false); expect(session.pending).toBe(false);
  expect(session.cleanupNeeded).toBe(false); expect(session.complete).toBe(false);
  expect(commands).toEqual(priorPreview ? ['beginSelection', 'polygon', 'polygon', 'cancelSelection'] :
    ['beginSelection', 'polygon', 'cancelSelection']);
});

it('does not resume failed live computation from cursor, queries, Combine or profile restart', async () => {
  const commands: SceneCommand[] = [];
  let queries = 0, failures = 0;
  const session = new SelectionSession(async (command, livePreview) => {
    commands.push(command);
    return livePreview ? computationFailure : true;
  }, undefined, 0, true, () => { failures++; });
  session.update({ command: 'polygon', points: [[1, 1], [9, 1], [9, 9]] }); await session.flush();
  const revision = session.requestedRevision;
  session.update({ command: 'polygon', points: [[1, 1], [9, 1], [11, 9]] });
  await session.updateQuery(async () => { queries++; return { command: 'polygon' }; });
  session.setOperation(1);
  await session.restart(2, { command: 'polygon', overlap: true }); await session.flush();
  expect(queries).toBe(0); expect(failures).toBe(1); expect(session.requestedRevision).toBe(revision);
  expect(session.computationFailed).toBe(true); expect(session.hasFailed).toBe(false);
  expect(commands.map(command => command.command)).toEqual(['beginSelection', 'polygon', 'cancelSelection']);
  expect(await session.finish({ command: 'polygon', overlap: true })).toBe(true);
  expect(commands.at(-2)).toMatchObject({ command: 'polygon', operation: 2, overlap: true });
  expect(commands.map(command => command.command)).toEqual(['beginSelection', 'polygon', 'cancelSelection',
    'beginSelection', 'polygon', 'confirmSelection']);
});

it('queues an explicit new-vertex resume behind the original baseline restoration without replay', async () => {
  const restoring = gate<void>(), restored = gate<boolean>(), commands: SceneCommand[] = [];
  let first = true;
  const session = new SelectionSession(async command => {
    commands.push(command);
    if (command.command === 'polygon' && first) { first = false; return computationFailure; }
    if (command.command === 'cancelSelection') { restoring.resolve(); return restored.promise; }
    return true;
  }, undefined, 0, true);
  session.update({ command: 'polygon', index: 1 }); await restoring.promise;
  expect(session.computationFailed).toBe(true); expect(session.pending).toBe(true);
  session.resumePreview(); session.update({ command: 'polygon', index: 2 });
  expect(session.computationFailed).toBe(false); expect(session.pending).toBe(true);
  expect(commands.map(command => command.command)).toEqual(['beginSelection', 'polygon', 'cancelSelection']);
  restored.resolve(true); await session.flush();
  expect(commands.filter(command => command.command === 'polygon').map(command => command.index)).toEqual([1, 2]);
  expect(commands.map(command => command.command)).toEqual(['beginSelection', 'polygon', 'cancelSelection', 'beginSelection', 'polygon']);
  expect(session.complete).toBe(true); expect(session.hasFailed).toBe(false);
  expect(await session.confirm()).toBe(true);
});

it('restores a newly resumed draft after fatal publication in the same drain', async () => {
  const restoring = gate<void>(), restored = gate<boolean>(), commands: string[] = [];
  let first = true, nativeDraft = false;
  const session = new SelectionSession(async command => {
    commands.push(command.command);
    if (command.command === 'beginSelection') { nativeDraft = true; return true; }
    if (command.command === 'polygon') {
      if (first) { first = false; return computationFailure; }
      return false;
    }
    if (command.command === 'cancelSelection') {
      if (commands.filter(value => value === 'cancelSelection').length === 1) {
        restoring.resolve(); const accepted = await restored.promise;
        if (accepted) nativeDraft = false;
        return accepted;
      }
      nativeDraft = false; return true;
    }
    return true;
  }, undefined, 0, true);
  session.update({ command: 'polygon', index: 1 }); await restoring.promise;
  session.resumePreview(); session.update({ command: 'polygon', index: 2 });
  restored.resolve(true); await session.flush();
  expect(session.hasFailed).toBe(true); expect(session.cleanupNeeded).toBe(false); expect(nativeDraft).toBe(false);
  expect(commands).toEqual(['beginSelection', 'polygon', 'cancelSelection', 'beginSelection', 'polygon', 'cancelSelection']);
});

it('preserves the one queued final evaluation when its in-flight live preview fails', async () => {
  const evaluating = gate<void>(), result = gate<SelectionRunResult>(), restoring = gate<void>(), restored = gate<boolean>();
  const commands: { command: SceneCommand; livePreview: boolean | undefined }[] = [];
  let failures = 0;
  const session = new SelectionSession(async (command, livePreview) => {
    commands.push({ command, livePreview });
    if (command.command === 'polygon' && livePreview) { evaluating.resolve(); return result.promise; }
    if (command.command === 'cancelSelection') { restoring.resolve(); return restored.promise; }
    return true;
  }, undefined, 2, true, () => { failures++; });
  session.update({ command: 'polygon', overlap: false }); await evaluating.promise;
  const finished = session.finish({ command: 'polygon', overlap: true });
  result.resolve(computationFailure); await restoring.promise;
  expect(failures).toBe(1); expect(session.computationFailed).toBe(true);
  expect(commands.map(value => value.command.command)).toEqual(['beginSelection', 'polygon', 'cancelSelection']);
  restored.resolve(true); expect(await finished).toBe(true);
  expect(commands.map(value => value.command.command)).toEqual(['beginSelection', 'polygon', 'cancelSelection',
    'beginSelection', 'polygon', 'confirmSelection']);
  expect(commands.filter(value => value.command.command === 'polygon')).toEqual([
    { command: { command: 'polygon', overlap: false, fromBaseline: true, operation: 2 }, livePreview: true },
    { command: { command: 'polygon', overlap: true, fromBaseline: true, operation: 2 }, livePreview: false },
  ]);
  expect(session.computationFailed).toBe(false); expect(session.hasFailed).toBe(false);
  expect(session.cleanupNeeded).toBe(false);
});

it('joins a canceled live computation without notifying or restoring twice', async () => {
  const evaluating = gate<void>(), result = gate<SelectionRunResult>(), commands: string[] = [];
  let failures = 0;
  const session = new SelectionSession(async command => {
    commands.push(command.command);
    if (command.command === 'polygon') { evaluating.resolve(); return result.promise; }
    return true;
  }, undefined, 0, true, () => { failures++; });
  session.update({ command: 'polygon' }); await evaluating.promise;
  const canceled = session.cancel(); result.resolve(computationFailure);
  expect(await canceled).toBe(true); expect(failures).toBe(0);
  expect(session.hasFailed).toBe(false); expect(session.computationFailed).toBe(false);
  expect(session.cleanupNeeded).toBe(false);
  expect(commands).toEqual(['beginSelection', 'polygon', 'cancelSelection']);
});

it('marks asynchronous queries and restarted profiles as live and evaluates release strictly', async () => {
  const modes: { command: string; livePreview: boolean | undefined }[] = [];
  const session = new SelectionSession(async (command, livePreview) => {
    modes.push({ command: command.command, livePreview }); return true;
  }, undefined, 0, true);
  await session.updateQuery(async () => ({ command: 'polygon' }));
  await session.restart(2, { command: 'polygon', overlap: true });
  expect(await session.finishQuery(async () => ({ command: 'polygon', overlap: false }))).toBe(true);
  expect(modes).toEqual([
    { command: 'beginSelection', livePreview: false }, { command: 'polygon', livePreview: true },
    { command: 'cancelSelection', livePreview: false }, { command: 'beginSelection', livePreview: false },
    { command: 'polygon', livePreview: true }, { command: 'polygon', livePreview: false },
    { command: 'confirmSelection', livePreview: false },
  ]);
});

it.each(['finish', 'finishQuery', 'finishFromBaseline'] as const)('joins failed preview restoration before %s evaluates once', async method => {
  const restoring = gate<void>(), restored = gate<boolean>();
  const modes: (boolean | undefined)[] = [], commands: string[] = [];
  let queries = 0;
  const session = new SelectionSession(async (command, livePreview) => {
    commands.push(command.command);
    if (command.command === 'polygon') { modes.push(livePreview); return livePreview ? computationFailure : true; }
    if (command.command === 'cancelSelection') { restoring.resolve(); return restored.promise; }
    return true;
  }, undefined, 0, true);
  session.update({ command: 'polygon' }); await restoring.promise;
  const finished = method === 'finishQuery' ? session.finishQuery(async () => {
    queries++; return { command: 'polygon', overlap: true };
  }) : session[method]({ command: 'polygon', overlap: true });
  expect(commands).toEqual(['beginSelection', 'polygon', 'cancelSelection']); expect(queries).toBe(0);
  restored.resolve(true); expect(await finished).toBe(true);
  expect(commands).toEqual(['beginSelection', 'polygon', 'cancelSelection', 'beginSelection', 'polygon', 'confirmSelection']);
  expect(modes).toEqual([true, false]); expect(queries).toBe(method === 'finishQuery' ? 1 : 0);
});

it('joins a held strict baseline restoration without interrupting it for the final shape', async () => {
  const restoring = gate<void>(), restored = gate<boolean>(), commands: SceneCommand[] = [];
  let interruptions = 0, nativeBusy = false;
  const session = new SelectionSession(async (command, livePreview) => {
    if (nativeBusy) throw new Error('Concurrent native commands');
    commands.push(command); nativeBusy = true;
    try {
      if (command.command === 'polygon' && livePreview) return computationFailure;
      if (command.command === 'cancelSelection') { restoring.resolve(); return await restored.promise; }
      return true;
    } finally { nativeBusy = false; }
  }, () => {
    interruptions++;
    // This models cancelEdit aborting the strict cancelSelection publication.
    // Any interruption here would turn a valid final pass into required cleanup.
    restored.resolve(false);
  }, 2, true);
  session.update({ command: 'polygon', overlap: false }); await restoring.promise;
  expect(session.restoring).toBe(true);
  const finished = session.finishFromBaseline({ command: 'polygon', overlap: true });
  expect(interruptions).toBe(0); expect(session.pending).toBe(true);
  expect(commands.map(command => command.command)).toEqual(['beginSelection', 'polygon', 'cancelSelection']);
  restored.resolve(true); expect(await finished).toBe(true);
  expect(session.restoring).toBe(false);
  expect(interruptions).toBe(0); expect(session.hasFailed).toBe(false); expect(session.restorationFailed).toBe(false);
  expect(commands.map(command => command.command)).toEqual(['beginSelection', 'polygon', 'cancelSelection',
    'beginSelection', 'polygon', 'confirmSelection']);
  expect(commands.at(-2)).toMatchObject({ operation: 2, overlap: true, fromBaseline: true });
});

it.each(['finish', 'finishQuery', 'finishFromBaseline', 'confirm'] as const)('does not retry a refused baseline restoration joined by %s', async method => {
  const restoring = gate<void>(), refused = gate<boolean>(), commands: string[] = [];
  let allowCleanup = false, queries = 0;
  const session = new SelectionSession(async (command, livePreview) => {
    commands.push(command.command);
    if (command.command === 'polygon') {
      expect(livePreview).toBe(true); return computationFailure;
    }
    if (command.command === 'cancelSelection' && !allowCleanup) { restoring.resolve(); return refused.promise; }
    return true;
  }, undefined, 0, true);
  session.update({ command: 'polygon' }); await restoring.promise;
  const finished = method === 'confirm' ? session.confirm() : method === 'finishQuery' ? session.finishQuery(async () => {
    queries++; return { command: 'polygon', overlap: true };
  }) : session[method]({ command: 'polygon', overlap: true });
  // A later attempt would succeed, so this detects silent retry rather than
  // merely observing a second refusal from unchanged admission state.
  allowCleanup = true; refused.resolve(false);
  expect(await finished).toBe(false); await session.flush(); await session.flush();
  expect(queries).toBe(0); expect(session.hasFailed).toBe(true);
  expect(session.restorationFailed).toBe(true); expect(session.cleanupNeeded).toBe(true);
  expect(commands).toEqual(['beginSelection', 'polygon', 'cancelSelection']);
  expect(await session.cancel()).toBe(true);
  expect(session.restorationFailed).toBe(false); expect(session.cleanupNeeded).toBe(false);
  expect(commands).toEqual(['beginSelection', 'polygon', 'cancelSelection', 'cancelSelection']);
});

it('does not repeat refused cleanup after a fatal final evaluation or subsequent observation', async () => {
  const commands: string[] = [];
  let allowCleanup = false;
  const session = new SelectionSession(async (command, livePreview) => {
    commands.push(command.command); expect(livePreview).toBe(false);
    if (command.command === 'polygon') return false;
    if (command.command === 'cancelSelection') return allowCleanup;
    return true;
  }, undefined, 0, true);
  expect(await session.finish({ command: 'polygon' })).toBe(false);
  expect(session.hasFailed).toBe(true); expect(session.restorationFailed).toBe(true); expect(session.cleanupNeeded).toBe(true);
  allowCleanup = true; await session.flush(); await session.restart(2, { command: 'polygon' });
  expect(commands).toEqual(['beginSelection', 'polygon', 'cancelSelection']);
  expect(await session.cancel()).toBe(true);
  expect(session.restorationFailed).toBe(false); expect(session.cleanupNeeded).toBe(false);
  expect(commands).toEqual(['beginSelection', 'polygon', 'cancelSelection', 'cancelSelection']);
});

it.each([false, undefined, computationFailure, 'throw'])('retains fatal cleanup authority for failed baseline restoration acknowledgment %s', async outcome => {
  const commands: string[] = [];
  let recover = false;
  const session = new SelectionSession(async command => {
    commands.push(command.command);
    if (command.command === 'polygon') return computationFailure;
    if (command.command === 'cancelSelection' && !recover) {
      if (outcome === 'throw') throw new Error('Restoration acknowledgment lost');
      return outcome as SelectionRunResult;
    }
    return true;
  }, undefined, 0, true);
  session.update({ command: 'polygon' }); await session.flush();
  expect(session.hasFailed).toBe(true); expect(session.cleanupNeeded).toBe(true);
  expect(session.restorationFailed).toBe(true);
  await session.flush(); await session.flush();
  session.resumePreview(); session.update({ command: 'polygon' }); await session.restart(2, { command: 'polygon' });
  expect(commands).toEqual(['beginSelection', 'polygon', 'cancelSelection']);
  recover = true; expect(await session.cancel()).toBe(true);
  expect(commands).toEqual(['beginSelection', 'polygon', 'cancelSelection', 'cancelSelection']);
  expect(session.cleanupNeeded).toBe(false);
  expect(session.restorationFailed).toBe(false);
});

it('does not mark a known refused begin as a failed restoration or issue cancellation', async () => {
  const commands: string[] = [];
  const session = new SelectionSession(async command => { commands.push(command.command); return false; });
  session.update({ command: 'rectangle' }); await session.flush();
  expect(session.hasFailed).toBe(true); expect(session.restorationFailed).toBe(false);
  expect(await session.cancel()).toBe(true);
  expect(session.restorationFailed).toBe(false); expect(session.cleanupNeeded).toBe(false);
  expect(commands).toEqual(['beginSelection']);
});

it('ignores a stale typed failure without clearing the replacement owner or queued request', async () => {
  const evaluating = gate<void>(), oldResult = gate<SelectionRunResult>(), commands: SceneCommand[] = [];
  let failures = 0;
  const session = new SelectionSession(async (command, livePreview) => {
    commands.push(command);
    if (command.command === 'polygon' && command.overlap === false) {
      expect(livePreview).toBe(true); evaluating.resolve(); return oldResult.promise;
    }
    return true;
  }, undefined, 0, true, () => { failures++; });
  session.update({ command: 'polygon', overlap: false }); await evaluating.promise;
  const restarted = session.restart(2, { command: 'polygon', overlap: true });
  oldResult.resolve(computationFailure); await restarted;
  expect(failures).toBe(0); expect(session.computationFailed).toBe(false); expect(session.hasFailed).toBe(false);
  expect(session.complete).toBe(true); expect(session.appliedCommand).toMatchObject({ operation: 2, overlap: true });
  expect(commands.map(command => command.command)).toEqual(['beginSelection', 'polygon', 'cancelSelection', 'beginSelection', 'polygon']);
});

it.each([undefined, { kind: 'computation-failed', version: 2 }, { kind: 'unknown', version: 1 }, 'throw'])('keeps superseded unknown or thrown preview acknowledgment %s fatal', async outcome => {
  const evaluating = gate<void>(), result = gate<void>(), commands: string[] = [];
  const session = new SelectionSession(async command => {
    commands.push(command.command);
    if (command.command === 'polygon') {
      evaluating.resolve(); await result.promise;
      if (outcome === 'throw') throw new Error('Physical publication failed');
      return outcome as SelectionRunResult;
    }
    return true;
  }, undefined, 0, true);
  session.update({ command: 'polygon' }); await evaluating.promise;
  const restarted = session.restart(2, { command: 'polygon', overlap: true }); result.resolve(); await restarted;
  expect(session.hasFailed).toBe(true); expect(session.computationFailed).toBe(false);
  expect(commands).toEqual(['beginSelection', 'polygon', 'cancelSelection']);
});

it('keeps an explicit physical failure fatal even when its superseded result is typed computation failure', async () => {
  const evaluating = gate<void>(), result = gate<void>(), commands: string[] = [];
  let failures = 0;
  const session = new SelectionSession(async command => {
    commands.push(command.command);
    if (command.command === 'polygon') {
      evaluating.resolve(); await result.promise; session.fail(); return computationFailure;
    }
    return true;
  }, undefined, 0, true, () => { failures++; });
  session.update({ command: 'polygon' }); await evaluating.promise;
  const restarted = session.restart(2, { command: 'polygon', overlap: true }); result.resolve(); await restarted;
  expect(session.hasFailed).toBe(true); expect(session.computationFailed).toBe(false); expect(failures).toBe(0);
  expect(commands).toEqual(['beginSelection', 'polygon', 'cancelSelection']);
});

it.each(['beginSelection', 'polygon', 'confirmSelection', 'cancelSelection'])('rejects a typed computation failure as a %s terminal acknowledgment', async failedCommand => {
  const commands: string[] = [];
  let failures = 0;
  const session = new SelectionSession(async (command, livePreview) => {
    commands.push(command.command); expect(livePreview).toBe(false);
    return command.command === failedCommand ? computationFailure : true;
  }, undefined, 0, failedCommand !== 'cancelSelection', () => { failures++; });
  if (failedCommand === 'cancelSelection') {
    expect(await session.cancel()).toBe(false); expect(session.hasFailed).toBe(true);
    expect(session.cleanupNeeded).toBe(true);
  } else {
    expect(await session.finish({ command: 'polygon' })).toBe(false);
    expect(session.hasFailed).toBe(true);
  }
  expect(failures).toBe(0); expect(session.computationFailed).toBe(false);
});
