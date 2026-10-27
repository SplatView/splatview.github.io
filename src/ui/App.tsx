import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type RefObject, type ReactNode, type CSSProperties } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { webFeatureAllowed, productTokens } from '../app/productPolicy';
import { AppController, type DeferredColorPointerToken, type DeferredSelectionOptions, type FilterGizmoGestureToken, type TransformGizmoGestureToken } from '../app/controller';
import { installProductionBenchmarkBridge } from '../app/benchmarkBridge';
import type { CameraController, FilterGizmoSession } from '../input/camera';
import type { FilterGizmoMode } from '../document/filterGizmo';
import type { TransformGizmoSession } from '../document/transformGizmo';
import { setApp, setSelectionPreferences, switchToolsMode, useApp, type SelectionTool } from '../app/store';
import type { SceneCommand } from '../document/types';
import { SCENE_EXPORT_FORMATS, sceneExportDescriptor, type SceneExportFormat } from '../document/exportFormats';
import { colorFields } from '../generated/desktop';
import type { AutoColorMethod } from '../document/colorProtocol';
import { sameColorValues } from '../document/colorSession';
import { navigationKey, translationKey } from '../input/navigation';
import { admitWheel } from '../input/wheel';
import { DeferredPointerQueue, DEFERRED_POINTER_REPLAY_BATCH_SIZE, type DeferredPointerKind } from '../input/deferredPointer';
import { KeyOwnershipLedger, type InputContext, type ScopeTransition } from '../input/inputScope';
import { useDialogFocus } from './useDialogFocus';
import { toleranceFromRatio, tolerancePercent, toleranceRatio } from '../input/tolerance';
import { BACKGROUND_COLORS, type BackgroundColor } from '../input/background';
import { Icon } from './Icon';
import { DecorativeChevron } from './DecorativeChevron';
import { FontSizePicker } from './FontSizePicker';
import { ThemePicker } from './ThemePicker';
import { RenderSettings, GraphicsDiagnostics } from './RenderSettings';
import { useThemeAppearance } from '../app/useThemeAppearance';
import { useLanguageAppearance, useTranslation } from '../app/useLanguageAppearance';
import { translateStatus } from '../app/i18n';
import { LanguagePicker } from './LanguagePicker';
import { ViewportGuidesOverlay } from './ViewportGuides';
import { nextViewportGuides, viewportGuidesTooltip, type ViewportGuides } from '../input/viewportGuides';
import { SettingsDialog, type SettingsTab } from './SettingsDialog';
import { RenderedHistogram } from './RenderedHistogram';
import { SelectionMorphology } from './SelectionMorphology';
import { SelectionRangeControl, SelectionRangeTutorial } from './SelectionRangeControl';
import { ManualSelectionFeedback } from './ManualSelectionFeedback';
import { handleFloatingSelectionKey } from './FloatingSelectionActions';
import { SelectionMenus } from './SelectionMenus';
import { FilterControls } from './FilterControls';
import { FilterOverlay } from './FilterOverlay';
import { FilterGizmo, filterGizmoConfig } from './FilterGizmo';
import { TransformControls } from './TransformControls';
import { OpacityControls } from './OpacityControls';
import { GradeControls } from './GradeControls';
import { TransformModeMenu } from './TransformModeMenu';
import { TransformGizmo, transformGizmoConfig } from './TransformGizmo';
import { TransformGizmoActions, handleTransformGizmoKey } from './TransformGizmoActions';
import { AutoColorActions, ColorApplyButton } from './AutoColorActions';
import { AlignmentControls, AlignmentOverlay, alignmentControlsEnabled, handleAlignmentKey, projectAlignmentPoint, projectAlignmentSegment,
  projectAlignmentNormal, projectFloorOverlay, type AlignmentNormalProjection, type FloorOverlayProjection } from './AlignmentControls';
import { UI_SIZES, uiSizeStyle, useUiPreferences } from '../app/uiPreferences';
import { type TutorialStep, type TutorialTarget } from '../app/tutorialCatalog';
import { TutorialOverlay } from './TutorialOverlay';
import { useTutorial } from './useTutorial';
import { SceneAccessibility } from './SceneAccessibility';
import { OfflineStatus, OfflineUpdateNotice } from './OfflineStatus';
import { BUILD_DESCRIPTOR } from '../generated/buildIdentity';
import { version as webVersion } from '../../package.json';
import '../styles/app.css';

type CapturedGizmo = { camera: CameraController; pointerId: number; pointer: [number, number]; mode: FilterGizmoMode } & (
  { target: 'filter'; token: FilterGizmoGestureToken; session: FilterGizmoSession; filterId: number;
    kind: NonNullable<ReturnType<typeof useApp.getState>['filter']>['kind'] } |
  { target: 'transform'; token: TransformGizmoGestureToken; session: TransformGizmoSession; transformId: number; baseId: number });

type DeferredPointerOptions = DeferredSelectionOptions & Readonly<{ tool: SelectionTool; brushSize: number; operation: number }>;
/** Physical press preferences are detached before delayed color settlement or
 * a released-pick queue can observe a later tool/radius change. */
export function captureSelectionRangePointerOptions(state: Pick<ReturnType<typeof useApp.getState>, 'colorRange' | 'fillRange' | 'brushSize'>, scaleX: number) {
  return { colorRange: Object.freeze({ ...state.colorRange }), fillRange: Object.freeze({ ...state.fillRange }),
    sampleRadiusPixels: state.brushSize * scaleX / 2 };
}
type SceneMouseInput = Pick<ReactMouseEvent<HTMLCanvasElement>, 'clientX' | 'clientY' | 'button' | 'buttons' | 'detail' |
  'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey' | 'preventDefault'> & { nativeEvent?: Event; replayed?: boolean };
type ScenePointerInput = SceneMouseInput & { pointerId: number; pointerType: string };
type DeferredPointerRecord = { kind: DeferredPointerKind; input: ScenePointerInput; options: DeferredPointerOptions };
type DeferredPointerOwner = { token: DeferredColorPointerToken; queue: DeferredPointerQueue<DeferredPointerRecord>;
  tool: SelectionTool; physicalPointer: number | null; lastPointer: number; options: DeferredPointerOptions;
  refusedPointer: number | null; acceptCompanion: boolean; ready: boolean; pumping: boolean; bounds: readonly number[] };

type CollectionRect = Readonly<{ left: number; right: number; top: number; bottom: number }>;
/** Desktop edge hit areas are omitted when they intersect another shell control. */
export function collectionArrowVisibility(width: number, height: number, scale: number, controls: readonly CollectionRect[]) {
  const inset = 12 * scale, arrowWidth = 36 * scale, arrowHeight = 64 * scale;
  if (width - 2 * inset < 2 * arrowWidth + 6 * scale || height < arrowHeight + 2 * inset) return [false, false] as const;
  const top = (height - arrowHeight) / 2;
  const clear = (left: number) => !controls.some(rect => left < rect.right && left + arrowWidth > rect.left && top < rect.bottom && top + arrowHeight > rect.top);
  return [clear(inset), clear(width - inset - arrowWidth)] as const;
}
export function collectionPageDirection(event: Pick<KeyboardEvent, 'key' | 'repeat' | 'ctrlKey' | 'metaKey' | 'altKey' | 'isComposing' | 'defaultPrevented'>,
  context: Readonly<{ available: boolean; text: boolean; activeUi: boolean; popup: boolean; captured: boolean }>) {
  if (event.key !== 'PageUp' && event.key !== 'PageDown') return undefined;
  if (event.defaultPrevented || event.isComposing || event.repeat || event.ctrlKey || event.metaKey || event.altKey ||
      !context.available || context.text || context.activeUi || context.popup || context.captured) return 0;
  return event.key === 'PageUp' ? -1 : 1;
}

