import { browserProductCapabilities, tutorialTargetAllowed } from './productPolicy';
// Pinned SplatView v1.0.2, commit 4e1be155511fb49f08fd8c863d785ac008a4c43a,
// src/tutorial.hpp:7-208 (tutorialVersion7). Exact decoded native copy and
// source lines stay separate from browser adaptations. AgentAccess is omitted.
export const TUTORIAL_VERSION = 7;
export const TUTORIAL_NATIVE_OMISSIONS = Object.freeze(['AgentAccess'] as const);
export const TUTORIAL_TARGETS = Object.freeze([
  'open',
  'save',
  'navigation',
  'auto-rotate',
  'guides',
  'lens',
  'capture',
  'thumbnail',
  'tools',
  'undo-redo',
  'settings',
  'modes',
  'scope',
  'histogram',
  'single',
  'brushes',
  'area',
  'color-select',
  'fill',
  'combine',
  'refine',
  'actions',
  'selection-edits',
  'duplicate',
  'current-view',
  'options',
  'range',
  'selection-finish',
  'cleanup-reset',
  'filter',
  'auto-color',
  'presets',
  'color-slider',
  'pro-color',
  'color-reset',
  'pick-center',
  'scale-align',
  'plane-align',
  'floor',
  'gizmo',
  'transform-mode',
  'coordinates',
  'snap-flips',
  'pivot',
  'transform-values',
  'transform-reset',
] as const);
export type TutorialTarget = typeof TUTORIAL_TARGETS[number];
export const TUTORIAL_STEP_IDS = Object.freeze([
  'open',
  'save',
  'thumbnail',
  'capture',
  'navigation',
  'auto-rotate',
  'guides',
  'lens',
  'tools',
  'undo-redo',
  'settings',
  'modes',
  'scope',
  'histogram',
  'cleanup-reset',
  'single',
  'brushes',
  'area',
  'color-select',
  'fill',
  'filter-choice',
  'combine',
  'refine',
  'options',
  'range',
  'actions',
  'current-view',
  'selection-edits',
  'duplicate',
  'filter-confirm',
  'selection-finish',
  'transform-reset',
  'pick-center',
  'scale-align',
  'plane-align',
  'floor',
  'transform-mode',
  'gizmo',
  'coordinates',
  'snap-flips',
  'pivot',
  'transform-values',
  'color-reset',
  'auto-color',
  'presets',
  'color-slider',
  'pro-color',
] as const);
export type TutorialStepId = typeof TUTORIAL_STEP_IDS[number];
export type TutorialSection = 'Selection' | 'Color' | 'Transform';
export type TutorialDisplayMode = 'basic' | 'pro';
export type TutorialStep = Readonly<{
  id: TutorialStepId; index: number; title: string; text: string; target: TutorialTarget;
  section: TutorialSection | null; tools: boolean; displayMode: TutorialDisplayMode;
  nativeTarget: string; nativeTitle: string; nativeText: string; nativeSourceLine: number;
}>;
type NativeStep = Readonly<{
  id: TutorialStepId; title: string; text: string; target: TutorialTarget; nativeTarget: string; nativeSourceLine: number;
  section?: TutorialSection; tools?: boolean; displayMode?: TutorialDisplayMode;
}>;

