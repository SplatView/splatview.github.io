import type { ReactNode } from 'react';
import { useDialogFocus } from '../useDialogFocus';

export type ModalFocusOptions = Omit<Parameters<typeof useDialogFocus>[0], 'initialFocus' | 'onEscape'>;
export function ModalFrame({ label, focus, onEscape, floating = false, children }: {
  label: string; focus: ModalFocusOptions; onEscape?(): void; floating?: boolean; children: ReactNode;
}) {
  const panel = useDialogFocus({ ...focus, onEscape });
  const contents = <div ref={panel} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}
    className={floating ? 'output-dialog' : 'dialog panel'}>{children}</div>;
  return floating ? contents : <div className="dialog-backdrop">{contents}</div>;
}
