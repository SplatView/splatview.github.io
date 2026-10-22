import { useEffect, useState } from 'react';
import { CANVAS_INSTRUCTIONS, sceneAnnouncement } from '../app/sceneAnnouncements';
import { useApp } from '../app/store';
import { useTranslation } from '../app/useLanguageAppearance';

/** Stable, debounced state descriptions; the controller owns operation results. */
export function SceneAccessibility({ instructionsId, suspended }: { instructionsId: string; suspended: boolean }) {
  const state = useApp(), { t, locale } = useTranslation();
  const next = suspended ? '' : sceneAnnouncement(state, locale);
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (next === null) return;
    if (!next) { setMessage(''); return; }
    const timer = window.setTimeout(() => setMessage(next), 150);
    return () => clearTimeout(timer);
  }, [next]);
  return <>
    <p id={instructionsId} className="sr-only">{t(CANVAS_INSTRUCTIONS)}</p>
    <div className="sr-only" role="status" aria-label={t('Scene status')} aria-live="polite" aria-atomic="true">{message}</div>
  </>;
}
