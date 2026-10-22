import { wheelTicks } from './navigation';

export interface WheelInput {
  readonly deltaY: number;
  readonly deltaMode: number;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly defaultPrevented: boolean;
}

export interface WheelContext {
  /** Wheel follows the pointer, independently of keyboard focus. */
  readonly overScene: boolean;
  readonly tutorial: boolean;
  readonly modal: boolean;
  readonly menu: boolean;
  readonly gizmo: boolean;
  readonly brushTool: boolean;
  readonly canResizeBrush: boolean;
  readonly canNavigate: boolean;
}

export interface WheelDecision {
  readonly action: 'none' | 'browser' | 'blocked' | 'brush' | 'camera';
  readonly ticks: number;
  readonly preventDefault: boolean;
}

/** Browser zoom precedes scene ownership; UI/modal admission precedes Alt-size. */
export function admitWheel(input: WheelInput, context: WheelContext): WheelDecision {
  const idle = (action: WheelDecision['action'] = 'none'): WheelDecision =>
    ({ action, ticks: 0, preventDefault: false });
  if (input.defaultPrevented || !context.overScene) return idle();
  // Chromium and Safari represent a trackpad pinch as Ctrl-wheel. Never turn
  // browser magnification into camera movement or brush resizing.
  if (input.ctrlKey || input.metaKey) return idle('browser');
  const ticks = wheelTicks(input.deltaY, input.deltaMode);
  if (!Number.isFinite(ticks) || ticks === 0) return idle();
  const blocked = (): WheelDecision => ({ action: 'blocked', ticks: 0, preventDefault: true });
  if (context.tutorial || context.modal || context.menu || context.gizmo) return blocked();
  if (input.altKey && context.brushTool)
    return context.canResizeBrush ? { action: 'brush', ticks, preventDefault: true } : blocked();
  return context.canNavigate ? { action: 'camera', ticks, preventDefault: true } : blocked();
}
