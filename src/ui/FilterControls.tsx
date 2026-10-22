import { useEffect, useRef, useState } from 'react';
import type { SelectionFilterKind, SelectionFilterParameters } from '../document/filterProtocol';
import type { FilterGizmoMode } from '../document/filterGizmo';
import { Icon } from './Icon';
import { useTranslation } from '../app/useLanguageAppearance';

type ParameterPatch = Partial<SelectionFilterParameters>;
function formatted(value: number, digits: number) { return Number.isFinite(value) ? value.toFixed(digits) : ''; }
function FloatField({ label, value, digits = 3, disabled, onChange }: {
  label: string; value: number; digits?: number; disabled: boolean; onChange(value: number): void;
}) {
  const [text, setText] = useState(() => formatted(value, digits)), editing = useRef(false), initial = useRef(value);
  useEffect(() => { if (!editing.current) setText(formatted(value, digits)); }, [value, digits]);
  return <input type="number" step="any" aria-label={label} className="filter-float" disabled={disabled} value={text}
    onFocus={() => { editing.current = true; initial.current = value; }}
    onChange={event => { const next = event.target.value; setText(next); if (next.trim() && Number.isFinite(Number(next))) onChange(Number(next)); }}
    onBlur={() => { editing.current = false; setText(formatted(value, digits)); }} onKeyDown={event => {
      event.stopPropagation();
      if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
      else if (event.key === 'Escape') { event.preventDefault(); onChange(initial.current); setText(formatted(initial.current, digits)); event.currentTarget.blur(); }
    }} />;
}
function VectorField({ label, value, disabled, onChange }: {
  label: string; value: readonly number[]; disabled: boolean; onChange(value: [number, number, number]): void;
}) {
  return <label className="filter-field"><span>{label}</span><span className="filter-vector">
    {value.map((component, index) => <FloatField key={index} label={`${label} ${'XYZ'[index]}`} value={component} digits={2} disabled={disabled}
      onChange={next => onChange(value.map((entry, at) => at === index ? next : entry) as [number, number, number])} />)}
  </span></label>;
}
function SliderField({ label, value, low, high, disabled, onChange }: {
  label: string; value: number; low: number; high: number; disabled: boolean; onChange(value: number): void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false), [text, setText] = useState('');
  const field = useRef<HTMLInputElement>(null), range = useRef<HTMLInputElement>(null), initial = useRef(value);
  useEffect(() => { if (editing) { field.current?.focus(); field.current?.select(); } }, [editing]);
  const edit = () => { if (!disabled) { initial.current = value; setText(String(value)); setEditing(true); } };
  const change = (next: string) => {
    setText(next); if (next.trim() && Number.isFinite(Number(next))) onChange(Math.max(low, Math.min(high, Number(next))));
  };
  return <label className="filter-field"><span>{label}</span><span className="slider-control" onContextMenu={event => { event.preventDefault(); edit(); }}>
    {editing ? <input ref={field} type="number" step="any" aria-label={t('%s value', label)} min={low} max={high} disabled={disabled} value={text}
      className="filter-float filter-slider-number" onChange={event => change(event.target.value)} onBlur={() => setEditing(false)}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.key === 'Enter') { event.preventDefault(); setEditing(false); requestAnimationFrame(() => range.current?.focus({ preventScroll: true })); }
        else if (event.key === 'Escape') { event.preventDefault(); onChange(initial.current); setEditing(false); requestAnimationFrame(() => range.current?.focus({ preventScroll: true })); }
      }} /> : <><input ref={range} type="range" aria-label={label} min={low} max={high} step="any" value={value} disabled={disabled}
        onChange={event => onChange(Number(event.target.value))} onPointerDown={event => { if (event.ctrlKey || event.metaKey) { event.preventDefault(); edit(); } }}
        onKeyDown={event => { event.stopPropagation(); if (event.key === 'Enter') { event.preventDefault(); edit(); } }} />
      <output>{formatted(value, 2)}</output></>}
  </span></label>;
}

