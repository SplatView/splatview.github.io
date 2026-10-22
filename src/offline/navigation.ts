/** Keep the controller's unload permission alive until navigation commits or is cancelled. */
export const UPDATE_NAVIGATION_TIMEOUT_MS = 45_000;
export interface UpdateNavigationEnvironment {
  navigation?: { navigate(url: string): { committed?: Promise<unknown>; finished?: Promise<unknown> } };
  location: { assign(url: string): void };
  stop(): void;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}
export function commitUpdateNavigation(url: string, environment: UpdateNavigationEnvironment = window): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true; clearTimeout(timer); environment.removeEventListener('pagehide', hidden);
      if (error) reject(error); else resolve();
    };
    const hidden = () => finish();
    const timer = setTimeout(() => {
      // Actively cancel the owned browser navigation before releasing its unload
      // permission. A timeout alone never counts as a successful transition.
      try { environment.stop(); }
      catch (error) { finish(error); return; }
      finish(new Error('The update navigation was stopped. Your current scene remains open.'));
    }, UPDATE_NAVIGATION_TIMEOUT_MS);
    environment.addEventListener('pagehide', hidden);
    try {
      if (environment.navigation?.navigate) {
        const transition = environment.navigation.navigate(url);
        void transition.finished?.catch(() => undefined);
        if (!transition.committed) throw new Error('The browser did not start the update navigation.');
        void transition.committed.then(() => finish(), error => finish(error));
      } else environment.location.assign(url);
    } catch (error) { finish(error); }
  });
}
