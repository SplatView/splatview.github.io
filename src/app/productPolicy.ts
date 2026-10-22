import { productAllowed, productTokens } from '../generated/product-policy';
import { registeredAllowed } from '../generated/product-adapter';

export { productTokens };
/** Product scope supplements worker/codec/GPU admission; it grants no file authority. */
export function webFeatureAllowed(feature: string, capabilities: readonly string[] = []): boolean {
  return productAllowed(feature, 'web', 'web-lite', 'ui', 'editor', capabilities);
}
export function browserProductCapabilities(): readonly string[] {
  const capabilities: string[] = [];
  if (typeof document !== 'undefined' && typeof document.documentElement.requestFullscreen === 'function') capabilities.push('fullscreen');
  if (globalThis.isSecureContext && typeof navigator !== 'undefined' && typeof navigator.clipboard?.write === 'function') capabilities.push('clipboard');
  try { if (globalThis.localStorage) capabilities.push('local_storage'); } catch { /* Existing persistence owner supplies its fallback. */ }
  return capabilities;
}
export function tutorialTargetAllowed(target: string, capabilities: readonly string[] = browserProductCapabilities()): boolean {
  return registeredAllowed(`TutorialTarget.${target}`, 'ui', capabilities);
}
export function requireWorkerProductCommand(value: unknown): void {
  if (!value || typeof value !== 'object' || !('command' in value) || typeof value.command !== 'string')
    throw new Error('A registered worker command is required.');
  if (!registeredAllowed(`WorkerCommand.${value.command}`, 'ui'))
    throw new Error(`This action is unavailable in the lightweight web editor: ${value.command}`);
  if ('rangeEnabled' in value && value.rangeEnabled === true && !webFeatureAllowed('selection.advanced'))
    throw new Error('Selection range is unavailable in the lightweight web editor.');
  if ('selectionView' in value && value.selectionView != null && !webFeatureAllowed('selection.advanced'))
    throw new Error('Current-view selection is unavailable in the lightweight web editor.');
}
