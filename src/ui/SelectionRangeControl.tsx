import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { AppController } from '../app/controller';
import { formatMessage } from '../app/i18n';
import { useApp } from '../app/store';
import { useTranslation } from '../app/useLanguageAppearance';
import { SelectionRangeOverlay } from './SelectionRangeOverlay';

export type SelectionRangeTool = 'color' | 'fill';
export type SelectionRangeController = Pick<AppController, 'selectionRangeControlsEnabled' | 'selectionRangeBounds' |
  'ensureSelectionRangeBounds' | 'setSelectionRangeRadius' | 'setTransformNumericFocus' | 'selectionRangePreview' | 'camera' | 'scene'>;
const adjustmentKeys = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);

export function selectionRangeRatio(value: number, minimum: number, maximum: number): number {
  if (!(minimum > 0) || maximum <= minimum) return 0;
  return Math.max(0, Math.min(1, Math.log(value / minimum) / Math.log(maximum / minimum)));
}
export function selectionRangeFromRatio(ratio: number, minimum: number, maximum: number): number {
  if (maximum <= minimum || ratio <= 0) return minimum;
  if (ratio >= 1) return maximum;
  return minimum * Math.pow(maximum / minimum, ratio);
}

/** Disabled explanatory value only: no controller, scene, preferences or
 * statistics query is acquired just to show tutorial.hpp:140-143. */
export function SelectionRangeTutorial() {
  const { t } = useTranslation();
  return <label className="slider-row selection-range-parameter" data-tutorial-target="range" data-tutorial-demo="range" aria-hidden="true" inert>
    <span>{t('Radius')} (m)</span><span className="slider-control"
      title={t('Limit matches to a sphere around the picked point. Adjust its radius to update the last selection.')}>
      <input type="range" min="0" max="1" step="any" value={.5} disabled readOnly aria-label={t('Radius')}
        aria-valuemin={.1} aria-valuemax={10} aria-valuenow={1} aria-valuetext="1" />
      <output>{formatMessage('%.6g', 1)}</output>
    </span>
  </label>;
}

/** Desktop selection_ui.cpp:856-869: Radius is logarithmic and displayed with
 * six significant digits. Native selection changes are sent only on settled
 * input; local staging also supplies the cheap display-only sphere. */
