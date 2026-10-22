import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AppController } from '../app/controller';
import { useApp, type ToolsMode } from '../app/store';
import { SELECTION_SIGMA_MINIMUM, SELECTION_SIGMA_MAXIMUM,
  SELECTION_SIGMA_STEP, type SelectionMorphologyCommand } from '../input/selectionMorphology';
import { Icon } from './Icon';
import { useTranslation } from '../app/useLanguageAppearance';

type Controller = Pick<AppController, 'selectionMorphologyControlsEnabled' | 'selectionMorphologyVolumeEnabled' |
  'selectionMorphologyRange' | 'ensureSelectionMorphologyRange' | 'setSelectionMorphologyMethod' |
  'setSelectionDistance' | 'setSelectionSigma' | 'command'>;

// Committed selection_ui.cpp / ui_widgets.hpp: reach r is stored, 2r displayed.
// Display formatting never rounds the preference or native command operand.
export function morphologyDiameter(reach: number) { return Math.fround(2 * reach); }
export function morphologyRatio(value: number, minimum: number, maximum: number) {
  if (maximum <= minimum) return 0;
  return Math.max(0, Math.min(1, minimum > 0 ? Math.log(value / minimum) / Math.log(maximum / minimum) : (value - minimum) / (maximum - minimum)));
}
export function morphologyFromRatio(ratio: number, minimum: number, maximum: number) {
  if (ratio <= 0) return minimum;
  if (ratio >= 1) return maximum;
  return minimum > 0 ? minimum * Math.pow(maximum / minimum, ratio) : minimum + ratio * (maximum - minimum);
}

function Parameter({ controller, enabled, volume }: { controller: Controller; enabled: boolean; volume: boolean }) {
  const { t } = useTranslation(), state = useApp(), bounds = controller.selectionMorphologyRange;
  const value = volume ? morphologyDiameter(bounds?.value ?? 0) : state.selectionSigma;
  const minimum = volume ? morphologyDiameter(bounds?.minimum ?? 0) : SELECTION_SIGMA_MINIMUM;
  const maximum = volume ? morphologyDiameter(bounds?.maximum ?? 0) : SELECTION_SIGMA_MAXIMUM;
  const label = t(volume ? 'Diameter' : 'Sigma'), disabled = !enabled || volume && !controller.selectionMorphologyVolumeEnabled;
  const [editing, setEditing] = useState(false), [text, setText] = useState('');
  const entry = useRef<HTMLInputElement>(null), slider = useRef<HTMLInputElement>(null), initial = useRef<number | null>(null), restoreFocus = useRef(false);
  useLayoutEffect(() => {
    if (editing) { entry.current?.focus({ preventScroll: true }); entry.current?.select(); }
    else if (restoreFocus.current) { restoreFocus.current = false; slider.current?.focus({ preventScroll: true }); }
  }, [editing]);
  const change = (next: number) => {
    if (disabled || !Number.isFinite(next)) return;
    const clamped = Math.max(minimum, Math.min(maximum, next));
    if (volume) controller.setSelectionDistance(clamped / 2);
    else controller.setSelectionSigma(clamped);
  };
  const edit = () => {
    if (!disabled) { initial.current = volume ? state.selectionDistance : state.selectionSigma; setText(String(value)); setEditing(true); }
  };
  const close = () => { restoreFocus.current = true; setEditing(false); };
  return <label className="slider-row selection-morphology-parameter" data-tutorial-target="refine"><span>{label}</span>
    <span className="slider-control" title={t(volume ? 'Diameter in scene units; reach is half the diameter. Right-click to enter a value.' : 'Contact radius in sigma. 0.5 to 10, in 0.5 steps. Right-click to enter a value.')}
      onContextMenu={event => { event.preventDefault(); edit(); }}>
      {editing ? <input ref={entry} type="number" step={volume ? 'any' : SELECTION_SIGMA_STEP} min={minimum} max={maximum}
        aria-label={t('%s value', label)} value={text} disabled={disabled} className="selection-morphology-number"
        onChange={event => { const next = event.target.value; setText(next); if (next.trim()) change(Number(next)); }}
        onBlur={() => setEditing(false)} onKeyDown={event => {
          event.stopPropagation();
          if (event.key === 'Enter') { event.preventDefault(); close(); }
          else if (event.key === 'Escape') {
            event.preventDefault();
            if (volume) controller.setSelectionDistance(initial.current);
            else controller.setSelectionSigma(initial.current!);
            close();
          }
        }} onKeyUp={event => event.stopPropagation()} /> : <>
        <input ref={slider} type="range" aria-label={label} aria-valuemin={minimum} aria-valuemax={maximum} aria-valuenow={value}
          aria-valuetext={volume ? String(value) : value.toFixed(1)} min={volume ? 0 : minimum} max={volume ? 1 : maximum}
          step={volume ? 'any' : SELECTION_SIGMA_STEP} value={volume ? morphologyRatio(value, minimum, maximum) : value} disabled={disabled}
          onChange={event => { const next = Number(event.target.value); change(volume ? morphologyFromRatio(next, minimum, maximum) : next); }}
          onPointerDown={event => { if ((event.ctrlKey || event.metaKey) && event.button === 0) { event.preventDefault(); edit(); } }}
          onKeyDown={event => { event.stopPropagation(); if (event.key === 'Enter') { event.preventDefault(); edit(); } }} onKeyUp={event => event.stopPropagation()} />
        <output>{volume ? bounds ? Number(value.toPrecision(6)).toString() : '\u2014' : value.toFixed(1)}</output>
      </>}
    </span>
  </label>;
}

