import { Children, createElement, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SelectionActions } from '../src/ui/App';
import { desktopIcons } from '../src/generated/desktop';
import { currentDesktopIcons } from '../src/generated/currentDesktopIcons';

type Props = Parameters<typeof SelectionActions>[0];
type Action = { label?: string; icon?: string; disabled?: boolean; onClick?(): void; children?: ReactNode };
function render(props: Props) {
  let tree: ReactNode;
  // Render the actual component under React's hook dispatcher and retain its
  // returned element tree so the actual action closure can be exercised.
  function Capture() { tree = SelectionActions(props);return tree; }
  const markup = renderToStaticMarkup(createElement(Capture));
  return { markup, tree: tree! };
}
function action(tree: ReactNode, label: string): Action | undefined {
  for (const node of Children.toArray(tree)) {
    if (!isValidElement<Action>(node)) continue;
    if (node.props.label === label) return node.props;
    const found = action(node.props.children, label);if (found) return found;
  }
}
function button(markup: string) {
  return [...markup.matchAll(/<button\b[^>]*>/g)].map(match => match[0]).find(tag => tag.includes('aria-label="Duplicate selection"'));
}

describe('Pro Duplicate selection action', () => {
  it('keeps Duplicate out of Basic and renders its captured icon and guidance in Pro', () => {
    const props = { enabled: true, selected: 2, duplicateEnabled: true, onCommand: vi.fn() };
    const basic = render({ ...props, pro: false });expect(button(basic.markup)).toBeUndefined();
    expect(action(basic.tree, 'Duplicate selection')).toBeUndefined();
    const pro = render({ ...props, pro: true });
    const svg = currentDesktopIcons.Duplicate ?? desktopIcons.Duplicate;
    expect(svg).toMatch(/^<svg\b/);expect(pro.markup).toContain(svg);
    expect(button(pro.markup)).toContain('data-tutorial-target="duplicate"');
    expect(button(pro.markup)).toContain('Copy selected splats in place as a green selection');
    expect(action(pro.tree, 'Duplicate selection')?.icon).toBe('Duplicate');
    expect(props.onCommand).not.toHaveBeenCalled();
  });
  it('dispatches exactly the Duplicate command from the enabled Pro action', () => {
    const onCommand = vi.fn(), value = render({ enabled: true, selected: 2, pro: true, duplicateEnabled: true, onCommand });
    const duplicate = action(value.tree, 'Duplicate selection');
    expect(duplicate).toBeDefined();expect(duplicate!.disabled).toBe(false);
    expect(button(value.markup)).not.toContain('disabled=');
    duplicate!.onClick!();expect(onCommand).toHaveBeenCalledExactlyOnceWith('duplicate');
  });
  it.each([
    { enabled: false, selected: 2, duplicateEnabled: true },
    { enabled: true, selected: 2, duplicateEnabled: false },
    { enabled: true, selected: 0, duplicateEnabled: true },
  ])('disables Pro Duplicate when ordinary or native readiness refuses: %j', props => {
    const onCommand = vi.fn(), value = render({ ...props, pro: true, onCommand });
    expect(action(value.tree, 'Duplicate selection')?.disabled).toBe(true);
    expect(button(value.markup)).toContain('disabled=""');expect(onCommand).not.toHaveBeenCalled();
  });
});
