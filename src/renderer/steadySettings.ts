/** Session-only display preferences; these never enter a scene or saved-view format. */
export type GaussianRenderMode = 'sorted' | 'steady';
export type SteadySettings = Readonly<{
  mode: GaussianRenderMode; historyWeight: number; convergence: boolean; convergenceFrames: number; animate: boolean;
}>;
export type SteadyStatus = 'sorted' | 'preparing' | 'steady' | 'unavailable';
export const DEFAULT_STEADY_SETTINGS: SteadySettings = Object.freeze({
  mode: 'sorted', historyWeight: .7, convergence: true, convergenceFrames: 16, animate: true,
});
export function validateSteadySettings(value: SteadySettings): SteadySettings {
  if (!value || (value.mode !== 'sorted' && value.mode !== 'steady') ||
      !Number.isFinite(value.historyWeight) || value.historyWeight < 0 || value.historyWeight > .95 ||
      typeof value.convergence !== 'boolean' || typeof value.animate !== 'boolean' ||
      !Number.isInteger(value.convergenceFrames) || value.convergenceFrames < 1 || value.convergenceFrames > 1024)
    throw new RangeError('Invalid Gaussian rendering settings.');
  return Object.freeze({ mode: value.mode, historyWeight: value.historyWeight,
    convergence: value.convergence, convergenceFrames: value.convergenceFrames, animate: value.animate });
}
