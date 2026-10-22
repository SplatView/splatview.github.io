import { translate } from './i18n';
import type { UiLocale } from './languagePreferences';
import type { useApp } from './store';

export const CANVAS_INSTRUCTIONS = 'Tab moves between the scene and controls. Scene shortcuts work while the scene has focus. Open Tutorial for navigation and selection controls. The canvas is visual; scene status reports the current file, tool and selection counts.';

type SceneState = ReturnType<typeof useApp.getState>;
const loadingStages = new Set(['Finding scene files', 'Opening scene', 'Reading SOG metadata', 'Reading scene', 'Decoding scene', 'Preparing scene']);
const selectionTools = {
  single: 'Single splat', brush: 'Brush', volume: 'Volume brush', rectangle: 'Box select',
  polygon: 'Polygon', color: 'Color picker', fill: 'Fill',
} as const;
const alignmentTools = { center: 'Alignment: center', scale: 'Alignment: scale', align: 'Alignment: points', floor: 'Alignment: floor' } as const;
const operations = ['Replace', 'Add', 'Subtract', 'Intersect'] as const;

/**
 * A neutral description of current state, never an operation receipt.
 * null retains the previous message while live state is transient; an empty
 * string clears it when another dialog or critical alert owns the message.
 */
export function sceneAnnouncement(state: SceneState, locale: UiLocale): string | null {
  const t = (key: string, ...args: (string | number)[]) => translate(key, locale, ...args);
  if (state.error || state.operationRecovery === 'required' || state.selectionRecovery === 'required' || state.bootstrapState === 'failed' ||
    state.memoryOverageBytes > 0 || state.filter?.phase === 'required' || state.transform?.phase === 'required' ||
    state.opacity?.phase === 'required' || state.settingsOpen || state.exportOpen || state.navigationPrompt ||
    state.outputPending || state.savedViewChoices.length) return '';
  if (state.rendererState === 'recovering') return t('Restoring graphics.');
  if (state.bootstrapState === 'initializing') return t('Starting viewer.');
  if (state.busy && loadingStages.has(state.stage)) return t('Opening a scene.');
  if (state.busy && state.stage === 'Closing scene') return t('Closing the scene.');
  if (state.selectionDragging || state.filterGizmoDragging || state.transformGizmoDragging || state.alignmentPicking || state.filterCenterPending) return null;
  if (state.pendingSelectionCount > 0) return t('Scene work in progress.');
  if (state.summary?.selectionDraft || state.summary?.pending ||
    state.filter?.phase === 'previewing' || state.transform?.phase === 'applying' || state.opacity?.phase === 'applying') return null;
  if (state.selectionRecovery === 'restoring') return t('Restoring selection.');
  if (state.busy || state.thumbnailPending || state.viewTransferPending) return t('Scene work in progress.');
  if (!state.ready || state.rendererState !== 'ready') return t('Viewer is not ready.');

  const active = state.filter ? 'Selection filter' : state.transform ? 'Transform' : state.opacity ? 'Opacity' :
    state.alignmentTool ? alignmentTools[state.alignmentTool] : state.tool ? selectionTools[state.tool] : state.fly ? 'Look navigation' : 'Orbit navigation';
  const mode = t(state.mode === 'basic' ? 'Basic' : 'Pro'), tool = t(active);
  const summary = state.summary;
  if (!summary?.loaded) return t('No scene open. %s mode. %s.', mode, tool);
  if (!Number.isSafeInteger(summary.selected) || summary.selected < 0 || !Number.isSafeInteger(summary.visible) || summary.visible < 0) return null;
  const current = t('Ready. %s. %u selected of %u visible. %s mode. %s.',
    state.sourceName || t('Current scene'), summary.selected, summary.visible, mode, tool);
  if (!state.filter && (!state.tool || state.transform || state.opacity || state.alignmentTool)) return current;
  const effectiveOperation = state.filter?.operation ?? state.selectionOperation ??
    ((state.selectionModifiers & 2) ? (state.selectionModifiers & 1) ? 3 : 2 : (state.selectionModifiers & 1) ? 1 : state.operation);
  const operation = operations[effectiveOperation];
  return operation ? t('%s Combine: %s.', current, t(operation)) : null;
}
