// Actual App UI with test-only startup substitution. No native runtime, worker,
// GPU or scene fixture is initialized by these appearance-only contracts.
import { createRoot } from 'react-dom/client';
import { App } from '../src/ui/App';
import { AppController } from '../src/app/controller';
import { setApp, useApp } from '../src/app/store';
import { useUiPreferences } from '../src/app/uiPreferences';
import { offlineState, type OfflineState } from '../src/offline/client';

// Explicit UI-only availability for update-notice tests. Normal appearance
// tests retain the original snapshot; no router/native work is simulated.
const originalOfflineSnapshot = offlineState.getSnapshot, originalOfflineSubscribe = offlineState.subscribe;
let updateSnapshot: OfflineState | undefined;
const updateListeners = new Set<() => void>();
offlineState.getSnapshot = () => updateSnapshot ?? originalOfflineSnapshot();
offlineState.subscribe = listener => {
  updateListeners.add(listener);
  const unsubscribe = originalOfflineSubscribe(listener);
  return () => { updateListeners.delete(listener); unsubscribe(); };
};

const commands: string[] = [];
AppController.prototype.initialize = async function () {
  setApp({ ready: true, rendererState: 'ready', bootstrapState: 'ready', toolsOpen: true });
};
AppController.prototype.command = async function (command) { commands.push(command.command); return true; };
window.uiSizeHarness = {
  preference: () => ({ size: useUiPreferences.getState().size, preview: useUiPreferences.getState().previewSize }),
  application: () => { const state = useApp.getState(); return { mode: state.mode, dirty: state.dirty, summary: state.summary, commands: [...commands] }; },
  mode: (mode: 'basic' | 'pro') => setApp({ mode }),
  updateAvailable: (available: boolean) => {
    updateSnapshot = Object.freeze({ phase: 'ready', current: 'a'.repeat(64), available: available ? 'b'.repeat(64) : null,
      checking: false, error: null });
    for (const listener of updateListeners) listener();
  },
};
createRoot(document.getElementById('root')!).render(<App />);
declare global {
  interface Window { uiSizeHarness: {
    preference(): { size: string; preview: string | null };
    application(): { mode: string; dirty: boolean; summary: unknown; commands: string[] };
    mode(mode: 'basic' | 'pro'): void;
    updateAvailable(available: boolean): void;
  }; }
}
