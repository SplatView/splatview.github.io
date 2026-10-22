import { useEffect, useRef, useState } from 'react';
import type { TransformParameters } from '../document/transformProtocol';
import type { FilterGizmoMode } from '../document/filterGizmo';
import { pivotPresentation, type TransformPivotMode } from '../document/transformPivot';
import type { ToolsMode } from '../app/store';
import { useTranslation } from '../app/useLanguageAppearance';
import { Icon } from './Icon';
import { applyAction } from './applyAction';

const formatted = (value: number, digits: number) => Number.isFinite(value) ? value.toFixed(digits) : '';
type NumericFocusListener = (token: object, active: boolean) => void;
function FloatField({ label, labelArgs = [], value, digits, disabled, onChange, onNumericFocus }: {
  label: string; labelArgs?: readonly (string | number)[]; value: number; digits: number; disabled: boolean; onChange(value: number): void;
  onNumericFocus?: NumericFocusListener;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState(() => formatted(value, digits)), editing = useRef(false), initial = useRef(value);
  const focusToken = useRef<object>({}), focusListener = useRef(onNumericFocus);
  focusListener.current = onNumericFocus;
  useEffect(() => { if (!editing.current) setText(formatted(value, digits)); }, [value, digits]);
  useEffect(() => () => {
    if (editing.current) { editing.current = false; focusListener.current?.(focusToken.current, false); }
  }, []);
  return <input type="number" step="any" aria-label={t(label, ...labelArgs)} className="filter-float transform-float" disabled={disabled} value={text}
    onFocus={() => { editing.current = true; initial.current = value; focusListener.current?.(focusToken.current, true); }}
    onChange={event => { const next = event.target.value; setText(next); if (next.trim() && Number.isFinite(Number(next))) onChange(Number(next)); }}
    onBlur={() => { editing.current = false; setText(formatted(value, digits)); focusListener.current?.(focusToken.current, false); }} onKeyDown={event => {
      event.stopPropagation();
      if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
      else if (event.key === 'Escape') { event.preventDefault(); onChange(initial.current); setText(formatted(initial.current, digits)); event.currentTarget.blur(); }
    }} />;
}
function VectorField({ label, value, disabled, onChange, onNumericFocus }: {
  label: string; value: readonly number[]; disabled: boolean; onChange(value: [number, number, number]): void;
  onNumericFocus?: NumericFocusListener;
}) {
  const { t } = useTranslation(), translatedLabel = t(label);
  return <label className="filter-field transform-field"><span>{translatedLabel}</span><span className="filter-vector">
    {value.map((component, index) => <FloatField key={index} label="%s %s" labelArgs={[translatedLabel, 'XYZ'[index]]} value={component} digits={2} disabled={disabled}
      onNumericFocus={onNumericFocus} onChange={next => onChange(value.map((entry, at) => at === index ? next : entry) as [number, number, number])} />)}
  </span></label>;
}

// Committed processing_ui.cpp / viewport_tools.cpp: both profiles expose the
// compact strip; Pro adds local axes, pivot and representation fields. Values
// and composition remain native-owned. Explicit Apply replaces automatic baking.
export function TransformControls({ parameters: actualParameters, enabled, applyEnabled, cancelEnabled, pending, dirty,
  mode = 'pro', gizmoMode, gizmoEnabled: gizmoAllowed, localAxes, snap, pivotMode, pivotChosen, pivotPending, hasSelected, presentationOnly = false,
  onParameters, onFlip, onCyclePivot, onApply, onCancel, onNumericFocus,
  onGizmo, onLocalAxes, onSnap }: {
  parameters: TransformParameters; enabled: boolean; applyEnabled: boolean; cancelEnabled: boolean; mode?: ToolsMode;
  presentationOnly?: boolean;
  pending: boolean; dirty: boolean; gizmoMode: FilterGizmoMode | null; gizmoEnabled: boolean; localAxes: boolean; snap: boolean;
  pivotMode: TransformPivotMode; pivotChosen: boolean; pivotPending: boolean; hasSelected: boolean;
  onParameters(patch: Partial<TransformParameters>): void; onFlip(axis: 0 | 1 | 2, value: boolean): void;
  onCyclePivot(): void; onApply(): void | Promise<boolean>; onCancel(): void;
  onNumericFocus?: NumericFocusListener;
  onGizmo(mode: FilterGizmoMode): void; onLocalAxes(value: boolean): void; onSnap(value: boolean): void;
}) {
  const { t } = useTranslation();
  // Desktop processing_ui.cpp:408 presents Euler during the tour without
  // changing the stored representation or a retained native edit owner.
  const parameters = presentationOnly ? { ...actualParameters, mode: 'euler' as const } : actualParameters;
  const disabled = !enabled || presentationOnly, gizmoEnabled = gizmoAllowed && !presentationOnly;
  const pivot = pivotPresentation(pivotMode, hasSelected);
  const vector = (label: string, name: 'translation' | 'scale' | 'pivot' | 'euler' | 'axis') =>
    <VectorField label={label} value={parameters[name]} disabled={disabled || name === 'pivot' && pending}
      onNumericFocus={onNumericFocus} onChange={value => onParameters({ [name]: value })} />;
  return <div className="transform-controls">
    <div className="transform-option-actions">
      <div className="selection-segments" role="group" aria-label={t('Transform gizmo')} data-tutorial-target="gizmo">
        {(['move', 'rotate', 'scale'] as const).map(mode => <button key={mode} type="button"
          className={`icon-button transform-option-button ${gizmoMode === mode ? 'active' : ''}`}
          aria-label={t(mode[0].toUpperCase() + mode.slice(1))} title={t(mode[0].toUpperCase() + mode.slice(1))}
          aria-pressed={gizmoMode === mode} disabled={!gizmoEnabled} onClick={() => onGizmo(mode)}>
          <Icon name={mode[0].toUpperCase() + mode.slice(1)} /></button>)}
      </div>
      <div className="selection-segments" role="group" aria-label={t('Transform axes and snapping')}>
        {mode === 'pro' && <button type="button" data-tutorial-target="coordinates" className={`icon-button transform-option-button ${localAxes ? 'active' : ''}`} aria-label={t('Local axes')}
          title={t('Local axes / world axes')} aria-pressed={localAxes} disabled={!gizmoEnabled} onClick={() => onLocalAxes(!localAxes)}><Icon name="Axes" /></button>}
        <button type="button" data-tutorial-target="snap-flips" className={`icon-button transform-option-button ${snap ? 'active' : ''}`} aria-label={t('Snap')}
          title={t('Snap: move 0.1 units, rotate 15 degrees, scale 0.1\nHold Ctrl to snap temporarily')} aria-pressed={snap}
          disabled={!gizmoEnabled} onClick={() => onSnap(!snap)}><Icon name="Snap" /></button>
      </div>
      <div className="selection-segments" role="group" aria-label={t('Transform flips')} data-tutorial-target="snap-flips">
        {parameters.flips.map((active, index) => { const label = t(`Flip ${'XYZ'[index]}`); return <button key={index} type="button"
          className={`icon-button transform-option-button ${active ? 'active' : ''}`} aria-label={label} title={label}
          aria-pressed={active} disabled={disabled} onClick={() => onFlip(index as 0 | 1 | 2, !active)}><Icon name={`Flip${'XYZ'[index]}`} /></button>; })}
      </div>
      {mode === 'pro' && parameters.mode !== 'matrix' && <button type="button" data-tutorial-target="pivot"
        className={`icon-button transform-option-button ${pivotChosen ? 'active' : ''}`} aria-label={t('Cycle pivot')}
        title={t(pivot.tooltip)} aria-pressed={pivotChosen} aria-busy={pivotPending || undefined}
        disabled={disabled || pending || pivotPending} onClick={onCyclePivot}><Icon name={pivot.icon} /></button>}
    </div>
    {mode === 'pro' && <div className="transform-numeric-values" data-tutorial-target="transform-values">{parameters.mode !== 'matrix' ? <>
      {vector('Translation', 'translation')}{vector('Scale XYZ', 'scale')}{vector('Pivot', 'pivot')}
      {parameters.mode === 'euler' ? vector('Rotation XYZ', 'euler') : parameters.mode === 'quaternion' ? <>
        <div className="transform-wide-label">{t('Quaternion wxyz')}</div><div className="filter-vector transform-four">
          {parameters.quaternion.map((component, index) => <FloatField key={index} label="Quaternion %s" labelArgs={['wxyz'[index]]} value={component} digits={3} disabled={disabled}
            onNumericFocus={onNumericFocus} onChange={next => onParameters({ quaternion: parameters.quaternion.map((entry, at) => at === index ? next : entry) as [number, number, number, number] })} />)}
        </div>
      </> : <>{vector('Axis', 'axis')}<label className="filter-field transform-field"><span>{t('Angle in degrees')}</span>
        <FloatField label="Angle in degrees" value={parameters.angle} digits={3} disabled={disabled}
          onNumericFocus={onNumericFocus} onChange={angle => onParameters({ angle })} /></label></>}
    </> : <>
      <div className="transform-wide-label">{t('Row-major affine matrix')}</div>
      {[0, 1, 2, 3].map(row => <div key={row} className="filter-vector transform-four">
        {[0, 1, 2, 3].map(column => { const index = row * 4 + column; return <FloatField key={column}
          label="Affine matrix row %u column %u" labelArgs={[row + 1, column + 1]} value={parameters.matrix[index]} digits={3} disabled={disabled}
          onNumericFocus={onNumericFocus} onChange={next => onParameters({ matrix: parameters.matrix.map((entry, at) => at === index ? next : entry) as TransformParameters['matrix'] })} />; })}
      </div>)}
    </>}</div>}
    <div className="transform-apply-actions" hidden={!dirty}>
      <button type="button" className="action-button" disabled={!applyEnabled || presentationOnly} onClick={event => applyAction(event.currentTarget,
        event.currentTarget.closest('.transform-controls')?.querySelector<HTMLInputElement>('input:not(:disabled)') ??
          event.currentTarget.closest('.transform-controls')?.querySelector<HTMLButtonElement>('.transform-option-actions button'), onApply)}>{t('Apply transform')}</button>
      {dirty && <button type="button" className="action-button" disabled={!cancelEnabled || presentationOnly} onClick={onCancel}>{t('Cancel transform preview')}</button>}
    </div>
    {pending && <div className="transform-preview-status" role="status">{t('Updating transform…')}</div>}
  </div>;
}
