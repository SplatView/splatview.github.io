import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SceneExportDialog } from '../src/ui/dialogs/SceneExportDialog';
import type { SceneExportFormat } from '../src/document/exportFormats';

const renderDialog = (acceptedFormat: SceneExportFormat, disabled = false, count = 10, sourceCount = 10) =>
  renderToStaticMarkup(createElement(SceneExportDialog, {
    acceptedFormat, disabled, count, sourceCount, scope: 0,
    onScopeChange() {}, onCancel() {}, onExport() {},
  }));
const formatOptions = (html: string) => html.match(/<select\b[^>]*\baria-label="Export format"[^>]*>(.*?)<\/select>/)?.[1] ?? '';

describe('scene export dialog menu and opening draft', () => {
  it('renders the desktop order with explicit stable wire values', () => {
    const options = formatOptions(renderDialog(0));
    expect([...options.matchAll(/<option value="(\d+)"/g)].map(match => Number(match[1]))).toEqual([0, 8, 1, 2, 3, 4, 5, 6, 7]);
    expect(options).toContain('<option value="8">SPZ v4 (*.spz)</option>');
    expect(options).toContain('<option value="1">Legacy SPZ v3 (*.spz)</option>');
    expect(options).toContain('SuperSplat compressed PLY (*.compressed.ply)');
  });

  it.each([0, 8, 1, 3, 6, 7] as const)('opens a fresh draft from accepted wire format %s', acceptedFormat => {
    const options = formatOptions(renderDialog(acceptedFormat));
    expect(options.match(/<option value="(\d+)" selected=""/g)).toEqual([`<option value="${acceptedFormat}" selected=""`]);
  });

  it('keeps the existing sampled-preview notice and disabled Download boundary', () => {
    const html = renderDialog(8, true, 3, 10);
    expect(html).toContain('Only the 3 loaded splats will be exported.');
    expect(html).toContain('<button>Cancel</button><button disabled="">Download</button>');
    expect(renderDialog(0)).not.toContain('loaded splats will be exported.');
  });
});
