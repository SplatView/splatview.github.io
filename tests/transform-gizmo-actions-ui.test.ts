import { Children, createElement, isValidElement, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { FloatingSelectionActions, type FloatingTransformActionsProps } from '../src/ui/FloatingSelectionActions';
import { TransformGizmoActions, handleTransformGizmoKey } from '../src/ui/TransformGizmoActions';
import { translate } from '../src/app/i18n';
import { currentDesktopIcons } from '../src/generated/currentDesktopIcons';
import { desktopIcons } from '../src/generated/desktop';

type Button = ButtonHTMLAttributes<HTMLButtonElement>;
function find<T extends { children?: ReactNode }>(tree: ReactNode, match: (props: T, type: unknown) => boolean): T | undefined {
  for (const node of Children.toArray(tree)) {
    if (!isValidElement<T>(node)) continue;
    if (match(node.props, node.type)) return node.props;
    const child = find(node.props.children, match); if (child) return child;
  }
}
function props(): FloatingTransformActionsProps {
  return { kind: 'transform', scene: { current: null }, scale: 1, enabled: true, chromeVisible: true,
    finishEnabled: true, undoEnabled: true, cancelEnabled: true, onFinish: vi.fn(), onUndo: vi.fn(), onCancel: vi.fn() };
}
function render(value: FloatingTransformActionsProps) {
  let tree: ReactNode;
  function Capture() { tree = FloatingSelectionActions(value); return tree; }
  return { markup: renderToStaticMarkup(createElement(Capture)), tree: tree! };
}
const button = (tree: ReactNode, name: string) => find<Button>(tree, (value, type) => type === 'button' && value['aria-label'] === name)!;

describe('desktop transform gizmo floating actions', () => {
  it('presents Check / Undo / Cancel with exact desktop copy and independent readiness', () => {
    const value = render({ ...props(), finishEnabled: false, undoEnabled: false, scale: 1.25 });
    const labels = ['Finish transform tool (Enter)', 'Undo transform', 'Cancel transforms (Esc)'];
    expect([...value.markup.matchAll(/<button\b[^>]*aria-label="([^"]+)"/g)].map(match => match[1])).toEqual(labels);
    for (const label of labels) expect(button(value.tree, label).title).toBe(label);
    expect(button(value.tree, labels[0]).disabled).toBe(true); expect(button(value.tree, labels[1]).disabled).toBe(true);
    expect(button(value.tree, labels[2]).disabled).toBe(false);
    for (const icon of ['Check', 'Undo', 'Cancel']) expect(value.markup).toContain(currentDesktopIcons[icon] ?? desktopIcons[icon]);
    expect(value.markup).toContain('transform-gizmo-finish'); expect(value.markup).toContain('--selection-action-scale:1.25');
    expect(value.markup).not.toContain('Clear selection'); expect(value.markup).not.toContain('aria-label="Undo"');
  });
  it.each([
    ['Finish transform tool (Enter)', 'onFinish'], ['Undo transform', 'onUndo'], ['Cancel transforms (Esc)', 'onCancel'],
  ] as const)('routes %s exclusively to its explicit transform action', (label, callback) => {
    const value = props(), tree = render(value).tree, stopPropagation = vi.fn();
    button(tree, label).onClick!({ stopPropagation } as unknown as Parameters<NonNullable<Button['onClick']>>[0]);
    expect(stopPropagation).toHaveBeenCalledTimes(1); expect(value[callback]).toHaveBeenCalledExactlyOnceWith();
    for (const other of ['onFinish', 'onUndo', 'onCancel'] as const) if (other !== callback) expect(value[other]).not.toHaveBeenCalled();
  });
  it('keeps transform cancellation distinct from selection clearing in the shared shell', () => {
    const value = props(), tree = TransformGizmoActions(value);
    expect(tree.type).toBe(FloatingSelectionActions); expect(tree.props.kind).toBe('transform');
    expect(tree.props.onCancel).toBe(value.onCancel); expect(tree.props).not.toHaveProperty('onClear');
    expect(tree.props).not.toHaveProperty('clearEnabled');
  });
  it.each([
    ['es', ['Finalizar transformación (Enter)', 'Deshacer transformación', 'Cancelar transformaciones (Esc)']],
    ['fr', ['Terminer la transformation (Entrée)', 'Annuler la dernière transformation', 'Abandonner les transformations (Échap)']],
    ['de', ['Transformation abschließen (Enter)', 'Transformation rückgängig', 'Transformationen abbrechen (Esc)']],
    ['pt', ['Concluir transformação (Enter)', 'Desfazer transformação', 'Cancelar transformações (Esc)']],
    ['zh-Hans', ['完成变换工具（Enter）', '撤销变换', '取消变换（Esc）']],
    ['ja', ['変換ツールを終了（Enter）', '変換を元に戻す', '変換をキャンセル（Esc）']],
    ['ko', ['변환 도구 완료 (Enter)', '변환 실행 취소', '변환 취소 (Esc)']],
  ] as const)('resolves exact desktop action rows308-310 in %s', (locale, expected) => {
    expect(['Finish transform tool (Enter)', 'Undo transform', 'Cancel transforms (Esc)'].map(key => translate(key, locale))).toEqual(expected);
  });
});

describe('admitted transform gizmo keyboard ownership', () => {
  const event = (key: string, patch: Partial<Parameters<typeof handleTransformGizmoKey>[0]> = {}) => ({
    key, repeat: false, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, isComposing: false,
    defaultPrevented: false, preventDefault: vi.fn(), ...patch,
  });
  const actions = () => ({ captured: false, canUndo: true, onFinish: vi.fn(), onUndo: vi.fn(), onCancel: vi.fn(), onCancelDrag: vi.fn() });
  it.each([['Enter', false, 'onFinish'], ['Escape', false, 'onCancel'], ['z', true, 'onUndo']] as const)(
    'routes idle %s to its session action', (key, primary, callback) => {
      const value = actions(), keyEvent = event(key, primary ? { ctrlKey: true } : {});
      expect(handleTransformGizmoKey(keyEvent, primary, value)).toBe(true); expect(value[callback]).toHaveBeenCalledExactlyOnceWith();
      expect(keyEvent.preventDefault).toHaveBeenCalledTimes(1);
    });
  it('cancels an unfinished first drag before any eligible history and consumes held repeats', () => {
    const value = { ...actions(), captured: true, canUndo: false };
    expect(handleTransformGizmoKey(event('z', { metaKey: true }), true, value)).toBe(true);
    expect(value.onCancelDrag).toHaveBeenCalledExactlyOnceWith(); expect(value.onUndo).not.toHaveBeenCalled();
    expect(handleTransformGizmoKey(event('z', { metaKey: true, repeat: true }), true, value)).toBe(true);
    expect(value.onCancelDrag).toHaveBeenCalledTimes(1);
    expect(handleTransformGizmoKey(event('Enter'), false, value)).toBe(true); expect(value.onFinish).not.toHaveBeenCalled();
  });
  it('allows generic history fallback at the session baseline', () => {
    const value = { ...actions(), canUndo: false }, keyEvent = event('z', { ctrlKey: true });
    expect(handleTransformGizmoKey(keyEvent, true, value)).toBe(false); expect(keyEvent.preventDefault).not.toHaveBeenCalled();
    expect(value.onUndo).not.toHaveBeenCalled();
  });
  it.each([
    ['z', true, { ctrlKey: true, shiftKey: true }], ['Escape', false, { altKey: true }],
    ['Enter', false, { isComposing: true }], ['Escape', false, { defaultPrevented: true }], ['c', false, {}],
  ] as const)('leaves %s (%j) with its prior owner', (key, primary, patch) => {
    const value = actions(), keyEvent = event(key, patch);
    expect(handleTransformGizmoKey(keyEvent, primary, value)).toBe(false); expect(keyEvent.preventDefault).not.toHaveBeenCalled();
    for (const callback of ['onFinish', 'onUndo', 'onCancel', 'onCancelDrag'] as const) expect(value[callback]).not.toHaveBeenCalled();
  });
});
