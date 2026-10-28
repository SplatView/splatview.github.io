import { useEffect, useRef, type RefObject } from 'react';
import type { AppController } from '../../app/controller';
import { useApp } from '../../app/store';
import { useTranslation } from '../../app/useLanguageAppearance';

export function SavedViewChooser({ controller, returnFocus }: { controller: AppController; returnFocus: RefObject<HTMLButtonElement | null> }) {
  const { t, locale } = useTranslation();
  const choices = useApp(state => state.savedViewChoices), panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.querySelector('button')?.focus();
    return () => {
      // Loading disables Open and the browser may move focus to body before
      // this dialog mounts. Use the initiating toolbar action in that case.
      const usable = (target: HTMLElement | null) => target?.isConnected && target !== document.body &&
        !target.matches(':disabled') && target.getClientRects().length > 0;
      const target = usable(previous) ? previous : usable(returnFocus.current) ? returnFocus.current : null;
      target?.focus({ preventScroll: true });
    };
  }, [returnFocus]);
  return <div className="dialog-backdrop"><div ref={panel} className="dialog panel" role="dialog" aria-modal="true" aria-label={t("Choose saved view")}
    onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); controller.dismissSavedViews(); }
      if (event.key === 'Tab') {
        const buttons = Array.from(panel.current?.querySelectorAll('button') ?? []);
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (buttons.length) {
          event.preventDefault();
          buttons[index < 0 ? event.shiftKey ? buttons.length - 1 : 0 : (index + (event.shiftKey ? buttons.length - 1 : 1)) % buttons.length]?.focus();
        }
      }
    }}>
    <h1>{t("Choose saved view")}</h1><p>{t("Several saved views match this content.")}</p>
    {choices.map(record => <button className="saved-view-choice" key={record.recordId} onClick={() => void controller.chooseSavedView(record.recordId)}>
      {record.displayName || t('Saved view')}<small>{new Date(record.updatedAt).toLocaleString(locale)}</small></button>)}
    <div className="dialog-actions"><button onClick={() => controller.dismissSavedViews()}>{t("Use initial view")}</button></div>
  </div></div>;
}
