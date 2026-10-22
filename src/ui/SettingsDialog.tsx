import { useEffect, useId, useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';
import { Icon } from './Icon';
import { focusAndReveal } from './focusScroll';
import { useTranslation } from '../app/useLanguageAppearance';

export type SettingsTab = 'general' | 'privacy' | 'help';
const tabs = [['general', 'General'], ['privacy', 'Privacy'], ['help', 'Help']] as const;

export function SettingsDialog({ panels, activeTab, onTabChange, withTools, returnFocus, onClose }: {
  panels: Record<SettingsTab, ReactNode>;
  activeTab: SettingsTab;
  onTabChange(tab: SettingsTab): void;
  withTools: boolean;
  returnFocus: RefObject<HTMLButtonElement | null>;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const panel = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null), id = useId();
  const tabButtons = useRef<Partial<Record<SettingsTab, HTMLButtonElement | null>>>({});
  const controls = () => Array.from(panel.current?.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, summary, [tabindex]') ?? [])
    .filter(element => element.tabIndex >= 0 && !element.matches(':disabled') && element.getClientRects().length > 0);
  useLayoutEffect(() => { if (content.current) content.current.scrollTop = 0; }, [activeTab]);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusFirst = () => focusAndReveal(controls()[0], panel.current);
    const owns = (target: Node) => panel.current?.contains(target) ||
      // FontSizePicker renders its controlled listbox in a body portal.
      Array.from(panel.current?.querySelectorAll('[aria-controls]') ?? []).some(control =>
        control.getAttribute('aria-controls')!.split(/\s+/).some(controlId => document.getElementById(controlId)?.contains(target)));
    const contain = (event: FocusEvent) => { if (event.target instanceof Node && !owns(event.target)) focusFirst(); };
    focusFirst(); document.addEventListener('focusin', contain);
    return () => {
      document.removeEventListener('focusin', contain);
      const usable = (target: HTMLElement | null) => target?.isConnected && target !== document.body &&
        !target.matches(':disabled') && target.getClientRects().length > 0;
      const target = usable(previous) ? previous : usable(returnFocus.current) ? returnFocus.current : null;
      focusAndReveal(target);
    };
  }, [returnFocus]);
  return <div className="settings-backdrop" onPointerDown={event => {
    if (event.target === event.currentTarget) {
      // Dismiss the popup without forwarding this press to the scene beneath it.
      event.preventDefault(); event.stopPropagation(); onClose();
    }
  }}><div ref={panel} className={`settings-dialog panel${withTools ? ' with-tools' : ''}`} role="dialog" aria-modal="true" aria-label={t('Settings')}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      if (event.key === 'Tab') {
        // A picker Tab first closes its portal, then continues within Settings.
        const values = controls(), index = values.indexOf(document.activeElement as HTMLElement);
        event.preventDefault();
        focusAndReveal(values[index < 0 ? event.shiftKey ? values.length - 1 : 0 : (index + (event.shiftKey ? values.length - 1 : 1)) % values.length], panel.current);
      }
    }}>
    <div className="panel-heading"><h1>{t('Settings')}</h1><span className="grow" />
      <button type="button" className="icon-button small" aria-label={t('Close Settings')} title={t('Close settings (Esc)')} onClick={onClose}><Icon name="Cancel" /></button>
    </div>
    <div className="settings-tabs" role="tablist" aria-label={t('Settings sections')}>
      {tabs.map(([tab, label], index) => <button key={tab} type="button" role="tab" id={`${id}-${tab}-tab`}
        ref={element => { tabButtons.current[tab] = element; }} aria-selected={activeTab === tab}
        aria-controls={`${id}-${tab}-panel`} tabIndex={activeTab === tab ? 0 : -1} onClick={() => onTabChange(tab)}
        onKeyDown={event => {
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 :
            event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : null;
          if (next === null) return;
          event.preventDefault(); event.stopPropagation();
          const nextTab = tabs[next][0]; onTabChange(nextTab); focusAndReveal(tabButtons.current[nextTab], panel.current);
        }}>{t(label)}</button>)}
    </div>
    {tabs.map(([tab]) => <div key={tab} ref={activeTab === tab ? content : undefined} className="settings-content" role="tabpanel"
      id={`${id}-${tab}-panel`} aria-labelledby={`${id}-${tab}-tab`} hidden={activeTab !== tab}
      tabIndex={activeTab !== tab ? -1 : tab === 'general' ? undefined : 0}>
      {activeTab === tab ? panels[tab] : null}
    </div>)}
  </div></div>;
}