export function SelectionRangeControl({ controller, tool, scene, disabled = false, previewEnabled = true }: {
  controller: SelectionRangeController; tool: SelectionRangeTool; scene: RefObject<HTMLCanvasElement | null>;
  disabled?: boolean; previewEnabled?: boolean;
}) {
  const { t } = useTranslation(), state = useApp(), preference = tool === 'fill' ? state.fillRange : state.colorRange;
  const bounds = controller.selectionRangeBounds(tool), unavailable = disabled || !preference.enabled || !controller.selectionRangeControlsEnabled || !bounds;
  const [draft, setDraft] = useState<number>(), [editing, setEditing] = useState(false), [text, setText] = useState('');
  const staged = useRef<number | undefined>(undefined), stagedSource = useRef<{ scene: AppController['scene']; tool: SelectionRangeTool } | undefined>(undefined);
  const entry = useRef<HTMLInputElement>(null), slider = useRef<HTMLInputElement>(null);
  const token = useRef<object>({}), activity = useRef({ pointer: null as number | null, keys: new Set<string>(), number: false, active: false });
  const current = useRef({ controller, tool, bounds, unavailable, preference }); current.current = { controller, tool, bounds, unavailable, preference };
  const cancelledNumber = useRef(false), restoreFocus = useRef(false);
  const publishActivity = () => {
    const owner = activity.current, active = owner.pointer !== null || owner.keys.size > 0 || owner.number;
    if (owner.active !== active) { owner.active = active; current.current.controller.setTransformNumericFocus(token.current, active); }
  };
  const discard = () => { staged.current = undefined; stagedSource.current = undefined; setDraft(undefined); };
  const stage = (value: number) => {
    const live = current.current;
    if (live.unavailable || !live.bounds || !Number.isFinite(value) || value <= 0) return;
    // Keep the user's raw positive double for future source limits. The
    // slider/output/sphere use an independently clamped float32 operand.
    staged.current = value;
    stagedSource.current = { scene: live.controller.scene, tool: live.tool };
    setDraft(staged.current);
  };
  const commit = () => {
    const value = staged.current, source = stagedSource.current, live = current.current;
    if (value !== undefined && source && !live.unavailable && live.bounds && source.scene === live.controller.scene && source.tool === live.tool)
      live.controller.setSelectionRangeRadius(value, live.tool);
    discard();
  };
  const finishPointer = (pointerId: number, accept: boolean) => {
    if (activity.current.pointer !== pointerId) return;
    if (accept) commit(); else discard();
    activity.current.pointer = null; publishActivity();
  };
  const edit = () => {
    if (current.current.unavailable || !current.current.bounds) return;
    setText(String(staged.current ?? current.current.preference.radius ?? current.current.bounds.value)); cancelledNumber.current = false;
    activity.current.number = true; activity.current.pointer = null; activity.current.keys.clear();
    publishActivity(); setEditing(true);
  };
  useEffect(() => {
    // Both profiles request this source statistic for the active Color/Fill
    // panel. The shared controller query owns readiness, refusal and joining.
    if (!bounds) void controller.ensureSelectionRangeBounds();
  }, [controller, tool, controller.scene, state.ready, state.busy, state.toolsOpen,
    state.summary?.count, state.summary?.contentRevision, state.summary?.morphologyRange, !!bounds]);
  useLayoutEffect(() => {
    if (editing) { entry.current?.focus({ preventScroll: true }); entry.current?.select(); }
    else if (restoreFocus.current) { restoreFocus.current = false; slider.current?.focus({ preventScroll: true }); }
  }, [editing]);
  useLayoutEffect(() => {
    staged.current = undefined; stagedSource.current = undefined; setDraft(undefined); setEditing(false);
    return () => {
      const owner = activity.current;
      owner.pointer = null; owner.keys.clear(); owner.number = false;
      if (owner.active) { owner.active = false; controller.setTransformNumericFocus(token.current, false); }
    };
  }, [controller, controller.scene, tool]);
  useLayoutEffect(() => {
    if (!unavailable) return;
    discard(); setEditing(false);
    const owner = activity.current;
    owner.pointer = null; owner.keys.clear(); owner.number = false; publishActivity();
  }, [unavailable]);
  const minimum = bounds?.minimum ?? 0, maximum = bounds?.maximum ?? 0;
  const effectiveDraft = draft !== undefined && bounds ? Math.fround(Math.max(minimum, Math.min(maximum, draft))) : undefined;
  const value = effectiveDraft ?? bounds?.value ?? 0;
  const finishNumber = () => {
    if (cancelledNumber.current) discard(); else commit();
    activity.current.number = false; publishActivity(); setEditing(false);
  };
  return <>
    {preference.enabled && <label className="slider-row selection-range-parameter" data-tutorial-target="range">
      <span>{t('Radius')} (m)</span>
      <span className="slider-control" title={t('Limit matches to a sphere around the picked point. Adjust its radius to update the last selection.')}
        onContextMenu={event => { event.preventDefault(); edit(); }}>
        {editing ? <input ref={entry} type="number" step="any" min={minimum} max={maximum} aria-label={t('%s value', t('Radius'))}
          className="selection-range-number" value={text} disabled={unavailable}
          onChange={event => {
            const next = event.target.value; setText(next);
            if (next.trim() && Number.isFinite(Number(next)) && Number(next) > 0) stage(Number(next)); else discard();
          }}
          onBlur={finishNumber} onKeyDown={event => {
            event.stopPropagation();
            if (event.key === 'Enter') { event.preventDefault(); restoreFocus.current = true; event.currentTarget.blur(); }
            else if (event.key === 'Escape') {
              event.preventDefault(); cancelledNumber.current = true; discard(); restoreFocus.current = true; event.currentTarget.blur();
            }
          }} onKeyUp={event => event.stopPropagation()} /> : <>
          <input ref={slider} type="range" min="0" max="1" step="any" aria-label={t('Radius')}
            aria-valuemin={minimum} aria-valuemax={maximum} aria-valuenow={value} aria-valuetext={bounds ? String(value) : undefined}
            value={selectionRangeRatio(value, minimum, maximum)} disabled={unavailable}
            onChange={event => {
              stage(selectionRangeFromRatio(Number(event.target.value), minimum, maximum));
              // An assistive standalone change has no following physical/key release.
              if (activity.current.pointer === null && !activity.current.keys.size) commit();
            }} onPointerDown={event => {
              if (event.button !== 0 || unavailable) return;
              if (event.ctrlKey || event.metaKey) { event.preventDefault(); edit(); return; }
              if (activity.current.pointer === null) {
                activity.current.pointer = event.pointerId; publishActivity();
                try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* A source transition may retire the control. */ }
              }
            }} onPointerUp={event => finishPointer(event.pointerId, true)} onPointerCancel={event => finishPointer(event.pointerId, false)}
            onLostPointerCapture={event => finishPointer(event.pointerId, false)} onBlur={() => {
              activity.current.keys.clear(); if (activity.current.pointer === null) commit(); publishActivity();
            }} onKeyDown={event => {
              event.stopPropagation();
              if (adjustmentKeys.has(event.key)) { activity.current.keys.add(event.key); publishActivity(); }
              else if (event.key === 'Enter') { event.preventDefault(); edit(); }
              else if (event.key === 'Escape') {
                event.preventDefault(); discard(); activity.current.keys.clear(); publishActivity();
              }
            }} onKeyUp={event => {
              event.stopPropagation();
              if (activity.current.keys.delete(event.key) && !activity.current.keys.size) {
                commit(); publishActivity();
              }
            }} />
          <output>{bounds ? formatMessage('%.6g', value) : '\u2014'}</output>
        </>}
      </span>
    </label>}
    <SelectionRangeOverlay controller={controller} scene={scene} radius={effectiveDraft}
      enabled={previewEnabled && preference.enabled && state.toolsOpen} />
  </>;
}