// Exact bytes are independently pinned in tests/fixtures/tutorial-v7.hpp.
const nativeSteps: readonly NativeStep[] = [
  {"id":"open","title":"Open a scene","text":"Open a splat to edit, or another PLY to view.","target":"open","nativeTarget":"Open","nativeSourceLine":67},
  {"id":"save","title":"Save scene","text":"Save edits and the current view. Choose a file and format; use a new name to keep the original. Overwriting asks first.","target":"save","nativeTarget":"Save","nativeSourceLine":68},
  {"id":"thumbnail","title":"Set Explorer thumbnail","text":"Frame the view, then click Set thumbnail (T). Saves the Explorer thumbnail, default view and background.","target":"thumbnail","nativeTarget":"Thumbnail","nativeSourceLine":72},
  {"id":"capture","title":"Capture and copy","text":"Capture saves an image. Copy sends it to the clipboard (Ctrl+C).","target":"capture","nativeTarget":"Capture","nativeSourceLine":76},
  {"id":"navigation","title":"Navigate","text":"Drag to orbit, right-drag to pan, scroll to zoom. V: Orbit/Look. R: reset view.","target":"navigation","nativeTarget":"Navigation","nativeSourceLine":78},
  {"id":"auto-rotate","title":"Orbit and flip","text":"O: auto orbit. F: flip the camera\u0027s up direction.","target":"auto-rotate","nativeTarget":"AutoRotate","nativeSourceLine":81},
  {"id":"guides","title":"Guides and background","text":"Cycle grid/axes and the black, gray or white background swatch. Guides stay out of saved images.","target":"guides","nativeTarget":"Guides","nativeSourceLine":83},
  {"id":"lens","title":"Lens and fullscreen","text":"Adjust field of view. F11: fullscreen. Esc: exit. Page Up/Down: browse files.","target":"lens","nativeTarget":"Lens","nativeSourceLine":87},
  {"id":"tools","title":"Tools","text":"Selection, Transform and Color tools.","target":"tools","nativeTarget":"Tools","nativeSourceLine":94},
  {"id":"undo-redo","title":"Undo and redo","text":"Ctrl+Z: undo. Ctrl+Y: redo.","target":"undo-redo","nativeTarget":"UndoRedo","nativeSourceLine":95,"tools":true},
  {"id":"settings","title":"Settings","text":"Choose language, theme, text size and privacy. Replay the tour in Help.","target":"settings","nativeTarget":"Settings","nativeSourceLine":96,"tools":true},
  {"id":"modes","title":"Basic and Pro","text":"Basic has selection, alignment, gizmos and color. Pro adds filters and precise controls. This tour shows Pro without changing your mode.","target":"modes","nativeTarget":"Modes","nativeSourceLine":98,"tools":true},
  {"id":"scope","title":"Edit scope","text":"Color and manual transforms use the selection, or the whole scene when empty. Alignment always moves the whole scene.","target":"scope","nativeTarget":"Scope","nativeSourceLine":103,"tools":true},
  {"id":"histogram","title":"Histogram","text":"RGB distribution of the current view: shadows left, highlights right.","target":"histogram","nativeTarget":"Histogram","nativeSourceLine":107,"tools":true},
  {"id":"cleanup-reset","title":"Reset cleanup","text":"Restore hidden splats and clear selection.","target":"cleanup-reset","nativeTarget":"CleanupReset","nativeSourceLine":109,"section":"Selection","tools":true},
  {"id":"single","title":"Single splat","text":"Click the rendered surface to select its strongest splat. Middle-drag to orbit.","target":"single","nativeTarget":"Single","nativeSourceLine":111,"section":"Selection","tools":true},
  {"id":"brushes","title":"Brushes","text":"B: screen brush. Shift+B: 3D brush. Alt+scroll: brush size.","target":"brushes","nativeTarget":"Brushes","nativeSourceLine":114,"section":"Selection","tools":true},
  {"id":"area","title":"Rectangle and polygon","text":"X: drag a rectangle. P: click or draw a polygon. Enter: close. Backspace: undo point.","target":"area","nativeTarget":"Area","nativeSourceLine":116,"section":"Selection","tools":true},
  {"id":"color-select","title":"Color picker","text":"Pick matching colors (Ctrl+E). Connected colors stays in one region. Tolerance updates live.","target":"color-select","nativeTarget":"ColorSelect","nativeSourceLine":119,"section":"Selection","tools":true},
  {"id":"fill","title":"Fill select","text":"Click a connected patch in the current view (Ctrl+G). Lower tolerance keeps the selection tighter.","target":"fill","nativeTarget":"Fill","nativeSourceLine":123,"section":"Selection","tools":true},
  {"id":"filter-choice","title":"Filters in Pro","text":"Choose one filter at a time. A new filter replaces the draft.","target":"filter","nativeTarget":"Filter","nativeSourceLine":127,"section":"Selection","tools":true},
  {"id":"combine","title":"Combine selections","text":"1-4: Replace, Add, Subtract, Intersect. Shift adds, Ctrl subtracts; both intersect.","target":"combine","nativeTarget":"Combine","nativeSourceLine":129,"section":"Selection","tools":true},
  {"id":"refine","title":"Grow and shrink","text":"Grow adds neighbors; Shrink removes boundary splats. Choose Volume or Sigma. Hover the slider: blue adds, red removes.","target":"refine","nativeTarget":"Refine","nativeSourceLine":132,"section":"Selection","tools":true},
  {"id":"options","title":"Selection options","text":"Options follows the tool: size, tolerance, visibility or live selection. Highlighted icons are on.","target":"options","nativeTarget":"Options","nativeSourceLine":136,"section":"Selection","tools":true},
  {"id":"range","title":"Selection range","text":"Turn on the sphere in Options. Preview follows the cursor before clicking; Radius updates the same selection.","target":"range","nativeTarget":"Range","nativeSourceLine":140,"section":"Selection","tools":true},
  {"id":"actions","title":"Selection actions","text":"All selects every splat. None clears. Invert swaps selected splats.","target":"actions","nativeTarget":"Actions","nativeSourceLine":144,"section":"Selection","tools":true},
  {"id":"current-view","title":"Current view only","text":"Toggle the frustum beside Invert to limit selection and selected edits to the current view. Starts off.","target":"current-view","nativeTarget":"CurrentView","nativeSourceLine":146,"section":"Selection","tools":true},
  {"id":"selection-edits","title":"Delete and keep","text":"Delete hides selected splats. Keep hides everything else. Ctrl+Z: undo.","target":"selection-edits","nativeTarget":"SelectionEdits","nativeSourceLine":150,"section":"Selection","tools":true},
  {"id":"duplicate","title":"Duplicate selection","text":"Pro: duplicate selected splats, then move the green copy. Editing it turns it yellow.","target":"duplicate","nativeTarget":"Duplicate","nativeSourceLine":152,"section":"Selection","tools":true},
  {"id":"filter-confirm","title":"Confirm a filter","text":"Adjust limits or a volume. Volume filters have a target icon to pick the center. Check confirms; Esc restores the starting selection.","target":"filter","nativeTarget":"Filter","nativeSourceLine":155,"section":"Selection","tools":true},
  {"id":"selection-finish","title":"Finish, undo or clear","text":"Check keeps the selection and exits. Undo reverses the last action. X clears. Right-click clears, then exits when empty.","target":"selection-finish","nativeTarget":"SelectionFinish","nativeSourceLine":159,"section":"Selection","tools":true},
  {"id":"transform-reset","title":"Reset transform","text":"Reset alignment, axis flips and transforms. Ctrl+Z restores them. Save a copy when finished.","target":"transform-reset","nativeTarget":"TransformReset","nativeSourceLine":163,"section":"Transform","tools":true},
  {"id":"pick-center","title":"1-point center","text":"Pick a point, then confirm. The whole scene moves; the view stays framed.","target":"pick-center","nativeTarget":"PickCenter","nativeSourceLine":167,"section":"Transform","tools":true},
  {"id":"scale-align","title":"2-point scale","text":"Pick two points, enter their target distance in meters, then confirm.","target":"scale-align","nativeTarget":"ScaleAlign","nativeSourceLine":170,"section":"Transform","tools":true},
  {"id":"plane-align","title":"3-point align","text":"Pick three points. Check the normal arrow, flip if needed, then confirm.","target":"plane-align","nativeTarget":"PlaneAlign","nativeSourceLine":172,"section":"Transform","tools":true},
  {"id":"floor","title":"Level floor","text":"Detect the floor, check its normal, then confirm. Use 3-point align if needed.","target":"floor","nativeTarget":"Floor","nativeSourceLine":174,"section":"Transform","tools":true},
  {"id":"transform-mode","title":"Rotation format","text":"Pro: choose Euler angles, quaternion, axis-angle or matrix entry.","target":"transform-mode","nativeTarget":"TransformMode","nativeSourceLine":177,"section":"Transform","tools":true},
  {"id":"gizmo","title":"Move, rotate and scale","text":"Choose a gizmo, then drag a handle. Check keeps edits; Undo reverses a drag; X cancels the session.","target":"gizmo","nativeTarget":"Gizmo","nativeSourceLine":179,"section":"Transform","tools":true},
  {"id":"coordinates","title":"Transform axes","text":"Pro: switch between world and local axes. Basic uses world axes.","target":"coordinates","nativeTarget":"Coordinates","nativeSourceLine":183,"section":"Transform","tools":true},
  {"id":"snap-flips","title":"Snap and axis flips","text":"Use the magnet or hold Ctrl to snap. Flip X/Y/Z changes orientation. Available in Basic and Pro.","target":"snap-flips","nativeTarget":"SnapFlips","nativeSourceLine":185,"section":"Transform","tools":true},
  {"id":"pivot","title":"Transform pivot","text":"Pro: cycle the pivot through scene center, selection center and origin.","target":"pivot","nativeTarget":"Pivot","nativeSourceLine":189,"section":"Transform","tools":true},
  {"id":"transform-values","title":"Exact transforms","text":"Pro: type translation, scale, pivot and rotation values. Distances are in meters.","target":"transform-values","nativeTarget":"TransformValues","nativeSourceLine":191,"section":"Transform","tools":true},
  {"id":"color-reset","title":"Reset color","text":"Reset color and opacity. Ctrl+Z restores the previous values.","target":"color-reset","nativeTarget":"ColorReset","nativeSourceLine":194,"section":"Color","tools":true},
  {"id":"auto-color","title":"Auto color","text":"Hover to preview the image and histogram. Click to apply and update the sliders.","target":"auto-color","nativeTarget":"AutoColor","nativeSourceLine":196,"section":"Color","tools":true},
  {"id":"presets","title":"Color presets","text":"Hover to preview; click to apply. A dot marks the active preset. Pro offers more.","target":"presets","nativeTarget":"Presets","nativeSourceLine":199,"section":"Color","tools":true},
  {"id":"color-slider","title":"Color sliders","text":"Right-click a slider to type a value. Temperature: -100 cool, 0 neutral, +100 warm.","target":"color-slider","nativeTarget":"ColorSlider","nativeSourceLine":202,"section":"Color","tools":true},
  {"id":"pro-color","title":"More color controls","text":"Pro adds gamma, vibrance, tint, shadows, highlights, hue and Fade / boost. They stay active in Basic.","target":"pro-color","nativeTarget":"ProColor","nativeSourceLine":205,"section":"Color","tools":true},
];

