import { expect, test } from '@playwright/test';
import { polygonBaselineIds, polygonCenterIds, polygonPositions } from './polygon-fixture';
import type {} from './polygon-harness';

const injectionBoundary = 'test-only client-result replacement after real native preview';
type Result = Awaited<ReturnType<Window['polygonHarness']['geometricDeferred']>>;
type Snapshot = Result['before'];
const mask = (ids: readonly number[]) => polygonPositions.map((_, index) => Number(ids.includes(index)));
function exact(snapshot: Snapshot, ids: number[]) {
  expect(snapshot.gpu).toEqual(mask(ids)); expect(snapshot.ids).toEqual(ids);
  expect(snapshot.summary.selected).toBe(ids.length);
  expect(snapshot.nativeMasks.map(value => Number(value === 1))).toEqual(mask(ids));
}

test.describe('Geometric deferred finish/cancel after a forwarded typed live result', () => {
  for (const mode of ['basic', 'pro'] as const) {
    for (const tool of ['rectangle', 'brush', 'visible-brush', 'volume'] as const) {
      for (const priorPreview of [false, true]) {
        for (const terminal of ['finish', 'cancel'] as const) {
          test(`${mode} ${tool} failure ${priorPreview ? 'after accepted' : 'before first'} preview defers to ${terminal}`, async ({ page }, info) => {
            await page.goto('/e2e/polygon-harness.html'); await page.waitForFunction(() => Boolean(window.polygonHarness));
            const result = await page.evaluate(({ tool, mode, priorPreview, terminal }) =>
              window.polygonHarness.geometricDeferred(tool, mode, priorPreview, terminal), { tool, mode, priorPreview, terminal });
            exact(result.before, polygonBaselineIds); expect(result.before.summary.canRedo).toBe(true);
            if (priorPreview) {
              expect(result.published).toBeDefined(); exact(result.published!, polygonCenterIds);
              expect(result.published!.summary.selectionDraft).toBe(true); expect(result.published!.summary.canRedo).toBe(true);
            } else expect(result.published).toBeUndefined();
            exact(result.failed, polygonBaselineIds); expect(result.failed.summary.canRedo).toBe(true);
            expect(result.failed.summary.selectionDraft).toBe(false); expect(result.failed.summary.transaction).toBe(false);
            expect(result.failed.error).toBeNull(); expect(result.failed.active).toBe(true);
            expect(result.deferred).toMatchObject({ computationFailed: true, hasFailed: false, cleanupNeeded: false });
            expect(result.deferred.state.selectionRecovery).toBe('idle');
            exact(result.suppressed, polygonBaselineIds); expect(result.suppressed.summary.canRedo).toBe(true);
            expect(result.suppressedCalls).toEqual({ previews: 0, commands: 0 });
            expect(result.previewResults).toHaveLength(priorPreview ? 2 : 1);
            expect(result.previewResults.filter(value => value.injected)).toHaveLength(1);
            expect(result.previewResults.every(value => value.actual.kind === 'published')).toBe(true);
            expect(result.accepted).toBe(true); expect(result.after.active).toBe(false);
            expect(result.after.summary.selectionDraft).toBe(false); expect(result.after.summary.transaction).toBe(false);
            expect(result.after.error).toBeNull();

            // Rectangle center/touched membership is independently [1]/[1,2].
            // The full brush/Volume path additionally reaches independent ID3;
            // dropping its first segment would lose IDs1/2 from the final mask.
            const finalIds = tool === 'rectangle' ? [1, 2] : [1, 2, 3];
            if (terminal === 'finish') {
              exact(result.after, finalIds); expect(result.after.summary.canRedo).toBe(false);
              expect(result.finalEvaluations).toBe(1);
              expect(result.finalRequest).toMatchObject({ operation: 0, overlap: true, visibleOnly: tool === 'visible-brush',
                points: result.fullPath, fromBaseline: true });
              expect(result.fullPath).toHaveLength(3);
              expect(result.undone).toBeDefined(); exact(result.undone!, polygonBaselineIds);
              exact(result.redone, finalIds); exact(result.settled, finalIds);
            } else {
              exact(result.after, polygonBaselineIds); expect(result.after.summary.canRedo).toBe(true);
              expect(result.finalEvaluations).toBe(0); expect(result.finalRequest).toBeUndefined();
              expect(result.undone).toBeUndefined(); exact(result.redone, [0, 2, 3]); exact(result.settled, [0, 2, 3]);
            }
            expect(result.work).toBe(0); expect(result.settled.work).toBe(0);
            expect(result.settled.summary.selectionMapBytes).toBe(0); expect(result.settled.summary.selectionMapId).toBeNull();
            await info.attach('geometric-deferred-live-result.json', {
              body: Buffer.from(JSON.stringify({ injectionBoundary,
                workflowBoundary: 'controller release payload; no physical profile/Mac interaction claim', result }, null, 2)),
              contentType: 'application/json',
            });
          });
        }
      }
    }
  }
});
