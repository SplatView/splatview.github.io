import { useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { AppController } from '../app/controller';
import { webFeatureAllowed } from '../app/productPolicy';
import { setSelectionPreferences, useApp, type SelectionTool } from '../app/store';
import { useTranslation } from '../app/useLanguageAppearance';
import { toleranceFromRatio, tolerancePercent, toleranceRatio } from '../input/tolerance';
import { Icon } from './Icon';
import { IconButton } from './IconButton';

/** Physical press preferences are detached before delayed color settlement or
 * a released-pick queue can observe a later tool/radius change. */
export function captureSelectionRangePointerOptions(state: Pick<ReturnType<typeof useApp.getState>, 'colorRange' | 'fillRange' | 'brushSize'>, scaleX: number) {
  return { colorRange: Object.freeze({ ...state.colorRange }), fillRange: Object.freeze({ ...state.fillRange }),
    sampleRadiusPixels: state.brushSize * scaleX / 2 };
}
export function SelectionControlsPopup({ tool, filter = false, apple = false, returnFocus, onClose }: {
  tool: SelectionTool | null; filter?: boolean; apple?: boolean; returnFocus: RefObject<HTMLButtonElement | null>; onClose(): void;
}) {
  const { t } = useTranslation();
  const panel = useRef<HTMLDivElement>(null), body = useRef<HTMLDivElement>(null), close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    close.current?.focus({ preventScroll: true });
    const capture = (event: KeyboardEvent) => {
      // This capture runs before the scene's Page/G/editor listeners. Opening
      // Help must not confirm, cancel, or alter an unfinished manual gesture.
      event.stopImmediatePropagation();
      // Escape belongs to this read-only popup, even if focus was moved out of it.
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
      if (event.key === 'Tab') {
        event.preventDefault();
        (document.activeElement === close.current ? body.current : close.current)?.focus({ preventScroll: true });
      }
      if ((event.key === 'Enter' || event.key === ' ') && document.activeElement === close.current) {
        event.preventDefault(); if (!event.repeat) onClose();
      }
      if ((event.ctrlKey || event.metaKey) && ['o', 's', 'z', 'y', 'a', 'i', 'e'].includes(event.key.toLowerCase())) event.preventDefault();
    };
    const captureRelease = (event: KeyboardEvent) => event.stopImmediatePropagation();
    window.addEventListener('keydown', capture, true); window.addEventListener('keyup', captureRelease, true);
    return () => {
      window.removeEventListener('keydown', capture, true); window.removeEventListener('keyup', captureRelease, true);
      if (returnFocus.current?.isConnected && !returnFocus.current.matches(':disabled')) returnFocus.current.focus({ preventScroll: true });
    };
  }, [onClose, returnFocus]);
  const primary = apple ? 'Cmd' : 'Ctrl';
  const rows: [string, string][] = [
    ...(tool || filter ? [['Combine', '1 / 2 / 3 / 4']] as [string, string][] : []),
    ...(tool && !filter ? [['Union', 'Shift'], ['Subtract', primary], ['Intersect', `Shift+${primary}`]] as [string, string][] : []),
    ...(!filter ? [['All / clear', `${primary}+A / C`], ['Invert', 'I']] as [string, string][] : []), ['Undo / redo', `${primary}+Z / ${primary}+Y`],
    ...(!filter && (tool === 'brush' || tool === 'volume') ? [['Brush size', '[ / ] or Alt+wheel']] as [string, string][] : []),
    ...(!filter && tool === 'polygon' ? [['Close polygon', 'Enter'], ['Undo point', 'Backspace']] as [string, string][] : []),
    ['Clear selection / exit tool', 'Right-click'], ['Pan', 'Right-drag'], ...(tool || filter ? [['Cancel', 'Esc']] as [string, string][] : []),
  ];
  return <div className="selection-controls-backdrop" onPointerDown={event => {
    if (event.target === event.currentTarget) { event.preventDefault(); event.stopPropagation(); onClose(); }
  }}><div ref={panel} className="selection-controls-popup panel" role="dialog" aria-modal="false" aria-label={t("Selection controls")} data-selection-controls data-chrome>
    <div className="panel-heading"><h1>{t("Selection")}</h1><span className="grow" /><IconButton buttonRef={close} icon="Cancel" label="Close Selection controls" hint="Close" small onClick={onClose} /></div>
    <div ref={body} className="selection-controls-body" tabIndex={0} aria-label={t("Selection control shortcuts")}><table><thead><tr><th scope="col">{t("Control")}</th><th scope="col">{t("Input")}</th></tr></thead><tbody>
      {rows.map(([control, input]) => <tr key={control}><td>{t(control)}</td><td>{t(input)}</td></tr>)}
    </tbody></table></div>
  </div></div>;
}
export function SelectionActions({ enabled, selected, hasDeleted = false, tool = null, filter = false, apple = false, helpEnabled = enabled,
  pro = false, duplicateEnabled = false,
  currentViewOnly = false, currentViewOnlyEnabled = enabled, onCurrentViewOnly, onCommand, onHelpOpened, onInputScopeChange }: {
  enabled: boolean; selected: number; hasDeleted?: boolean; tool?: SelectionTool | null; filter?: boolean; apple?: boolean; helpEnabled?: boolean;
  pro?: boolean; duplicateEnabled?: boolean;
  currentViewOnly?: boolean; currentViewOnlyEnabled?: boolean; onCurrentViewOnly?(): void;
  onCommand(command: string): void; onHelpOpened?(): void; onInputScopeChange?(owner: string, open: boolean): void;
}) {
  const { t } = useTranslation();
  const [helpOpen, setHelpOpen] = useState(false), help = useRef<HTMLButtonElement>(null);
  const scopeCallback = useRef(onInputScopeChange); scopeCallback.current = onInputScopeChange;
  const closeHelp = useRef(() => { scopeCallback.current?.('selection-help', false); setHelpOpen(false); }).current;
  useEffect(() => () => scopeCallback.current?.('selection-help', false), []);
  const popupHost = help.current?.closest('.viewport-shell');
  return <fieldset disabled={!enabled && !filter && !currentViewOnlyEnabled} className="selection-actions">
    <div className="selection-actions-caption"><span>{t("Actions")}</span></div>
    <div className="selection-action-groups">
      <div className="selection-segments" role="group" aria-label={t("Selection actions")}>
        <IconButton icon="All" label="Select all" tutorialTarget="actions" disabled={!enabled} onClick={() => onCommand('selectAll')} />
        <IconButton icon="Clear" label="Clear selection" tutorialTarget="actions" disabled={!enabled || selected === 0} onClick={() => onCommand('selectNone')} />
        <IconButton icon="Invert" label="Invert selection" tutorialTarget="actions" disabled={!enabled} onClick={() => onCommand('invert')} />
        {webFeatureAllowed('selection.advanced') && <IconButton icon="Frustum" label="Current view only" tutorialTarget="current-view" hint={'Current view only\nLimit selection and selected edits to the camera frustum'}
          active={currentViewOnly} disabled={!currentViewOnlyEnabled} onClick={() => onCurrentViewOnly?.()} />}
      </div>
      <div className="selection-segments" role="group" aria-label={t("Delete or keep selection")}>
        <IconButton icon="Delete" label="Delete selected" tutorialTarget="selection-edits" disabled={!enabled || selected === 0} onClick={() => onCommand('delete')} />
        <IconButton icon="Crop" label="Keep selected" tutorialTarget="selection-edits" disabled={!enabled || selected === 0} onClick={() => onCommand('crop')} />
        {pro && <IconButton icon="Duplicate" label="Duplicate selection" tutorialTarget="duplicate"
          hint={'Duplicate selection\nCopy selected splats in place as a green selection\nMoving or editing the copy turns it yellow and allows another duplicate'}
          disabled={!enabled || !duplicateEnabled || selected === 0} onClick={() => onCommand('duplicate')} />}
      </div>
      <button ref={help} type="button" className="icon-button selection-controls-help" aria-label={t("Selection controls")} title={t("Selection controls")}
        disabled={!helpEnabled} aria-haspopup="dialog" aria-expanded={helpOpen} onClick={() => { onHelpOpened?.(); onInputScopeChange?.('selection-help', true); setHelpOpen(true); }}><Icon name="Help" /></button>
    </div>
    <div className="selection-action-restore" hidden={!hasDeleted}><IconButton icon="Restore" label="Restore deleted" small disabled={!enabled} onClick={() => onCommand('restore')} /></div>
    {helpOpen && popupHost && createPortal(<SelectionControlsPopup tool={tool} filter={filter} apple={apple} returnFocus={help} onClose={closeHelp} />, popupHost)}
  </fieldset>;
}
// Captured cleanup_context.hpp: hidden preferences retain their per-mode values;
// the active tool changes which controls exist, never the selection itself.
const TOOL_OPTIONS = {
  single: ['live'], brush: ['visibleOnly', 'overlap', 'live'], volume: ['visibleOnly', 'overlap', 'live'],
  rectangle: ['overlap', 'live'], polygon: ['overlap', 'live'], color: ['connectedColor', 'range'], fill: ['visibleOnly', 'overlap', 'range'],
} as const;
export type PolygonActions = { count: number; closeEnabled: boolean; editEnabled: boolean; close(): void; previous(): void; cancel(): void };
export function PolygonSelectionControls({ polygon, disabled }: { polygon: PolygonActions; disabled: boolean }) {
  const { t } = useTranslation();
  return <fieldset disabled={disabled} className="polygon-controls">
    <div className="selection-segments polygon-actions" role="group" aria-label={t('Polygon')}>
      <IconButton icon="Check" label="Close polygon (Enter)" disabled={!polygon.closeEnabled} onClick={polygon.close} />
      <IconButton icon="Undo" label="Previous point (Backspace)" disabled={!polygon.editEnabled} onClick={polygon.previous} />
      <IconButton icon="Cancel" label="Cancel polygon" disabled={!polygon.editEnabled} onClick={polygon.cancel} />
    </div>
    <div className="polygon-point-count sr-only" role="status">{t('%zu points', polygon.count)}</div>
  </fieldset>;
}
export function SelectionOptions({ controller, tool, disabled, polygon, tutorial, showPolygon = true }: {
  controller: AppController; tool: SelectionTool | null; disabled: boolean; polygon: PolygonActions; tutorial?: 'options' | 'range'; showPolygon?: boolean;
}) {
  const { t } = useTranslation(), state = useApp();
  if (!tool) return null;
  const controls = {
    visibleOnly: { icon: 'Visible', label: 'Visible only', shortcut: 'N', hint: 'Visible only (N)\nBrush and fill tools\nOff: select through all depths\nOn: select splats contributing to the rendered surface' },
    overlap: { icon: 'Overlap', label: 'Include splat edges', shortcut: 'M', hint: 'Include splat edges (M)\nArea tools only\nOff: select by center\nOn: include splats whose edges touch the selection' },
    live: { icon: 'LiveSelection', label: 'Live selection', hint: 'Live selection\nSingle splat, brush, rectangle and polygon tools\nOff: update when finished\nOn: preview while drawing' },
    connectedColor: { icon: 'ConnectedColor', label: 'Connected colors', hint: `${t('Color picker')}\n${t('Connected colors\nOff: match across the scene\nOn: match only the connected region in the current view')}` },
    range: { icon: 'Sphere', label: 'Range', hint: `${t('Range')}\n${t('Limit matches to a sphere around the picked point. Adjust its radius to update the last selection.')}` },
  };
  return <fieldset disabled={disabled || !!tutorial} className="selection-options" data-tutorial-target="options">
    <div className="selection-options-caption">{t('Options')}</div>
    <div className="selection-option-groups"><div className="selection-segments" role="group" aria-label={t('Options')}>
      {TOOL_OPTIONS[tool].filter(key => key !== 'range' || webFeatureAllowed('selection.advanced')).map(key => { const control = controls[key]; return <IconButton key={key}
        icon={control.icon} label={control.label} hint={control.hint} shortcut={'shortcut' in control ? control.shortcut : undefined}
        tutorialTarget={key === 'range' ? 'range' : undefined}
        active={key === 'range' ? tutorial === 'range' || (tool === 'fill' ? state.fillRange.enabled : state.colorRange.enabled) : state[key]}
        disabled={key === 'connectedColor' && state.selectionDragging || key === 'range' && !controller.selectionRangeControlsEnabled}
        onClick={() => key === 'range' ? controller.setSelectionRangeEnabled(!(tool === 'fill' ? state.fillRange.enabled : state.colorRange.enabled), tool === 'fill' ? 'fill' : 'color') :
          key === 'connectedColor' ? controller.setConnectedColor(!state.connectedColor) : setSelectionPreferences({ [key]: !state[key] })} />; })}
    </div></div>
    {showPolygon && tool === 'polygon' && <PolygonSelectionControls polygon={polygon} disabled={disabled || !!tutorial} />}
  </fieldset>;
}

