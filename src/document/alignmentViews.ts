import { carryCameraState, type AlignmentCameraState, type AlignmentCameraTransform,
  type AlignmentFrame, type AlignmentFrameChange } from './alignment';
import { sameAlignmentBranch, type AlignmentSummary } from './alignmentProtocol';

/** Metadata only: these checkpoints retain no native scene, image or history payload. */
export type AlignmentViewCheckpoint = Readonly<{
  branchId: number; frame: AlignmentFrame; activeRoll: number; defaultRoll: number; corrected: boolean;
}>;
export type AlignmentViewCheckpoints = ReadonlyMap<number, AlignmentViewCheckpoint>;
export const MAX_ALIGNMENT_VIEW_CHECKPOINTS = 34;
// Count-bounded JS bookkeeping allowance; this is not native allocation credit.
export const ALIGNMENT_VIEW_BOOKKEEPING_BYTES = MAX_ALIGNMENT_VIEW_CHECKPOINTS * 1024;

export type PreparedAlignmentView = Readonly<{
  active: AlignmentCameraState; defaultCamera: AlignmentCameraState;
  checkpoints: AlignmentViewCheckpoints;
}>;

/** Captured Viewer::prepareAlignmentView/carryAlignmentView checkpoint semantics. */
export function prepareAlignmentView(before: AlignmentSummary, after: AlignmentSummary,
  active: readonly number[], defaultCamera: readonly number[], checkpoints: AlignmentViewCheckpoints,
  transform: AlignmentCameraTransform, frameChange: AlignmentFrameChange,
  policy?: 0 | 1): PreparedAlignmentView | null {
  if (sameAlignmentBranch(before, after)) return null;
  const camera = carryCameraState(active, before.frame, after.frame, transform, frameChange);
  const nextDefault = carryCameraState(defaultCamera, before.frame, after.frame, transform, frameChange);
  const source = Object.freeze({ branchId: before.branchId, frame: before.frame,
    activeRoll: Math.fround(active[9]), defaultRoll: Math.fround(defaultCamera[9]),
    corrected: checkpoints.get(before.branchId)?.corrected ?? false });
  let target: AlignmentViewCheckpoint = Object.freeze({ branchId: after.branchId, frame: after.frame,
    activeRoll: camera[9], defaultRoll: nextDefault[9], corrected: source.corrected });
  if (policy !== undefined) {
    if (policy === 1) camera[9] = nextDefault[9] = 0;
    target = Object.freeze({ ...target, activeRoll: camera[9], defaultRoll: nextDefault[9],
      corrected: policy === 1 || source.corrected });
  } else {
    const existing = checkpoints.get(after.branchId);
    if (existing) {
      target = existing;
      if (source.corrected || target.corrected) {
        camera[9] = target.activeRoll; nextDefault[9] = target.defaultRoll;
      }
    }
  }
  const retained = new Set(after.retainedBranchIds);
  const next = new Map([...checkpoints].filter(([branch]) => branch === 0 || retained.has(branch)));
  // History carries the current pose but does not overwrite intentional rolls.
  if (policy !== undefined) { next.set(source.branchId, source); next.set(target.branchId, target); }
  if (next.size > MAX_ALIGNMENT_VIEW_CHECKPOINTS)
    throw new Error('The alignment camera history is full. Reopen the scene to continue.');
  return Object.freeze({ active: camera, defaultCamera: nextDefault, checkpoints: next });
}

/** An explicit saved/default view replaces only the default-roll lineage. */
export function replaceAlignmentDefaultRolls(checkpoints: AlignmentViewCheckpoints, rolls: readonly number[]): AlignmentViewCheckpoints {
  if (rolls.length !== checkpoints.size || rolls.some(value => !Number.isFinite(value) || !Number.isFinite(Math.fround(value))))
    throw new Error('The saved view cannot produce valid alignment roll checkpoints.');
  return new Map([...checkpoints].map(([branch, entry], index) => [branch,
    Object.freeze({ ...entry, defaultRoll: Math.fround(rolls[index]) })]));
}

/** Viewer::resetCamera starts active roll history from the current default. */
export function resetAlignmentActiveRolls(checkpoints: AlignmentViewCheckpoints): AlignmentViewCheckpoints {
  return new Map([...checkpoints].map(([branch, entry]) => [branch,
    Object.freeze({ ...entry, activeRoll: entry.defaultRoll })]));
}