// Capture02 processing_ui.cpp:512-556. Exact mask evaluation belongs to the
// controller's explicit Preview command; these controls only edit its definition.
export function FilterControls({ kind, parameters, enabled, previewPending, previewEnabled = enabled, dirty, showVolume, centerPicking, recommendedMaxScale,
  gizmoMode, gizmoEnabled, localAxes, snap, onParameters, onReset, onPreview, onCurrentView, onPickCenter, onVolume,
  onGizmo, onLocalAxes, onSnap }: {
  kind: SelectionFilterKind; parameters: SelectionFilterParameters; enabled: boolean; previewPending: boolean; dirty: boolean;
  previewEnabled?: boolean;
  showVolume: boolean; centerPicking: boolean; recommendedMaxScale?: number | null;
  gizmoMode: FilterGizmoMode | null; gizmoEnabled: boolean; localAxes: boolean; snap: boolean;
  onParameters(patch: ParameterPatch): void; onReset(): void; onPreview(): void; onCurrentView(): void; onPickCenter(): void; onVolume(value: boolean): void;
  onGizmo(mode: FilterGizmoMode): void; onLocalAxes(value: boolean): void; onSnap(value: boolean): void;
}) {
  const { t } = useTranslation();
  const spatial = !['opacity', 'scale'].includes(kind), disabled = !enabled;
  const scalar = (label: string, name: 'radius' | 'aspect' | 'near' | 'far' | 'minScale' | 'maxScale', title?: string) =>
    <label className="filter-field" title={title}><span>{label}</span><FloatField label={label} value={parameters[name]} disabled={disabled}
      onChange={value => onParameters({ [name]: value })} /></label>;
  return <div className="filter-options">
    <span className="selection-boundary-label">{t('Options')}</span>
    <div className="filter-option-actions">
      <button type="button" className="icon-button filter-option-button" aria-label={t('Reset filter')} title={t('Reset filter')} disabled={disabled} onClick={onReset}><Icon name="Reset" /></button>
      {spatial && <>
        <button type="button" className={`icon-button filter-option-button ${centerPicking ? 'active' : ''}`} aria-label={t('Pick filter center')} title={t('Pick filter center')}
          aria-pressed={centerPicking} disabled={disabled} onClick={onPickCenter}><Icon name="PickCenter" /></button>
        <div className="selection-segments filter-gizmo-controls" role="group" aria-label={t('Filter gizmo')}>
          {(['move', 'rotate', 'scale'] as const).map(mode => <button key={mode} type="button"
            className={`icon-button filter-option-button ${gizmoMode === mode ? 'active' : ''}`} aria-label={t(mode[0].toUpperCase() + mode.slice(1))}
            title={t(mode[0].toUpperCase() + mode.slice(1))} aria-pressed={gizmoMode === mode}
            disabled={!gizmoEnabled || kind === 'frustum' && mode === 'scale'} onClick={() => onGizmo(mode)}>
            <Icon name={mode[0].toUpperCase() + mode.slice(1)} /></button>)}
        </div>
        <div className="selection-segments filter-gizmo-preferences" role="group" aria-label={t('Filter axes and snapping')}>
          <button type="button" className={`icon-button filter-option-button ${localAxes ? 'active' : ''}`} aria-label={t('Local axes')} title={t('Local axes / world axes')}
            aria-pressed={localAxes} disabled={!gizmoEnabled} onClick={() => onLocalAxes(!localAxes)}><Icon name="Axes" /></button>
          <button type="button" className={`icon-button filter-option-button ${snap ? 'active' : ''}`} aria-label={t('Snap')}
            title={t('Snap: move 0.1 units, rotate 15 degrees, scale 0.1\nHold Ctrl to snap temporarily')}
            aria-pressed={snap} disabled={!gizmoEnabled} onClick={() => onSnap(!snap)}><Icon name="Snap" /></button>
        </div>
        <button type="button" className={`icon-button filter-option-button ${showVolume ? 'active' : ''}`} aria-label={t('Show selection volume')} title={t('Show selection volume')}
          aria-pressed={showVolume} disabled={disabled} onClick={() => onVolume(!showVolume)}><Icon name="VolumeOutline" /></button>
      </>}
    </div>
    {kind === 'opacity' ? <>
      <SliderField label={t('Minimum opacity')} value={parameters.minOpacity} low={0} high={1} disabled={disabled} onChange={minOpacity => onParameters({ minOpacity })} />
      <SliderField label={t('Maximum opacity')} value={parameters.maxOpacity} low={0} high={1} disabled={disabled} onChange={maxOpacity => onParameters({ maxOpacity })} />
    </> : kind === 'scale' ? <>
      {scalar(t('Minimum splat scale'), 'minScale')}{scalar(t('Maximum scale'), 'maxScale', t('Largest Gaussian axis in scene units. 100 means unlimited.'))}
      {recommendedMaxScale !== null && recommendedMaxScale !== undefined && Number.isFinite(recommendedMaxScale) && <button type="button" className="action-button" disabled={disabled}
        onClick={() => onParameters({ maxScale: recommendedMaxScale })}>{t('Use recommended max scale')}</button>}
    </> : <>
      {kind === 'frustum' && <button type="button" className="action-button" disabled={disabled} onClick={onCurrentView}>{t('Use current view')}</button>}
      <VectorField label={t('Center / position')} value={parameters.center} disabled={disabled} onChange={center => onParameters({ center })} />
      {kind === 'sphere' && scalar(t('Radius'), 'radius')}
      {(kind === 'box' || kind === 'ellipsoid') && <VectorField label={t(kind === 'box' ? 'Box size XYZ' : 'Ellipsoid radii')} value={parameters.size}
        disabled={disabled} onChange={size => onParameters({ size })} />}
      {kind !== 'sphere' && <VectorField label={t('Rotation vector (degrees)')} value={parameters.rotation} disabled={disabled} onChange={rotation => onParameters({ rotation })} />}
      {kind === 'frustum' && <>
        <SliderField label={t('Vertical field of view')} value={parameters.fov} low={1} high={179} disabled={disabled} onChange={fov => onParameters({ fov })} />
        {scalar(t('Aspect ratio'), 'aspect')}{scalar(t('Near plane'), 'near')}{scalar(t('Far plane'), 'far')}
      </>}
    </>}
    <button type="button" className="action-button filter-preview" disabled={disabled || !previewEnabled || previewPending || !dirty} onClick={onPreview}>{t('Preview')}</button>
    {dirty && !previewPending && <p className="filter-preview-status" role="status">{t('Preview changes before confirming.')}</p>}
  </div>;
}
