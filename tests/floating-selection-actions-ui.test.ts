import { Children, createElement, isValidElement, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { FloatingSelectionActions, handleFloatingSelectionKey, placeSelectionActions, type FloatingSelectionActionsProps, type SelectionActionObstacle } from '../src/ui/FloatingSelectionActions';
import { ManualSelectionFeedback } from '../src/ui/ManualSelectionFeedback';
import { FilterOverlay } from '../src/ui/FilterOverlay';
import { filterDefaults } from '../src/document/filterProtocol';
import { currentDesktopIcons } from '../src/generated/currentDesktopIcons';
import { desktopIcons } from '../src/generated/desktop';

type Button = ButtonHTMLAttributes<HTMLButtonElement>;
type Click = Parameters<NonNullable<Button['onClick']>>[0];
type Container = HTMLAttributes<HTMLDivElement>;
function find<T extends { children?: ReactNode }>(tree: ReactNode, matches: (props: T, type: unknown) => boolean): T | undefined {
  for (const node of Children.toArray(tree)) {
    if (!isValidElement<T>(node)) continue;
    if (matches(node.props, node.type)) return node.props;
    const value = find(node.props.children, matches); if (value) return value;
  }
}
function props(kind: 'manual' | 'filter' = 'manual'): FloatingSelectionActionsProps {
  return { scene: { current: null }, kind, enabled: true, chromeVisible: true, scale: 1,
    finishEnabled: true, undoEnabled: true, clearEnabled: true, onFinish: vi.fn(), onUndo: vi.fn(), onClear: vi.fn() };
}
function render(value = props()) {
  let tree: ReactNode;
  function Capture() { tree = FloatingSelectionActions(value); return tree; }
  return { markup: renderToStaticMarkup(createElement(Capture)), tree: tree! };
}
const button = (tree: ReactNode, label: string) => find<Button>(tree, (value, type) => type === 'button' && value['aria-label'] === label)!;

describe('committed floating Check / Undo / X selection controls', () => {
  it.each(['manual', 'filter'] as const)('renders exactly three ordered current desktop icons and action tooltips for %s', kind => {
    const value = render(props(kind)), finish = kind === 'manual' ? 'Finalize selection' : 'Confirm filter';
    const undo = kind === 'manual' ? 'Undo (Selection)' : 'Undo (Filter)';
    expect([...value.markup.matchAll(/<button\b[^>]*aria-label="([^"]+)"/g)].map(match => match[1]))
      .toEqual([finish, undo, 'Clear selection (C)']);
    expect(button(value.tree, finish).title).toBe(kind === 'manual' ? 'Finish selection tool (keeps selection)' : 'Confirm filter (Enter)');
    expect(button(value.tree, undo).title).toBe('Undo'); expect(button(value.tree, 'Clear selection (C)').title).toBe('Clear selection (C)');
    for (const icon of ['Check', 'Undo', 'Cancel']) expect(value.markup).toContain(currentDesktopIcons[icon] ?? desktopIcons[icon]);
    expect(value.markup).not.toContain('Exit selection tool'); expect(value.markup).not.toContain('Cancel filter preview');
    expect(value.markup).toContain(kind === 'manual' ? 'manual-selection-finish' : 'filter-finish');
  });
  it('keeps each readiness gate independent and retains all three actions while placement is initially unmeasured', () => {
    const value = render({ ...props(), finishEnabled: false, clearEnabled: false, scale: 1.25 });
    expect(button(value.tree, 'Finalize selection').disabled).toBe(true);
    expect(button(value.tree, 'Undo (Selection)').disabled).toBe(false); expect(button(value.tree, 'Clear selection (C)').disabled).toBe(true);
    expect(value.markup).toContain('hidden=""'); expect(value.markup).toContain('--selection-action-scale:1.25');
  });
  it.each([
    ['Finalize selection', 'onFinish'], ['Undo (Selection)', 'onUndo'], ['Clear selection (C)', 'onClear'],
  ] as const)('dispatches only %s and consumes the UI click before it reaches scene input', (label, callback) => {
    const value = props(), rendered = render(value), stopPropagation = vi.fn();
    button(rendered.tree, label).onClick!({ stopPropagation } as unknown as Click);
    expect(stopPropagation).toHaveBeenCalledTimes(1); expect(value[callback]).toHaveBeenCalledExactlyOnceWith();
    for (const other of ['onFinish', 'onUndo', 'onClear'] as const) if (other !== callback) expect(value[other]).not.toHaveBeenCalled();
  });
  it('keeps pointer, key and wheel events owned by the floating UI', () => {
    const value = render(), group = find<Container>(value.tree, entry => entry.role === 'group')!;
    const stopPropagation = vi.fn(), event = { stopPropagation };
    group.onPointerDown!(event as unknown as Parameters<NonNullable<Container['onPointerDown']>>[0]);
    group.onPointerUp!(event as unknown as Parameters<NonNullable<Container['onPointerUp']>>[0]);
    group.onKeyDown!(event as unknown as Parameters<NonNullable<Container['onKeyDown']>>[0]);
    group.onKeyUp!(event as unknown as Parameters<NonNullable<Container['onKeyUp']>>[0]);
    group.onWheel!(event as unknown as Parameters<NonNullable<Container['onWheel']>>[0]);
    expect(stopPropagation).toHaveBeenCalledTimes(5);
  });
});

describe('manual and filter action integration', () => {
  it('mounts manual release tracking before display geometry or a selected bit exists', () => {
    const value = props(); let tree: ReactNode;
    function Capture() {
      tree = ManualSelectionFeedback({ ...value, actionsVisible: false, tool: 'polygon', operation: 0, radius: 8,
        geometry: () => ({ rectangle: null, polygon: [], vertices: [], trail: [], radius: 8 }) });
      return tree;
    }
    renderToStaticMarkup(createElement(Capture));
    const shared = find<FloatingSelectionActionsProps & { children?: ReactNode }>(tree!, (_entry, type) => type === FloatingSelectionActions)!;
    expect(shared).toBeDefined(); expect(shared.enabled).toBe(false); expect(shared.onUndo).toBe(value.onUndo); expect(shared.onClear).toBe(value.onClear);
  });
  it('passes filter-specific Undo and Clear callbacks without using cancellation for X', () => {
    const value = props('filter'); let tree: ReactNode;
    function Capture() {
      tree = FilterOverlay({ ...value, kind: 'sphere', parameters: filterDefaults(), camera: undefined, showVolume: false,
        picking: false, pending: false, cursor: null, captured: false, onConfirm: value.onFinish });
      return tree;
    }
    renderToStaticMarkup(createElement(Capture));
    const shared = find<FloatingSelectionActionsProps & { children?: ReactNode }>(tree!, (_entry, type) => type === FloatingSelectionActions)!;
    expect(shared.kind).toBe('filter'); expect(shared.onFinish).toBe(value.onFinish);
    expect(shared.onUndo).toBe(value.onUndo); expect(shared.onClear).toBe(value.onClear);
    expect(shared).not.toHaveProperty('onCancel'); expect(shared.enabled).toBe(true);
  });
});

describe('admitted floating selection keyboard actions', () => {
  const key = (value: string, patch: Partial<Parameters<typeof handleFloatingSelectionKey>[0]> = {}) => ({
    key: value, repeat: false, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, isComposing: false,
    defaultPrevented: false, preventDefault: vi.fn(), ...patch,
  });
  it.each([
    ['c', false, {}, 'onClear'], ['C', false, { shiftKey: true }, 'onClear'],
    ['z', true, { ctrlKey: true }, 'onUndo'], ['z', true, { metaKey: true }, 'onUndo'],
  ] as const)('routes admitted %s primary=%s to the explicit action', (value, primary, patch, name) => {
    const actions = { onUndo: vi.fn(), onClear: vi.fn() }, event = key(value, patch);
    expect(handleFloatingSelectionKey(event, primary, actions)).toBe(true); expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(actions[name]).toHaveBeenCalledExactlyOnceWith();
    expect(actions[name === 'onUndo' ? 'onClear' : 'onUndo']).not.toHaveBeenCalled();
  });
  it('consumes a repeated admitted action without starting another mutation', () => {
    const actions = { onUndo: vi.fn(), onClear: vi.fn() }, event = key('z', { ctrlKey: true, repeat: true });
    expect(handleFloatingSelectionKey(event, true, actions)).toBe(true); expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(actions.onUndo).not.toHaveBeenCalled(); expect(actions.onClear).not.toHaveBeenCalled();
  });
  it.each([
    ['z', true, { shiftKey: true, ctrlKey: true }], ['c', true, { ctrlKey: true }], ['c', false, { ctrlKey: true }],
    ['c', false, { altKey: true }], ['z', true, { isComposing: true }], ['c', false, { defaultPrevented: true }],
    ['Escape', false, {}], ['Enter', false, {}], ['z', false, {}],
  ] as const)('leaves %s primary=%s to its existing owner (%j)', (value, primary, patch) => {
    const actions = { onUndo: vi.fn(), onClear: vi.fn() }, event = key(value, patch);
    expect(handleFloatingSelectionKey(event, primary, actions)).toBe(false); expect(event.preventDefault).not.toHaveBeenCalled();
    expect(actions.onUndo).not.toHaveBeenCalled(); expect(actions.onClear).not.toHaveBeenCalled();
  });
});

describe('desktop release-safe three-button placement', () => {
  function assertClear(anchor: readonly [number, number], viewport: { width: number; height: number }, obstacles: SelectionActionObstacle[], scale: number) {
    const value = placeSelectionActions(anchor, viewport, obstacles, scale); expect(value).not.toBeNull();
    const { left, top } = value!, width = 90 * scale, height = 28 * scale, gap = 4 * scale, inset = 12 * scale;
    expect(left).toBeGreaterThanOrEqual(inset); expect(top).toBeGreaterThanOrEqual(inset);
    expect(left + width).toBeLessThanOrEqual(viewport.width - inset); expect(top + height).toBeLessThanOrEqual(viewport.height - inset);
    expect(anchor[0] >= left && anchor[0] < left + width && anchor[1] >= top && anchor[1] < top + height).toBe(false);
    for (const obstacle of obstacles) expect(left + width <= obstacle.left - gap || left >= obstacle.left + obstacle.width + gap ||
      top + height <= obstacle.top - gap || top >= obstacle.top + obstacle.height + gap).toBe(true);
    return value;
  }
  it('uses the first clear lower-right candidate beside an ordinary release', () => {
    expect(placeSelectionActions([100, 80], { width: 600, height: 400 }, [], 1)).toEqual({ left: 112, top: 92 });
  });
  it.each([1, 1.12, 1.25])('keeps all three buttons visible and off the release near viewport corners at scale %s', scale => {
    for (const anchor of [[0, 0], [599, 0], [0, 399], [599, 399]] as const) assertClear(anchor, { width: 600, height: 400 }, [], scale);
  });
  it('avoids an overlapping Tools panel and toolbar with the required gap', () => {
    const obstacles = [{ left: 360, top: 12, width: 228, height: 376 }, { left: 12, top: 12, width: 60, height: 220 }];
    assertClear([355, 200], { width: 600, height: 400 }, obstacles, 1);
  });
  it('omits controls when the three-button extent or all usable space is unavailable', () => {
    expect(placeSelectionActions([50, 50], { width: 113, height: 400 }, [], 1)).toBeNull();
    expect(placeSelectionActions([50, 25], { width: 600, height: 51 }, [], 1)).toBeNull();
    expect(placeSelectionActions([50, 50], { width: 600, height: 400 }, [{ left: 0, top: 0, width: 600, height: 400 }], 1)).toBeNull();
  });
});
