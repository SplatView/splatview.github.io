import { create } from 'zustand';
import { webFeatureAllowed } from './productPolicy';
import { NEUTRAL_COLOR, type NativeSummary } from '../document/types';
import type { BackgroundColor } from '../input/background';
import type { SavedViewRecord } from '../io/savedView';
import type { RenderedHistogram } from '../renderer/histogram';
import { SELECTION_SIGMA_DEFAULT } from '../input/selectionMorphology';
import type { ColorSessionState } from '../document/colorSession';
import type { FloorSummary } from '../document/floorProtocol';
import { filterDefaults, type SelectionFilterKind, type SelectionFilterParameters } from '../document/filterProtocol';
import type { FilterGizmoMode } from '../document/filterGizmo';
import { transformDefaults, type TransformKind, type TransformMatrix, type TransformParameters, type TransformVec3 } from '../document/transformProtocol';
import type { TransformPivotMode } from '../document/transformPivot';
import type { SelectionRangePreference } from '../document/selectionRange';
export type { FilterGizmoMode, FilterGizmoPose } from '../document/filterGizmo';
export type { TransformMode, TransformParameters } from '../document/transformProtocol';
export type SelectionTool = 'single' | 'brush' | 'volume' | 'rectangle' | 'polygon' | 'color' | 'fill';
export type ToolsMode = 'basic' | 'pro';
export type ToolbarAction = 'save' | 'capture' | 'thumbnail';
export type ToolbarFeedback = Readonly<{ sequence: number; message: 'Download prepared' | 'Thumbnail and default view saved in this browser.' }>;
export type FloorState = {
  phase: 'detecting' | 'cancelling' | 'candidate' | 'failed';
  progress: number; message: string | null; candidate: FloorSummary | null;
};
export type FilterState = {
  kind: SelectionFilterKind;
  phase: 'preparing' | 'ready' | 'previewing' | 'confirming' | 'cancelling' | 'required';
  parameters: SelectionFilterParameters; operation: number; dirty: boolean;
  desiredRevision: number; previewRevision: number | null; id: number | null;
};
export type TransformState = {
  phase: 'preparing' | 'ready' | 'applying' | 'resetting' | 'ending' | 'required';
  kind: TransformKind; selectedOnly: boolean; id: number | null; baseId: number | null;
  desiredRevision: number; appliedRevision: number | null; dirty: boolean;
};
export type TransformPreview = {
  matrix: TransformMatrix; pivot: TransformVec3; selectedOnly: boolean; kind: TransformKind;
  id: number; baseId: number; epoch: number;
};
export type OpacityState = {
  phase: 'preparing' | 'ready' | 'applying' | 'resetting' | 'ending' | 'required';
  selectedOnly: boolean; id: number | null; baseId: number | null;
  desiredRevision: number; appliedRevision: number | null; dirty: boolean;
};
export type OpacityPreview = { scale: number; selectedOnly: boolean; id: number; baseId: number; epoch: number; revision: number };
type SelectionPreferences = { operation: number; visibleOnly: boolean; overlap: boolean; live: boolean };
const defaults: Record<ToolsMode, SelectionPreferences> = {
  basic: { operation: 1, visibleOnly: true, overlap: true, live: false },
  pro: { operation: 0, visibleOnly: false, overlap: false, live: false },
};
const modeKey = 'splatview.tools-mode.v1';
function initialMode(): ToolsMode {
  if (!webFeatureAllowed('processing.advanced')) return 'basic';
  try { return localStorage.getItem(modeKey) === 'pro' ? 'pro' : 'basic'; } catch { return 'basic'; }
}
const mode = initialMode();
type AppState = {
  ready: boolean; busy: boolean; stage: string; progress: number; error: string | null;
  rendererState: 'ready' | 'recovering' | 'unavailable';
  bootstrapState: 'initializing' | 'ready' | 'failed';
  runtimeMode: 'production-verified' | 'development-module-graph' | null;
  selectionRecovery: 'idle' | 'restoring' | 'required';
  operationRecovery: 'idle' | 'checking' | 'required';
  operationRecoveryCommitted: boolean;
  memoryOverageBytes: number;
  summary: NativeSummary | null; sourceName: string; dirty: boolean; toolsOpen: boolean;
  toolbarFeedback: Readonly<Record<ToolbarAction, ToolbarFeedback | null>>;
  collectionCount: number; collectionIndex: number; collectionPath: string; collectionPrevious: boolean; collectionNext: boolean;
  histogram: RenderedHistogram | null; histogramUnavailable: boolean;
  settingsOpen: boolean; exportOpen: boolean; mode: ToolsMode; pendingMode: ToolsMode | null; fly: boolean; autoOrbit: boolean;
  grade: number[]; appliedGrade: number[]; colorSession: ColorSessionState | null; colorSelectedOnly: boolean; gradeRevision: number;
  tool: SelectionTool | null; operation: number; brushSize: number; selectionSigma: number;
  selectionMorphologyMethod: 'volume' | 'sigma'; selectionDistance: number | null;
  filter: FilterState | null; filterParameters: SelectionFilterParameters;
  filterVolumeVisible: boolean; filterLocalAxes: boolean; filterSnap: boolean;
  filterGizmoMode: FilterGizmoMode | null; filterGizmoDragging: boolean;
  filterCenterPicking: boolean; filterCenterPending: boolean;
  transform: TransformState | null; transformParameters: TransformParameters; transformPreview: TransformPreview | null;
  transformPivotMode: TransformPivotMode; transformPivotChosen: boolean; transformPivotPending: boolean;
  transformGizmoMode: FilterGizmoMode | null; transformGizmoDragging: boolean;
  opacity: OpacityState | null; opacityScale: number; opacityPreview: OpacityPreview | null; opacityPreviewRevision: number;
  alignmentTool: 'center' | 'scale' | 'align' | 'floor' | null; alignmentPoint: [number, number, number] | null;
  alignmentSecondPoint: [number, number, number] | null; alignmentTargetDistance: number | null; alignmentPicking: boolean;
  alignmentThirdPoint: [number, number, number] | null; alignmentFlip: boolean;
  alignmentNormal: [number, number, number] | null;
  alignmentFloor: FloorState | null;
  currentViewOnly: boolean;
  visibleOnly: boolean; overlap: boolean; live: boolean; tolerance: number; colorTolerance: number; fillTolerance: number; connectedColor: boolean;
  colorRange: SelectionRangePreference; fillRange: SelectionRangePreference;
  navigationPrompt: boolean; navigationIntent: 'replace' | 'close' | null; outputPending: boolean;
  thumbnailPending: boolean; viewTransferPending: boolean; savedViewAvailable: boolean; viewStatus: string | null; savedViewChoices: readonly SavedViewRecord[];
  background: BackgroundColor; selectionOperation: number | null; selectionModifiers: number;
  selectionDragging: boolean; selectionActionPending: boolean; pendingSelectionCount: number; selectionOptionsRevision: number; selectionPreferences: Record<ToolsMode, SelectionPreferences>; preferencesError: string | null;
};
export const useApp = create<AppState>(() => ({
  ready: false, busy: false, stage: '', progress: 0, error: null, rendererState: 'unavailable', selectionRecovery: 'idle', operationRecovery: 'idle', operationRecoveryCommitted: false, memoryOverageBytes: 0, summary: null,
  bootstrapState: 'initializing', runtimeMode: null,
  sourceName: '', dirty: false, toolsOpen: false, histogram: null, histogramUnavailable: false, settingsOpen: false, exportOpen: false,
  toolbarFeedback: { save: null, capture: null, thumbnail: null },
  collectionCount: 0, collectionIndex: 0, collectionPath: '', collectionPrevious: false, collectionNext: false,
  mode, pendingMode: null, fly: false, autoOrbit: false, grade: [...NEUTRAL_COLOR], appliedGrade: [...NEUTRAL_COLOR],
  colorSession: null, colorSelectedOnly: false, gradeRevision: 0, tool: null,
  filter: null, filterParameters: filterDefaults(), filterVolumeVisible: true, filterLocalAxes: false, filterSnap: false,
  filterGizmoMode: null, filterGizmoDragging: false,
  filterCenterPicking: false, filterCenterPending: false,
  transform: null, transformParameters: transformDefaults(), transformPreview: null, transformGizmoMode: null, transformGizmoDragging: false,
  transformPivotMode: 'scene', transformPivotChosen: false, transformPivotPending: false,
  opacity: null, opacityScale: 1, opacityPreview: null, opacityPreviewRevision: 0,
  alignmentTool: null, alignmentPoint: null, alignmentSecondPoint: null, alignmentTargetDistance: null, alignmentPicking: false,
  alignmentThirdPoint: null, alignmentFlip: false, alignmentNormal: null, alignmentFloor: null,
  // The current-view scope belongs to this viewer, outside Basic/Pro profiles.
  currentViewOnly: false,
  // Viewer-session preferences, deliberately outside the Basic/Pro profiles.
  // null retains the desktop's automatic reach until the user edits Diameter.
  ...defaults[mode], brushSize: 48, selectionSigma: SELECTION_SIGMA_DEFAULT,
  selectionMorphologyMethod: 'volume', selectionDistance: null,
  tolerance: .01, colorTolerance: .01, fillTolerance: .01, connectedColor: false,
  colorRange: { enabled: false, radius: null }, fillRange: { enabled: false, radius: null },
  selectionDragging: false, selectionActionPending: false, pendingSelectionCount: 0, selectionOptionsRevision: 0, selectionPreferences: { basic: { ...defaults.basic }, pro: { ...defaults.pro } }, preferencesError: null,
  navigationPrompt: false, navigationIntent: null, outputPending: false, background: 'black', selectionOperation: null, selectionModifiers: 0,
  thumbnailPending: false, viewTransferPending: false, savedViewAvailable: false, viewStatus: null, savedViewChoices: [],
}));
export const setApp = useApp.setState;
export function setSelectionPreferences(patch: Partial<SelectionPreferences>) {
  const state = useApp.getState(), current = { operation: state.operation, visibleOnly: state.visibleOnly, overlap: state.overlap, live: state.live, ...patch };
  // Windows setSelectionOptions ends a completed tolerance checkpoint even
  // when the same options are explicitly assigned. Profile restoration and
  // Combine changes do not invoke that setter and keep the captured click.
  const optionEdit = 'visibleOnly' in patch || 'overlap' in patch || 'live' in patch;
  setApp({ ...current, selectionOptionsRevision: state.selectionOptionsRevision + Number(optionEdit),
    selectionPreferences: { ...state.selectionPreferences, [state.mode]: current } });
}
export function switchToolsMode(requested: ToolsMode, ownedSelectionBusy = false) {
  const state = useApp.getState();
  // A filter owns an unconfirmed baseline independently of manual gestures.
  // The controller must join explicit cancellation before Basic can hide it.
  if (requested !== state.mode && (state.filter || state.opacity || state.transform && (state.transform.kind !== 'gizmo' || state.transform.phase !== 'ready' || state.transform.dirty || state.transformGizmoDragging))) { setApp({ pendingMode: requested }); return; }
  const dragging = (state.selectionDragging || state.summary?.selectionDraft) && state.tool !== 'polygon';
  // Toggling back to the active profile cancels a deferred request immediately.
  // Completed Color/Fill amendments and an unfinished Polygon can change
  // profiles through owned work. Released clicks keep their captured profile
  // until their entire commit or rollback settles; unrelated work still waits.
  if (requested !== state.mode && (dragging || state.pendingSelectionCount > 0 || state.busy && !ownedSelectionBusy)) {
    setApp({ pendingMode: requested }); return;
  }
  const current = { operation: state.operation, visibleOnly: state.visibleOnly, overlap: state.overlap, live: state.live };
  const preferences = { ...state.selectionPreferences, [state.mode]: current };
  let preferencesError = null;
  try { localStorage.setItem(modeKey, requested); } catch { preferencesError = 'Could not save tool preferences. This window keeps your choice.'; }
  setApp({ mode: requested, pendingMode: null, ...preferences[requested], selectionPreferences: preferences, preferencesError });
}
