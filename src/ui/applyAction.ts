// Transient web Apply rows disappear after acknowledgment. Return keyboard
// focus only after success, while the original control still belongs to the UI.
export function applyAction(button: HTMLButtonElement, target: HTMLElement | null | undefined,
  action: () => void | Promise<boolean>) {
  const ownedFocus = document.activeElement === button;
  void Promise.resolve(action()).then(accepted => {
    if (accepted === true && ownedFocus && target?.isConnected && !target.matches(':disabled') &&
      (document.activeElement === button || document.activeElement === document.body)) target.focus({ preventScroll: true });
  });
}
