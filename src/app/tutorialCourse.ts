import { TUTORIAL_STEPS, type TutorialStep, type TutorialStepId } from './tutorialCatalog';

export type TutorialCourseId = 'essentials' | 'all';
export type TutorialChapter = 'View and save' | 'Tools overview' | 'Selection' | 'Transform' | 'Color';
export type TutorialCourseStep = TutorialStep & Readonly<{ chapter: TutorialChapter }>;

export const TUTORIAL_OFFER_TEXT = 'Take the Essentials tour with a sample scene. More topics are available inside the tour. Replay in Settings > Help.';

// Follow the chrome left to right, then the panel top to bottom. Shared menus
// stay together; chapter browsing and Next/Back use this same inventory.
const chapterTopics = [
  { chapter: 'View and save', ids: ['open', 'save', 'capture', 'navigation', 'auto-rotate', 'guides', 'lens', 'tools'] },
  { chapter: 'Tools overview', ids: ['undo-redo', 'settings', 'thumbnail', 'scope', 'histogram'] },
  { chapter: 'Selection', ids: ['cleanup-reset', 'single', 'brushes', 'area', 'color-select', 'fill', 'combine', 'options',
    'actions', 'selection-edits', 'selection-finish'] },
  { chapter: 'Transform', ids: ['transform-reset', 'pick-center', 'scale-align', 'plane-align', 'gizmo', 'snap-flips'] },
  { chapter: 'Color', ids: ['color-reset', 'auto-color', 'presets', 'color-slider'] },
] as const satisfies readonly Readonly<{ chapter: TutorialChapter; ids: readonly TutorialStepId[] }>[];
const allIds = chapterTopics.flatMap<TutorialStepId>(group => group.ids);
const chapterById = new Map<TutorialStepId, TutorialChapter>();
for (const group of chapterTopics) for (const id of group.ids) chapterById.set(id, group.chapter);
const essentialTopics = new Set<TutorialStepId>([
  'open', 'save', 'capture', 'navigation', 'tools', 'undo-redo', 'settings', 'thumbnail', 'scope', 'histogram',
  'brushes', 'area', 'combine', 'selection-edits', 'selection-finish', 'gizmo', 'color-reset', 'auto-color', 'presets', 'color-slider',
]);
const essentialsIds = allIds.filter(id => essentialTopics.has(id));
const commonCopy: Readonly<Partial<Record<TutorialStepId, string>>> = Object.freeze({
  open: 'Follow the highlighted controls from left to right, then down the Tools panel. Use Topics to choose a lesson. Close the tour or press Esc to try the tools.',
  save: 'Choose a format, then download a new copy of the scene. The source file stays unchanged.',
  'selection-finish': 'Check keeps the selection and exits. Undo reverses the last eligible action. C clears the selection. Right-click clears, then exits when empty.',
  gizmo: 'Choose Move, Rotate or Scale, then drag a handle. Check keeps edits; Undo reverses a drag; Esc cancels the session.',
  'snap-flips': 'Use the magnet or hold Ctrl while dragging to snap. Flip X/Y/Z changes orientation.',
  'auto-color': 'Choose an automatic correction from Auto color. It commits immediately; Undo reverses the change.',
  'color-reset': 'Reset the preview to neutral colors. Apply color commits the preview; Undo reverses a committed change.',
  settings: 'Choose language, theme and text size. Replay the tutorial in Settings > Help.',
});
const essentialsCopy: Readonly<Partial<Record<TutorialStepId, Readonly<{ title: string; text?: string }>>>> = Object.freeze({
  open: Object.freeze({ title: 'Welcome to SplatView',
    text: 'Explore the sample and the main controls. If you already opened a scene, it stays in place. Close the text tour to try the tools.' }),
  area: Object.freeze({ title: 'Rectangle', text: 'Drag a rectangle to select splats through the scene.' }),
  'selection-edits': Object.freeze({ title: 'Delete and Undo',
    text: 'Delete hides the selected splats. Undo brings them back. Keep hides everything outside the selection.' }),
});

function course(id: TutorialCourseId, label: 'Essentials' | 'All topics', ids: readonly TutorialStepId[], available: readonly TutorialStep[]) {
  const visible = ids.filter(stepId => available.some(step => step.id === stepId));
  const steps: readonly TutorialCourseStep[] = Object.freeze(visible.map((stepId, index) => {
    const original = available.find(step => step.id === stepId)!;
    const override = id === 'essentials' ? essentialsCopy[stepId] : undefined;
    const chapter = chapterById.get(stepId)!;
    return Object.freeze({ ...original, index: index + 1, displayMode: 'basic' as const, chapter,
      title: override?.title ?? original.title, text: override?.text ?? commonCopy[stepId] ?? original.text });
  }));
  return Object.freeze({ id, label, steps });
}

/** Presentation-only courses; the controller retains every editor/session owner. */
export function createTutorialCourses(available: readonly TutorialStep[]) {
  return Object.freeze({
    essentials: course('essentials', 'Essentials', essentialsIds, available),
    all: course('all', 'All topics', allIds, available),
  });
}
export const TUTORIAL_COURSES = createTutorialCourses(TUTORIAL_STEPS);
