// Real App/native/GPU fixture; announcements are observed from their persistent
// DOM status region. Scheduling gates are inherited from the qualified harness.
import './deferred-grade-harness';
import { setApp, useApp } from '../src/app/store';
import { NEUTRAL_COLOR } from '../src/document/types';

type StatusUpdate = { text: string; busy: boolean; selected: number | null; sourceName: string; time: number };
const updates: StatusUpdate[] = [];
let observer: MutationObserver | undefined;
function region() { return document.querySelector<HTMLElement>('[role="status"][aria-live="polite"][aria-atomic="true"]'); }
function observe() {
  observer?.disconnect(); updates.length = 0;
  const target = region(); if (!target) throw new Error('The persistent scene status region is missing.');
  const record = () => {
    const state = useApp.getState(), text = target.textContent ?? '';
    if (updates.at(-1)?.text === text) return;
    updates.push({ text, busy: state.busy, selected: state.summary?.selected ?? null, sourceName: state.sourceName, time: performance.now() });
  };
  record(); observer = new MutationObserver(record); observer.observe(target, { childList: true, characterData: true, subtree: true });
}
function status() { return { text: region()?.textContent ?? null, updates: structuredClone(updates) }; }
async function load() { await window.deferredGrade.load('single', false); }
async function editedRedo() {
  const original = await window.deferredGrade.snapshot(), values = [...NEUTRAL_COLOR]; values[0] = 1.25;
  await window.deferredGrade.command({ command: 'grade', values, selectedOnly: false });
  await window.deferredGrade.command({ command: 'single', index: 1, operation: 1 });
  await window.deferredGrade.command({ command: 'undo' });
  return { original, edited: await window.deferredGrade.snapshot() };
}
const harness = { ready: () => window.deferredGrade?.ready() ?? false, load, observe, status, editedRedo,
  snapshot: () => window.deferredGrade.snapshot(), command: window.deferredGrade.command,
  physicalModifiers: () => useApp.getState().selectionModifiers,
  progress(value: number) { setApp({ progress: value, stage: 'Applying edit' }); },
  cancel: () => window.geometryViewer.controllerForSourceNavigation().cancelOperation(),
};
declare global { interface Window { accessibilityApp: typeof harness } }
window.accessibilityApp = harness;
