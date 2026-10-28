import { useRef } from 'react';
import { useTranslation } from '../../app/useLanguageAppearance';
import { BUILD_DESCRIPTOR } from '../../generated/buildIdentity';
import { version as webVersion } from '../../../package.json';
import { IconButton } from '../IconButton';
import { useDialogFocus } from '../useDialogFocus';
import type { ModalFocusOptions } from './ModalFrame';

// The browser app has its own version and build identity. Native Store update
// actions stay in the desktop host; web update controls live in Help.
export function AboutDialog({ focus, onClose }: { focus: ModalFocusOptions; onClose(): void }) {
  const { t } = useTranslation(), close = useRef<HTMLButtonElement>(null);
  const panel = useDialogFocus({ ...focus, onEscape: onClose, initialFocus: () => close.current });
  return <div className="dialog-backdrop"><div ref={panel} className="about-dialog panel" role="dialog" aria-modal="true" aria-label={t('About')} tabIndex={-1}>
    <div className="panel-heading"><h1>{t('About')}</h1><span className="grow" />
      <IconButton buttonRef={close} icon="Cancel" label="Close about" small onClick={onClose} />
    </div>
    <div className="about-content">
      <p>SplatView</p><p>{t('Version')} <span data-web-version>{webVersion}</span></p>
      <p>{t('SplatView web viewer and editor.')}</p>
      <p className="about-build"><span>{t('Application')}</span><code data-app-input-id title={BUILD_DESCRIPTOR.appInputId}>{BUILD_DESCRIPTOR.appInputId}</code></p>
      <div className="about-links"><a href="https://opsiclear.com/" target="_blank" rel="noopener noreferrer">{t('Help & feedback')}</a>
        <a href="mailto:support@opsiclear.com?subject=SplatView%20web%20bug%20report">{t('Report a bug')}</a></div>
    </div>
  </div></div>;
}
