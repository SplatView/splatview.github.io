import { useEffect, useLayoutEffect, useState } from 'react';
import { effectiveTheme, themeStyle, useThemePreferences } from './themePreferences';

// Root-level variables also reach body portals. Scene colors and camera
// background remain renderer-owned; changing appearance never edits them.
export function useThemeAppearance() {
  const preference = useThemePreferences();
  const [systemDark, setSystemDark] = useState(() =>
    typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)').matches : true);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const changed = () => setSystemDark(query.matches);
    changed(); query.addEventListener('change', changed);
    return () => query.removeEventListener('change', changed);
  }, []);
  const displayed = preference.previewTheme ?? preference.theme;
  useLayoutEffect(() => {
    const root = document.documentElement, previousTheme = root.getAttribute('data-ui-theme');
    const previous = Object.entries(themeStyle(displayed, systemDark)).map(([name, value]) => {
      const property = name === 'colorScheme' ? 'color-scheme' : name;
      const old = root.style.getPropertyValue(property), priority = root.style.getPropertyPriority(property);
      root.style.setProperty(property, String(value));
      return { property, old, priority };
    });
    root.dataset.uiTheme = effectiveTheme(displayed, systemDark);
    return () => {
      for (const { property, old, priority } of previous) {
        if (old) root.style.setProperty(property, old, priority); else root.style.removeProperty(property);
      }
      if (previousTheme === null) root.removeAttribute('data-ui-theme'); else root.setAttribute('data-ui-theme', previousTheme);
    };
  }, [displayed, systemDark]);
}