export function SelectionMorphology({ controller, displayMode, presentationOnly = false }: { controller: Controller; displayMode?: ToolsMode; presentationOnly?: boolean }) {
  const { t } = useTranslation(), state = useApp(), mode = displayMode ?? state.mode;
  const controlsEnabled = controller.selectionMorphologyControlsEnabled, volume = state.selectionMorphologyMethod === 'volume';
  const range = state.summary?.morphologyRange;
  useEffect(() => {
    // Showing the tour must not acquire a native job or edit owner. Existing
    // accepted readonly bounds may still be displayed without a query.
    if (!presentationOnly && mode === 'pro' && volume) void controller.ensureSelectionMorphologyRange();
  }, [controller, mode, state.toolsOpen, volume, state.sourceName, state.summary?.kind, state.summary?.count,
    state.summary?.contentRevision, range, controlsEnabled, presentationOnly]);
  if (mode !== 'pro') return null;
  const boundary = !!state.summary && state.summary.selected > 0 && (state.currentViewOnly || state.summary.selected < state.summary.visible);
  const run = (direction: SelectionMorphologyCommand['mode']) => {
    const current = useApp.getState(), reach = controller.selectionMorphologyRange;
    if (current.selectionMorphologyMethod === 'volume' && !reach) return;
    void controller.command(current.selectionMorphologyMethod === 'volume'
      ? { command: 'morphology', mode: direction, method: 'volume', distance: reach!.value }
      : { command: 'morphology', mode: direction, method: 'sigma', sigma: current.selectionSigma });
  };
  const commandEnabled = !presentationOnly && controlsEnabled && boundary && (!volume || controller.selectionMorphologyVolumeEnabled);
  return <>
    <div className="selection-boundary-group selection-morphology" data-tutorial-target="refine">
      <span className="selection-boundary-label">{t('Grow / Shrink')}</span>
      <div className="selection-morphology-strip" role="group" aria-label={t('Grow / Shrink')}>
        <div className="selection-segments selection-morphology-actions">
          <button type="button" className="icon-button" aria-label={t('Grow selection')} title={t(volume ? 'Grow one layer within the 3D distance.' : 'Grow selection\nAdd one layer of touching splats in 3D')}
            disabled={!commandEnabled} onClick={() => run('grow')}><Icon name="Grow" /></button>
          <button type="button" className="icon-button" aria-label={t('Shrink selection')} title={t(volume ? 'Shrink selected splats near unselected splats using the 3D distance.' : 'Shrink selection\nRemove selected splats touching unselected splats')}
            disabled={!commandEnabled} onClick={() => run('shrink')}><Icon name="Shrink" /></button>
        </div>
        <div className="selection-segments selection-morphology-methods">
          <button type="button" className={`icon-button${volume ? ' active' : ''}`} aria-label={t('Morphology volume')} aria-pressed={volume}
            title={t('Volume\nUse a 3D distance between Gaussian centers.')} disabled={!controlsEnabled || presentationOnly}
            onClick={() => controller.setSelectionMorphologyMethod('volume')}><Icon name="Sphere" /></button>
          <button type="button" className={`icon-button${!volume ? ' active' : ''}`} aria-label={t('Morphology sigma')} aria-pressed={!volume}
            title={t('Sigma\nUse touching Gaussian ellipsoids at the chosen sigma.')} disabled={!controlsEnabled || presentationOnly}
            onClick={() => controller.setSelectionMorphologyMethod('sigma')}><Icon name="Ellipsoid" /></button>
        </div>
      </div>
    </div>
    <Parameter key={volume ? 'volume' : 'sigma'} controller={controller} enabled={controlsEnabled && !presentationOnly} volume={volume} />
  </>;
}
