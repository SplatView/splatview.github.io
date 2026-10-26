import type { AppController } from '../app/controller';
import { useApp } from '../app/store';
import { useTranslation } from '../app/useLanguageAppearance';
import type { GaussianRenderMode, SteadySettings } from '../renderer/steadySettings';
import type { GraphicsBackendPreference } from '../renderer/backend';

export function RenderSettings({ controller }: { controller: AppController }) {
  const { t, locale } = useTranslation();
  const settings = useApp(state => state.renderSettings), status = useApp(state => state.renderStatus);
  const geometry = useApp(state => !!state.summary && state.summary.kind !== 0);
  const fallback = useApp(state => state.graphicsFallbackReason);
  const update = (patch: Partial<SteadySettings>) => controller.setRenderSettings({ ...settings, ...patch });
  if (geometry) return null;
  return <section className="render-settings" aria-label={t('Rendering')}>
    <h2>{t('Rendering')}</h2>
    {fallback && <p role="status">{t('WebGPU is unavailable. Using WebGL2.')}</p>}
    <label className="render-settings-row"><span>{t('Renderer')}</span>
      <select aria-label={t('Gaussian renderer')} value={settings.mode} onChange={event => update({ mode: event.target.value as GaussianRenderMode })}>
        <option value="sorted">{t('Sorted (default)')}</option><option value="steady">SteadySplats</option>
      </select>
    </label>
    {settings.mode === 'steady' && <>
      <details className="settings-details steady-options"><summary>{t('SteadySplats options')}</summary>
      <label className="render-settings-row"><span>{t('History weight')}</span><span className="render-history-weight slider-control">
        <input type="range" min="0" max="0.95" step="0.05" aria-label={t('History weight')} value={settings.historyWeight}
          onChange={event => update({ historyWeight: Number(event.target.value) })} />
        <output>{settings.historyWeight.toLocaleString(locale, { maximumFractionDigits: 2 })}</output>
      </span></label>
      <label className="render-settings-row"><span>{t('Animate samples')}</span><input type="checkbox" checked={settings.animate}
        onChange={event => update({ animate: event.target.checked })} /></label>
      <label className="render-settings-row"><span>{t('Converge at rest')}</span><input type="checkbox" checked={settings.convergence}
        disabled={!settings.animate || settings.historyWeight === 0} onChange={event => update({ convergence: event.target.checked })} /></label>
      <label className="render-settings-row"><span>{t('Refinement frames')}</span><select aria-label={t('Refinement frames')}
        value={settings.convergenceFrames} disabled={!settings.convergence || !settings.animate || settings.historyWeight === 0}
        onChange={event => update({ convergenceFrames: Number(event.target.value) })}>
        {[16,64,256,1024].map(value => <option key={value} value={value}>{value}</option>)}
      </select></label>
      <p>{t('Capture and saved-view images use sorted rendering.')}</p>
      </details>
      {status === 'preparing' && <p role="status">{t('Preparing SteadySplats…')}</p>}
      {status === 'unavailable' && <p role="status">{t('SteadySplats is unavailable for this view. Using sorted rendering.')}</p>}
    </>}
  </section>;
}

/** Manual session overrides and technical details belong with support tools. */
export function GraphicsDiagnostics({ controller }: { controller: AppController }) {
  const { t } = useTranslation();
  const preference = useApp(state => state.backendPreference), backend = useApp(state => state.graphicsBackend);
  const fallback = useApp(state => state.graphicsFallbackReason);
  const locked = useApp(state => !!state.summary || state.busy || state.rendererState === 'recovering' || state.bootstrapState === 'initializing');
  return <details className="graphics-diagnostics settings-details">
    <summary>{t('Graphics diagnostics')}</summary>
    <label className="render-settings-row"><span>{t('Graphics backend')}</span>
      <select aria-label={t('Graphics backend')} value={preference} disabled={locked}
        onChange={event => {
          const select = event.currentTarget, focused = document.activeElement === select;
          void controller.setBackendPreference(select.value as GraphicsBackendPreference).finally(() => requestAnimationFrame(() => {
            if (focused && select.isConnected && !select.disabled && (document.activeElement === select || document.activeElement === document.body)) select.focus();
          }));
        }}>
        <option value="auto">{t('Automatic (WebGPU first)')}</option><option value="webgpu">WebGPU</option><option value="webgl2">WebGL2</option>
      </select>
    </label>
    <p>{t('Active backend')}: {backend === 'webgpu' ? 'WebGPU' : backend === 'webgl2' ? 'WebGL2' : t('Unavailable')}</p>
    <p>{t('Backend changes require closing the scene and apply to this session only.')}</p>
    <pre>{JSON.stringify({ backend, fallbackReason: fallback, observation: controller.renderer?.negotiationSnapshot ?? null }, null, 2)}</pre>
  </details>;
}
