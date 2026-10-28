import { useCallback, useLayoutEffect, useRef, useState, type RefObject, type CSSProperties } from 'react';
import type { AppController } from '../app/controller';
import { webFeatureAllowed, productTokens } from '../app/productPolicy';
import { setApp, switchToolsMode, useApp, type SelectionTool } from '../app/store';
import { useTranslation } from '../app/useLanguageAppearance';
import { colorFields } from '../generated/desktop';
import type { AutoColorMethod } from '../document/colorProtocol';
import { sameColorValues } from '../document/colorSession';
import type { TutorialStep } from '../app/tutorialCatalog';
import { IconButton } from './IconButton';
import { DecorativeChevron } from './DecorativeChevron';
import { RenderedHistogram } from './RenderedHistogram';
import { SelectionActions, SelectionOptions, PolygonSelectionControls, ToleranceControl, type PolygonActions } from './SelectionControls';
import { SelectionMorphology } from './SelectionMorphology';
import { SelectionRangeControl, SelectionRangeTutorial } from './SelectionRangeControl';
import { SelectionMenus } from './SelectionMenus';
import { FilterControls } from './FilterControls';
import { TransformControls } from './TransformControls';
import { OpacityControls } from './OpacityControls';
import { GradeControls } from './GradeControls';
import { TransformModeMenu } from './TransformModeMenu';
import { AutoColorActions, ColorApplyButton } from './AutoColorActions';
import { AlignmentControls } from './AlignmentControls';

export type ToolsPanelRetention = {
  folding: { selection: boolean; color: boolean; transform: boolean };
  scroll: Record<'basic' | 'pro', { body: number; panel: number }>;
};
export function ToolsPanel({ controller, scene, chromeVisible, autoMethod, onAutoMethod, visible = true, tutorialStep, onInputScopeChange, retention, polygon }: {
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
