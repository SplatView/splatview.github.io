import { useState, useSyncExternalStore } from 'react';
import type { AppController } from '../app/controller';
import { useApp } from '../app/store';
import { useTranslation } from '../app/useLanguageAppearance';
import { checkOfflineUpdate, offlineState, reloadOfflineUpdate } from '../offline/client';
import { Icon } from './Icon';

const subscribe = (listener: () => void) => offlineState.subscribe(listener);
const getSnapshot = () => offlineState.getSnapshot();

/** Browser application/update information alongside the Help actions. */
export function OfflineStatus({ controller }: { controller: AppController }) {
  const { t } = useTranslation(), state = useApp(), offline = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const [checkFailed, setCheckFailed] = useState(false);
  const available = offline.available && offline.available !== offline.current ? offline.available : null;
  const message = offline.phase === 'ready' ? 'Available offline' : offline.phase === 'installing' ? 'Preparing offline use…' : 'Offline use unavailable';
  const check = async () => {
    setCheckFailed(false);
    try { await checkOfflineUpdate(); }
    catch { setCheckFailed(true); }
  };
  return <section className="offline-settings" aria-label={t('Application')}>
    <p role="status" title={offline.error ?? undefined}>{t(message)}{available ? ` · ${t('Update available')}` : ''}</p>
    {offline.phase !== 'unsupported' && <div className="dialog-actions">
      <button type="button" disabled={offline.checking || state.navigationPrompt || state.outputPending || state.exportOpen}
        onClick={() => void check()}>{t(offline.checking ? 'Checking for updates…' : 'Check for updates')}</button>
      {available && <button type="button" disabled={offline.checking || !controller.appUpdateAvailable}
        onClick={() => void controller.requestAppUpdate(() => reloadOfflineUpdate(available, () => controller.appUpdateNavigationCurrent,
          () => controller.beginAppUpdateUnload()))}>{t('Reload to update')}</button>}
    </div>}
    {checkFailed && <p role="status">{t('Could not check for updates. Try again when connected.')}</p>}
    <p className="offline-cache-hint">{t('Only application files are cached. Scene files stay on your device.')}</p>
  </section>;
}

export function OfflineUpdateNotice({ onOpen, disabled }: {
  onOpen(): void; disabled: boolean;
}) {
  const { t } = useTranslation(), offline = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  if (!offline.available || offline.available === offline.current) return null;
  return <button type="button" className="icon-button offline-update-notice" aria-label={t('Update available')}
    title={t('Update available')} aria-haspopup="dialog" disabled={disabled} onClick={onOpen}>
    <Icon name="Reset" />
  </button>;
}
