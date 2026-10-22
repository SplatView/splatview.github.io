import { useEffect, useRef, useState } from 'react';
import { useTranslation } from '../app/useLanguageAppearance';
import { applyAction } from './applyAction';

export const OPACITY_PERCENT_MAX = 500;
const percent = (scale: number) => scale * 100;
const clampPercent = (value: number) => Math.max(0, Math.min(OPACITY_PERCENT_MAX, value));

// Capture02 processing_ui.cpp:248 and ui_widgets.hpp:338-351. Percentage
// presentation stays separate from the native absolute opacity operation.
export function OpacityControls({ scale, enabled, applyEnabled, cancelEnabled, pending, dirty, resetRevision = 0,
  onScale, onApply, onCancel }: {
  scale: number; enabled: boolean; applyEnabled: boolean; cancelEnabled: boolean;
  pending: boolean; dirty: boolean; resetRevision?: number;
  onScale(value: number): void; onApply(): void | Promise<boolean>; onCancel(): void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false), [text, setText] = useState('');
  const entry = useRef<HTMLInputElement>(null), range = useRef<HTMLInputElement>(null), initial = useRef(scale);
  const valid = text.trim().length > 0 && Number.isFinite(Number(text));
  const invalid = editing && !valid;
  useEffect(() => { if (editing) { entry.current?.focus(); entry.current?.select(); } }, [editing]);
  useEffect(() => { setEditing(false); setText(''); }, [resetRevision]);
  const edit = () => { if (enabled) { initial.current = scale; setText(String(percent(scale))); setEditing(true); } };
  const finish = () => {
    if (!valid) return;
    setEditing(false); requestAnimationFrame(() => range.current?.focus({ preventScroll: true }));
  };
  const change = (next: string) => {
    setText(next);
    if (!next.trim() || !Number.isFinite(Number(next))) return;
    const bounded = clampPercent(Number(next));
    if (bounded !== Number(next)) setText(String(bounded));
    onScale(bounded / 100);
  };
  return <div className="opacity-controls" role="group" aria-label={t('Opacity controls')} onKeyUp={event => event.stopPropagation()}>
    <label className="slider-row opacity-slider"><span title={t('Fade / boost')}>{t('Fade / boost')}</span><span className="slider-control"
      title={t('Ctrl-click or right-click to enter a percentage')} onContextMenu={event => { event.preventDefault(); edit(); }}>
      {editing ? <input ref={entry} type="number" min="0" max={OPACITY_PERCENT_MAX} step="any" aria-label={t('Fade / boost percent')}
        aria-invalid={invalid} className="opacity-percent-entry" value={text} disabled={!enabled}
        onChange={event => change(event.target.value)} onBlur={() => { if (valid) setEditing(false); }} onKeyDown={event => {
          event.stopPropagation();
          if (event.key === 'Enter') { event.preventDefault(); finish(); }
          else if (event.key === 'Escape') {
            event.preventDefault(); onScale(initial.current); setEditing(false);
            requestAnimationFrame(() => range.current?.focus({ preventScroll: true }));
          } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            event.preventDefault(); if (valid) change(String(Number(text) + (event.key === 'ArrowUp' ? 1 : -1)));
          }
        }} /> : <><input ref={range} type="range" min="0" max={OPACITY_PERCENT_MAX} step="any" aria-label={t('Fade / boost')}
        aria-valuetext={`${percent(scale).toFixed(0)}%`} value={percent(scale)} disabled={!enabled}
        onChange={event => onScale(clampPercent(Number(event.target.value)) / 100)}
        onPointerDown={event => { if (event.ctrlKey || event.metaKey) { event.preventDefault(); edit(); } }}
        onKeyDown={event => {
          event.stopPropagation();
          if (event.key === 'Enter') { event.preventDefault(); edit(); }
          else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
            event.preventDefault(); onScale(clampPercent(percent(scale) + (event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -1 : 1)) / 100);
          }
        }} /><output>{percent(scale).toFixed(0)}%</output></>}
    </span></label>
    <div className="opacity-apply-actions" hidden={!dirty}>
      <button type="button" className="action-button" disabled={!applyEnabled || invalid} onClick={event => {
        if (!invalid) applyAction(event.currentTarget,
          event.currentTarget.closest('.opacity-controls')?.querySelector<HTMLInputElement>('.opacity-slider input:not(:disabled)'), onApply);
      }}>{t('Apply opacity')}</button>
      {dirty && <button type="button" className="action-button" disabled={!cancelEnabled} onClick={() => {
        setEditing(false); setText(''); onCancel();
      }}>{t('Cancel opacity preview')}</button>}
    </div>
    {pending && <div className="opacity-preview-status" role="status">{t('Updating opacity…')}</div>}
  </div>;
}
