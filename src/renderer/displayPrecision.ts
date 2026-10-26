import type { SortPrecision } from './sortPrecision';

export type DisplayPoseIdentity=Readonly<{owner:object;scene:object|undefined;camera:object;revision:number}>;
/** A changed pose may use the qualified interactive key; a stationary or new
 * owner uses exact order. The host schedules the final refinement frame. */
export function interactiveDisplayPrecision(previous:DisplayPoseIdentity|undefined,current:DisplayPoseIdentity):SortPrecision {
  return previous&&previous.owner===current.owner&&previous.scene===current.scene&&previous.camera===current.camera&&previous.revision!==current.revision?24:32;
}
