import type { RefObject } from 'react';
import type { TutorialTarget } from '../app/tutorialCatalog';
import { useTranslation } from '../app/useLanguageAppearance';
import { Icon } from './Icon';

type ButtonProps = { icon: string; label: string; onClick: () => void; disabled?: boolean; active?: boolean; small?: boolean; shortcut?: string; hint?: string; buttonRef?: RefObject<HTMLButtonElement | null>; tutorialTarget?: TutorialTarget | 'duplicate' };
export function IconButton({ icon, label, onClick, disabled, active, small, shortcut, hint, buttonRef, tutorialTarget }: ButtonProps) {
  const { t } = useTranslation();
  return <button ref={buttonRef} data-tutorial-target={tutorialTarget} type="button" aria-label={t(label)} title={hint ? t(hint) : (shortcut ? `${t(label)} (${shortcut})` : t(label))} aria-keyshortcuts={shortcut} onClick={onClick} disabled={disabled}
    className={`icon-button ${active ? 'active' : ''} ${small ? 'small' : ''}`} aria-pressed={active}><Icon name={icon} /></button>;
}