export function ToleranceControl({ value, disabled, onChange, onNumericFocus }: {
  value: number; disabled: boolean; onChange: (value: number) => void; onNumericFocus?(token: object, active: boolean): void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false), [text, setText] = useState('');
  const initial = useRef(value), number = useRef<HTMLInputElement>(null);
  const sliderToken = useRef<object>({}), numberToken = useRef<object>({}), focusListener = useRef(onNumericFocus);
  const sliderActivity = useRef({ keys: new Set<string>(), pointerId: null as number | null, active: false }), numberActive = useRef(false);
  focusListener.current = onNumericFocus;
  const publishSliderActivity = () => {
    const activity = sliderActivity.current, active = activity.keys.size > 0 || activity.pointerId !== null;
    if (activity.active !== active) { activity.active = active; focusListener.current?.(sliderToken.current, active); }
  };
  const setNumberActivity = (active: boolean) => {
    if (numberActive.current !== active) { numberActive.current = active; focusListener.current?.(numberToken.current, active); }
  };
  const endSliderPointer = (pointerId: number) => {
    if (sliderActivity.current.pointerId === pointerId) { sliderActivity.current.pointerId = null; publishSliderActivity(); }
  };
  useEffect(() => { if (editing) { number.current?.focus(); number.current?.select(); } }, [editing]);
  useEffect(() => () => {
    if (sliderActivity.current.active) { sliderActivity.current.active = false; focusListener.current?.(sliderToken.current, false); }
    if (numberActive.current) { numberActive.current = false; focusListener.current?.(numberToken.current, false); }
  }, []);
  const edit = () => {
    if (!disabled) {
      initial.current = value; setText(String(value * 100)); setNumberActivity(true);
      sliderActivity.current.keys.clear(); sliderActivity.current.pointerId = null; publishSliderActivity(); setEditing(true);
    }
  };
  return <div className="slider-control" onContextMenu={event => { event.preventDefault(); edit(); }}>
    {editing ? <input ref={number} type="number" aria-label={t("Tolerance percent")} min="0" max="100" step="any" value={text}
      style={{ width: '100%', height: '100%', minWidth: 0, background: 'transparent', padding: '0 7px' }} disabled={disabled}
      onFocus={() => setNumberActivity(true)}
      onChange={event => { const next = event.target.value; setText(next); if (next.trim() && Number.isFinite(Number(next))) onChange(Math.max(0, Math.min(100, Number(next))) / 100); }}
      onBlur={() => { setNumberActivity(false); setEditing(false); }} onKeyDown={event => {
        if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
        else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onChange(initial.current); setNumberActivity(false); setEditing(false); }
      }} /> : <><input type="range" aria-label={t("Selection tolerance")} aria-valuetext={`${tolerancePercent(value)}%`} min="0" max="1" step="any"
        value={toleranceRatio(value)} disabled={disabled} onChange={event => onChange(toleranceFromRatio(Number(event.target.value)))}
        onBlur={() => { sliderActivity.current.keys.clear(); publishSliderActivity(); }}
        onPointerDown={event => {
          if (event.ctrlKey || event.metaKey) { event.preventDefault(); edit(); }
          else if (event.button === 0 && sliderActivity.current.pointerId === null) {
            sliderActivity.current.pointerId = event.pointerId; publishSliderActivity();
            try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* The element may have retired during the callback. */ }
          }
        }}
        onPointerUp={event => endSliderPointer(event.pointerId)} onPointerCancel={event => endSliderPointer(event.pointerId)}
        onLostPointerCapture={event => endSliderPointer(event.pointerId)}
        onKeyDown={event => {
          if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) {
            sliderActivity.current.keys.add(event.key); publishSliderActivity();
          } else if (event.key === 'Enter') { event.preventDefault(); edit(); }
        }}
        onKeyUp={event => { if (sliderActivity.current.keys.delete(event.key)) publishSliderActivity(); }} />
      <output>{tolerancePercent(value)}%</output></>}
  </div>;
}
