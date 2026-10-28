import { useRef, useState } from 'react';
import { SCENE_EXPORT_FORMATS, sceneExportDescriptor, type SceneExportFormat } from '../../document/exportFormats';
import { useTranslation } from '../../app/useLanguageAppearance';
import { useDialogFocus } from '../useDialogFocus';
import type { ModalFocusOptions } from './ModalFrame';

export function SceneExportDialog({ acceptedFormat, scope, onScopeChange, count, sourceCount, disabled, onCancel, onExport, focus }: {
  acceptedFormat: SceneExportFormat; scope: number; onScopeChange(scope: number): void;
  count?: number; sourceCount?: number; disabled: boolean; onCancel(): void; onExport(format: SceneExportFormat, scope: number): void; focus?: ModalFocusOptions;
}) {
  const { t, locale } = useTranslation();
  // Each opening mounts a fresh draft. Only the controller's accepted choice is
  // used on the next opening; changing this select or cancelling cannot save it.
  const [format, setFormat] = useState<SceneExportFormat>(acceptedFormat);
  const formatSelect = useRef<HTMLSelectElement>(null);
  const panel = useDialogFocus({ ...focus, onEscape: onCancel, initialFocus: () => formatSelect.current });
  return <div className="dialog-backdrop"><div ref={panel} className="dialog panel" role="dialog" aria-modal="true" tabIndex={-1} aria-label={t("Save scene")}><h1>{t("Save scene")}</h1>
    {count !== undefined && sourceCount !== undefined && count < sourceCount && <p>{t('Only the %s loaded splats will be exported.', count.toLocaleString(locale))}</p>}
    <label>{t("Format")}<select ref={formatSelect} aria-label={t("Export format")} value={format} style={{ minWidth: 0 }} onChange={event => {
      const descriptor = sceneExportDescriptor(Number(event.target.value));
      if (descriptor) setFormat(descriptor.format);
    }}>{SCENE_EXPORT_FORMATS.map(descriptor => <option value={descriptor.format} key={descriptor.format}>{t(descriptor.label)}</option>)}</select></label>
    <label>{t("Scope")}<select aria-label={t("Export scope")} value={scope} onChange={event => onScopeChange(Number(event.target.value))}>{['All', 'Selected', 'Remainder'].map((name, index) => <option value={index} key={name}>{t(name)}</option>)}</select></label>
    <div className="dialog-actions"><button onClick={onCancel}>{t("Cancel")}</button><button onClick={() => onExport(format, scope)} disabled={disabled}>{t("Download")}</button></div>
  </div></div>;
}
