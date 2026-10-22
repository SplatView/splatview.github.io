import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { initializeRuntime } from './build/runtime';
import { effectiveLanguage, useLanguagePreferences } from './app/languagePreferences';
import { translate } from './app/i18n';
import { initializeOffline } from './offline/client';

// Capture this module's URL here; another module's import.meta.url is not the entry.
const entryUrl = import.meta.url;
const root = document.getElementById('root')!;
const preference = useLanguagePreferences.getState();
const initialLocale = effectiveLanguage(preference.language, preference.systemLocale);
document.documentElement.lang = initialLocale;
root.textContent = translate('Verifying SplatView…', initialLocale);
void initializeRuntime(entryUrl).then(() => {
  createRoot(root).render(<App />);
  void initializeOffline();
}, error => {
  root.replaceChildren();
  const panel = document.createElement('div'); panel.setAttribute('role', 'alert');
  const title = document.createElement('h1'); title.textContent = translate('SplatView needs a reload', initialLocale);
  const detail = document.createElement('p'); detail.textContent = error instanceof Error ? error.message : String(error);
  const reload = document.createElement('button'); reload.textContent = translate('Reload', initialLocale); reload.onclick = () => location.reload();
  panel.append(title, detail, reload); root.append(panel);
});
