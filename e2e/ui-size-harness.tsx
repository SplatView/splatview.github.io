// Actual App UI with test-only startup substitution. No native runtime, worker,
// GPU or scene fixture is initialized by these appearance-only contracts.
import { createRoot } from 'react-dom/client';
import { App } from '../src/ui/App';
import { AppController } from '../src/app/controller';
import { setApp, useApp } from '../src/app/store';
import { useUiPreferences } from '../src/app/uiPreferences';

const commands: string[] = [];
AppController.prototype.initialize = async function () {
  setApp({ ready: true, rendererState: 'ready', bootstrapState: 'ready', toolsOpen: true });
};
AppController.prototype.command = async function (command) { commands.push(command.command); return true; };
window.uiSizeHarness = {
  preference: () => ({ size: useUiPreferences.getState().size, preview: useUiPreferences.getState().previewSize }),
  application: () => { const state = useApp.getState(); return { mode: state.mode, dirty: state.dirty, summary: state.summary, commands: [...commands] }; },
  mode: (mode: 'basic' | 'pro') => setApp({ mode }),
};
createRoot(document.getElementById('root')!).render(<App />);
declare global {
  interface Window { uiSizeHarness: {
    preference(): { size: string; preview: string | null };
    application(): { mode: string; dirty: boolean; summary: unknown; commands: string[] };
    mode(mode: 'basic' | 'pro'): void;
  }; }
}
