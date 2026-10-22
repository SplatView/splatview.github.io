import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { desktopIcons } from '../src/generated/desktop';
import { currentDesktopIcons } from '../src/generated/currentDesktopIcons';
import { Icon } from '../src/ui/Icon';

const capture = 'reference/targets/windows-r0-20261012-02';
const currentSource = `${capture}/source`;
const pivotCapture = 'reference/targets/windows-pivot-20261016-01';
const pivotSource = `${pivotCapture}/source`;
const reviewed = {
  'src/icons.def': { bytes: 2692, sha256: '19da533f1f72f70ba86f4782d435a25257ad4db4a77afaf7cbea3c748cf23d72' },
  'assets/icons/selection-grow.svg': { bytes: 325, sha256: '6ef8dce31dcd358cc4f7bb665c9fbbae402c2c3f97f274ff1f9e480d46ed67b5' },
  'assets/icons/selection-shrink.svg': { bytes: 346, sha256: '398ac533fbfc7e693d1bc51aa9bda1716b40b014cd3713eb5344482df0e6eb35' },
  'assets/icons/pivot-center.svg': { bytes: 260, sha256: '371619a63f9a803ed520beb9319639e36963d7c4f5c8034790774bd29c500142' },
} as const;
const pivotReviewed = {
  'src/icons.def': { bytes: 2768, sha256: 'ad6d4bfdb71fa00f5e19b462eb5c518bf0da5d67f2ef013ea30e1da6d77e6ea6' },
  'assets/icons/pivot-selection.svg': { bytes: 324, sha256: 'f85caf6effc4aa768ee08734ca0c5106081d30983dd6e14dc9bc17c51e78fcf7' },
  'assets/icons/pivot-origin.svg': { bytes: 312, sha256: 'd5357c49ada218878f065839a7098b6199048104bf61d5e62a4168bfbf891957' },
} as const;
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const projects: string[] = [];
afterEach(() => {
  for (const project of projects.splice(0)) {
    // Only the exact mkdtemp directory beneath the OS temporary directory is removed.
    if (dirname(resolve(project)) !== resolve(tmpdir()) || !project.includes('splatview-icon-assets-'))
      throw new Error('Unexpected temporary icon-test directory');
    rmSync(project, { recursive: true, force: true });
  }
});
function project() {
  const folder = mkdtempSync(join(tmpdir(), 'splatview-icon-assets-')); projects.push(folder);
  const baseline = readFileSync('reference/windows/src/icons.def', 'utf8');
  const names = [...baseline.matchAll(/SPLAT_ICON\(\w+, "([^"]+)"\)/g)].map(match => match[1]);
  const paths = ['tools/generate-assets.py', 'src/generated/desktop.ts', 'src/generated/currentDesktopIcons.ts',
    'reference/windows/src/icons.def', 'reference/windows/src/color.hpp', 'reference/windows/src/gsmod_presets.json',
    'reference/windows/assets/icons/copy.svg',
    ...names.map(name => `reference/windows/assets/icons/${name}.svg`), `${capture}/CAPTURE_MANIFEST.json`,
    ...Object.keys(reviewed).map(path => `${currentSource}/${path}`), `${pivotCapture}/CAPTURE_MANIFEST.json`,
    ...Object.keys(pivotReviewed).map(path => `${pivotSource}/${path}`)];
  for (const path of paths) {
    const target = join(folder, path); mkdirSync(dirname(target), { recursive: true }); copyFileSync(path, target);
  }
  return folder;
}
function generate(folder: string, check = true) {
  return spawnSync('python', ['tools/generate-assets.py', ...(check ? ['--check'] : [])],
    { cwd: folder, encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 1_048_576 });
}

describe('captured desktop selection icons', () => {
  it('preserves the 73-icon baseline and supplements reviewed controls with the existing Duplicate copy asset', () => {
    expect(Object.keys(desktopIcons)).toHaveLength(73);
    expect(sha(readFileSync('src/generated/desktop.ts'))).toBe('aac4e0622fcd225a06ac70831effbdaedb1373ff4ad61325d29428ac9541b313');
    expect(Object.keys(currentDesktopIcons)).toEqual(['Grow', 'Shrink', 'CenterPivot', 'SelectionPivot', 'OriginPivot', 'Duplicate']);
    expect(currentDesktopIcons.Duplicate).toBe(readFileSync('reference/windows/assets/icons/copy.svg', 'utf8'));
    expect(sha(readFileSync('public/icons/copy.svg'))).toBe('ea80e566c7a12628a447cb53179b19aea4f60b9143e2becd0d0f20bf260e5718');
    const manifest = JSON.parse(readFileSync(`${capture}/CAPTURE_MANIFEST.json`, 'utf8')) as {
      captureId: string; files: { path: string; bytes: number; sha256: string }[];
    };
    expect(manifest.captureId).toBe('cc71f0df-8f38-4900-8aff-5c9ee0d6814c');
    for (const [path, expected] of Object.entries(reviewed)) {
      expect(manifest.files.filter(record => record.path === path)).toEqual([{ path, ...expected }]);
      const bytes = readFileSync(`${currentSource}/${path}`);
      expect(bytes.byteLength).toBe(expected.bytes); expect(sha(bytes)).toBe(expected.sha256);
    }
    const definitions = readFileSync(`${currentSource}/src/icons.def`, 'utf8');
    for (const [name, filename] of [['Grow', 'selection-grow'], ['Shrink', 'selection-shrink'], ['CenterPivot', 'pivot-center']] as const) {
      expect([...definitions.matchAll(new RegExp(`SPLAT_ICON\\(${name}, "([^\\"]+)"\\)`, 'g'))]
        .map(match => match[1])).toEqual([filename]);
      expect(currentDesktopIcons[name]).toBe(readFileSync(`${currentSource}/assets/icons/${filename}.svg`, 'utf8'));
      expect(currentDesktopIcons[name]).not.toBe(desktopIcons.Help);
    }
    expect(readFileSync('public/icons/pivot-center.svg')).toEqual(readFileSync(`${currentSource}/assets/icons/pivot-center.svg`));
  });

  it('keeps the later pivot assets in their finite exact desktop source capture', () => {
    const manifest = JSON.parse(readFileSync(`${pivotCapture}/CAPTURE_MANIFEST.json`, 'utf8')) as {
      schemaVersion: number; captureId: string; desktopCommit: string; desktopVersion: string;
      files: { path: string; bytes: number; sha256: string }[]; mappings: Record<string, string>;
    };
    expect(manifest.schemaVersion).toBe(1); expect(manifest.captureId).toBe('windows-pivot-20261016-01');
    expect(manifest.desktopCommit).toBe('4e1be155511fb49f08fd8c863d785ac008a4c43a'); expect(manifest.desktopVersion).toBe('1.0.2');
    for (const [path, expected] of Object.entries(pivotReviewed)) {
      expect(manifest.files.filter(record => record.path === path)).toEqual([{ path, ...expected }]);
      const bytes = readFileSync(`${pivotSource}/${path}`);
      expect(bytes.byteLength).toBe(expected.bytes); expect(sha(bytes)).toBe(expected.sha256);
    }
    const definitions = readFileSync(`${pivotSource}/src/icons.def`, 'utf8');
    for (const [name, filename] of [['SelectionPivot', 'pivot-selection'], ['OriginPivot', 'pivot-origin']] as const) {
      expect(manifest.mappings[name]).toBe(filename);
      expect([...definitions.matchAll(new RegExp(`SPLAT_ICON\\(${name}, "([^\\"]+)"\\)`, 'g'))]
        .map(match => match[1])).toEqual([filename]);
      const svg = readFileSync(`${pivotSource}/assets/icons/${filename}.svg`);
      expect(currentDesktopIcons[name]).toBe(svg.toString('utf8'));
      expect(readFileSync(`public/icons/${filename}.svg`)).toEqual(svg);
      expect(currentDesktopIcons[name]).not.toBe(desktopIcons.Help);
    }
    expect(definitions).toContain('SPLAT_ICON(PickCenter, "crosshair")');
    expect(desktopIcons.PickCenter).toBe(readFileSync('reference/windows/assets/icons/crosshair.svg', 'utf8'));
  });

  it('renders every explicit morphology control icon from its desktop asset instead of the Help fallback', () => {
    const morphology = readFileSync('src/ui/SelectionMorphology.tsx', 'utf8');
    const names = [...morphology.matchAll(/<Icon name="([^"]+)"/g)].map(match => match[1]);
    expect(names).toEqual(['Grow', 'Shrink', 'Sphere', 'Ellipsoid']);
    for (const name of names) {
      const svg = currentDesktopIcons[name] ?? desktopIcons[name];
      expect(svg, `Explicit desktop icon ${name} must resolve`).toBeDefined();
      expect(svg.trim().length).toBeGreaterThan(0); expect(svg).toMatch(/^<svg\b/);
      expect(svg).not.toBe(desktopIcons.Help);
      expect(renderToStaticMarkup(createElement(Icon, { name })))
        .toBe(`<span aria-hidden="true" class="icon">${svg}</span>`);
    }
  });

  it('checks both generations and leaves the exact baseline bytes intact when generating the supplement', () => {
    const folder = project(), baseline = readFileSync(join(folder, 'src/generated/desktop.ts'));
    const check = generate(folder); expect(check.status, check.stderr).toBe(0);
    writeFileSync(join(folder, 'src/generated/currentDesktopIcons.ts'), '// stale supplement\n');
    const stale = generate(folder); expect(stale.status).not.toBe(0);
    expect(stale.stderr).toContain('Generated current desktop icons differ');
    const rebuilt = generate(folder, false); expect(rebuilt.status, rebuilt.stderr).toBe(0);
    expect(readFileSync(join(folder, 'src/generated/desktop.ts'))).toEqual(baseline);
    expect(readFileSync(join(folder, 'src/generated/currentDesktopIcons.ts')))
      .toEqual(readFileSync('src/generated/currentDesktopIcons.ts'));
    const final = generate(folder); expect(final.status, final.stderr).toBe(0);
  });

  it.each(['assets/icons/selection-grow.svg', 'assets/icons/selection-shrink.svg', 'assets/icons/pivot-center.svg', 'src/icons.def'])(
    'refuses changed captured %s before generating or touching either output', path => {
      const folder = project(), baseline = readFileSync(join(folder, 'src/generated/desktop.ts'));
      const supplement = readFileSync(join(folder, 'src/generated/currentDesktopIcons.ts'));
      writeFileSync(join(folder, currentSource, path), `${readFileSync(join(folder, currentSource, path), 'utf8')}\n`);
      const refused = generate(folder, false);
      expect(refused.status).not.toBe(0); expect(refused.stderr).toContain('differs from its capture manifest');
      expect(readFileSync(join(folder, 'src/generated/desktop.ts'))).toEqual(baseline);
      expect(readFileSync(join(folder, 'src/generated/currentDesktopIcons.ts'))).toEqual(supplement);
    });

  it('refuses an edited asset and matching edited manifest that no longer match the reviewed capture', () => {
    const folder = project(), path = 'assets/icons/selection-grow.svg';
    const svg = Buffer.from(readFileSync(join(folder, currentSource, path), 'utf8').replace('width="6"', 'width="7"'));
    writeFileSync(join(folder, currentSource, path), svg);
    const manifestPath = join(folder, capture, 'CAPTURE_MANIFEST.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { files: { path: string; bytes: number; sha256: string }[] };
    const entry = manifest.files.find(record => record.path === path)!;
    entry.bytes = svg.byteLength; entry.sha256 = sha(svg); writeFileSync(manifestPath, JSON.stringify(manifest));
    const refused = generate(folder); expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain('manifest differs from the reviewed capture');
  });

  it.each(Object.keys(pivotReviewed))('refuses changed pivot capture %s before touching either output', path => {
    const folder = project(), baseline = readFileSync(join(folder, 'src/generated/desktop.ts'));
    const supplement = readFileSync(join(folder, 'src/generated/currentDesktopIcons.ts'));
    writeFileSync(join(folder, pivotSource, path), `${readFileSync(join(folder, pivotSource, path), 'utf8')}\n`);
    const refused = generate(folder, false);
    expect(refused.status).not.toBe(0); expect(refused.stderr).toContain('differs from its capture manifest');
    expect(readFileSync(join(folder, 'src/generated/desktop.ts'))).toEqual(baseline);
    expect(readFileSync(join(folder, 'src/generated/currentDesktopIcons.ts'))).toEqual(supplement);
  });

  it('refuses rewritten pivot provenance even when it matches altered source bytes', () => {
    const folder = project(), path = 'assets/icons/pivot-selection.svg';
    const svg = Buffer.from(`${readFileSync(join(folder, pivotSource, path), 'utf8')}\n`);
    writeFileSync(join(folder, pivotSource, path), svg);
    const manifestPath = join(folder, pivotCapture, 'CAPTURE_MANIFEST.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { files: { path: string; bytes: number; sha256: string }[] };
    const entry = manifest.files.find(record => record.path === path)!;
    entry.bytes = svg.byteLength; entry.sha256 = sha(svg); writeFileSync(manifestPath, JSON.stringify(manifest));
    const refused = generate(folder); expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain('manifest differs from the reviewed capture');
  });
});