// Browser storage, focus-owned shortcuts, explicit expensive work and numeric
// Apply/Cancel differ from desktop. IDs keep adaptations stable across ordering.
export const TUTORIAL_ADAPTATIONS: Readonly<Partial<Record<TutorialStepId, Readonly<{ title?: string; text: string }>>>> = Object.freeze({
  save: { text: 'Choose a format and export scope, then save a copy to keep the source.' },
  thumbnail: { title: 'Remember view', text: 'In Settings > General, choose Remember view to save this camera view and background in this browser.' },
  capture: { text: 'Capture saves an image. Copy sends it to the clipboard (Ctrl+C, or Command+C on Mac).' },
  lens: { text: 'Adjust field of view or use Fullscreen. Page Up/Down browses an available scene collection when the scene has focus.' },
  'undo-redo': { text: 'Ctrl+Z: undo. Ctrl+Y: redo. On Mac, use Command instead of Ctrl.' },
  'color-select': { text: 'Pick matching colors (Ctrl+E, or Command+E on Mac). Connected colors stays in one region. Tolerance updates live.' },
  fill: { text: 'Click a connected region. G selects Fill when the scene has focus. Lower tolerance keeps the selection tighter.' },
  combine: { text: '1-4: Replace, Add, Subtract, Intersect. Shift adds; Ctrl (Command on Mac) subtracts; both intersect.' },
  refine: { text: 'In Pro, Grow adds one layer and Shrink removes boundary splats. Choose Volume for center distance or Sigma for touching ellipsoids. Changes apply when you click Grow or Shrink.' },
  range: { text: 'Enable Range for Color or Fill. A successful pick fixes its center; the sphere is shown in Tools. Release Radius or finish typing to update the same selection.' },
  'selection-finish': { text: 'Check keeps the selection and exits. Undo reverses eligible selection history in this session. X clears. Right-click clears, then exits when empty.' },
  'transform-reset': { text: 'Reset alignment, axis flips and transforms. An active gizmo session is cancelled first. Use Undo to reverse committed changes.' },
  'snap-flips': { text: 'Use the magnet or hold Ctrl (Command on Mac) to snap. Flip X/Y/Z changes orientation. Available in Basic and Pro.' },
  'transform-values': { text: 'In Pro, enter translation, scale, pivot and rotation values. Distances are in meters. Apply commits the preview; Cancel discards uncommitted values.' },
  'auto-color': { text: 'Choose an automatic correction from Auto color. The Color controls show the result.' },
  presets: { text: 'Choose a preset to update the color preview. Use Apply color to commit the preview. Pro offers more presets.' },
  'color-reset': { text: 'Reset the current color and opacity preview.' },
});

