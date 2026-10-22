import type { FloatingTransformActionsProps } from './FloatingSelectionActions';
import { FloatingSelectionActions } from './FloatingSelectionActions';

type GizmoKey = Pick<KeyboardEvent, 'key' | 'repeat' | 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey' | 'isComposing' | 'defaultPrevented' | 'preventDefault'>;
/** Call after input ownership admission. At the session baseline Undo falls
 * through to ordinary history; a captured drag consumes it before history. */
export function handleTransformGizmoKey(event: GizmoKey, primary: boolean, actions: {
  captured: boolean; canUndo: boolean; onFinish(): void; onUndo(): void; onCancel(): void; onCancelDrag(): void;
}): boolean {
  if (event.defaultPrevented || event.isComposing || event.altKey) return false;
  const plain = !primary && !event.ctrlKey && !event.metaKey;
  let action: (() => void) | undefined;
  if (plain && event.key === 'Escape') action = actions.onCancel;
  else if (plain && event.key === 'Enter') action = actions.captured ? undefined : actions.onFinish;
  else if (primary && !event.shiftKey && event.key.toLowerCase() === 'z') {
    if (actions.captured) action = actions.onCancelDrag;
    else if (actions.canUndo) action = actions.onUndo;
    else return false;
  } else return false;
  event.preventDefault();
  if (!event.repeat) action?.();
  return true;
}

/** Desktop viewport_tools.cpp:412-454. Cancel restores all session transforms;
 * it deliberately has a separate callback from selection Clear. */
export function TransformGizmoActions(props: Omit<FloatingTransformActionsProps, 'kind'>) {
  return <FloatingSelectionActions {...props} kind="transform" />;
}
