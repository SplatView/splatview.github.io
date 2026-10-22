import type { LivePreviewOutcome, NativeSummary } from './types';

// An algorithm outcome is a separate response family. A generic error, a
// false/no-change selector result, or a missing acknowledgement cannot enter
// the deferred-gesture path through a truthy object or an error-message match.
export function livePreviewOutcome(value: unknown): LivePreviewOutcome {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid live selection outcome.');
  const outcome = value as Record<string, unknown>;
  const keys = Object.keys(outcome).sort().join(',');
  if (outcome.version !== 1) throw new Error('Unsupported live selection outcome.');
  if (outcome.kind === 'computation-failed' && keys === 'kind,version') return { kind: outcome.kind, version: 1 };
  if (outcome.kind !== 'published' || keys !== 'kind,summary,version') throw new Error('Invalid live selection outcome.');
  const summary = outcome.summary as NativeSummary | undefined;
  if (!summary || summary.ok !== true || summary.loaded !== true || summary.pending !== false ||
      summary.transaction !== true || summary.selectionDraft !== true || summary.sceneChanged !== false ||
      !Number.isSafeInteger(summary.count) || summary.count < 0 ||
      !Number.isSafeInteger(summary.selected) || summary.selected < 0 || summary.selected > summary.count ||
      !Number.isSafeInteger(summary.revision) || summary.revision < 0 ||
      !Number.isSafeInteger(summary.contentRevision) || summary.contentRevision < 0 ||
      !Array.isArray(summary.selectionMapRetainedIds) || summary.selectionMapRetainedIds.some(id => !Number.isSafeInteger(id) || id < 1))
    throw new Error('Invalid published live selection state.');
  return { kind: 'published', version: 1, summary };
}
