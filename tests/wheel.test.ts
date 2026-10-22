import { describe, expect, it } from 'vitest';
import { admitWheel, type WheelContext, type WheelInput } from '../src/input/wheel';

const input: WheelInput = { deltaY: -100, deltaMode: 0, ctrlKey: false, metaKey: false, altKey: false, defaultPrevented: false };
const scene: WheelContext = { overScene: true, tutorial: false, modal: false, menu: false, gizmo: false,
  brushTool: false, canResizeBrush: true, canNavigate: true };

describe('pointer-owned wheel admission', () => {
  it('queues fractional pixels, lines and pages with the existing native tick convention', () => {
    for (const [deltaY, deltaMode, ticks] of [[-12.5, 0, .125], [1.5, 1, -.5], [-1, 2, 1]])
      expect(admitWheel({ ...input, deltaY, deltaMode }, scene)).toEqual({ action: 'camera', ticks, preventDefault: true });
  });
  it.each(['ctrlKey', 'metaKey'] as const)('leaves %s browser zoom untouched even over a blocked brush scene', modifier => {
    expect(admitWheel({ ...input, altKey: true, [modifier]: true },
      { ...scene, tutorial: true, modal: true, brushTool: true, canResizeBrush: false }))
      .toEqual({ action: 'browser', ticks: 0, preventDefault: false });
  });
  it('retains a previous handler and keeps UI wheel outside the canvas listener', () => {
    expect(admitWheel({ ...input, defaultPrevented: true }, scene)).toEqual({ action: 'none', ticks: 0, preventDefault: false });
    expect(admitWheel(input, { ...scene, overScene: false })).toEqual({ action: 'none', ticks: 0, preventDefault: false });
  });
  it.each([0, NaN, Infinity, -Infinity])('does no work for empty or invalid vertical delta %s', deltaY => {
    expect(admitWheel({ ...input, deltaY }, scene)).toEqual({ action: 'none', ticks: 0, preventDefault: false });
  });
  it.each(['tutorial', 'modal', 'menu', 'gizmo'] as const)('%s blocks both camera navigation and Alt brush resizing', owner => {
    for (const altKey of [false, true])
      expect(admitWheel({ ...input, altKey }, { ...scene, brushTool: true, [owner]: true }))
        .toEqual({ action: 'blocked', ticks: 0, preventDefault: true });
  });
  it('resizes an admitted Alt brush without camera navigation, and does not fall through when sizing is unavailable', () => {
    expect(admitWheel({ ...input, altKey: true }, { ...scene, brushTool: true, canNavigate: false }))
      .toEqual({ action: 'brush', ticks: 1, preventDefault: true });
    expect(admitWheel({ ...input, altKey: true }, { ...scene, brushTool: true, canResizeBrush: false }))
      .toEqual({ action: 'blocked', ticks: 0, preventDefault: true });
  });
  it('retains Alt camera motion for non-brush tools and respects camera admission', () => {
    expect(admitWheel({ ...input, altKey: true }, scene)).toEqual({ action: 'camera', ticks: 1, preventDefault: true });
    expect(admitWheel(input, { ...scene, canNavigate: false })).toEqual({ action: 'blocked', ticks: 0, preventDefault: true });
  });
});