type ButtonProps = { icon: string; label: string; onClick: () => void; disabled?: boolean; active?: boolean; small?: boolean; shortcut?: string; hint?: string; buttonRef?: RefObject<HTMLButtonElement | null>; tutorialTarget?: TutorialTarget | 'duplicate' };
type ModalFocusOptions = Omit<Parameters<typeof useDialogFocus>[0], 'initialFocus' | 'onEscape'>;
function appModalOwner(current: ReturnType<typeof useApp.getState>): InputContext['modal'] {
  return current.outputPending ? 'output' : current.navigationPrompt ? 'unsaved' : current.exportOpen ? 'save'
    : current.settingsOpen ? 'settings' : current.savedViewChoices.length ? 'chooser' : null;
}
function ModalFrame({ label, focus, onEscape, floating = false, children }: {
  label: string; focus: ModalFocusOptions; onEscape?(): void; floating?: boolean; children: ReactNode;
}) {
  const panel = useDialogFocus({ ...focus, onEscape });
  const contents = <div ref={panel} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}
    className={floating ? 'output-dialog' : 'dialog panel'}>{children}</div>;
  return floating ? contents : <div className="dialog-backdrop">{contents}</div>;
}
// The browser app has its own version and build identity. Native Store update
// actions stay in the desktop host; web update controls live in General.
function AboutDialog({ focus, onClose }: { focus: ModalFocusOptions; onClose(): void }) {
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
export function SceneExportDialog({ acceptedFormat, scope, onScopeChange, count, sourceCount, disabled, onCancel, onExport, focus }: {
  acceptedFormat: SceneExportFormat; scope: number; onScopeChange(scope: number): void;
  count?: number; sourceCount?: number; disabled: boolean; onCancel(): void; onExport(format: SceneExportFormat, scope: number): void; focus?: ModalFocusOptions;
}) {
  const { t, locale } = useTranslation();
  // Each opening mounts a fresh draft. Only the controller's accepted choice is
  // used on the next opening; changing this select or cancelling cannot save it.
  const [format, setFormat] = useState<SceneExportFormat>(acceptedFormat);
  const formatSelect = useRef<HTMLSelectElement>(null);
  const panel = useDialogFocus({ ...focus, onEscape: onCancel, initialFocus: () => formatSelect.current });
  return <div className="dialog-backdrop"><div ref={panel} className="dialog panel" role="dialog" aria-modal="true" tabIndex={-1} aria-label={t("Save scene")}><h1>{t("Save scene")}</h1>
    {count !== undefined && sourceCount !== undefined && count < sourceCount && <p>{t('Only the %s loaded splats will be exported.', count.toLocaleString(locale))}</p>}
    <label>{t("Format")}<select ref={formatSelect} aria-label={t("Export format")} value={format} style={{ minWidth: 0 }} onChange={event => {
      const descriptor = sceneExportDescriptor(Number(event.target.value));
      if (descriptor) setFormat(descriptor.format);
    }}>{SCENE_EXPORT_FORMATS.map(descriptor => <option value={descriptor.format} key={descriptor.format}>{t(descriptor.label)}</option>)}</select></label>
    <label>{t("Scope")}<select aria-label={t("Export scope")} value={scope} onChange={event => onScopeChange(Number(event.target.value))}>{['All', 'Selected', 'Remainder'].map((name, index) => <option value={index} key={name}>{t(name)}</option>)}</select></label>
    <div className="dialog-actions"><button onClick={onCancel}>{t("Cancel")}</button><button onClick={() => onExport(format, scope)} disabled={disabled}>{t("Download")}</button></div>
  </div></div>;
}
function SavedViewChooser({ controller, returnFocus }: { controller: AppController; returnFocus: RefObject<HTMLButtonElement | null> }) {
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
function IconButton({ icon, label, onClick, disabled, active, small, shortcut, hint, buttonRef, tutorialTarget }: ButtonProps) {
  const { t } = useTranslation();
  return <button ref={buttonRef} data-tutorial-target={tutorialTarget} type="button" aria-label={t(label)} title={hint ? t(hint) : (shortcut ? `${t(label)} (${shortcut})` : t(label))} aria-keyshortcuts={shortcut} onClick={onClick} disabled={disabled}
    className={`icon-button ${active ? 'active' : ''} ${small ? 'small' : ''}`} aria-pressed={active}><Icon name={icon} /></button>;
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
function BackgroundButton({ value, disabled, onClick }: { value: BackgroundColor; disabled: boolean; onClick: () => void }) {
  const { t } = useTranslation();
  const tone = BACKGROUND_COLORS.indexOf(value);
  const title = t(['Black background. Click for gray.', 'Gray background. Click for white.', 'White background. Click for black.'][tone]);
  return <button type="button" className="icon-button background-button" data-tutorial-target="guides" aria-label={t("Background")} title={title} data-background={value}
    disabled={disabled} onClick={onClick}><svg aria-hidden="true" viewBox="0 0 36 36" width="36" height="36">
      <rect x="11" y="11" width="14" height="14" rx="2" fill={['#000', '#808080', '#fff'][tone]} stroke="#b3bac7" strokeWidth="1.5" />
    </svg></button>;
}
// Captured cleanup_context.hpp: hidden preferences retain their per-mode values;
// the active tool changes which controls exist, never the selection itself.
const TOOL_OPTIONS = {
  single: ['live'], brush: ['visibleOnly', 'overlap', 'live'], volume: ['visibleOnly', 'overlap', 'live'],
  rectangle: ['overlap', 'live'], polygon: ['overlap', 'live'], color: ['connectedColor', 'range'], fill: ['visibleOnly', 'overlap', 'range'],
} as const;
type PolygonActions = { count: number; closeEnabled: boolean; editEnabled: boolean; close(): void; previous(): void; cancel(): void };
function PolygonSelectionControls({ polygon, disabled }: { polygon: PolygonActions; disabled: boolean }) {
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

function ToleranceControl({ value, disabled, onChange, onNumericFocus }: {
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

type ToolsPanelRetention = {
  folding: { selection: boolean; color: boolean; transform: boolean };
  scroll: Record<'basic' | 'pro', { body: number; panel: number }>;
};
function ToolsPanel({ controller, scene, chromeVisible, autoMethod, onAutoMethod, visible = true, tutorialStep, onInputScopeChange, retention, polygon }: {
  controller: AppController; scene: RefObject<HTMLCanvasElement | null>; chromeVisible: boolean; autoMethod: AutoColorMethod; onAutoMethod(method: AutoColorMethod): void;
  visible?: boolean; tutorialStep?: TutorialStep; onInputScopeChange(owner: string, open: boolean): void; retention: ToolsPanelRetention; polygon: PolygonActions;
}) {
  const { t } = useTranslation();
  const state = useApp();
  const [folding, setFolding] = useState(() => ({ ...retention.folding }));
  const { selection: selectionOpen, transform: transformOpen, color: colorOpen } = folding;
  const setSectionOpen = (section: keyof ToolsPanelRetention['folding'], open: boolean) => {
    retention.folding[section] = open; setFolding({ ...retention.folding });
  };
  const displayMode = webFeatureAllowed('processing.advanced') ? tutorialStep?.displayMode ?? state.mode : 'basic';
  const showSelection = displayMode === 'basic' || selectionOpen || tutorialStep?.section === 'Selection';
  const showColor = displayMode === 'basic' || colorOpen || tutorialStep?.section === 'Color';
  const showTransform = displayMode === 'basic' || transformOpen || tutorialStep?.section === 'Transform';
  const selectionTutorial = tutorialStep?.target === 'options' || tutorialStep?.target === 'range' ? tutorialStep.target : undefined;
  const panel = useRef<HTMLElement>(null), body = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!tutorialStep && visible) {
      // Native gives Basic and Pro separate child-window identities. Retain
      // their offsets outside this component so hiding Tools also preserves it.
      const position = retention.scroll[state.mode];
      if (body.current) body.current.scrollTop = position.body;
      if (panel.current) panel.current.scrollTop = position.panel;
    }
  }, [state.mode, !!tutorialStep, visible, retention]);
  const [gradeResetRevision, setGradeResetRevision] = useState(0);
  const [opacityResetRevision, setOpacityResetRevision] = useState(0);
  const gradeValueScope = `${controller.client?.revision.documentId ?? 'none'}:${controller.client?.revision.sourceGeneration ?? 0}:${state.mode}:${gradeResetRevision}`;
  const gradeInputScope = `${gradeValueScope}:${colorOpen}`;
  const gradeDesiredValues = useRef<readonly number[]>(state.grade);
  const gradeObservedValues = useRef<readonly number[]>(state.grade);
  const gradeDesiredScope = useRef(gradeValueScope);
  const [gradeDraft, setGradeDraft] = useState<{ scope: string; observed: readonly number[]; values: readonly number[] }>({
    scope: gradeValueScope, observed: state.grade, values: state.grade,
  });
  const gradeDisplay = gradeDraft.scope === gradeValueScope && sameColorValues(gradeDraft.observed, state.grade) ? gradeDraft.values : state.grade;
  useLayoutEffect(() => {
    if (gradeDesiredScope.current !== gradeValueScope || !sameColorValues(gradeObservedValues.current, state.grade)) {
      gradeDesiredScope.current = gradeValueScope;
      gradeObservedValues.current = state.grade;
      gradeDesiredValues.current = state.grade;
      setGradeDraft({ scope: gradeValueScope, observed: state.grade, values: state.grade });
    }
  }, [gradeValueScope, state.grade]);
  const onGradeValues = useCallback((values: number[]) => {
    const observed = useApp.getState().grade;
    if (!controller.colorPreviewEnabled) {
      gradeDesiredValues.current = observed;
      setGradeDraft({ scope: gradeValueScope, observed, values: observed }); return;
    }
    // A clean retained owner may still be materializing. Preserve all submitted
    // fields while its eventual publication catches up with the visible inputs.
    gradeDesiredValues.current = values;
    setGradeDraft({ scope: gradeValueScope, observed, values });
    controller.setGrade(values);
  }, [controller, gradeValueScope]);
  const [gradeValidity, setGradeValidity] = useState({ scope: gradeInputScope, valid: true });
  const gradeInputValid = gradeValidity.scope !== gradeInputScope || gradeValidity.valid;
  const onGradeValidity = useCallback((valid: boolean) => setGradeValidity(previous =>
    previous.scope === gradeInputScope && previous.valid === valid ? previous : { scope: gradeInputScope, valid }), [gradeInputScope]);
  // A read-only PLY can project these controls during the tutorial. Its
  // geometry summary never grants editing or supplies editable splat counts.
  const editableSummary = state.summary?.kind === 0 ? state.summary : null;
  const editingAvailable = !!editableSummary && controller.editingAvailable;
  const enabled = !!state.summary && editingAvailable && !state.busy;
  const selectionEnabled = !!editableSummary && (editingAvailable || controller.filterControlsEnabled) &&
    (!state.busy || controller.isReleasedSelectionBusy || controller.selectionActive || controller.filterActive);
  const resetCleanupEnabled = (enabled || controller.filterControlsEnabled) && (!!state.filter || !!state.tool || !!state.summary?.selected || !!state.summary && state.summary.visible < state.summary.count);
  const effectiveOperation = state.filter?.operation ?? state.selectionOperation ?? ((state.selectionModifiers & 2) ? (state.selectionModifiers & 1) ? 3 : 2 : (state.selectionModifiers & 1) ? 1 : state.operation);
  const selectionControlDisabled = !selectionEnabled || state.selectionDragging;
  // Both native profiles use the same Tool menu and the same cleanup boundary.
  const chooseSelectionTool = (tool: SelectionTool | null) => {
    if (controller.filterActive || useApp.getState().transform || controller.opacityActive || controller.opacityPending) {
      void controller.activateSelectionTool(tool); return;
    }
    const current = useApp.getState();
    controller.cancelAlignment();
    if (tool === null) {
      if (current.tool || current.fly) { void controller.cancelSelectionGesture(); controller.endToleranceSelection(); setApp({ tool: null, fly: false }); }
    } else if (current.tool !== tool) setApp({ tool, fly: false });
  };
  const shownFields = displayMode === 'basic' ? [0, 1, 3, 5] : colorFields.map((_, index) => index);
  const retainedFields = state.mode === 'basic' ? [0, 1, 3, 5] : colorFields.map((_, index) => index);
  return <aside ref={panel} className="tools-panel panel" style={{ '--product-panel-bottom': `${productTokens.panelBottomPadding}px` } as CSSProperties} hidden={!visible} inert={!chromeVisible} aria-hidden={!chromeVisible || undefined} data-chrome data-tutorial-display-mode={displayMode} aria-label={t("Tools")}
    onScroll={event => { if (!tutorialStep && event.target === event.currentTarget) retention.scroll[state.mode].panel = event.currentTarget.scrollTop; }}>
    <div className="tools-fixed">
      <div className="panel-heading"><h1>{t("Tools")}</h1><span className="grow" />
        <div className="history-actions" data-tutorial-target="undo-redo" role="group" aria-label={t("Edit history")}>
          <IconButton icon="Undo" label="Undo" small disabled={!enabled || !state.summary?.canUndo} onClick={() => void controller.command({ command: 'undo' })} />
          <IconButton icon="Redo" label="Redo" small disabled={!enabled || !state.summary?.canRedo} onClick={() => void controller.command({ command: 'redo' })} />
        </div>
        <IconButton icon="Settings" label="Settings" tutorialTarget={tutorialStep?.id === 'thumbnail' ? 'thumbnail' : 'settings'} small onClick={() => setApp({ settingsOpen: true })} />
        <button hidden={!webFeatureAllowed('processing.advanced')} className="mode-button" data-tutorial-target="modes" aria-pressed={displayMode === 'pro'} disabled={!editingAvailable && !controller.filterControlsEnabled && !controller.transformControlsEnabled && !controller.opacityControlsEnabled} onClick={() => {
          const requested = (state.pendingMode ?? state.mode) === 'basic' ? 'pro' : 'basic';
          void (async () => { if (controller.filterActive && !await controller.cancelFilter()) return;
            const transform = useApp.getState().transform;
            const retainGizmo = transform?.kind === 'gizmo' && transform.phase === 'ready' &&
              !!useApp.getState().transformGizmoMode && !useApp.getState().transformGizmoDragging && !controller.transformPending && !controller.transformDirty;
            if (transform && !retainGizmo && !await controller.endTransformSession(true)) return;
            if (controller.opacityActive && !await controller.endOpacitySession(true)) return;
            switchToolsMode(requested, controller.isReleasedSelectionBusy || state.tool === 'polygon' && controller.selectionActive); })();
        }}><span className="mode-label"><span aria-hidden="true">{t("Basic")}</span><span aria-hidden="true">{t("Pro")}</span><span>{t(displayMode === 'basic' ? 'Basic' : 'Pro')}</span></span><span className="mode-switch" aria-hidden="true" /></button>
      </div>
      <div className="model-info" title={state.sourceName}>{state.sourceName || t('No scene open')}</div>
      {state.summary && <div className="model-stats" data-tutorial-target="scope" title={`${t(state.summary.selected ? 'Color and manual transforms affect selected splats. Alignment always affects the whole scene.' : 'Color and manual transforms affect the whole scene. Alignment always affects the whole scene.')}${state.summary.count < state.summary.sourceCount ? ` ${t('Sampled preview. Save includes the loaded visible splats.')}` : ''}`}>
        {t('%s/%s splats | SH%u', (editableSummary?.selected ?? 0).toLocaleString('en-US'), (editableSummary?.visible ?? 0).toLocaleString('en-US'), Math.min(state.summary.shDegree, 3))}
      </div>}
      {!state.summary && tutorialStep && <div className="model-stats" data-tutorial-target="scope">{t('No scene open')}</div>}
      {state.preferencesError && <p>{t(state.preferencesError)}</p>}
      <RenderedHistogram controller={controller} visible={chromeVisible} />
    </div>
    <div ref={body} className="tools-body" onScroll={event => { if (!tutorialStep) retention.scroll[state.mode].body = event.currentTarget.scrollTop; }}>
        <section><fieldset disabled={!selectionEnabled}><div className="section-heading tools-section-heading">
          {displayMode === 'pro' ? <h2 className="selection-fold-heading tools-section-title"><button type="button" className="selection-section-toggle tools-section-label" aria-expanded={showSelection} aria-controls="selection-panel-controls" onClick={() => setSectionOpen('selection', !selectionOpen)}>
            <span className="selection-section-chevron" aria-hidden="true"><DecorativeChevron direction={showSelection ? 'down' : 'right'} /></span><span className="tools-section-caption">{t("Selection")}</span><span className="tools-section-rule" aria-hidden="true" /></button></h2>
            : <h2 className="tools-section-title"><span className="tools-section-label"><span className="tools-section-caption">{t("Selection")}</span><span className="tools-section-rule" aria-hidden="true" /></span></h2>}
          <IconButton icon="Reset" label="Reset cleanup" tutorialTarget="cleanup-reset" small disabled={!resetCleanupEnabled} onClick={() => void (async () => {
            if (controller.filterActive && !await controller.cancelFilter()) return; await controller.command({ command: 'resetCleanup' });
          })()} /></div></fieldset>
          {(state.mode === 'basic' || selectionOpen || showSelection) && <div id="selection-panel-controls" hidden={!showSelection}><fieldset disabled={!selectionEnabled}>
          <SelectionMenus tool={state.tool} filter={state.filter?.kind ?? null} mode={displayMode} enabled={selectionEnabled} onInputScopeChange={onInputScopeChange}
            onTool={chooseSelectionTool} onFilter={kind => void controller.selectFilter(kind)} />
          <div className="selection-boundary-row"><div className="selection-boundary-group" data-tutorial-target="combine">
            <span className="selection-boundary-label">{t("Combine")}</span><div className="selection-segments">{['Replace', 'Add', 'Subtract', 'Intersect'].map((label, operation) => <IconButton key={label} icon={label} label={label}
              active={effectiveOperation === operation} onClick={() => state.filter ? controller.setFilterOperation(operation) : controller.setSelectionOperation(operation)} />)}</div></div>
            {displayMode === 'pro' && <SelectionMorphology controller={controller} displayMode={displayMode} presentationOnly={!!tutorialStep} />}
            {(!state.filter || selectionTutorial) && <SelectionOptions controller={controller}
              tool={selectionTutorial === 'options' ? 'brush' : selectionTutorial === 'range' ? 'color' : state.tool}
              disabled={!selectionEnabled || !!tutorialStep} polygon={polygon} tutorial={selectionTutorial} showPolygon={false} />}
          </div>
          </fieldset>
          {(!state.filter || selectionTutorial) && <>
          {state.tool === 'polygon' && <PolygonSelectionControls polygon={polygon} disabled={!selectionEnabled || !!tutorialStep} />}
          {selectionTutorial === 'range' && <SelectionRangeTutorial />}
          {(state.tool === 'brush' || state.tool === 'volume') && <label className="slider-row"><span>{t("Brush size")}</span><input aria-label={t("Brush size")} type="range" min="8" max="320" disabled={selectionControlDisabled} value={state.brushSize}
            onChange={event => { if (!useApp.getState().selectionDragging) setApp({ brushSize: Number(event.target.value) }); }} /></label>}
          {(state.tool === 'color' || state.tool === 'fill') && <div className="slider-row">
            <span title={t(state.tool === 'fill' ? 'Higher tolerance crosses larger opacity changes. Logarithmic scale gives fine control below 10%. Right-click to type an exact value. Updates the last selection immediately.' : 'Higher tolerance includes more colors. Logarithmic scale gives fine control below 10%. Right-click to type an exact value. Updates the last selection immediately.')}>
              {t('Tolerance')}</span>
            <ToleranceControl key={state.tool} value={state.tool === 'fill' ? state.fillTolerance : state.colorTolerance}
              disabled={selectionControlDisabled}
              onNumericFocus={(token, active) => controller.setTransformNumericFocus(token, active)}
              onChange={value => controller.setSelectionTolerance(value)} />
          </div>}
          {!tutorialStep && webFeatureAllowed('selection.advanced') && (state.tool === 'color' || state.tool === 'fill') && <SelectionRangeControl key={state.tool} controller={controller}
            tool={state.tool} scene={scene} disabled={selectionControlDisabled} previewEnabled={chromeVisible} />}
          </>}
          {state.filter && <FilterControls kind={state.filter.kind} parameters={state.filter.parameters} enabled={controller.filterControlsEnabled && !state.filterGizmoDragging}
            dirty={state.filter.dirty} previewPending={controller.filterPreviewPending} showVolume={state.filterVolumeVisible} centerPicking={state.filterCenterPicking}
            previewEnabled={controller.filterPreviewEnabled}
            gizmoMode={state.filterGizmoMode} gizmoEnabled={controller.filterGizmoModeEnabled && !state.filterGizmoDragging} localAxes={state.filterLocalAxes} snap={state.filterSnap}
            onParameters={patch => controller.setFilterParameters(patch)} onReset={() => controller.resetFilter()} onPreview={() => void controller.previewFilter()}
            onCurrentView={() => controller.useFilterCurrentView()} onPickCenter={() => state.filterCenterPicking ? controller.cancelFilterCenterPick() : controller.startFilterCenterPick()}
            onVolume={filterVolumeVisible => setApp({ filterVolumeVisible })} onGizmo={mode => controller.setFilterGizmoMode(mode)}
            onLocalAxes={filterLocalAxes => { if (controller.filterGizmoModeEnabled) setApp({ filterLocalAxes }); }}
            onSnap={filterSnap => { if (controller.filterGizmoModeEnabled) setApp({ filterSnap }); }} />}
          <SelectionActions enabled={enabled} selected={state.summary?.selected ?? 0} hasDeleted={!!state.summary && state.summary.visible < state.summary.count} tool={state.tool} filter={!!state.filter}
            pro={displayMode === 'pro'} duplicateEnabled={controller.duplicateControlsEnabled}
            apple={/Mac|iPhone|iPad/.test(navigator.platform)} helpEnabled={selectionEnabled}
            currentViewOnly={state.currentViewOnly} currentViewOnlyEnabled={controller.currentViewOnlyControlsEnabled}
            onCurrentViewOnly={() => void controller.setCurrentViewOnly(!useApp.getState().currentViewOnly)}
            onHelpOpened={() => controller.camera?.clearInput()} onInputScopeChange={onInputScopeChange} onCommand={command => void controller.command({ command })} />
          </div>}
        </section>
      <section><div className="section-heading tools-section-heading">
        {displayMode === 'pro' ? <h2 className="selection-fold-heading tools-section-title"><button type="button" className="selection-section-toggle tools-section-label"
          aria-expanded={showTransform} aria-controls="transform-panel-controls" onClick={() => setSectionOpen('transform', !transformOpen)}>
          <span className="selection-section-chevron" aria-hidden="true"><DecorativeChevron direction={showTransform ? 'down' : 'right'} /></span><span className="tools-section-caption">{t("Transform")}</span><span className="tools-section-rule" aria-hidden="true" /></button></h2>
          : <h2 className="tools-section-title"><span className="tools-section-label"><span className="tools-section-caption">{t("Transform")}</span><span className="tools-section-rule" aria-hidden="true" /></span></h2>}
        <IconButton icon="Reset" label="Reset transform" tutorialTarget="transform-reset" small disabled={!controller.transformResetEnabled} onClick={() => void controller.resetTransform()} />
      </div>
        {(state.mode === 'basic' || transformOpen || showTransform) && <div id="transform-panel-controls" hidden={!showTransform}>
          <div className={displayMode === 'pro' ? 'two-columns transform-selectors' : undefined} role="group" aria-label={t("Transform selectors")}>
            <AlignmentControls controller={controller} scene={scene} showReset={false} />
            <div hidden={displayMode !== 'pro'} data-tutorial-target="transform-mode"><TransformModeMenu mode={tutorialStep ? 'euler' : state.transformParameters.mode} enabled={!tutorialStep && controller.transformControlsEnabled && !state.transformGizmoDragging}
              onMode={mode => controller.setTransformMode(mode)} /></div>
          </div>
          <TransformControls mode={displayMode} parameters={state.transformParameters} enabled={controller.transformControlsEnabled} presentationOnly={!!tutorialStep}
            applyEnabled={controller.transformApplyEnabled} cancelEnabled={controller.transformCancelEnabled} pending={controller.transformPending}
            dirty={!!state.transform?.dirty} gizmoMode={state.transformGizmoMode} gizmoEnabled={controller.transformGizmoModeEnabled && !state.transformGizmoDragging}
            localAxes={state.filterLocalAxes} snap={state.filterSnap} onParameters={patch => controller.setTransformParameters(patch)}
            onNumericFocus={(token, active) => controller.setTransformNumericFocus(token, active)}
            onFlip={(axis, active) => controller.setTransformFlip(axis, active)} pivotMode={state.transformPivotMode}
            pivotChosen={state.transformPivotChosen} pivotPending={state.transformPivotPending} hasSelected={(state.summary?.selected ?? 0) > 0}
            onCyclePivot={() => void controller.cycleTransformPivot()}
            onApply={() => controller.applyTransform()} onCancel={() => void controller.cancelTransformPreview()}
            onGizmo={mode => void controller.setTransformGizmoMode(mode)} onLocalAxes={value => controller.setTransformLocalAxes(value)}
            onSnap={value => controller.setTransformSnap(value)} />
        </div>}
      </section>
      <section><div className="section-heading tools-section-heading">
        {displayMode === 'pro' ? <h2 className="selection-fold-heading tools-section-title"><button type="button" className="selection-section-toggle tools-section-label"
          aria-expanded={showColor} aria-controls="color-panel-controls" onKeyDown={event => event.stopPropagation()}
          onKeyUp={event => event.stopPropagation()} onClick={() => setSectionOpen('color', !colorOpen)}>
          <span className="selection-section-chevron" aria-hidden="true"><DecorativeChevron direction={showColor ? 'down' : 'right'} /></span><span className="tools-section-caption">{t("Color")}</span><span className="tools-section-rule" aria-hidden="true" /></button></h2>
          : <h2 className="tools-section-title"><span className="tools-section-label"><span className="tools-section-caption">{t("Color")}</span><span className="tools-section-rule" aria-hidden="true" /></span></h2>}
        <IconButton icon="Reset" label="Reset color preview" tutorialTarget="color-reset" small
        disabled={!controller.colorResetPreviewEnabled} onClick={() => void controller.resetColorPreview().then(accepted => {
          if (accepted) { setOpacityResetRevision(revision => revision + 1); setGradeResetRevision(revision => revision + 1); }
        })} /></div>
        {(state.mode === 'basic' || colorOpen || showColor) && <div id="color-panel-controls" hidden={!showColor}>
        <fieldset disabled={!controller.colorPreviewEnabled}>
        <AutoColorActions controller={controller} onInputScopeChange={onInputScopeChange} displayMode={displayMode} method={autoMethod} onMethodChanged={onAutoMethod} validInput={gradeInputValid} onPresetValues={onGradeValues} />
        <GradeControls key={gradeInputScope} grade={gradeDisplay} fields={colorFields} shownIndices={shownFields} retainedIndices={tutorialStep ? retainedFields : undefined}
          enabled={controller.colorPreviewEnabled} resetRevision={gradeResetRevision} desiredValuesRef={gradeDesiredValues}
          onValues={onGradeValues} onValidityChanged={onGradeValidity} />
        <ColorApplyButton controller={controller} validInput={gradeInputValid} />
        </fieldset>
        {(state.mode === 'pro' || displayMode === 'pro') && <div hidden={displayMode !== 'pro'} data-tutorial-target="pro-color"><OpacityControls key={controller.client?.revision.documentId ?? 'none'} scale={state.opacityScale} enabled={controller.opacityControlsEnabled}
          applyEnabled={controller.opacityApplyEnabled} cancelEnabled={controller.opacityCancelEnabled} pending={controller.opacityPending}
          dirty={!!state.opacity?.dirty} resetRevision={opacityResetRevision} onScale={value => controller.setOpacityScale(value)}
          onApply={() => controller.applyOpacity()} onCancel={() => void controller.cancelOpacityPreview()} /></div>}
        </div>}
      </section>
    </div>
  </aside>;
}

export function App() {
  useThemeAppearance(); useLanguageAppearance();
  const { t, locale } = useTranslation();
  const instructionsId = useId();
  const [controller] = useState(() => new AppController());
  useEffect(() => controller.trackManualSelectionHistory(), [controller]);
  const [autoChoice, setAutoChoice] = useState<{ documentId: string | null; method: AutoColorMethod }>({ documentId: null, method: 'enhance' });
  const uiPreference = useUiPreferences(), displayedUiSize = uiPreference.previewSize ?? uiPreference.size;
  const canvas = useRef<HTMLCanvasElement>(null), picker = useRef<HTMLInputElement>(null), folderPicker = useRef<HTMLInputElement>(null), viewPicker = useRef<HTMLInputElement>(null), openButton = useRef<HTMLButtonElement>(null);
  const [canvasGeneration, setCanvasGeneration] = useState(0);
  const replacementCanvas = useRef<{ resolve(value: HTMLCanvasElement): void; reject(error: unknown): void; focus: boolean } | null>(null);
  const bindCanvas = useCallback((element: HTMLCanvasElement | null) => {
    canvas.current = element;
    if (element && replacementCanvas.current) {
      const pending = replacementCanvas.current; replacementCanvas.current = null;
      if (pending.focus) element.focus({ preventScroll: true }); pending.resolve(element);
    }
  }, []);
  const pickerActive = useRef(false);
  const [inputLedger] = useState(() => new KeyOwnershipLedger());
  const inputMenus = useRef(new Set<string>()), inputComposing = useRef(false), dialogReturnFocus = useRef<HTMLElement | null>(null);
  const requestPicker = (target: RefObject<HTMLInputElement | null>) => {
    if (!target.current || useApp.getState().operationRecovery !== 'idle') return;
    pickerActive.current = true; target.current.click();
  };
  const sceneInputHandlers = useRef<{
    key(event: KeyboardEvent): void; release(event: KeyboardEvent): void;
    wheel(event: WheelEvent): void; beforeUnload(event: BeforeUnloadEvent): void; visibility(): void;
  } | null>(null);
  const state = useApp();
  const documentId = state.summary ? controller.client?.revision.documentId ?? null : null;
  const [fullscreen, setFullscreen] = useState(() => !!document.fullscreenElement);
  useEffect(() => {
    const changed = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', changed); changed();
    return () => document.removeEventListener('fullscreenchange', changed);
  }, []);
  const [copied, setCopied] = useState<{ client: AppController['client']; scene: AppController['scene'] } | null>(null);
  const copySequence = useRef(0), copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const copyImage = useCallback(() => {
    const sequence = ++copySequence.current, client = controller.client, scene = controller.scene;
    clearTimeout(copyTimer.current); setCopied(null);
    // The trusted handler reaches clipboard.write before its first await.
    void controller.copyImage().then(accepted => {
      const current = useApp.getState();
      if (!accepted || sequence !== copySequence.current || client !== controller.client || scene !== controller.scene ||
          !current.summary || !current.ready || current.busy || current.rendererState !== 'ready') return;
      setCopied({ client, scene });
      copyTimer.current = setTimeout(() => { if (sequence === copySequence.current) setCopied(null); }, 3000);
    });
  }, [controller]);
  useEffect(() => {
    ++copySequence.current; clearTimeout(copyTimer.current); setCopied(null);
    return () => { ++copySequence.current; clearTimeout(copyTimer.current); };
  }, [documentId]);
  const autoMethod = autoChoice.documentId === documentId ? autoChoice.method : 'enhance';
  const editingAvailable = controller.editingAvailable;
  const [arrowSpace, setArrowSpace] = useState<readonly [boolean, boolean]>([false, false]);
  const [chrome, setChrome] = useState(true), [polygon, setPolygon] = useState<[number, number][]>([]);
  // Like AppUI::viewportGuides_, this belongs to the viewer UI instance. It
  // survives source/camera changes without entering saved views or preferences.
  const [guides, setGuides] = useState<ViewportGuides>('none');
  const [filterCursor, setFilterCursor] = useState<[number, number] | null>(null), [filterCaptured, setFilterCaptured] = useState(false);
  const toolsRetention = useRef<ToolsPanelRetention>({
    folding: { selection: true, color: true, transform: true },
    scroll: { basic: { body: 0, panel: 0 }, pro: { body: 0, panel: 0 } },
  });
  const [gizmoPointer, setGizmoPointer] = useState<[number, number] | null>(null), [gizmoHandle, setGizmoHandle] = useState(0);
  const gizmoGesture = useRef<CapturedGizmo | null>(null);
  const filterGesture = useRef<{ x: number; y: number; lastX: number; lastY: number; pointerId: number; button: number; moved: boolean; cancelClick: boolean; clear: boolean } | null>(null);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general');
  const closeSettings = () => { setChrome(true); setApp({ settingsOpen: false }); };
  const [aboutOpen, setAboutOpen] = useState(false), aboutReturnFocus = useRef<HTMLElement | null>(null);
  const closeAbout = () => { setChrome(true); setAboutOpen(false); };
  const [rectangle, setRectangle] = useState<number[] | null>(null), [exportScope, setExportScope] = useState(0);
  const polygonPoints = useRef<[number, number][]>([]), polygonOperation = useRef(0);
  const polygonDeferredOptions = useRef<DeferredPointerOptions | undefined>(undefined);
  const polygonCursorPoint = useRef<[number, number] | null>(null);
  const polygonMousePointer = useRef<number | null>(null);
  const gestureVersion = useRef(0);
  const alignmentGesture = useRef<{ x: number; y: number; lastX: number; lastY: number; button: number; pointerId: number; moved: boolean; cancelClick: boolean } | null>(null);
  const [alignmentMarker, setAlignmentMarker] = useState<[number, number] | null>(null);
  const [alignmentSecondMarker, setAlignmentSecondMarker] = useState<[number, number] | null>(null);
  const [alignmentThirdMarker, setAlignmentThirdMarker] = useState<[number, number] | null>(null);
  const [alignmentSegment, setAlignmentSegment] = useState<[[number, number], [number, number]] | null>(null);
  const [alignmentTriangleSegments, setAlignmentTriangleSegments] = useState<([[number, number], [number, number]] | null)[]>([]);
  const [alignmentNormalProjection, setAlignmentNormalProjection] = useState<AlignmentNormalProjection | null>(null);
  const [floorGrid, setFloorGrid] = useState<FloorOverlayProjection['grid']>([]);
  const [alignmentDistanceMarker, setAlignmentDistanceMarker] = useState<[number, number] | null>(null);
  const gesture = useRef<{ x: number; y: number; button: number; points: [number, number][]; operation: number; selection: boolean;
    pointerId: number; panMoved: boolean; clearRevision: number | null; singleLive: boolean; singleCancelled: boolean; singleRestart: number;
    deferredOptions?: DeferredPointerOptions; replayedOptions?: boolean } | null>(null);
  const deferredPointer = useRef<DeferredPointerOwner | null>(null), replayOptions = useRef<DeferredPointerOptions | undefined>(undefined);
  const [deferredInputPending, setDeferredInputPending] = useState(false);
  const replayHandlers = useRef<{ down(input: ScenePointerInput): unknown; move(input: ScenePointerInput): unknown;
    up(input: ScenePointerInput): unknown; mouse(input: SceneMouseInput): unknown; double(input: SceneMouseInput): unknown } | null>(null);
  const tutorialAvailable = !aboutOpen && state.ready && !state.busy &&
    state.selectionRecovery === 'idle' && state.operationRecovery === 'idle' && !state.memoryOverageBytes && !state.navigationPrompt && !state.outputPending &&
    !state.exportOpen && !state.savedViewChoices.length && !state.selectionDragging && !state.pendingSelectionCount && !state.autoOrbit;
  const tutorial = useTutorial({ canOffer: tutorialAvailable && !state.settingsOpen && !state.error && !state.summary?.selectionDraft,
    canReplay: tutorialAvailable, preparationSuspended: state.savedViewChoices.length > 0,
    fallbackFocus: openButton, replayFallbackFocus: state.summary?.loaded ? canvas : openButton,
    prepareScene: async () => {
      // Replaying the tour must not replace a user's document or its history.
      try {
        if (!useApp.getState().summary && !controller.scene && !await controller.openExample()) return false;
        const { scene, client, renderer } = controller;
        if (!scene || !client || !renderer) return false;
        return { isCurrent: () => {
          const current = useApp.getState();
          return controller.scene === scene && controller.client === client && controller.renderer === renderer && !renderer.lost &&
            !!current.summary && current.ready && current.rendererState === 'ready' && !current.busy && !current.error &&
            current.operationRecovery === 'idle' && !current.navigationPrompt && !current.outputPending && !current.exportOpen;
        } };
      } catch (error) {
        setApp({ error: error instanceof Error ? error.message : String(error) });
        return false;
      }
    }, interactionIdle: () => {
      if (document.hidden || !document.hasFocus() || pickerActive.current || gesture.current || filterGesture.current || gizmoGesture.current || alignmentGesture.current || polygonMousePointer.current !== null || controller.camera?.active) return false;
      return !Array.from(document.querySelectorAll<HTMLElement>('[role="menu"], [role="dialog"], .alignment-popup'))
        .some(element => element.getClientRects().length > 0 && !element.closest('.tutorial-layer, .settings-dialog'));
    } });
  const inputContext = useCallback((event?: Event): InputContext => {
    const current = useApp.getState(), active = document.activeElement, target = event?.target ?? active;
    const field = (value: EventTarget | null) => value instanceof HTMLElement &&
      (value.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(value.tagName));
    const neutral = (value: EventTarget | null) => value === null || value === document.body || value === document || value === window;
    const focus = target === canvas.current && active === canvas.current ? 'canvas'
      : field(target) || field(active) ? 'field' : neutral(target) && neutral(active) ? 'neutral' : 'ui';
    const modal = appModalOwner(current) ?? (current.operationRecovery !== 'idle' || document.querySelector('[role="dialog"]') ? 'other' : null);
    const owner = [...inputMenus.current].at(-1);
    const captured = [deferredPointer.current?.physicalPointer, gizmoGesture.current?.pointerId, filterGesture.current?.pointerId, gesture.current?.pointerId,
      alignmentGesture.current?.pointerId, polygonMousePointer.current]
      .some(id => id !== null && id !== undefined && canvas.current?.hasPointerCapture(id));
    return { tutorial: tutorial.blocksInput(), modal, menu: !!owner || !!document.querySelector('[role="menu"]'), focus,
      capturedGesture: captured, sceneReady: current.ready && !!current.summary && current.rendererState === 'ready' && current.operationRecovery === 'idle',
      composing: inputComposing.current, ownerId: modal ?? owner };
  }, [tutorial.blocksInput]);
  const applyInputTransition = useCallback((transition?: ScopeTransition) => {
    if (transition?.clearCamera) controller.camera?.clearInput();
    if (transition?.resetSelectionModifiers && useApp.getState().selectionModifiers) setApp({ selectionModifiers: 0 });
  }, [controller]);
  const syncInputScope = useCallback((event?: Event) => {
    const context = inputContext(event);
    applyInputTransition(inputLedger.transition(context));
    const owner = deferredPointer.current;
    if (owner && (context.tutorial || context.modal || context.menu || context.focus !== 'canvas' ||
        document.hidden || useApp.getState().tool !== owner.tool || !controller.deferredColorPointersCurrent(owner.token)))
      controller.cancelDeferredColorPointers();
  }, [inputLedger, inputContext, applyInputTransition, controller]);
  const resetDeferredInput = useCallback(() => {
    const owner = deferredPointer.current;
    if (!owner) return;
    deferredPointer.current = null; replayOptions.current = undefined; owner.queue.clear();
    controller.endDeferredColorPointers(owner.token); setDeferredInputPending(false);
    if (!gesture.current && !polygonPoints.current.length && !controller.selectionActive && !useApp.getState().summary?.selectionDraft)
      setApp({ selectionDragging: false, selectionOperation: null });
    if (owner.physicalPointer !== null && canvas.current?.hasPointerCapture(owner.physicalPointer))
      canvas.current.releasePointerCapture(owner.physicalPointer);
  }, [controller]);
  const drainInput = useCallback(() => {
    controller.cancelDeferredColorPointers();
    inputLedger.invalidate(); inputComposing.current = false; controller.camera?.clearInput();
    if (useApp.getState().selectionModifiers) setApp({ selectionModifiers: 0 });
  }, [inputLedger, controller]);
  const onInputScopeChange = useCallback((owner: string, open: boolean) => {
    if (open) inputMenus.current.add(owner); else inputMenus.current.delete(owner);
    syncInputScope();
  }, [syncInputScope]);
  useLayoutEffect(() => { syncInputScope(); });
  useEffect(() => useApp.subscribe(() => syncInputScope()), [syncInputScope]);
  const modalFocus: ModalFocusOptions = { returnFocus: dialogReturnFocus,
    fallbackFocus: () => [openButton.current, canvas.current],
    restoreAllowed: () => !appModalOwner(useApp.getState()) && !tutorial.blocksInput() };
  useEffect(() => {
    const closed = () => { pickerActive.current = false; tutorial.notifyIdle(); };
    const inputs = [picker.current, folderPicker.current, viewPicker.current];
    inputs.forEach(input => input?.addEventListener('cancel', closed));
    return () => inputs.forEach(input => input?.removeEventListener('cancel', closed));
  }, [tutorial.notifyIdle]);
  const setPolygonPoints = (points: [number, number][]) => { polygonPoints.current = points; setPolygon(points); };
  const setPolygonCursor = (point: [number, number] | null) => { polygonCursorPoint.current = point; };
  const cancelGizmo = (deactivate = false) => {
    const capture = gizmoGesture.current;
    gizmoGesture.current = null; setGizmoHandle(0);
    if (capture) {
      if (capture.target === 'filter') {
        try { capture.camera.endFilterGizmo(capture.session); } catch { /* Logical session may already be retired. */ }
        controller.cancelFilterGizmoGesture(capture.token, deactivate);
      } else {
        try { capture.camera.endTransformGizmo(capture.session); } catch { /* Logical session may already be retired. */ }
        controller.cancelTransformGizmoGesture(capture.token, deactivate);
      }
      if (canvas.current?.hasPointerCapture(capture.pointerId)) canvas.current.releasePointerCapture(capture.pointerId);
    } else if (deactivate) {
      controller.cancelFilterGizmoGesture(undefined, true); controller.cancelTransformGizmoGesture(undefined, true);
    }
  };
  const clearFilterPointer = (deactivate = false) => {
    cancelGizmo(deactivate);
    const capture = filterGesture.current; filterGesture.current = null; setFilterCaptured(false);
    if (capture && canvas.current?.hasPointerCapture(capture.pointerId)) canvas.current.releasePointerCapture(capture.pointerId);
  };
  const updateGizmo = (pointer: [number, number], ctrl: boolean) => {
    const capture = gizmoGesture.current;
    if (!capture) return false;
    capture.pointer = pointer; setGizmoPointer(pointer);
    try {
      if (capture.target === 'filter') {
        const pose = capture.camera.updateFilterGizmo(capture.session, pointer, ctrl);
        if (pose && controller.updateFilterGizmoGesture(capture.token, pose)) return true;
      } else {
        const pose = capture.camera.updateTransformGizmo(capture.session, pointer, ctrl);
        if (pose && controller.updateTransformGizmoGesture(capture.token, pose)) return true;
      }
    } catch { /* Refused/stale native geometry never publishes a pose. */ }
    cancelGizmo(true); return false;
  };
  const cancelGesture = (clearReleased = true) => {
    resetDeferredInput();
    polygonDeferredOptions.current = undefined;
    gestureVersion.current++;
    polygonMousePointer.current = null;
    alignmentGesture.current = null;
    gesture.current = null; setRectangle(null); setPolygonPoints([]); setPolygonCursor(null);
    setApp({ selectionDragging: false, selectionOperation: null });
    return controller.cancelSelectionGesture(clearReleased);
  };
  const rearmTool = (tool: SelectionTool) => {
    if (controller.filterActive || useApp.getState().transform || controller.opacityActive || controller.opacityPending) { void controller.activateSelectionTool(tool); return; }
    controller.cancelAlignment();
    cancelGesture(); controller.endToleranceSelection(); controller.camera?.clearInput();
    setApp({ tool, fly: false, autoOrbit: false });
  };
  const regionCommand = (tool: string, points: [number, number][], operation: number): SceneCommand => {
    const element = canvas.current!, bounds = element.getBoundingClientRect(), sx = element.width / bounds.width, sy = element.height / bounds.height;
    const physical = points.map(([x, y]) => [Math.round(x * sx), Math.round(y * sy)]);
    const camera = controller.camera?.state, current = pointerState();
    return { command: tool, camera, selectionView: current.currentViewOnly && camera ? [...camera] : null, width: element.width, height: element.height,
      operation, overlap: (replayOptions.current ?? gesture.current?.deferredOptions ?? polygonDeferredOptions.current)?.overlap ?? useApp.getState().overlap,
      visibleOnly: (tool === 'brush' || tool === 'volume') && ((replayOptions.current ?? gesture.current?.deferredOptions)?.visibleOnly ?? useApp.getState().visibleOnly),
      points: physical, radius: ((replayOptions.current ?? gesture.current?.deferredOptions)?.brushSize ?? useApp.getState().brushSize) * sx / 2,
      rectangle: physical.length ? [...physical[0], ...physical[physical.length - 1]] : [0, 0, 0, 0] };
  };
  const polygonShape = (cursor = polygonCursorPoint.current) => {
    const points = polygonPoints.current, last = points[points.length - 1];
    return cursor && points.length < 4096 && (!last || last[0] !== cursor[0] || last[1] !== cursor[1]) ? [...points, cursor] : points;
  };
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  const pointerState = () => ({ ...useApp.getState(), ...(replayOptions.current ?? gesture.current?.deferredOptions ?? polygonDeferredOptions.current) });
  const pumpDeferredPointer = () => {
    const owner = deferredPointer.current;
    if (!owner || owner.pumping) return;
    owner.pumping = true;
    const current = () => {
      const element = canvas.current, state = useApp.getState(), bounds = element?.getBoundingClientRect();
      return deferredPointer.current === owner && controller.deferredColorPointersCurrent(owner.token) &&
        state.tool === owner.tool && document.activeElement === element && !document.hidden &&
        !tutorial.blocksInput() && !inputMenus.current.size && !document.querySelector('[role="menu"], [role="dialog"]') &&
        !!bounds && [bounds.left, bounds.top, bounds.width, bounds.height].every((value, index) => value === owner.bounds[index]);
    };
    void (async () => {
      try {
        if (!owner.ready) owner.ready = await controller.waitForDeferredColorPointers(owner.token);
        if (!owner.ready || !current()) { if (deferredPointer.current === owner) cancelGesture(); return; }
        let processed = 0;
        while (owner.queue.length && current()) {
          const record = owner.queue.shift()!; replayOptions.current = record.options;
          const handlers = replayHandlers.current!;
          await (record.kind === 'down' ? handlers.down(record.input) : record.kind === 'move' ? handlers.move(record.input) :
            record.kind === 'up' ? handlers.up(record.input) : record.kind === 'mouse-down' ? handlers.mouse(record.input) : handlers.double(record.input));
          replayOptions.current = undefined;
          if (deferredPointer.current !== owner) return;
          if (owner.physicalPointer !== null) setApp({ selectionDragging: true });
          if (++processed % DEFERRED_POINTER_REPLAY_BATCH_SIZE === 0) await new Promise<void>(resolve => window.setTimeout(resolve, 0));
        }
        if (!current()) { if (deferredPointer.current === owner) cancelGesture(); return; }
        if (!owner.queue.length && owner.physicalPointer === null) resetDeferredInput();
      } catch {
        if (deferredPointer.current === owner) cancelGesture();
      } finally { owner.pumping = false; }
    })();
  };
  const captureDeferredPointer = (kind: DeferredPointerKind, event: SceneMouseInput, pointerId: number, pointerType = 'mouse') => {
    if (event.replayed) return false;
    let owner = deferredPointer.current;
    if (!owner) {
      if (kind !== 'down' || event.button !== 0 || event.buttons !== 1 || !useApp.getState().tool || !controller.colorPointerDeferralAvailable) return false;
      const context = inputContext(event.nativeEvent);
      if (context.tutorial || context.modal || context.menu) return true;
      const token = controller.beginDeferredColorPointers();
      if (!token) { event.preventDefault(); return true; }
      const bounds = canvas.current!.getBoundingClientRect(), state = useApp.getState();
      owner = { token, queue: new DeferredPointerQueue<DeferredPointerRecord>(), tool: state.tool!,
        physicalPointer: null, lastPointer: pointerId, options: undefined!, refusedPointer: null, acceptCompanion: false, ready: false, pumping: false,
        bounds: [bounds.left, bounds.top, bounds.width, bounds.height] };
      deferredPointer.current = owner; setDeferredInputPending(true);
    }
    // Retain the mouse-down companion's native click count for Polygon. A
    // cancelled pointer-down suppresses that compatibility event in browsers.
    if (kind !== 'down') event.preventDefault();
    if (owner.refusedPointer === pointerId && kind !== 'down') {
      if (kind === 'up') owner.refusedPointer = null;
      return true;
    }
    if ((kind === 'mouse-down' || kind === 'double') && !owner.acceptCompanion) return true;
    if (kind === 'down') {
      if (event.button !== 0 || event.buttons !== 1 || owner.physicalPointer !== null) { cancelGesture(); return true; }
      const state = useApp.getState();
      owner.options = { tool: state.tool!, live: state.live, overlap: state.overlap, visibleOnly: state.visibleOnly, currentViewOnly: state.currentViewOnly,
        brushSize: state.brushSize, operation: state.operation, colorTolerance: state.colorTolerance,
        fillTolerance: state.fillTolerance, connectedColor: state.connectedColor,
        ...captureSelectionRangePointerOptions(state, canvas.current!.width / canvas.current!.getBoundingClientRect().width) };
    } else if ((kind === 'move' || kind === 'up') && owner.physicalPointer !== pointerId) return true;
    if (kind === 'move' && event.buttons !== 1 || kind === 'up' && (event.button !== 0 || event.buttons !== 0)) {
      cancelGesture(); return true;
    }
    const input: ScenePointerInput = { clientX: event.clientX, clientY: event.clientY, button: event.button,
      buttons: event.buttons, detail: event.detail, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey,
      metaKey: event.metaKey, altKey: event.altKey, pointerId, pointerType, replayed: true, preventDefault() {} };
    const result = owner.queue.append({ kind, input, options: owner.options });
    if (result === 'overflow') { cancelGesture(); return true; }
    if (result === 'refused') { if (kind === 'down') { owner.refusedPointer = pointerId; owner.acceptCompanion = false; } return true; }
    if (kind === 'down') {
      owner.refusedPointer = null; owner.acceptCompanion = true;
      owner.physicalPointer = pointerId; owner.lastPointer = pointerId;
      try { canvas.current!.focus(); canvas.current!.setPointerCapture(pointerId); }
      catch { cancelGesture(); return true; }
      setApp({ selectionDragging: true });
    } else if (kind === 'up') {
      owner.physicalPointer = null;
      if (canvas.current?.hasPointerCapture(pointerId)) canvas.current.releasePointerCapture(pointerId);
    }
    pumpDeferredPointer(); return true;
  };
  useEffect(() => {
    const capture = gizmoGesture.current;
    if (capture?.target === 'filter' && (!state.filter || capture.filterId !== state.filter.id || capture.kind !== state.filter.kind ||
      capture.mode !== state.filterGizmoMode || !state.filterGizmoDragging || state.filter.phase !== 'ready' ||
      state.rendererState !== 'ready' || !state.toolsOpen || !webFeatureAllowed('transform.manual') || capture.camera !== controller.camera)) cancelGizmo();
    if (!state.filter) { if (capture?.target === 'filter' || filterGesture.current) clearFilterPointer(); setFilterCursor(null); }
  }, [state.filter?.id, state.filter?.kind, state.filter?.phase, state.filterGizmoMode, state.filterGizmoDragging,
    state.rendererState, state.toolsOpen, state.mode, controller]);
  useEffect(() => {
    const capture = gizmoGesture.current;
    if (capture?.target === 'transform' && (!state.transform || capture.transformId !== state.transform.id ||
      // An owned press rebases asynchronously. The controller fences that
      // base/phase transition while App retains its physical pointer scratch.
      state.transform.kind !== 'gizmo' || !controller.transformGizmoGestureActive ||
      capture.mode !== state.transformGizmoMode || !state.transformGizmoDragging || state.rendererState !== 'ready' ||
      !state.toolsOpen || capture.camera !== controller.camera)) cancelGizmo();
  }, [state.transform?.id, state.transform?.baseId, state.transform?.kind, state.transform?.phase, state.transformGizmoMode,
    state.transformGizmoDragging, state.rendererState, state.toolsOpen, state.mode, controller]);
  useEffect(() => {
    controller.onDeferredPointerCancel = () => cancelGesture();
    controller.onViewportResize = () => { clearFilterPointer(); cancelGesture(); };
    controller.onSelectionOperationChanged = operation => {
      const start = gesture.current;
      // Replayed presses keep the Combine captured at physical admission. A
      // live Color/Fill press snapshots its options yet still takes Combine.
      if (start?.button === 0 && !start.replayedOptions && useApp.getState().tool) {
        const previous = start.operation;
        start.operation = operation; setApp({ selectionOperation: operation });
        // Windows retains the live request after Single's distance threshold
        // restores its draft. A changed explicit Combine restarts at the press,
        // then the same threshold can cancel the new preview again.
        if (start.singleLive && start.singleCancelled && previous !== operation) {
          const restart = ++start.singleRestart, version = gestureVersion.current;
          const current = () => gesture.current === start && gestureVersion.current === version &&
            start.singleRestart === restart && start.operation === operation && useApp.getState().tool === 'single';
          void (async () => {
            await controller.cancelSelectionGesture(false);
            if (!current() || !controller.beginSelectionGesture(operation)) return;
            const element = canvas.current!, bounds = element.getBoundingClientRect(), [x, y] = start.points[0];
            await controller.previewSinglePixel(x * element.width / bounds.width, y * element.height / bounds.height, operation);
            if (!current()) return;
            start.singleCancelled = Math.hypot(start.x - x, start.y - y) > 5;
            if (start.singleCancelled) await controller.cancelSelectionGesture(false);
          })();
        }
      }
      if (polygonPoints.current.length && !polygonDeferredOptions.current) { polygonOperation.current = operation; setApp({ selectionOperation: operation }); }
    };
    controller.onOpenPicker = () => { if (!tutorial.blocksInput()) requestPicker(picker); };
    const detachBenchmark = installProductionBenchmarkBridge(controller);
    controller.onCanvasReplacement = previous => new Promise<HTMLCanvasElement>((resolve, reject) => {
      replacementCanvas.current = { resolve, reject, focus: document.activeElement === previous }; setCanvasGeneration(value => value + 1);
    });
    void controller.initialize(canvas.current!);
    return () => {
      replacementCanvas.current?.reject(new DOMException('Graphics restoration cancelled', 'AbortError')); replacementCanvas.current = null; controller.onCanvasReplacement = undefined;
      cancelGesture(); clearFilterPointer(true); controller.onViewportResize = undefined; controller.onSelectionOperationChanged = undefined; controller.onDeferredPointerCancel = undefined; detachBenchmark(); controller.dispose(); };
  }, [controller]);
  useEffect(() => {
    let timer = 0, keyboardInput = false;
    const wake = (event?: Event) => {
      if (event instanceof KeyboardEvent) keyboardInput = true;
      else if (event?.type === 'pointerdown') keyboardInput = false;
      // Tab's native focus search must see the restored controls in this event.
      if (event instanceof KeyboardEvent && event.key === 'Tab' && canvas.current?.closest('.chrome-hidden')) flushSync(() => setChrome(true));
      else setChrome(true);
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (!document.querySelector('[data-chrome]:hover') && !document.querySelector('[data-chrome]:focus-within') && !(keyboardInput && canvas.current === document.activeElement) &&
            !inputMenus.current.size && !document.querySelector('[role="menu"], [role="dialog"], .alignment-popup') && !useApp.getState().busy &&
            useApp.getState().pendingSelectionCount === 0 && !useApp.getState().summary?.selectionDraft) setChrome(false);
      }, 3000);
    };
    const events = ['pointermove', 'pointerdown', 'pointerup', 'keydown', 'focusin'];
    for (const event of events) window.addEventListener(event, wake); wake();
    return () => { clearTimeout(timer); for (const event of events) window.removeEventListener(event, wake); };
  }, []);
  // Profile restoration preserves a completed Color/Fill checkpoint, including
  // a first RGB upgrade still waiting for its map. Explicit option assignments
  // have a separate revision and retain the desktop cancellation boundary.
  useEffect(() => {
    if (deferredPointer.current?.tool === state.tool || gesture.current?.deferredOptions?.tool === state.tool || polygonDeferredOptions.current?.tool === state.tool) return;
    cancelGesture();
  }, [state.tool, state.selectionOptionsRevision]);
  useEffect(() => {
    if (deferredPointer.current) return;
    controller.endToleranceSelection();
    setApp({ tolerance: state.tool === 'fill' ? state.fillTolerance : state.colorTolerance });
  }, [state.tool, state.selectionOptionsRevision, controller]);
  useEffect(() => {
    if (tutorial.active || deferredInputPending || !state.pendingMode) return;
    if (!editingAvailable || !state.ready || !state.summary || state.rendererState !== 'ready') { setApp({ pendingMode: null }); return; }
    const dragging = (state.selectionDragging || state.summary.selectionDraft) && state.tool !== 'polygon';
    const profileBusy = controller.isReleasedSelectionBusy || state.tool === 'polygon' && controller.selectionActive;
    if (!dragging && state.pendingSelectionCount === 0 && (!state.busy || profileBusy))
      switchToolsMode(state.pendingMode, profileBusy);
  }, [state.pendingMode, state.ready, state.summary, state.rendererState, state.tool,
    state.selectionDragging, state.busy, state.pendingSelectionCount, editingAvailable, controller, tutorial.active, deferredInputPending]);
  useEffect(() => {
    if (state.tool) { controller.camera?.clearInput(); setApp({ fly: false, autoOrbit: false }); }
  }, [state.tool, controller]);
  useEffect(() => {
    if (state.busy || state.settingsOpen || state.exportOpen || state.navigationPrompt || state.outputPending || state.savedViewChoices.length) controller.camera?.clearInput();
  }, [state.busy, state.settingsOpen, state.exportOpen, state.navigationPrompt, state.outputPending, state.savedViewChoices.length, controller]);
  useEffect(() => {
    const blur = () => { drainInput(); if (tutorial.blocksInput()) return; clearFilterPointer(); cancelGesture(); controller.cancelAlignment(); setApp({ selectionModifiers: 0 }); controller.camera?.clearInput(); };
    const focus = (event: FocusEvent) => { syncInputScope(event); if (!tutorial.blocksInput(event) && event.target !== canvas.current) { clearFilterPointer(); controller.camera?.clearInput(); } };
    const pointer = (event: PointerEvent) => { if (!tutorial.blocksInput(event)) controller.camera?.clearInput(); };
    window.addEventListener('blur', blur);
    const composition = (event: CompositionEvent) => { inputComposing.current = event.type === 'compositionstart'; syncInputScope(event); };
    window.addEventListener('focusin', focus); window.addEventListener('pointerdown', pointer, true);
    window.addEventListener('compositionstart', composition, true); window.addEventListener('compositionend', composition, true);
    return () => { window.removeEventListener('blur', blur); window.removeEventListener('focusin', focus); window.removeEventListener('pointerdown', pointer, true);
      window.removeEventListener('compositionstart', composition, true); window.removeEventListener('compositionend', composition, true); };
  }, [controller, drainInput, syncInputScope]);
  useEffect(() => { if (!deferredPointer.current && !state.summary?.selectionDraft && !controller.selectionActive) {
    if (gesture.current?.singleCancelled) return;
    gesture.current = null; polygonMousePointer.current = null;
    setRectangle(null); setPolygonPoints([]); setPolygonCursor(null); setApp({ selectionDragging: false, selectionOperation: null });
  // Fatal Polygon cleanup may retire its owner after the restored summary was
  // published. Other deferred tools still need their press through release.
  } }, [state.summary?.selectionDraft, state.tool === 'polygon' && state.selectionDragging]);
  useEffect(() => {
    if (state.selectionRecovery !== 'required') return;
    // End pointer/UI ownership even when native restoration is still refused.
    // The controller retains that authority separately until acknowledged.
    gestureVersion.current++; gesture.current = null; polygonMousePointer.current = null;
    setRectangle(null); setPolygonPoints([]); setPolygonCursor(null);
    controller.camera?.clearInput();
  }, [state.selectionRecovery, controller]);
  const finishPolygon = () => {
    if (polygonPoints.current.length < 3) return;
    const version = gestureVersion.current;
    const task = controller.finishPolygonGesture(regionCommand('polygon', polygonPoints.current, polygonOperation.current)).finally(() => {
      if (gestureVersion.current === version) setApp({ selectionDragging: false });
    });
    gesture.current = null;
    polygonMousePointer.current = null;
    setPolygonPoints([]); setPolygonCursor(null); setApp({ selectionOperation: null });
    polygonDeferredOptions.current = undefined;
    return task;
  };
  const previousPolygonPoint = () => {
    if (!polygonPoints.current.length) return;
    const points = polygonPoints.current.slice(0, -1); setPolygonPoints(points);
    if (!points.length) void cancelGesture();
    else void controller.updatePolygon(regionCommand('polygon', polygonShape(), polygonOperation.current));
  };
  const finishManualSelection = async () => {
    const client = controller.client, tool = useApp.getState().tool, version = gestureVersion.current;
    const deferred = deferredPointer.current;
    if (!tool || useApp.getState().selectionActionPending || gesture.current || deferred && deferred.physicalPointer !== null) return;
    if (tool === 'polygon' && polygonPoints.current.length) {
      if (polygonPoints.current.length < 3 || !await finishPolygon()) return;
    }
    if (client !== controller.client || version !== gestureVersion.current || useApp.getState().tool !== tool) return;
    // Leaving the tool cancels its gesture state and bumps the version itself;
    // the exited tool is the proof that this Finish, not a later action, ended it.
    if (await controller.finishManualSelection() && client === controller.client && useApp.getState().tool === null)
      canvas.current?.focus({ preventScroll: true });
  };
  const undoManualSelection = async (allowCaptured = false) => {
    const client = controller.client, tool = useApp.getState().tool;
    if (!tool || useApp.getState().selectionActionPending || deferredPointer.current || gesture.current && !allowCaptured) return;
    // A right/middle press is a camera or clear gesture, not a selection to
    // cancel; its clear refuses a changed revision on release.
    if (gesture.current?.button === 0 || tool === 'polygon' && polygonPoints.current.length) {
      const task = cancelGesture(false), version = gestureVersion.current;
      if (await task && client === controller.client && version === gestureVersion.current && useApp.getState().tool === tool)
        canvas.current?.focus({ preventScroll: true });
      return;
    }
    const version = gestureVersion.current;
    if (await controller.undoManualSelection() && client === controller.client && version === gestureVersion.current && useApp.getState().tool === tool)
      canvas.current?.focus({ preventScroll: true });
  };
  const clearManualSelection = async (allowCaptured = false) => {
    const client = controller.client, tool = useApp.getState().tool;
    if (!tool || useApp.getState().selectionActionPending || deferredPointer.current || gesture.current && !allowCaptured) return;
    const task = cancelGesture(), version = gestureVersion.current;
    if (!await task || client !== controller.client || version !== gestureVersion.current || useApp.getState().tool !== tool) return;
    if (await controller.clearManualSelection() && client === controller.client && version === gestureVersion.current && useApp.getState().tool === tool)
      canvas.current?.focus({ preventScroll: true });
  };
  const runTransformGizmoAction = async (action: () => Promise<boolean>, finish: boolean) => {
    const client = controller.client, mode = useApp.getState().transformGizmoMode, id = useApp.getState().transform?.id;
    const source = client && { documentId: client.revision.documentId, sourceGeneration: client.revision.sourceGeneration };
    const version = gestureVersion.current, element = canvas.current;
    if (!mode || !source || !client) return;
    if (!await action()) return;
    const current = useApp.getState();
    if (controller.client === client && client.revision.documentId === source.documentId && client.revision.sourceGeneration === source.sourceGeneration &&
        version === gestureVersion.current && element === canvas.current && element?.isConnected && current.ready &&
        current.transformGizmoMode === (finish ? null : mode) && (finish
          ? current.transform === null && current.tool === null && !current.filter && !current.alignmentTool && !current.opacity
          : current.transform?.id === id))
      element.focus({ preventScroll: true });
  };
  const undoGizmoSession = () => {
    // Capture controller priority before retiring App's physical scratch/capture.
    const task = runTransformGizmoAction(() => controller.undoTransformGizmo(), false);
    if (gizmoGesture.current?.target === 'transform') cancelGizmo();
    return task;
  };
  const cancelGizmoSession = () => {
    const task = runTransformGizmoAction(() => controller.cancelTransformGizmo(), true);
    if (gizmoGesture.current?.target === 'transform') cancelGizmo();
    return task;
  };
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (controller.appUpdateUnloadAllowed) return;
      const current = useApp.getState();
      if (current.dirty || current.operationRecovery !== 'idle') { event.preventDefault(); event.returnValue = ''; }
    };
    const visibility = () => { if (document.hidden) drainInput(); if (tutorial.blocksInput()) return; if (document.hidden) { clearFilterPointer(); cancelGesture(); controller.cancelAlignment(); controller.camera?.clearInput(); } else controller.invalidate(); };
    const key = (event: KeyboardEvent) => {
      if (tutorial.blocksInput(event)) return;
      const admission = inputLedger.keyDown(event, inputContext(event)); applyInputTransition(admission.scopeTransition);
      if (admission.action === 'ui.focus-scene') {
        event.preventDefault(); canvas.current?.focus({ preventScroll: true }); return;
      }
      if (admission.action === 'none') {
        if (admission.preventDefault) event.preventDefault();
        if (admission.owner === 'browser' && event.key !== 'Tab') drainInput();
        return;
      }
      if (event.key.toLowerCase() === 't') {
        const current = useApp.getState(), context = inputContext(event);
        // Match the toolbar's availability, with the desktop key's additional
        // no-repeat/no-capture boundary. Saving a view never rearms a tool.
        if (event.defaultPrevented || event.repeat || event.isComposing || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey ||
            context.focus !== 'canvas' || context.capturedGesture || !context.sceneReady ||
            current.busy || current.selectionRecovery !== 'idle' || current.memoryOverageBytes > 0 || controller.filterActive ||
            current.thumbnailPending || current.viewTransferPending) return;
        event.preventDefault(); controller.camera?.clearInput();
        void controller.updateThumbnail(); return;
      }
      if (event.key === 'PageUp' || event.key === 'PageDown') {
        const current = useApp.getState(), target = event.target, active = document.activeElement;
        const text = target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName));
        const captured = [gizmoGesture.current?.pointerId, filterGesture.current?.pointerId, gesture.current?.pointerId, alignmentGesture.current?.pointerId, polygonMousePointer.current]
          .some(id => id !== undefined && id !== null && canvas.current?.hasPointerCapture(id));
        const direction = collectionPageDirection(event, { available: controller.collectionNavigationAvailable,
          text, activeUi: active !== canvas.current && active !== document.body && active !== null,
          popup: current.settingsOpen || current.exportOpen || current.navigationPrompt || current.outputPending || !!current.savedViewChoices.length ||
            !!document.querySelector('[role="menu"], [role="dialog"]'), captured });
        // Only admitted scene input consumes collection keys; fields and UI retain their page keys.
        event.preventDefault(); controller.camera?.clearInput();
        if (direction) { cancelGesture(); void controller.adjacent(direction); }
        return;
      }
      const gizmo = gizmoGesture.current;
      const transform = useApp.getState().transform;
      if (transform?.kind === 'gizmo' && useApp.getState().transformGizmoMode &&
          !document.querySelector('[role="menu"], [role="dialog"]') && handleTransformGizmoKey(event, mac ? event.metaKey : event.ctrlKey, {
            captured: gizmo?.target === 'transform', canUndo: controller.transformGizmoUndoEnabled,
            onFinish: () => { void runTransformGizmoAction(() => controller.finishTransformGizmo(), true); },
            onUndo: () => { void undoGizmoSession(); }, onCancel: () => { void cancelGizmoSession(); },
            onCancelDrag: () => { void undoGizmoSession(); },
          })) return;
      if (gizmo && !event.defaultPrevented && !event.isComposing &&
        !document.querySelector('[role="menu"], [role="dialog"]')) {
        if (event.key === 'Escape') { event.preventDefault(); cancelGizmo(true); controller.camera?.clearInput(); return; }
        if (event.key === 'Enter') { event.preventDefault(); return; }
        if (event.code === 'ControlLeft' || event.code === 'ControlRight') {
          updateGizmo(gizmo.pointer, event.ctrlKey); return;
        }
        const digit = /^[1-4]$/.test(event.key) ? Number(event.key) : /^Digit[1-4]$/.test(event.code) ? Number(event.code.slice(-1)) : null;
        if (gizmo.target === 'filter' && digit !== null && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault(); if (!event.repeat) controller.setFilterOperation(digit - 1); return;
        }
        if (navigationKey(event.code) !== undefined) event.preventDefault();
        controller.camera?.clearInput(); return;
      }
      // Desktop Ctrl+G belongs to browser Find Next. Plain G is scoped to the
      // focused scene, and only an admitted first press rearms the tool. Keep
      // repeat distinct from clicking the already active toolbar button.
      if (event.key.toLowerCase() === 'g') {
        const current = useApp.getState();
        if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey ||
            event.target !== canvas.current || document.activeElement !== canvas.current ||
            current.settingsOpen || current.exportOpen || current.navigationPrompt || current.outputPending || current.savedViewChoices.length > 0 ||
            !current.ready || !current.summary || !controller.editingAvailable && !controller.filterControlsEnabled && !controller.transformControlsEnabled ||
            current.busy && !controller.selectionActive && !controller.isReleasedSelectionBusy) return;
        event.preventDefault();
        if (!event.repeat) rearmTool('fill');
        return;
      }
      setApp({ selectionModifiers: Number(event.shiftKey) | (Number(mac ? event.metaKey : event.ctrlKey) << 1) });
      if (event.target instanceof HTMLElement && (event.target.isContentEditable || /INPUT|SELECT|TEXTAREA/.test(event.target.tagName))) { controller.camera?.clearInput(); return; }
      const primary = mac ? event.metaKey : event.ctrlKey;
      const filter = useApp.getState().filter;
      if (filter && !event.defaultPrevented && !event.isComposing && !primary && !event.ctrlKey && !event.metaKey && !event.altKey &&
          !document.querySelector('[role="menu"], [role="dialog"]')) {
        if (event.key === 'Escape') {
          event.preventDefault(); controller.camera?.clearInput();
          if (useApp.getState().filterCenterPicking) controller.cancelFilterCenterPick(); else if (controller.filterCancelEnabled) void controller.cancelFilter();
          return;
        }
        if (event.key === 'Enter') { event.preventDefault(); if (!event.repeat && controller.filterFinishEnabled) void controller.confirmFilter(); return; }
        const digit = /^[1-4]$/.test(event.key) ? Number(event.key) : /^Digit[1-4]$/.test(event.code) ? Number(event.code.slice(-1)) : null;
        if (digit !== null) { event.preventDefault(); if (!event.repeat) controller.setFilterOperation(digit - 1); return; }
      }
      if (useApp.getState().settingsOpen || useApp.getState().savedViewChoices.length) {
        // Modal state owns scene shortcuts even if focus is on its opener or
        // body after a window blur. Dialog bubbling alone cannot guard that.
        controller.camera?.clearInput();
        if (primary && ['o', 's', 'z', 'y', 'a', 'i', 'e'].includes(event.key.toLowerCase())) event.preventDefault();
        return;
      }
      if ((filter || useApp.getState().tool) && !document.querySelector('[role="menu"], [role="dialog"]') && handleFloatingSelectionKey(event, primary, {
        onUndo: () => { if (filter) void controller.undoFilterSelection(); else void undoManualSelection(true); },
        onClear: () => { if (filter) void controller.clearFilterSelection(); else void clearManualSelection(true); },
      })) return;
      if (event.ctrlKey || event.metaKey) controller.camera?.clearInput();
      if (primary) {
        if (event.repeat && ['z', 'y', 'a', 'i'].includes(event.key.toLowerCase())) { event.preventDefault(); return; }
        if (useApp.getState().memoryOverageBytes > 0 && ['o', 's', 'c'].includes(event.key.toLowerCase())) { event.preventDefault(); return; }
        if (useApp.getState().selectionRecovery !== 'idle' && ['o', 's', 'c'].includes(event.key.toLowerCase())) { event.preventDefault(); return; }
        if (!controller.editingAvailable && (['z', 'y', 'a', 'i'].includes(event.key.toLowerCase()) ||
             event.key.toLowerCase() === 'e' && !controller.filterControlsEnabled && !controller.transformControlsEnabled) ||
            event.key.toLowerCase() === 's' && useApp.getState().summary?.kind !== 0 && !!useApp.getState().summary) {
          event.preventDefault(); return;
        }
        if (['o', 's', 'a', 'i'].includes(event.key.toLowerCase())) cancelGesture(event.key.toLowerCase() !== 's');
        if (event.key.toLowerCase() === 'o') { event.preventDefault(); requestPicker(picker); }
        if (event.key.toLowerCase() === 's') { event.preventDefault(); setApp({ exportOpen: true }); }
        if (event.key.toLowerCase() === 'z') { event.preventDefault(); void controller.command({ command: event.shiftKey ? 'redo' : 'undo' }); }
        if (event.key.toLowerCase() === 'y') { event.preventDefault(); void controller.command({ command: 'redo' }); }
        if (event.key.toLowerCase() === 'a') { event.preventDefault(); void controller.command({ command: event.shiftKey ? 'selectNone' : 'selectAll' }); }
        if (event.key.toLowerCase() === 'i') { event.preventDefault(); void controller.command({ command: 'invert' }); }
        if (event.key.toLowerCase() === 'c') { event.preventDefault(); copyImage(); }
        if (event.key.toLowerCase() === 'e') {
          event.preventDefault(); if (!event.repeat) rearmTool('color');
        }
        return;
      }
      if (event.ctrlKey || event.metaKey) return;
      const current = useApp.getState();
      if (current.settingsOpen || current.exportOpen || current.navigationPrompt || current.outputPending || current.savedViewChoices.length) { controller.camera?.clearInput(); return; }
      if (handleAlignmentKey(event, controller)) { alignmentGesture.current = null; controller.camera?.clearInput(); return; }
      if (event.key === 'Escape' && current.transform) {
        event.preventDefault(); controller.camera?.clearInput();
        if (!event.repeat) {
          if (current.transform.kind === 'gizmo') void cancelGizmoSession();
          else void controller.cancelTransformPreview();
        }
        return;
      }
      if (event.key === 'Escape' && controller.opacityActive) {
        event.preventDefault(); controller.camera?.clearInput();
        if (!event.repeat && controller.opacityCancelEnabled) void controller.cancelOpacityPreview();
        return;
      }
      controller.camera?.speed(event.shiftKey, event.altKey);
      if (navigationKey(event.code) !== undefined) {
        if (!current.summary || !controller.cameraNavigationEnabled || event.ctrlKey || event.metaKey ||
            event.target instanceof HTMLElement && /^(BUTTON|SUMMARY|A)$/.test(event.target.tagName)) return;
        event.preventDefault(); cancelGesture();
        setApp({ autoOrbit: false, ...(translationKey(event.code) ? { fly: true, tool: null } : {}) });
        controller.camera?.key(event.code, true, event.shiftKey, event.altKey); controller.invalidate(); return;
      }
      if (event.altKey && event.key !== 'Escape') return;
      if (!controller.cameraNavigationEnabled && ['v', 'o', 'f'].includes(event.key.toLowerCase())) return;
      if (!controller.editingAvailable && (['Delete', 'Backspace'].includes(event.key) ||
          event.key === 'Enter' && current.tool === 'polygon' || ['c', 'i'].includes(event.key.toLowerCase()) ||
           ['b', 'x', 'p'].includes(event.key.toLowerCase()) && !controller.filterControlsEnabled && !controller.transformControlsEnabled)) {
        event.preventDefault(); return;
      }
      if (event.repeat && ['r', 'v', 'o', 'f', 'b', 'x', 'p', 'm', 'n', 'c', 'i'].includes(event.key.toLowerCase())) return;
      if (event.key === 'Escape') { cancelGesture(); controller.camera?.clearInput(); setApp({ tool: null }); controller.cancelOperation(); }
      else if (event.key === 'Enter' && state.tool === 'polygon') finishPolygon();
      else if (event.key === 'Backspace' && polygonPoints.current.length) {
        event.preventDefault(); previousPolygonPoint();
      }
      else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); void controller.command({ command: 'delete' }); }
      else if (event.key.toLowerCase() === 'c' || event.key.toLowerCase() === 'i') {
        event.preventDefault(); cancelGesture(); void controller.command({ command: event.key.toLowerCase() === 'c' ? 'selectNone' : 'invert' });
      }
      else if (event.key.toLowerCase() === 'r') { cancelGesture(); controller.resetCamera(); }
      else if (event.key.toLowerCase() === 'v') { controller.cancelAlignment(); controller.camera?.clearInput(); setApp({ fly: !useApp.getState().fly, autoOrbit: false, tool: null }); }
      else if (event.key.toLowerCase() === 'o') { cancelGesture(); if (current.alignmentTool !== 'floor') controller.cancelAlignment(); controller.camera?.clearInput(); setApp({ autoOrbit: !useApp.getState().autoOrbit, fly: false, tool: null }); controller.invalidate(); }
      else if (event.key.toLowerCase() === 'f') { cancelGesture(); controller.camera?.flipUp(); controller.invalidate(); }
      else if (['b', 'x', 'p'].includes(event.key.toLowerCase())) {
        rearmTool(event.key.toLowerCase() === 'b' ? event.shiftKey ? 'volume' : 'brush' : event.key.toLowerCase() === 'x' ? 'rectangle' : 'polygon');
      }
      else if (current.tool && /^[1-4]$/.test(event.key)) { event.preventDefault(); controller.setSelectionOperation(Number(event.key) - 1); }
      else if (current.tool && event.key.toLowerCase() === 'm' && !['single', 'color'].includes(current.tool)) {
        event.preventDefault(); setSelectionPreferences({ overlap: !current.overlap });
      }
      else if (current.tool && event.key.toLowerCase() === 'n' && ['brush', 'volume', 'fill'].includes(current.tool)) {
        event.preventDefault(); setSelectionPreferences({ visibleOnly: !current.visibleOnly });
      }
      else if ((current.tool === 'brush' || current.tool === 'volume') && ['BracketLeft', 'BracketRight'].includes(event.code)) {
        event.preventDefault(); if (!current.selectionDragging) setApp({ brushSize: Math.max(8, Math.min(320, current.brushSize * (event.code === 'BracketLeft' ? 1 / 1.15 : 1.15))) });
      }
    };
    const release = (event: KeyboardEvent) => {
      if (tutorial.blocksInput(event)) return;
      const admission = inputLedger.keyUp(event, inputContext(event)); applyInputTransition(admission.scopeTransition);
      if (admission.action !== 'scene.release' && admission.action !== 'gesture.release') return;
      setApp({ selectionModifiers: Number(event.shiftKey) | (Number(mac ? event.metaKey : event.ctrlKey) << 1) });
      const gizmo = gizmoGesture.current;
      if (gizmo) {
        if (event.code === 'ControlLeft' || event.code === 'ControlRight') updateGizmo(gizmo.pointer, event.ctrlKey);
        controller.camera?.clearInput(); return;
      }
      if (controller.camera?.key(event.code, false, event.shiftKey, event.altKey)) controller.invalidate();
    };
    const wheel = (event: WheelEvent) => {
      const current = useApp.getState(), context = inputContext(event);
      const gizmo = !!gizmoGesture.current || controller.filterGizmoGestureActive || controller.transformGizmoGestureActive;
      const admitted = admitWheel(event, { overScene: event.target === canvas.current,
        tutorial: tutorial.blocksInput(event), modal: !!context.modal, menu: context.menu, gizmo,
        brushTool: current.tool === 'brush' || current.tool === 'volume',
        canResizeBrush: context.sceneReady && !current.busy && current.selectionRecovery === 'idle' &&
          !current.memoryOverageBytes && !current.selectionDragging && !current.thumbnailPending && !current.viewTransferPending,
        canNavigate: !!current.summary && controller.cameraNavigationEnabled && !controller.selectionActive &&
          !(gesture.current?.button === 0 && current.tool) });
      if (admitted.preventDefault) event.preventDefault();
      if (admitted.action === 'blocked' && gizmo) controller.camera?.clearInput();
      else if (admitted.action === 'brush')
        setApp({ brushSize: Math.max(8, Math.min(320, current.brushSize * Math.pow(1.15, admitted.ticks))) });
      else if (admitted.action === 'camera') {
        controller.camera?.queueScroll(admitted.ticks, current.fly); controller.invalidate();
      }
    };
    sceneInputHandlers.current = { key, release, wheel, beforeUnload, visibility };
  });
  useEffect(() => {
    // UI updates refresh the committed callbacks without replacing a listener
    // while the browser is dispatching its current key or pointer event.
    const key = (event: KeyboardEvent) => sceneInputHandlers.current?.key(event);
    const release = (event: KeyboardEvent) => sceneInputHandlers.current?.release(event);
    const wheel = (event: WheelEvent) => sceneInputHandlers.current?.wheel(event);
    const beforeUnload = (event: BeforeUnloadEvent) => sceneInputHandlers.current?.beforeUnload(event);
    const visibility = () => sceneInputHandlers.current?.visibility();
    const target = canvas.current!; target.addEventListener('wheel', wheel, { passive: false });
    window.addEventListener('keydown', key); window.addEventListener('keyup', release);
    window.addEventListener('beforeunload', beforeUnload); document.addEventListener('visibilitychange', visibility);
    return () => {
      target.removeEventListener('wheel', wheel); window.removeEventListener('keydown', key);
      window.removeEventListener('keyup', release); window.removeEventListener('beforeunload', beforeUnload);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [controller, canvasGeneration]);
  useEffect(() => {
    alignmentGesture.current = null;
  }, [state.alignmentTool]);
  useEffect(() => {
    const retainedFloor = state.alignmentTool === 'floor' && state.alignmentFloor?.phase === 'candidate' && state.alignmentFloor.candidate?.status === 'ready';
    if (!state.alignmentTool || !state.alignmentPoint && !retainedFloor) {
      setAlignmentMarker(null); setAlignmentSecondMarker(null); setAlignmentThirdMarker(null); setAlignmentSegment(null);
      setAlignmentTriangleSegments([]); setAlignmentNormalProjection(null); setAlignmentDistanceMarker(null); setFloorGrid([]); return;
    }
    let frame = 0;
    const update = () => {
      const element = canvas.current, camera = controller.camera, current = useApp.getState(), world = current.alignmentPoint;
      if (!element || !camera || !current.alignmentTool) return;
      const bounds = element.getBoundingClientRect();
      const floorCandidate = current.alignmentTool === 'floor' && current.alignmentFloor?.phase === 'candidate' && current.alignmentFloor.candidate?.status === 'ready' ? current.alignmentFloor.candidate : null;
      if (floorCandidate) {
        const projected = projectFloorOverlay(floorCandidate.plane, current.alignmentFlip, camera.view, camera.projection, bounds.width, bounds.height,
          UI_SIZES.find(info => info.size === displayedUiSize)!.panelScale);
        setAlignmentMarker(null); setAlignmentSecondMarker(null); setAlignmentThirdMarker(null); setAlignmentSegment(null);
        setAlignmentTriangleSegments(previous => previous.length ? [] : previous); setAlignmentDistanceMarker(null);
        setFloorGrid(previous => previous.length === projected.grid.length && previous.every((edge, index) =>
          !!edge === !!projected.grid[index] && (!edge || edge.flat().every((value, coordinate) => value === projected.grid[index]?.flat()[coordinate]))) ? previous : projected.grid);
        setAlignmentNormalProjection(previous => {
          const values = (value: AlignmentNormalProjection | null) => [...(value?.shaft?.flat() ?? []), ...(value?.head?.flat() ?? [])];
          return !!previous === !!projected.normal && !!previous?.shaft === !!projected.normal?.shaft && !!previous?.head === !!projected.normal?.head &&
            values(previous).every((value, index) => value === values(projected.normal)[index]) ? previous : projected.normal;
        });
        frame = requestAnimationFrame(update); return;
      }
      if (!world || current.alignmentTool === 'floor') return;
      setFloorGrid(previous => previous.length ? [] : previous);
      const marker = projectAlignmentPoint(world, camera.view, camera.projection, bounds.width, bounds.height);
      setAlignmentMarker(previous => previous?.[0] === marker?.[0] && previous?.[1] === marker?.[1] ? previous : marker);
      const second = current.alignmentTool !== 'center' ? current.alignmentSecondPoint : null;
      const third = current.alignmentTool === 'align' ? current.alignmentThirdPoint : null;
      const secondMarker = second ? projectAlignmentPoint(second, camera.view, camera.projection, bounds.width, bounds.height) : null;
      setAlignmentSecondMarker(previous => previous?.[0] === secondMarker?.[0] && previous?.[1] === secondMarker?.[1] ? previous : secondMarker);
      const thirdMarker = third ? projectAlignmentPoint(third, camera.view, camera.projection, bounds.width, bounds.height) : null;
      setAlignmentThirdMarker(previous => previous?.[0] === thirdMarker?.[0] && previous?.[1] === thirdMarker?.[1] ? previous : thirdMarker);
      const segment = second ? projectAlignmentSegment(world, second, camera.view, camera.projection, bounds.width, bounds.height) : null;
      setAlignmentSegment(previous => previous?.flat().every((value, index) => value === segment?.flat()[index]) && !!previous === !!segment ? previous : segment);
      const triangle = second && third ? [projectAlignmentSegment(second, third, camera.view, camera.projection, bounds.width, bounds.height),
        projectAlignmentSegment(third, world, camera.view, camera.projection, bounds.width, bounds.height)] : [];
      setAlignmentTriangleSegments(previous => previous.length === triangle.length && previous.every((edge, index) =>
        !!edge === !!triangle[index] && (!edge || edge.flat().every((value, coordinate) => value === triangle[index]?.flat()[coordinate]))) ? previous : triangle);
      const normal = second && third && current.alignmentNormal ? projectAlignmentNormal(world, second, third, current.alignmentNormal, current.alignmentFlip,
        camera.view, camera.projection, bounds.width, bounds.height, UI_SIZES.find(info => info.size === displayedUiSize)!.panelScale) : null;
      setAlignmentNormalProjection(previous => {
        const values = (value: AlignmentNormalProjection | null) => [...(value?.shaft?.flat() ?? []), ...(value?.head?.flat() ?? [])];
        return !!previous === !!normal && !!previous?.shaft === !!normal?.shaft && !!previous?.head === !!normal?.head &&
          values(previous).every((value, index) => value === values(normal)[index]) ? previous : normal;
      });
      const midpoint = current.alignmentTool === 'scale' && second ? world.map((value, index) => Math.fround(Math.fround(value + second[index]) * .5)) : null;
      const distanceMarker = midpoint ? projectAlignmentPoint(midpoint, camera.view, camera.projection, bounds.width, bounds.height) : null;
      setAlignmentDistanceMarker(previous => previous?.[0] === distanceMarker?.[0] && previous?.[1] === distanceMarker?.[1] ? previous : distanceMarker);
      frame = requestAnimationFrame(update);
    };
    update(); return () => cancelAnimationFrame(frame);
  }, [state.alignmentTool, state.alignmentPoint, state.alignmentSecondPoint, state.alignmentThirdPoint, state.alignmentNormal, state.alignmentFloor, state.alignmentFlip, displayedUiSize, controller]);
  const point = (event: { clientX: number; clientY: number }) => { const r = canvas.current!.getBoundingClientRect(); return [event.clientX - r.left, event.clientY - r.top] as [number, number]; };
  const pressPolygon = (event: SceneMouseInput, pointerId: number) => {
    const current = pointerState();
    if (event.button !== 0 || current.tool !== 'polygon' || !controller.editingAvailable || current.busy && !controller.selectionActive) return;
    if (!event.replayed) canvas.current!.focus();
    // Mouse down carries the native click count. Pointer down always reports
    // zero, so using it for a mouse double-click would append an extra vertex.
    if (event.detail > 1) return finishPolygon();
    const [x, y] = point(event), points = polygonPoints.current;
    if (points.length >= 3 && Math.hypot(x - points[0][0], y - points[0][1]) <= 8) return finishPolygon();
    if (!points.length) {
      void controller.cancelSelectionGesture(false);
      const primary = mac ? event.metaKey : event.ctrlKey;
      const operation = primary ? event.shiftKey ? 3 : 2 : event.shiftKey ? 1 : current.operation;
      if (!controller.beginPolygonGesture(operation, replayOptions.current)) return;
      polygonDeferredOptions.current = replayOptions.current;
      polygonOperation.current = operation;
    }
    const element = canvas.current!, bounds = element.getBoundingClientRect();
    const sx = element.width / bounds.width, sy = element.height / bounds.height;
    const vertex: [number, number] = [Math.round(x * sx) / sx, Math.round(y * sy) / sy], last = points[points.length - 1];
    const acceptedVertex = points.length < 4096 && (!last || last[0] !== vertex[0] || last[1] !== vertex[1]);
    if (acceptedVertex) setPolygonPoints([...points, vertex]);
    setPolygonCursor(vertex); gestureVersion.current++;
    gesture.current = { x, y, button: 0, points: [[x, y]], operation: polygonOperation.current, selection: true,
      pointerId, panMoved: false, clearRevision: null, singleLive: false, singleCancelled: false, singleRestart: 0,
      deferredOptions: polygonDeferredOptions.current, replayedOptions: !!polygonDeferredOptions.current };
    setApp({ selectionDragging: true, selectionOperation: polygonOperation.current });
    if (!event.replayed) setApp({ selectionModifiers: Number(event.shiftKey) | (Number(mac ? event.metaKey : event.ctrlKey) << 1) });
    void controller.updatePolygon(regionCommand('polygon', polygonShape(vertex), polygonOperation.current), acceptedVertex);
  };
  const pointerDown = (event: ScenePointerInput) => {
    if (tutorial.blocksInput(event.nativeEvent)) return;
    if (useApp.getState().operationRecovery !== 'idle') { controller.camera?.clearInput(); return; }
    if (captureDeferredPointer('down', event, event.pointerId, event.pointerType)) return;
    const state = pointerState();
    const current = useApp.getState();
    if (current.transformGizmoMode && current.transform?.kind === 'gizmo' && !current.filter) {
      if (gizmoGesture.current || ![0, 1, 2].includes(event.button)) return;
      const [x, y] = point(event); setGizmoPointer([x, y]);
      const preview = current.transformPreview, widgetMatrix = controller.transformGizmoWidgetMatrix;
      if (event.button === 0 && !(event.buttons & ~1) && current.transform.id !== null && current.transform.baseId !== null &&
        preview?.kind === 'gizmo' && widgetMatrix && controller.transformGizmoControlsEnabled &&
        !document.querySelector('[role="menu"], [role="dialog"]')) {
        const camera = controller.camera, element = canvas.current!, bounds = element.getBoundingClientRect();
        if (camera) try {
          const config = transformGizmoConfig(current.transformGizmoMode, widgetMatrix, preview.pivot,
            bounds.width, bounds.height, UI_SIZES.find(info => info.size === displayedUiSize)!.panelScale,
            current.mode === 'pro' && current.filterLocalAxes, current.filterSnap, [x, y]);
          const frame = camera.transformGizmoFrame(config);
          if (frame?.hitHandle) {
            const session = camera.beginTransformGizmo(config, frame.hitHandle); if (!session) return;
            const token = controller.beginTransformGizmoGesture();
            if (!token) { camera.endTransformGizmo(session); return; }
            gizmoGesture.current = { target: 'transform', token, session, camera, pointerId: event.pointerId, pointer: [x, y],
              mode: current.transformGizmoMode, transformId: current.transform.id, baseId: current.transform.baseId };
            try { element.focus(); element.setPointerCapture(event.pointerId); }
            catch { cancelGizmo(); return; }
            setGizmoHandle(frame.hitHandle); event.preventDefault(); return;
          }
        } catch { cancelGizmo(); return; }
      }
    }
    if (current.filter) {
      if (gizmoGesture.current || filterGesture.current || ![0, 1, 2].includes(event.button)) return;
      const [x, y] = point(event);
      setGizmoPointer([x, y]);
      if (event.button === 0 && !(event.buttons & ~1) && current.filter.id !== null && current.filterGizmoMode && controller.filterGizmoControlsEnabled &&
        !document.querySelector('[role="menu"], [role="dialog"]')) {
        const camera = controller.camera, element = canvas.current!, bounds = element.getBoundingClientRect();
        if (camera) try {
          const config = filterGizmoConfig(current.filter.kind, current.filterGizmoMode, current.filter.parameters,
            bounds.width, bounds.height, UI_SIZES.find(info => info.size === displayedUiSize)!.panelScale,
            current.filterLocalAxes, current.filterSnap, current.filterVolumeVisible, [x, y]);
          const frame = camera.filterGizmoFrame(config);
          if (frame?.hitHandle) {
            const session = camera.beginFilterGizmo(config, frame.hitHandle);
            if (!session) return;
            const token = controller.beginFilterGizmoGesture();
            if (!token) { camera.endFilterGizmo(session); return; }
            gizmoGesture.current = { target: 'filter', token, session, camera, pointerId: event.pointerId, pointer: [x, y],
              mode: current.filterGizmoMode, filterId: current.filter.id, kind: current.filter.kind };
            try { element.focus(); element.setPointerCapture(event.pointerId); }
            catch { cancelGizmo(); return; }
            setGizmoHandle(frame.hitHandle); event.preventDefault(); return;
          }
        } catch { cancelGizmo(); return; }
      }
      if (!controller.cameraNavigationEnabled) return;
      const expectedButtons = event.button === 0 ? 1 : event.button === 1 ? 4 : 2;
      canvas.current!.focus(); canvas.current!.setPointerCapture(event.pointerId); setFilterCaptured(true);
      filterGesture.current = { x, y, lastX: x, lastY: y, pointerId: event.pointerId, button: event.button, moved: false,
        cancelClick: !!(event.buttons & ~expectedButtons), clear: (current.summary?.selected ?? 0) > 0 };
      if (current.filterCenterPicking) setFilterCursor([x, y]);
      return;
    }
    if (current.alignmentTool) {
      if (!(current.alignmentTool === 'floor' ? controller.cameraNavigationEnabled : alignmentControlsEnabled(controller)) || alignmentGesture.current || ![0, 1, 2].includes(event.button)) return;
      const [x, y] = point(event);
      canvas.current!.focus(); canvas.current!.setPointerCapture(event.pointerId);
      const expectedButtons = event.button === 0 ? 1 : event.button === 1 ? 4 : 2;
      alignmentGesture.current = { x, y, lastX: x, lastY: y, button: event.button, pointerId: event.pointerId, moved: false,
        cancelClick: !!(event.buttons & ~expectedButtons) };
      return;
    }
    // Moving the polygon cursor can start a preview immediately before a click.
    // Keep accepting vertices within that gesture while its updates coalesce.
    const releasedClick = event.button === 0 && (state.tool === 'color' || state.tool === 'fill');
    if (event.button === 0 && state.tool && !controller.editingAvailable) return;
    if (state.busy && !controller.selectionActive && !(releasedClick && controller.isReleasedSelectionBusy)) return;
    const [x, y] = point(event); const primary = mac ? event.metaKey : event.ctrlKey;
    if (!event.replayed) canvas.current!.focus();
    if (event.button === 2 && state.tool === 'polygon' && polygonPoints.current.length) { cancelGesture(); return; }
    const operation = primary ? event.shiftKey ? 3 : 2 : event.shiftKey ? 1 : state.operation;
    if (event.button === 0 && state.tool === 'polygon') {
      // Mouse admission uses the following down event's click count. Pen and
      // touch admit directly. No Polygon press captures the pointer.
      if (event.pointerType === 'mouse') polygonMousePointer.current = event.pointerId;
      else return pressPolygon(event, event.pointerId);
      return;
    }
    // A new manual click preserves previously released records. Continuing a
    // polygon retains its own gesture instead of starting another one.
    if (event.button === 0 && state.tool && !(state.tool === 'polygon' && polygonPoints.current.length))
      void controller.cancelSelectionGesture(false);
    const clearRevision = event.button === 2 && state.ready && !gesture.current && event.buttons === 2 && state.summary?.selected &&
      !state.busy && !state.summary.selectionDraft && state.pendingSelectionCount === 0 && !controller.selectionActive ? state.summary.revision : null;
    if (event.button !== 0 || !state.tool) void controller.cancelSelectionGesture();
    const singleLive = event.button === 0 && state.tool === 'single' && state.live;
    const selection = event.button === 0 && (singleLive || ['brush', 'volume', 'rectangle'].includes(state.tool ?? ''));
    if (selection && !controller.beginSelectionGesture(operation, replayOptions.current)) return;
    if (event.button !== 0 && polygonPoints.current.length) cancelGesture();
    if (!event.replayed) canvas.current!.setPointerCapture(event.pointerId);
    gestureVersion.current++;
    gesture.current = { x, y, button: event.button, points: [[x, y]], operation, selection,
      pointerId: event.pointerId, panMoved: false, clearRevision, singleLive, singleCancelled: false, singleRestart: 0,
      replayedOptions: !!replayOptions.current, deferredOptions: replayOptions.current ?? (event.button === 0 && (state.tool === 'color' || state.tool === 'fill') ? {
        tool: state.tool, brushSize: state.brushSize, operation: state.operation, live: state.live, overlap: state.overlap, visibleOnly: state.visibleOnly,
        currentViewOnly: state.currentViewOnly, colorTolerance: state.colorTolerance, fillTolerance: state.fillTolerance, connectedColor: state.connectedColor,
        ...captureSelectionRangePointerOptions(state, canvas.current!.width / canvas.current!.getBoundingClientRect().width),
      } : undefined) };
    // Replay modifiers belong to this captured selection, not the current
    // physical keyboard; a later key release/press must keep its live state.
    if (!event.replayed) setApp({ selectionModifiers: Number(event.shiftKey) | (Number(primary) << 1) });
    if (event.button === 0 && state.tool) setApp({ selectionDragging: true, selectionOperation: state.tool === 'polygon' ? polygonOperation.current : operation });
    if (singleLive) {
      const element = canvas.current!, bounds = element.getBoundingClientRect();
      controller.previewSinglePixel(x * element.width / bounds.width, y * element.height / bounds.height, operation);
    } else if (selection && state.live && state.tool !== 'polygon') controller.previewSelection(regionCommand(state.tool!, [[x, y]], operation));
  };
  const pointerMove = (event: ScenePointerInput) => {
    if (tutorial.blocksInput(event.nativeEvent)) return;
    if (captureDeferredPointer('move', event, event.pointerId, event.pointerType)) return;
    const state = pointerState();
    const gizmo = gizmoGesture.current;
    if (gizmo) {
      if (event.pointerId !== gizmo.pointerId) return;
      if (!(event.buttons & 1) || event.buttons & ~1) { cancelGizmo(); return; }
      updateGizmo(point(event), event.ctrlKey); event.preventDefault(); return;
    }
    const filterStart = filterGesture.current, filterState = useApp.getState();
    if (filterState.transformGizmoMode) setGizmoPointer(point(event));
    if (filterState.filter) {
      const [x, y] = point(event);
      setGizmoPointer([x, y]);
      if (filterState.filterCenterPicking) setFilterCursor([x, y]);
      if (!filterStart || event.pointerId !== filterStart.pointerId || !controller.cameraNavigationEnabled) return;
      const moved = Math.hypot(x - filterStart.x, y - filterStart.y) > 4;
      const expectedButtons = filterStart.button === 0 ? 1 : filterStart.button === 1 ? 4 : 2;
      filterStart.cancelClick ||= !!(event.buttons & ~expectedButtons);
      if (filterStart.button === 2 && (filterStart.moved || moved)) {
        controller.camera?.pan(filterStart.moved ? x - filterStart.lastX : x - filterStart.x, filterStart.moved ? y - filterStart.lastY : y - filterStart.y);
        controller.invalidate();
      } else if (filterStart.button === 1 || !filterState.filterCenterPicking && filterStart.button === 0) {
        controller.camera?.orbit(x - filterStart.lastX, y - filterStart.lastY); controller.invalidate();
      }
      filterStart.moved ||= moved; filterStart.lastX = x; filterStart.lastY = y; return;
    }
    const alignment = alignmentGesture.current;
    if (alignment) {
      const current = useApp.getState();
      if (event.pointerId !== alignment.pointerId || !current.alignmentTool || current.alignmentTool === 'floor' && !controller.cameraNavigationEnabled) return;
      const [x, y] = point(event), moved = Math.hypot(x - alignment.x, y - alignment.y) > 4;
      const expectedButtons = alignment.button === 0 ? 1 : alignment.button === 1 ? 4 : 2;
      alignment.cancelClick ||= !!(event.buttons & ~expectedButtons);
      if (alignment.button === 1 || current.alignmentTool === 'floor' && alignment.button === 0) {
        if (current.alignmentTool === 'floor' && current.fly) controller.camera?.look(x - alignment.lastX, y - alignment.lastY);
        else controller.camera?.orbit(x - alignment.lastX, y - alignment.lastY);
        controller.invalidate();
      }
      else if (alignment.button === 2 && (alignment.moved || moved)) {
        controller.camera?.pan(alignment.moved ? x - alignment.lastX : x - alignment.x, alignment.moved ? y - alignment.lastY : y - alignment.y); controller.invalidate();
      }
      alignment.moved ||= moved; alignment.lastX = x; alignment.lastY = y; return;
    }
    if (useApp.getState().alignmentTool) return;
    const start = gesture.current, [x, y] = point(event);
    if (state.tool === 'polygon' && polygonPoints.current.length) {
      const element = canvas.current!, bounds = element.getBoundingClientRect(), sx = element.width / bounds.width, sy = element.height / bounds.height;
      const cursor: [number, number] = [Math.round(x * sx) / sx, Math.round(y * sy) / sy];
      setPolygonCursor(cursor);
      void controller.updatePolygon(regionCommand('polygon', polygonShape(cursor), polygonOperation.current));
      if (start?.button === 0) { start.x = x; start.y = y; return; }
    }
    if (!start) return;
    let completion: Promise<boolean> | undefined;
    if (start.button === 2 && (event.buttons & 5)) start.clearRevision = null;
    if (state.tool && start.button === 0) {
      if (state.tool === 'brush' || state.tool === 'volume') start.points.push([x, y]);
      else if (state.tool === 'rectangle') {
        start.points = [start.points[0], [x, y]]; setRectangle([start.points[0][0], start.points[0][1], x, y]);
      }
      if (start.singleLive) {
        if (!start.singleCancelled && Math.hypot(x - start.points[0][0], y - start.points[0][1]) > 5) {
          start.singleCancelled = true; completion = controller.cancelSelectionGesture();
        }
      } else if (start.selection && state.live && state.tool !== 'polygon') controller.previewSelection(regionCommand(state.tool, start.points, start.operation));
    } else {
      const dx = x - start.x, dy = y - start.y;
      if (start.button === 2) {
        const origin = start.points[0];
        if (start.panMoved || Math.hypot(x - origin[0], y - origin[1]) > 4) {
          controller.camera?.pan(start.panMoved ? dx : x - origin[0], start.panMoved ? dy : y - origin[1]);
          start.panMoved = true; controller.invalidate();
        }
      }
      else if (state.fly) controller.camera?.look(dx, dy);
      else controller.camera?.orbit(dx, dy);
      if (start.button !== 2) controller.invalidate();
    }
    start.x = x; start.y = y;
    return completion;
  };
  const pointerUp = (event: ScenePointerInput) => {
    if (tutorial.blocksInput(event.nativeEvent)) return;
    if (captureDeferredPointer('up', event, event.pointerId, event.pointerType)) return;
    const state = pointerState();
    const gizmo = gizmoGesture.current;
    if (gizmo) {
      if (event.pointerId !== gizmo.pointerId) return;
      if (event.button !== 0 || event.buttons !== 0) { cancelGizmo(); return; }
      if (!updateGizmo(point(event), event.ctrlKey)) return;
      gizmoGesture.current = null; setGizmoHandle(0);
      if (gizmo.target === 'filter') {
        if (!controller.finishFilterGizmoGesture(gizmo.token)) controller.cancelFilterGizmoGesture(gizmo.token, true);
        try { gizmo.camera.endFilterGizmo(gizmo.session); } catch { /* Session may already be retired. */ }
      } else {
        try { gizmo.camera.endTransformGizmo(gizmo.session); } catch { /* Session may already be retired. */ }
        void controller.finishTransformGizmoGesture(gizmo.token).then(accepted => {
          if (!accepted) controller.cancelTransformGizmoGesture(gizmo.token, true);
        }).catch(() => controller.cancelTransformGizmoGesture(gizmo.token, true));
      }
      if (canvas.current?.hasPointerCapture(gizmo.pointerId)) canvas.current.releasePointerCapture(gizmo.pointerId);
      event.preventDefault(); return;
    }
    const filterStart = filterGesture.current;
    if (filterStart) {
      if (event.pointerId !== filterStart.pointerId) return;
      filterGesture.current = null; setFilterCaptured(false);
      const current = useApp.getState(), [x, y] = point(event), element = canvas.current!, bounds = element.getBoundingClientRect();
      if (!current.filter) return;
      const moved = filterStart.moved || Math.hypot(x - filterStart.x, y - filterStart.y) > 4;
      const inside = x >= 0 && y >= 0 && x < bounds.width && y < bounds.height;
      if (filterStart.button === 2 && moved) {
        controller.camera?.pan(filterStart.moved ? x - filterStart.lastX : x - filterStart.x, filterStart.moved ? y - filterStart.lastY : y - filterStart.y); controller.invalidate();
      } else if (filterStart.button === 2 && event.button === 2 && inside && !filterStart.cancelClick && !(event.buttons & 5)) {
        if (current.filterCenterPicking) controller.cancelFilterCenterPick(); else void controller.rightClickFilter(filterStart.clear);
      } else if (filterStart.button === 0 && event.button === 0 && !moved && !filterStart.cancelClick && inside && current.filterCenterPicking) {
        void controller.pickFilterCenter(x * element.width / bounds.width, y * element.height / bounds.height);
      }
      return;
    }
    const alignment = alignmentGesture.current;
    if (alignment) {
      if (alignment.pointerId !== event.pointerId) return;
      alignmentGesture.current = null;
      const current = useApp.getState(), [x, y] = point(event), element = canvas.current!, bounds = element.getBoundingClientRect();
      if (!current.alignmentTool) return;
      if (current.alignmentTool === 'floor' && !controller.cameraNavigationEnabled) return;
      const moved = alignment.moved || Math.hypot(x - alignment.x, y - alignment.y) > 4;
      const inside = x >= 0 && y >= 0 && x < bounds.width && y < bounds.height;
      if (alignment.button === 2 && moved) {
        controller.camera?.pan(alignment.moved ? x - alignment.lastX : x - alignment.x, alignment.moved ? y - alignment.lastY : y - alignment.y); controller.invalidate();
      } else if (alignment.button === 2 && event.button === 2 && inside && !alignment.cancelClick && !(event.buttons & 5)) {
        if (current.alignmentTool !== 'floor' && (current.alignmentPoint || current.alignmentSecondPoint || current.alignmentThirdPoint || current.alignmentPicking)) controller.clearAlignmentPoints(); else controller.cancelAlignment();
      } else if (current.alignmentTool !== 'floor' && alignment.button === 0 && event.button === 0 && !moved && !alignment.cancelClick && inside && alignmentControlsEnabled(controller)) {
        void controller.pickAlignmentPoint(x * element.width / bounds.width, y * element.height / bounds.height);
      }
      return;
    }
    if (useApp.getState().alignmentTool) return;
    const start = gesture.current;
    if (!start || start.pointerId !== event.pointerId) return;
    const [x, y] = point(event), bounds = canvas.current!.getBoundingClientRect();
    if (start.button === 0 && state.tool === 'polygon') { gesture.current = null; return; }
    if (start.button === 2 && event.button === 2) {
      // Release can be the first event beyond the desktop's four-pixel limit.
      const origin = start.points[0], moved = start.panMoved || Math.hypot(x - origin[0], y - origin[1]) > 4;
      if (moved) {
        controller.camera?.pan(start.panMoved ? x - start.x : x - origin[0], start.panMoved ? y - start.y : y - origin[1]);
        controller.invalidate();
      }
      const inside = (position: number[]) => position[0] >= 0 && position[1] >= 0 && position[0] < bounds.width && position[1] < bounds.height;
      const current = useApp.getState();
      const clear = current.ready && !moved && start.clearRevision !== null && current.summary?.revision === start.clearRevision &&
        !current.busy && !current.summary?.selectionDraft && !controller.selectionActive && !(event.buttons & 5) && inside(origin) && inside([x, y]);
      gesture.current = null; setRectangle(null);
      if (clear) void controller.command({ command: 'selectNone' });
      return;
    }
    gesture.current = null; setRectangle(null); if (start.button !== 0 || !state.tool) return;
    if (state.tool !== 'polygon') setApp({ selectionOperation: null });
    if (state.tool === 'color' || state.tool === 'fill') {
      const version = gestureVersion.current;
      const deferredToken = event.replayed ? deferredPointer.current?.token : undefined;
      // The click is complete even when its contributor/surface is pending.
      // Desktop tolerance entry then belongs to that released request.
      setApp({ selectionDragging: false });
      void controller.cancelSelectionGesture(false);
      return (async () => {
        try {
          if (Math.hypot(x - start.points[0][0], y - start.points[0][1]) <= 5) {
            const px = x * canvas.current!.width / bounds.width, py = y * canvas.current!.height / bounds.height;
            if (state.tool === 'fill') await controller.fillPixel(px, py, start.operation, start.deferredOptions, deferredToken);
            else await controller.selectColorPixel(px, py, start.operation, start.deferredOptions, deferredToken);
          }
        } finally { if (gestureVersion.current === version) setApp({ selectionDragging: false }); }
      })();
    }
    if (state.tool === 'single') {
      const version = gestureVersion.current;
      const deferredToken = event.replayed ? deferredPointer.current?.token : undefined;
      return (async () => {
        try {
          if (Math.hypot(x - start.points[0][0], y - start.points[0][1]) > 5) { if (start.singleLive) await controller.cancelSelectionGesture(); return; }
          const px = x * canvas.current!.width / bounds.width, py = y * canvas.current!.height / bounds.height;
          if (!start.singleLive) { await controller.selectPixel(px, py, start.operation, deferredToken); return; }
          if (start.singleCancelled) {
            await controller.cancelSelectionGesture();
            if (gestureVersion.current !== version || useApp.getState().tool !== 'single' || !controller.beginSelectionGesture(start.operation, start.deferredOptions)) return;
          }
          const element = canvas.current!, [pressX, pressY] = start.points[0];
          const stationary = Math.floor(px) === Math.floor(pressX * element.width / bounds.width) &&
            Math.floor(py) === Math.floor(pressY * element.height / bounds.height);
          if (stationary && !start.singleCancelled) await controller.confirmSelectionGesture();
          else await controller.finishSinglePixel(px, py, start.operation);
        } finally { if (gestureVersion.current === version) setApp({ selectionDragging: false }); }
      })();
    }
    if (start.selection) {
      const version = gestureVersion.current;
      return controller.finishSelectionGesture(regionCommand(state.tool, [...start.points, [x, y]], start.operation)).finally(() => {
        if (gestureVersion.current === version) setApp({ selectionDragging: false });
      });
    }
  };
  const mouseDown = (event: SceneMouseInput) => {
    if (tutorial.blocksInput(event.nativeEvent)) return;
    if (useApp.getState().operationRecovery !== 'idle') return;
    if (captureDeferredPointer('mouse-down', event, deferredPointer.current?.lastPointer ?? 0)) return;
    const pointerId = polygonMousePointer.current; polygonMousePointer.current = null;
    if (pointerId !== null) return pressPolygon(event, pointerId);
  };
  const doubleClick = (event: SceneMouseInput) => {
    if (tutorial.blocksInput(event.nativeEvent)) return;
    if (useApp.getState().operationRecovery !== 'idle') return;
    if (captureDeferredPointer('double', event, deferredPointer.current?.lastPointer ?? 0)) return;
    const state = pointerState();
    const current = useApp.getState();
    if (current.alignmentTool && (current.alignmentTool !== 'floor' || !controller.floorCandidateReady)) return;
    if (state.tool === 'polygon') return finishPolygon();
    if (state.tool || state.busy || !controller.editingAvailable) return;
    const [x, y] = point(event), element = canvas.current!, bounds = element.getBoundingClientRect();
    controller.camera?.clearInput(); void controller.focusPixel(x * element.width / bounds.width, y * element.height / bounds.height);
  };
  replayHandlers.current = { down: pointerDown, move: pointerMove, up: pointerUp, mouse: mouseDown, double: doubleClick };
  const selectionBlocked = state.selectionRecovery !== 'idle';
  const memoryBlocked = state.memoryOverageBytes > 0;
  const geometrySource = !!state.summary && state.summary.kind !== 0;
  const operationBlocked = state.operationRecovery !== 'idle';
  const progressStage = state.operationRecovery === 'checking' ? 'Checking the edit result' : state.stage;
  const operationRecoveryMessage = state.operationRecoveryCommitted
    ? 'The edit is committed. Restore graphics to continue.'
    : 'The edit result is unknown. Editing, opening and saving are paused until recovery completes.';
  const disabled = !state.summary || state.busy || selectionBlocked || operationBlocked || controller.filterActive;
  const navigationDisabled = !state.summary || !controller.cameraNavigationEnabled || selectionBlocked || operationBlocked;
  const saveDisabled = !state.summary || geometrySource || selectionBlocked || operationBlocked || memoryBlocked || controller.filterActive || state.busy && !controller.isReleasedSelectionBusy;
  const chromeVisible = !!(tutorial.active || chrome || state.busy || selectionBlocked || operationBlocked || memoryBlocked || state.pendingSelectionCount > 0 || state.summary?.selectionDraft || state.settingsOpen || state.exportOpen || state.navigationPrompt || state.outputPending || state.savedViewChoices.length > 0);
  const manualFeedbackEnabled = !!state.summary && !geometrySource && state.ready && state.rendererState === 'ready' &&
    !selectionBlocked && !operationBlocked && !memoryBlocked && !state.filter && !state.alignmentTool && !state.transformGizmoMode && !tutorial.active &&
    (!state.busy || controller.selectionActive || controller.isReleasedSelectionBusy);
  const polygonEditable = manualFeedbackEnabled && !!polygon.length && !deferredInputPending && (!state.busy || controller.selectionActive);
  const polygonActions: PolygonActions = { count: polygon.length, closeEnabled: polygonEditable && polygon.length >= 3, editEnabled: polygonEditable,
    close: () => { void finishPolygon(); canvas.current?.focus({ preventScroll: true }); },
    previous: () => { previousPolygonPoint(); canvas.current?.focus({ preventScroll: true }); },
    cancel: () => { void cancelGesture(); canvas.current?.focus({ preventScroll: true }); } };
  const manualFinishEnabled = manualFeedbackEnabled && !state.selectionActionPending && !deferredInputPending && (state.tool === 'polygon' && polygon.length >= 3
    ? true : !polygon.length && controller.manualSelectionFinishEnabled);
  const manualUndoEnabled = manualFeedbackEnabled && !state.selectionActionPending && !deferredInputPending && (polygon.length > 0 || controller.manualSelectionUndoEnabled);
  const manualClearEnabled = manualFeedbackEnabled && !state.selectionActionPending && !deferredInputPending && (polygon.length > 0 || controller.manualSelectionClearEnabled);
  const effectiveSelectionOperation = state.selectionOperation ?? ((state.selectionModifiers & 2) ? (state.selectionModifiers & 1) ? 3 : 2 : (state.selectionModifiers & 1) ? 1 : state.operation);
  const copyConfirmed = !!copied && copied.client === controller.client && copied.scene === controller.scene && !!state.summary && state.ready && !state.busy && state.rendererState === 'ready';
  const toolsVisible = tutorial.step?.tools ?? (!geometrySource && state.toolsOpen);
  const emptyState = useRef<HTMLDivElement>(null);
  const wasTutorial = useRef(false);
  useEffect(() => {
    const tutorialTransition = tutorial.active || wasTutorial.current;
    wasTutorial.current = tutorial.active;
    if (tutorialTransition) return;
    if (!state.toolsOpen) clearFilterPointer(true);
    else if (!chromeVisible) clearFilterPointer(!useApp.getState().transformGizmoMode);
  }, [chromeVisible, state.toolsOpen, controller, tutorial.active]);
  useLayoutEffect(() => {
    const shell = canvas.current?.parentElement; if (!shell) return;
    const scale = UI_SIZES.find(size => size.size === displayedUiSize)!.panelScale;
    const controls = Array.from(shell.querySelectorAll<HTMLElement>('[data-chrome], .panel, .dialog-backdrop, .alignment-popup'))
      .filter(element => !element.classList.contains('collection-arrow'));
    const update = () => {
      const bounds = shell.getBoundingClientRect();
      // Native toolbar groups round each actual row, including nested display controls.
      for (const group of shell.querySelectorAll<HTMLElement>('.toolbar-group')) {
        const buttons = Array.from(group.querySelectorAll<HTMLElement>('.icon-button'));
        const rows = buttons.map(button => button.getBoundingClientRect().top);
        buttons.forEach((button, index) => {
          button.toggleAttribute('data-row-start', index === 0 || Math.abs(rows[index] - rows[index - 1]) > 1);
          button.toggleAttribute('data-row-end', index === buttons.length - 1 || Math.abs(rows[index] - rows[index + 1]) > 1);
        });
      }
      const empty = emptyState.current, actions = empty?.querySelector<HTMLElement>('.empty-actions');
      if (empty && actions) {
        // Read natural button geometry in the active font/language, then share
        // the larger width. No text metrics or viewport-size guesses are used.
        const buttons = Array.from(actions.querySelectorAll<HTMLButtonElement>('button'));
        buttons.forEach(button => { button.style.width = 'max-content'; });
        const naturalWidth = Math.max(154, ...buttons.map(button => button.getBoundingClientRect().width));
        const available = Math.max(1, bounds.width - 24);
        buttons.forEach(button => { button.style.width = `${Math.min(naturalWidth, available)}px`; });
        actions.dataset.stacked = String(2 * naturalWidth + 6 > available);
        const content = empty.getBoundingClientRect(), actionBounds = actions.getBoundingClientRect();
        const footer = shell.querySelector<HTMLElement>('.brand-link')?.getBoundingClientRect();
        const overlapsFooter = footer && actionBounds.left < footer.right && actionBounds.right > footer.left;
        const bottom = overlapsFooter ? footer.top - bounds.top - 6 : bounds.height - 12;
        const toolbar = shell.querySelector<HTMLElement>('.toolbar')?.getBoundingClientRect();
        const top = Math.min((toolbar ? toolbar.bottom - bounds.top : 12) + 8, Math.max(12, bottom - content.height));
        empty.style.top = `${Math.max(12, top + (bottom - top - content.height) / 2)}px`;
      }
      const rectangles = controls.filter(element => element.getClientRects().length > 0).map(element => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left - bounds.left, right: rect.right - bounds.left, top: rect.top - bounds.top, bottom: rect.bottom - bounds.top };
      });
      const next = collectionArrowVisibility(bounds.width, bounds.height, scale, rectangles);
      setArrowSpace(previous => previous[0] === next[0] && previous[1] === next[1] ? previous : next);
    };
    update(); const observer = new ResizeObserver(update); observer.observe(shell); controls.forEach(element => observer.observe(element));
    shell.querySelectorAll('.toolbar-group').forEach(group => observer.observe(group));
    if (emptyState.current) observer.observe(emptyState.current);
    window.addEventListener('resize', update);
    return () => { observer.disconnect(); window.removeEventListener('resize', update); };
  }, [displayedUiSize, state.toolsOpen, state.settingsOpen, state.exportOpen, state.navigationPrompt, state.outputPending,
    state.savedViewChoices.length, state.error, state.busy, state.alignmentTool, state.viewStatus, state.collectionCount, chromeVisible, t]);
  const arrowsVisible = !tutorial.active && !(state.toolsOpen && !geometrySource) && !!state.summary && !state.settingsOpen &&
    !state.exportOpen && !state.navigationPrompt && !state.savedViewChoices.length;
  return <main inert={tutorial.active} style={uiSizeStyle(displayedUiSize)} data-ui-size={displayedUiSize} data-scene-ready={!!state.summary} className={`viewport-shell ${chromeVisible ? '' : 'chrome-hidden'}`} onDragOver={event => event.preventDefault()}
    onDrop={event => { event.preventDefault(); if (tutorial.blocksInput(event.nativeEvent) || useApp.getState().operationRecovery !== 'idle') return; const snapshot = controller.snapshotDrop(event.dataTransfer); if (snapshot) void controller.openDrop(snapshot); }}>
    <canvas key={canvasGeneration} ref={bindCanvas} data-graphics-backend={state.graphicsBackend ?? undefined} aria-label={t("SplatView scene")} aria-describedby={instructionsId}
      aria-busy={state.busy || operationBlocked || state.selectionDragging || state.selectionRecovery === 'restoring' || state.rendererState === 'recovering'} data-navigation={state.fly ? 'look' : 'orbit'} tabIndex={0} onContextMenu={event => event.preventDefault()} onPointerDown={pointerDown}
      onMouseDown={mouseDown}
      onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerLeave={() => { if (!gizmoGesture.current) setGizmoPointer(null); }} onDoubleClick={doubleClick}
      onPointerCancel={() => { if (tutorial.blocksInput()) return; clearFilterPointer(); cancelGesture(); controller.cancelAlignment(); }} onLostPointerCapture={event => {
        if (tutorial.blocksInput()) return;
        const owner = deferredPointer.current;
        if (owner) {
          if (owner.physicalPointer === event.pointerId && !canvas.current?.hasPointerCapture(event.pointerId)) cancelGesture();
          return;
        }
        if (gizmoGesture.current) cancelGizmo();
        if (filterGesture.current) { filterGesture.current = null; setFilterCaptured(false); }
        if (alignmentGesture.current) { alignmentGesture.current = null; controller.cancelAlignment(); }
        if (gesture.current && useApp.getState().tool !== 'polygon') cancelGesture();
      }} />
    <SceneAccessibility instructionsId={instructionsId} suspended={tutorial.active} />
    <ViewportGuidesOverlay controller={controller} scene={canvas} mode={guides} />
    <input ref={picker} type="file" multiple hidden aria-label={t("Open scene files")}
      onChange={event => { pickerActive.current = false; tutorial.notifyIdle(); if (!tutorial.blocksInput(event.nativeEvent) && useApp.getState().operationRecovery === 'idle' && event.target.files?.length) void controller.openFiles(event.target.files); event.target.value = ''; }} />
    <input ref={folderPicker} type="file" multiple hidden aria-label={t("Open scene folder")} {...{ webkitdirectory: '', directory: '' }}
      onChange={event => { pickerActive.current = false; tutorial.notifyIdle(); if (!tutorial.blocksInput(event.nativeEvent) && useApp.getState().operationRecovery === 'idle' && event.target.files?.length) void controller.openFolder(event.target.files); event.target.value = ''; }} />
    <input ref={viewPicker} type="file" hidden accept=".zip,.splatview-view.zip" aria-label={t("Import saved view")}
      onChange={event => { pickerActive.current = false; tutorial.notifyIdle(); const file = event.target.files?.[0]; event.target.value = ''; if (file && !tutorial.blocksInput(event.nativeEvent) && useApp.getState().operationRecovery === 'idle') void controller.importSavedView(file); }} />
    <div className={`toolbar ${toolsVisible ? 'with-tools' : ''}`} role="toolbar" aria-label={t("Scene controls")} inert={!chromeVisible} aria-hidden={!chromeVisible || undefined} data-chrome>
      <div className="toolbar-group" role="group" aria-label={t("Scene files")}>
      <IconButton buttonRef={openButton} tutorialTarget="open" icon="Folder" label="Open scene" hint={t('Memory and GPU limits apply')} disabled={!state.ready || state.busy || selectionBlocked || operationBlocked || memoryBlocked || state.navigationPrompt} onClick={() => requestPicker(picker)} />
      <IconButton tutorialTarget="save" icon="Save" label="Save scene" active={!!state.toolbarFeedback.save} hint={state.toolbarFeedback.save?.message}
        disabled={saveDisabled} onClick={() => { cancelGesture(false); setApp({ exportOpen: true }); }} />
      <IconButton tutorialTarget="capture" icon="Camera" label="Capture image" active={!!state.toolbarFeedback.capture} hint={state.toolbarFeedback.capture?.message}
        disabled={disabled || memoryBlocked} onClick={() => void controller.snapshot()} />
      <IconButton tutorialTarget="capture" icon="CopyImage" label="Copy image" active={copyConfirmed} hint={copyConfirmed ? 'Copied view to clipboard' : 'Copy view to clipboard (Ctrl+C)'} disabled={disabled || memoryBlocked} onClick={copyImage} />
      </div>
      <div className="toolbar-group" role="group" aria-label={t("View navigation")}>
      <IconButton tutorialTarget="navigation" icon="Reset" label="Reset camera" disabled={navigationDisabled} onClick={() => controller.resetCamera()} />
      <IconButton tutorialTarget="navigation" icon={state.fly ? 'Fly' : 'Orbit'} label="Orbit / Look" active={!state.tool && !state.alignmentTool} disabled={navigationDisabled} onClick={() => {
        const current = useApp.getState();
        controller.cancelAlignment(); controller.camera?.clearInput();
        // Desktop's navigation action returns an armed manual tool to Orbit.
        setApp({ fly: !current.fly && current.tool === null, autoOrbit: false, tool: null });
      }} />
      <IconButton tutorialTarget="auto-rotate" icon="AutoRotate" label="Auto orbit" active={state.autoOrbit} disabled={navigationDisabled} onClick={() => { if (useApp.getState().alignmentTool !== 'floor') controller.cancelAlignment(); controller.camera?.clearInput(); setApp({ autoOrbit: !state.autoOrbit, fly: false, tool: null }); controller.invalidate(); }} />
      <IconButton tutorialTarget="auto-rotate" icon="FlipUp" label="Flip up" disabled={navigationDisabled} onClick={() => { controller.camera?.flipUp(); controller.invalidate(); }} />
      <div className="viewport-display-controls" role="group" aria-label={t("Guides and background")}>
      <IconButton tutorialTarget="guides" icon="Axes" label="Viewport guides" active={guides !== 'none'} disabled={!state.summary || state.rendererState !== 'ready'}
        hint={t(viewportGuidesTooltip(guides))} onClick={() => setGuides(nextViewportGuides)} />
      <BackgroundButton value={state.background} disabled={!state.summary || state.rendererState !== 'ready'} onClick={() => controller.cycleBackground()} />
      </div>
      </div>
      <div className="toolbar-group" role="group" aria-label={t("Lens and display")}>
      <IconButton tutorialTarget="lens" icon="ZoomIn" label="Narrower lens" disabled={navigationDisabled} onClick={() => { controller.camera?.lens(-5); controller.invalidate(); }} />
      <IconButton tutorialTarget="lens" icon="ZoomOut" label="Wider lens" disabled={navigationDisabled} onClick={() => { controller.camera?.lens(5); controller.invalidate(); }} />
      <IconButton tutorialTarget="lens" icon={fullscreen ? 'ExitFullscreen' : 'Fullscreen'} label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'} active={fullscreen} onClick={() => void controller.fullscreen()} />
      </div>
      <div className="toolbar-group" role="group" aria-label={t("Viewer panel")}>
      {geometrySource ? <IconButton icon="Settings" label="Settings" onClick={() => setApp({ settingsOpen: true })} /> :
        <IconButton tutorialTarget="tools" icon="Tools" label="Tools" active={state.toolsOpen} onClick={() => void (async () => {
          const current = useApp.getState();
          if (current.toolsOpen && controller.opacityActive && !await controller.endOpacitySession(true)) return;
          setApp({ toolsOpen: !current.toolsOpen });
        })()} />}
      <OfflineUpdateNotice disabled={tutorial.active || aboutOpen || state.navigationPrompt || state.outputPending || state.exportOpen || state.settingsOpen}
        onOpen={() => { setChrome(true); setSettingsTab('help'); setApp({ settingsOpen: true }); }} />
      </div>
    </div>
    {arrowsVisible && ([-1, 1] as const).map((direction, index) => {
      const path = direction < 0 ? controller.previousAssetPath : controller.nextAssetPath;
      if (!path || !arrowSpace[index]) return null;
      const label = direction < 0 ? 'Previous asset' : 'Next asset', shortcut = direction < 0 ? 'PageUp' : 'PageDown';
      return <button key={direction} type="button" className={`icon-button collection-arrow ${direction < 0 ? 'previous' : 'next'}`} data-chrome inert={!chromeVisible} aria-hidden={!chromeVisible || undefined}
        aria-label={t(label)} aria-keyshortcuts={shortcut} disabled={!controller.collectionNavigationAvailable}
        onClick={() => { cancelGesture(); canvas.current?.focus(); void controller.adjacent(direction); }}>
        <svg aria-hidden="true" viewBox="0 0 36 64"><polyline points={direction < 0 ? '22,24 14,32 22,40' : '14,24 22,32 14,40'} /></svg>
        <span className="collection-tooltip" role="tooltip"><span>{t(label)} ({direction < 0 ? 'PgUp' : 'PgDn'})</span><span>{path}</span></span>
      </button>;
    })}
    {!state.summary && !state.busy && <div ref={emptyState} className="empty-state">
      <p>{t("Drop a Gaussian splat file to begin.")}</p>
      <div className="empty-actions" inert={!chromeVisible}>
        <button type="button" className="primary-open" aria-label={t("Choose a scene file")} title={t('Memory and GPU limits apply')}
          disabled={!state.ready || selectionBlocked || operationBlocked || memoryBlocked || state.navigationPrompt} onClick={() => requestPicker(picker)}><Icon name="Folder" /><span>{t("Open scene")}</span></button>
        <button type="button" className="secondary-open" disabled={!state.ready || selectionBlocked || operationBlocked || memoryBlocked || state.navigationPrompt}
          onClick={() => { if (!tutorial.blocksInput()) void controller.openExample(); }}><Icon name="Tutorial" /><span>{t("Open example")}</span></button>
      </div>
    </div>}
    <a className="brand-link" data-chrome inert={!chromeVisible} aria-hidden={!chromeVisible || undefined} href="https://opsiclear.com" target="_blank" rel="noopener noreferrer" aria-label={t("OpsiClear website")}>
      <img className="brand" src={new URL('opsiclear.png', new URL(import.meta.env.BASE_URL, document.baseURI)).href} alt="" /></a>
    {/* The read-only tour projects Tools without opening the actual editor. */}
    {(!geometrySource && state.toolsOpen || tutorial.phase === 'tour' && (!geometrySource || tutorial.step?.tools)) && <ToolsPanel controller={controller} scene={canvas} chromeVisible={chromeVisible} autoMethod={autoMethod} visible={toolsVisible} tutorialStep={tutorial.step ?? undefined}
      retention={toolsRetention.current} polygon={polygonActions} onInputScopeChange={onInputScopeChange} onAutoMethod={method => setAutoChoice({ documentId, method })} />}
    <AlignmentOverlay controller={controller} scene={canvas} marker={alignmentMarker} secondMarker={alignmentSecondMarker}
      thirdMarker={alignmentThirdMarker} segment={alignmentSegment} triangleSegments={alignmentTriangleSegments}
      normalProjection={alignmentNormalProjection} distanceMarker={alignmentDistanceMarker} floorGrid={floorGrid} />
    {state.filter && state.filterGizmoMode && <FilterGizmo camera={controller.camera} scene={canvas} kind={state.filter.kind}
      mode={state.filterGizmoMode} parameters={state.filter.parameters} local={state.filterLocalAxes} snap={state.filterSnap}
      showVolume={state.filterVolumeVisible} pointer={gizmoPointer} capturedHandle={gizmoHandle} enabled={controller.filterGizmoControlsEnabled} />}
    {!state.filter && state.transformGizmoMode && state.transformPreview?.kind === 'gizmo' && <TransformGizmo camera={controller.camera}
      scene={canvas} mode={state.transformGizmoMode} widgetMatrix={controller.transformGizmoWidgetMatrix} pivot={state.transformPreview.pivot}
      local={state.mode === 'pro' && state.filterLocalAxes} snap={state.filterSnap} pointer={gizmoPointer} capturedHandle={gizmoHandle} enabled={controller.transformGizmoControlsEnabled} />}
    {state.transformGizmoMode && <TransformGizmoActions key={`transform-actions:${controller.client?.revision.documentId ?? 'empty'}:${state.transformGizmoMode}`}
      scene={canvas} enabled={controller.transformGizmoActionsVisible} captured={state.transformGizmoDragging || gizmoGesture.current?.target === 'transform'}
      chromeVisible={chromeVisible && !tutorial.active && !selectionBlocked && !operationBlocked && !memoryBlocked && state.ready && state.toolsOpen}
      scale={UI_SIZES.find(info => info.size === displayedUiSize)!.panelScale}
      finishEnabled={controller.transformGizmoFinishEnabled} undoEnabled={controller.transformGizmoUndoEnabled} cancelEnabled={controller.transformGizmoCancelEnabled}
      onFinish={() => void runTransformGizmoAction(() => controller.finishTransformGizmo(), true)} onUndo={() => void undoGizmoSession()} onCancel={() => void cancelGizmoSession()} />}
    {state.filter && <FilterOverlay key={`filter-overlay:${documentId ?? 'empty'}`} kind={state.filter.kind} parameters={state.filter.parameters} camera={controller.camera} scene={canvas}
      showVolume={state.filterVolumeVisible && !state.filterGizmoMode} picking={state.filterCenterPicking} pending={state.filterCenterPending} cursor={filterCursor}
      captured={filterCaptured || state.filterGizmoDragging} chromeVisible={chromeVisible && !tutorial.active && !selectionBlocked && !operationBlocked && !memoryBlocked && state.ready}
      finishEnabled={!state.selectionActionPending && controller.filterFinishEnabled} undoEnabled={!state.selectionActionPending && controller.filterUndoEnabled} clearEnabled={!state.selectionActionPending && controller.filterClearEnabled}
      onConfirm={() => void controller.confirmFilter()} onUndo={() => void controller.undoFilterSelection()} onClear={() => void controller.clearFilterSelection()} />}
    <ManualSelectionFeedback key={`manual-feedback:${documentId ?? 'empty'}`} scene={canvas} tool={state.tool} operation={effectiveSelectionOperation} radius={state.brushSize / 2}
      enabled={manualFeedbackEnabled} chromeVisible={chromeVisible} actionsVisible={polygon.length > 0 || controller.manualSelectionActionsVisible}
      finishEnabled={manualFinishEnabled} undoEnabled={manualUndoEnabled} clearEnabled={manualClearEnabled}
      scale={UI_SIZES.find(info => info.size === displayedUiSize)!.panelScale} geometry={() => ({ rectangle, polygon: state.tool === 'polygon' ? polygonShape() : [], vertices: polygonPoints.current,
        trail: (state.tool === 'brush' || state.tool === 'volume') && gesture.current?.button === 0 ? gesture.current.points : [],
        radius: (gesture.current?.deferredOptions?.brushSize ?? state.brushSize) / 2 })}
      onFinish={() => void finishManualSelection()} onUndo={() => void undoManualSelection()} onClear={() => void clearManualSelection()} />
    <span className="sr-only" role="status" aria-label={t('Copy image')}>{copyConfirmed ? t('Copied view to clipboard') : ''}</span>
    {state.busy && !(state.alignmentTool === 'floor' && ['detecting', 'cancelling'].includes(state.alignmentFloor?.phase ?? '')) && <div className="status panel"><span>{t(progressStage)}</span><progress aria-label={t(progressStage) || t('Scene status')} max="1" value={state.progress} />{!operationBlocked && <button onClick={() => controller.cancelOperation()}>{t("Cancel")}</button>}</div>}
    {(state.error || state.selectionRecovery === 'required' || state.operationRecovery === 'required' || memoryBlocked) && <div className="error-banner panel" role="alert" data-memory-overage={memoryBlocked || undefined} data-operation-recovery={state.operationRecovery === 'required' || undefined}><span>{memoryBlocked ? t('This scene retains more memory than the scene budget. Editing, opening and saving are paused. Close the scene to release its memory; retrying graphics cannot reclaim it.') : state.operationRecovery === 'required' ? t(operationRecoveryMessage) : state.error ? translateStatus(state.error, locale) : t('Selection could not be restored. Editing and saving are paused.')}</span>
      {state.operationRecovery === 'required' && <button onClick={() => void controller.retryOperationRecovery()}>{t('Retry edit recovery')}</button>}
      {memoryBlocked && <button disabled={state.navigationPrompt || !state.summary || operationBlocked} onClick={() => void controller.closeScene()}>{t("Close scene")}</button>}
      {selectionBlocked && !memoryBlocked && <button disabled={state.selectionRecovery === 'restoring' || state.rendererState !== 'ready' || operationBlocked} onClick={() => void controller.retrySelectionCleanup()}>{t("Restore selection")}</button>}
      {state.bootstrapState === 'failed' && <button onClick={() => location.reload()}>{t("Reload application")}</button>}
      {state.rendererState === 'unavailable' && state.bootstrapState !== 'failed' && !memoryBlocked && <button disabled={operationBlocked} onClick={() => void controller.retryRenderer()}>{t("Retry graphics")}</button>}
      {!operationBlocked && <IconButton icon="Cancel" label="Dismiss error" small onClick={() => setApp({ error: null })} />}</div>}
    {state.settingsOpen && !aboutOpen && !state.exportOpen && !state.navigationPrompt && !state.outputPending && <SettingsDialog returnFocus={openButton} onClose={closeSettings} withTools={state.toolsOpen && !geometrySource}
      activeTab={settingsTab} onTabChange={setSettingsTab} panels={{ general: <>
      <LanguagePicker />
      <ThemePicker />
      <FontSizePicker />
      <RenderSettings controller={controller} />
      <div className="settings-scene-actions" role="group" aria-label={t('Scene')}>
        <button disabled={!state.ready || state.busy || selectionBlocked || operationBlocked || memoryBlocked || state.navigationPrompt}
          onClick={() => { closeSettings(); requestPicker(folderPicker); }}>{t('Open folder')}</button>
        <button disabled={!state.summary || state.navigationPrompt || operationBlocked} onClick={() => { closeSettings(); void controller.closeScene(); }}>{t("Close scene")}</button>
      </div>
      <div className="dialog-actions saved-view-actions" role="group" aria-label={t('Saved view')}>
        <button aria-keyshortcuts="T" aria-pressed={!!state.toolbarFeedback.thumbnail}
          title={t(state.toolbarFeedback.thumbnail?.message ?? 'Save this camera view and background in this browser.')}
          disabled={disabled || memoryBlocked || state.navigationPrompt || state.thumbnailPending || state.viewTransferPending}
          onClick={() => void controller.updateThumbnail()}>{t('Remember view')}</button>
        <button disabled={disabled || memoryBlocked || state.navigationPrompt || state.thumbnailPending || state.viewTransferPending || state.savedViewChoices.length > 0} onClick={() => requestPicker(viewPicker)}>{t('Import view…')}</button>
        <button disabled={disabled || memoryBlocked || state.navigationPrompt || state.thumbnailPending || state.viewTransferPending || !state.savedViewAvailable} onClick={() => void controller.exportSavedView()}>{t("Export saved view")}</button>
        {state.viewTransferPending && <button onClick={() => controller.cancelSavedViewTransfer()}>{t("Cancel saved view transfer")}</button>}
      </div>
      {state.viewTransferPending && <p role="status">{t('Preparing saved view…')}</p>}
      {state.viewStatus && <p role="status">{translateStatus(state.viewStatus, locale)}</p>}
      {state.bootstrapState === 'failed' && <button onClick={() => location.reload()}>{t("Reload application")}</button>}
      {state.rendererState === 'unavailable' && state.bootstrapState !== 'failed' && <button disabled={memoryBlocked || operationBlocked} onClick={() => void controller.retryRenderer()}>{t("Retry graphics")}</button>}
      </>, privacy: <>
        <p>{t("Scenes are processed locally in this browser. Scene data is not uploaded.")}</p>
        <p>{t("Usage and error reporting are off.")}</p>
        <p>{t("Appearance preferences and saved views are stored in this browser. You can remove them using your browser's site-data controls.")}</p>
      </>, help: <>
        <div className="settings-help-actions">
        <button type="button" onClick={() => { closeSettings(); setAboutOpen(true); }}><Icon name="Help" />{t('About')}</button>
        <button type="button" className="tutorial-replay" data-tutorial-replay disabled={!tutorialAvailable} onClick={() => { if (tutorial.replay()) closeSettings(); }}><Icon name="Tutorial" />{t('Tutorial')}</button>
        <a href="https://opsiclear.com/" target="_blank" rel="noopener noreferrer"><Icon name="Help" />{t('Help & feedback')}</a>
        <a href="mailto:support@opsiclear.com?subject=SplatView%20web%20bug%20report"><Icon name="Bug" />{t('Report a bug')}</a>
        </div>
        {tutorial.error && <p role="alert" data-tutorial-error>{t(tutorial.error)}</p>}
        <OfflineStatus controller={controller} />
        <GraphicsDiagnostics controller={controller} />
        <div className="settings-navigation" role="group" aria-label={t('Navigation')}><dl className="settings-shortcuts">
          <dt>{t("Orbit")}</dt><dd>{t("Drag")}</dd><dt>{t("Pan")}</dt><dd>{t("Right drag")}</dd><dt>{t("Zoom")}</dt><dd>{t("Scroll")}</dd>
          <dt>{t("Look")}</dt><dd><kbd>V</kbd></dd><dt>{t("Auto orbit")}</dt><dd><kbd>O</kbd></dd><dt>{t("Reset view")}</dt><dd><kbd>R</kbd></dd>
          <dt>{t("Fill")}</dt><dd><kbd>G</kbd></dd>
        </dl><p>{t("Shortcuts work when the scene has focus.")}</p>
        <p>{t("Move with W/A/S/D, Q/E or Space; use arrows to turn. Hold Shift to move faster or Alt to move slowly.")}</p></div>
      </> }} />}
    {aboutOpen && !state.exportOpen && !state.navigationPrompt && !state.outputPending && <AboutDialog onClose={closeAbout}
      focus={{ returnFocus: aboutReturnFocus, fallbackFocus: () => [canvas.current, openButton.current],
        restoreAllowed: () => !appModalOwner(useApp.getState()) && !tutorial.blocksInput() }} />}
    {state.exportOpen && !geometrySource && !state.navigationPrompt && !state.outputPending && <SceneExportDialog focus={modalFocus} acceptedFormat={controller.acceptedExportFormat} scope={exportScope} onScopeChange={setExportScope}
      count={state.summary?.count} sourceCount={state.summary?.sourceCount} disabled={saveDisabled}
      onCancel={() => { controller.cancelExport(); setApp({ exportOpen: false }); }} onExport={(format, scope) => void controller.exportScene(format, scope)} />}
    {state.outputPending && <ModalFrame label={t("Download prepared. Keep the file before continuing.")} focus={modalFocus} floating onEscape={() => setApp({ outputPending: false })}><div className="output-receipt panel" role="status"><span>{t("Download prepared. Keep the file before continuing.")}</span><button onClick={() => controller.acknowledgeOutput()}>{t("I have kept the file")}</button><button onClick={() => setApp({ outputPending: false })}>{t("Stay")}</button></div></ModalFrame>}
    {state.viewStatus && !state.settingsOpen && !state.outputPending && !state.busy && !state.error && !memoryBlocked && <div className="output-receipt panel" role="status"><span>{translateStatus(state.viewStatus, locale)}</span><IconButton icon="Cancel" label="Dismiss saved view status" small onClick={() => setApp({ viewStatus: null })} /></div>}
    {state.savedViewChoices.length > 0 && !state.busy && !state.settingsOpen && !state.exportOpen && !state.navigationPrompt && <SavedViewChooser controller={controller} returnFocus={openButton} />}
    {state.navigationPrompt && !state.outputPending && <ModalFrame label={t("Unsaved changes")} focus={modalFocus} onEscape={() => controller.stay()}><h1>{t(state.navigationIntent === 'close' && memoryBlocked ? 'Close without saving?' : 'Save changes?')}</h1><p>{t("This scene has unsaved edits.")}</p>{memoryBlocked && <p>{t("Saving is unavailable while retained memory exceeds the scene budget. Stay to keep this document, or explicitly discard its edits and close.")}</p>}<div className="dialog-actions"><button onClick={() => controller.stay()}>{t("Stay")}</button><button onClick={() => void controller.discardAndContinue()}>{t(state.navigationIntent === 'close' ? 'Discard and close' : 'Discard')}</button><button disabled={saveDisabled} onClick={() => void controller.exportScene()}>{t("Save")}</button></div></ModalFrame>}
    {!tutorial.active && !state.settingsOpen && tutorial.error && <div className="error-banner panel" role="alert" data-tutorial-error>{t(tutorial.error)}</div>}
    {tutorial.active && <TutorialOverlay step={tutorial.step} stepIndex={tutorial.index} totalSteps={tutorial.totalSteps} courseId={tutorial.courseId} onSelectTopic={tutorial.selectTopic} offer={tutorial.phase === 'offer'} preferenceError={tutorial.error}
      preparing={tutorial.preparing} returnFocus={tutorial.returnFocus} restoreFocusWhenAllowed={() => !appModalOwner(useApp.getState())}
      onStart={tutorial.start} onSkip={tutorial.skip} onClose={tutorial.close} onBack={tutorial.back} onNext={tutorial.next} />}
  </main>;
}