// Retain the exact reviewed desktop capture independently from the active product projection.
export const TUTORIAL_ALL_STEPS: readonly TutorialStep[] = Object.freeze(nativeSteps.map((step, index) => {
  const adaptation = TUTORIAL_ADAPTATIONS[step.id];
  return Object.freeze({ id: step.id, index: index + 1,
    title: adaptation?.title ?? step.title, text: adaptation?.text ?? step.text, target: step.target,
    section: step.section ?? null, tools: step.tools ?? false, displayMode: step.displayMode ?? 'pro',
    nativeTarget: step.nativeTarget, nativeTitle: step.title, nativeText: step.text, nativeSourceLine: step.nativeSourceLine });
}));
// The lightweight product omits Pro-only clauses from these adaptations.
export const TUTORIAL_BASIC_ADAPTATIONS: Readonly<Partial<Record<TutorialStepId, string>>> = Object.freeze({
  presets: 'Choose a preset to update the color preview. Use Apply color to commit the preview.',
  'snap-flips': 'Use the magnet or hold Ctrl (Command on Mac) to snap. Flip X/Y/Z changes orientation.',
});
/** Steps available with the given browser capabilities; tests pass an explicit set. */
export function availableTutorialSteps(capabilities: readonly string[] = browserProductCapabilities()): readonly TutorialStep[] {
  return Object.freeze(TUTORIAL_ALL_STEPS.filter(step => tutorialTargetAllowed(step.target, capabilities)).map((step, index) =>
    Object.freeze({ ...step, index: index + 1, displayMode: 'basic' as const, tools: step.id === 'thumbnail' || step.tools,
      text: TUTORIAL_BASIC_ADAPTATIONS[step.id] ?? step.text })));
}
export const TUTORIAL_STEPS: readonly TutorialStep[] = availableTutorialSteps();
