import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from '../app/useLanguageAppearance';
import { gradeDisplayBounds, gradeDisplayValue, gradeEntryText, gradeEscapeValue, gradePointerValue, gradeSliderTweak,
  gradeValueText, parseGradeText, type GradeField } from './gradeInput';
export type { GradeField } from './gradeInput';

function GradeSlider({ index, field, value, enabled, resetRevision, onValue, onValidity, hidden = false }: {
  index: number; field: GradeField; value: number; enabled: boolean; resetRevision: number;
  onValue(index: number, value: number): void; onValidity(index: number, valid: boolean): void;
  hidden?: boolean;
}) {
  const { t } = useTranslation(), label = t(field.label);
  const [editing, setEditing] = useState(false), [text, setText] = useState('');
  const entry = useRef<HTMLInputElement>(null), slider = useRef<HTMLInputElement>(null);
  const restoreSliderFocus = useRef(false);
  const initialText = useRef(''), accumulator = useRef(0), navValue = useRef(value);
  const [low, high] = gradeDisplayBounds(field), invalid = editing && parseGradeText(field, text) === null;
  useLayoutEffect(() => {
    if (editing) { entry.current?.focus({ preventScroll: true }); entry.current?.select(); }
    else if (restoreSliderFocus.current) { restoreSliderFocus.current = false; slider.current?.focus({ preventScroll: true }); }
  }, [editing]);
  useEffect(() => { onValidity(index, !invalid); }, [index, invalid, onValidity]);
  useEffect(() => () => onValidity(index, true), [index, onValidity]);
  useEffect(() => { setEditing(false); setText(''); accumulator.current = 0; }, [resetRevision]);
  useEffect(() => { if (!Object.is(navValue.current, value)) accumulator.current = 0; navValue.current = value; }, [value]);
  const edit = () => {
    if (!enabled || editing) return;
    initialText.current = gradeEntryText(field, navValue.current); accumulator.current = 0;
    setText(initialText.current); setEditing(true);
  };
  const close = () => { onValidity(index, true); restoreSliderFocus.current = true; setEditing(false); };
  return <label className="slider-row" hidden={hidden} data-grade-field={field.name}><span title={label}>{label}</span>
    <span className="slider-control" onContextMenu={event => { if (!editing) { event.preventDefault(); edit(); } }}>
      {editing ? <input ref={entry} className="grade-value-entry" type="text" inputMode="decimal" autoComplete="off" spellCheck={false}
        aria-label={t('%s value', label)} aria-invalid={invalid} value={text} disabled={!enabled}
        onChange={event => {
          setText(event.target.value);
          const parsed = parseGradeText(field, event.target.value);
          onValidity(index, parsed !== null);
          if (parsed !== null && !Object.is(parsed, navValue.current)) { navValue.current = parsed; onValue(index, parsed); }
        }} onBlur={() => { if (!invalid) setEditing(false); }} onKeyDown={event => {
          event.stopPropagation();
          if (event.key === 'Enter') { event.preventDefault(); if (!invalid) close(); }
          else if (event.key === 'Escape') {
            event.preventDefault();
            const restored = gradeEscapeValue(field, navValue.current, initialText.current);
            if (restored !== null && !Object.is(restored, navValue.current)) { navValue.current = restored; onValue(index, restored); }
            close();
          }
        }} onKeyUp={event => event.stopPropagation()} /> : <>
        <input ref={slider} type="range" min={low} max={high} step="any" aria-label={label}
          aria-valuetext={gradeValueText(field, value)} value={gradeDisplayValue(field, value)} disabled={!enabled}
          onFocus={() => { accumulator.current = 0; }} onBlur={() => { accumulator.current = 0; }}
          onPointerDown={event => { accumulator.current = 0; if ((event.ctrlKey || event.metaKey) && event.button === 0) { event.preventDefault(); edit(); } }}
          onChange={event => { accumulator.current = 0; const next = gradePointerValue(field, Number(event.target.value));
            if (!Object.is(next, navValue.current)) { navValue.current = next; onValue(index, next); } }}
          onKeyDown={event => {
            event.stopPropagation();
            if (event.key === 'Enter') { event.preventDefault(); edit(); }
            else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
              event.preventDefault();
              const next = gradeSliderTweak(field, navValue.current, event.key === 'ArrowLeft' ? -1 : 1, accumulator.current, event.ctrlKey, event.shiftKey);
              accumulator.current = next.accumulator;
              if (!Object.is(next.value, navValue.current)) { navValue.current = next.value; onValue(index, next.value); }
            } else if (['ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', ' '].includes(event.key)) event.preventDefault();
          }} onKeyUp={event => event.stopPropagation()} /><output>{gradeValueText(field, value)}</output>
      </>}
    </span>
  </label>;
}

export function GradeControls({ grade, fields, shownIndices, retainedIndices, enabled, resetRevision = 0, desiredValuesRef, onValues, onValidityChanged }: {
  grade: readonly number[]; fields: readonly GradeField[]; shownIndices: readonly number[]; enabled: boolean; resetRevision?: number;
  desiredValuesRef?: { current: readonly number[] };
  retainedIndices?: readonly number[];
  onValues(values: number[]): void; onValidityChanged?(valid: boolean): void;
}) {
  const { t } = useTranslation();
  const invalidFields = useRef(new Set<number>()), valid = useRef(true), localValues = useRef<readonly number[]>([...grade]),
    authoritative = useRef([...grade]), validityCallback = useRef(onValidityChanged);
  const values = desiredValuesRef ?? localValues;
  validityCallback.current = onValidityChanged;
  useLayoutEffect(() => {
    if (!desiredValuesRef && (grade.length !== authoritative.current.length || grade.some((value, index) => !Object.is(value, authoritative.current[index]))))
      localValues.current = [...grade];
    authoritative.current = [...grade];
  }, [desiredValuesRef, grade]);
  useEffect(() => { onValidityChanged?.(valid.current); }, [onValidityChanged]);
  useEffect(() => () => validityCallback.current?.(true), []);
  const reportValidity = useCallback((index: number, next: boolean) => {
    if (next) invalidFields.current.delete(index); else invalidFields.current.add(index);
    const allValid = invalidFields.current.size === 0;
    if (allValid !== valid.current) { valid.current = allValid; validityCallback.current?.(allValid); }
  }, []);
  const change = (index: number, value: number) => {
    const next = [...values.current]; next[index] = value; values.current = next; onValues(next);
  };
  return <div className="grade-controls" data-tutorial-target="color-slider pro-color" role="group" aria-label={t('Color grading')}>
    {fields.map((_, index) => index).filter(index => shownIndices.includes(index) || retainedIndices?.includes(index)).map(index => <GradeSlider key={fields[index].name} index={index} field={fields[index]} value={grade[index]} hidden={!shownIndices.includes(index)}
      enabled={enabled} resetRevision={resetRevision} onValue={change} onValidity={reportValidity} />)}
  </div>;
}
