import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { crc32, gunzipSync } from 'node:zlib';
import { gaussianPly } from '../tests/fixtures/gaussians';
import { chooseSelectionTool } from './selectTool';

const formats = [
  { id: 0, extension: 'ply' }, { id: 1, extension: 'spz' }, { id: 2, extension: 'splat' },
  { id: 3, extension: 'compressed.ply' }, { id: 4, extension: 'ksplat' },
  { id: 5, extension: 'csv' }, { id: 6, extension: 'sog' }, { id: 7, extension: 'sogs' }, { id: 8, extension: 'spz' },
] as const;

// Independent ZIP32 observer for these tiny downloaded stored-member bundles.
// The browser's SOG/ZIP readers are not used to validate the writer's container.
function sogMetadata(bytes: Buffer) {
  const end = bytes.length - 22;
  expect(bytes.readUInt32LE(end)).toBe(0x06054b50);
  expect(bytes.readUInt16LE(end + 4)).toBe(0); expect(bytes.readUInt16LE(end + 6)).toBe(0);
  const count = bytes.readUInt16LE(end + 10), directory = bytes.readUInt32LE(end + 16);
  expect(bytes.readUInt16LE(end + 8)).toBe(count); expect(count).toBe(8);
  expect(bytes.readUInt16LE(end + 20)).toBe(0);
  expect(directory + bytes.readUInt32LE(end + 12)).toBe(end);
  const members = new Map<string, Buffer>(); let at = directory, nextLocal = 0;
  for (let index = 0; index < count; index++) {
    expect(bytes.readUInt32LE(at)).toBe(0x02014b50);
    expect(bytes.readUInt16LE(at + 8)).toBe(8); expect(bytes.readUInt16LE(at + 10)).toBe(0);
    const checksum = bytes.readUInt32LE(at + 16), size = bytes.readUInt32LE(at + 20),
      nameLength = bytes.readUInt16LE(at + 28), extraLength = bytes.readUInt16LE(at + 30),
      commentLength = bytes.readUInt16LE(at + 32), local = bytes.readUInt32LE(at + 42);
    expect(bytes.readUInt32LE(at + 24)).toBe(size); expect(local).toBe(nextLocal);
    const name = bytes.toString('utf8', at + 46, at + 46 + nameLength);
    expect(members.has(name)).toBe(false); expect(bytes.readUInt32LE(local)).toBe(0x04034b50);
    expect(bytes.readUInt16LE(local + 6)).toBe(8); expect(bytes.readUInt16LE(local + 8)).toBe(0);
    expect(bytes.readUInt16LE(local + 26)).toBe(nameLength);
    expect(bytes.toString('utf8', local + 30, local + 30 + nameLength)).toBe(name);
    const start = local + 30 + nameLength + bytes.readUInt16LE(local + 28), descriptor = start + size;
    expect(descriptor + 16).toBeLessThanOrEqual(directory);
    const data = bytes.subarray(start, descriptor);
    expect(data.length).toBe(size); expect(crc32(data)).toBe(checksum);
    expect(bytes.readUInt32LE(descriptor)).toBe(0x08074b50);
    expect(bytes.readUInt32LE(descriptor + 4)).toBe(checksum);
    expect(bytes.readUInt32LE(descriptor + 8)).toBe(size); expect(bytes.readUInt32LE(descriptor + 12)).toBe(size);
    members.set(name, data); nextLocal = descriptor + 16;
    at += 46 + nameLength + extraLength + commentLength;
  }
  expect(at).toBe(end); expect(nextLocal).toBe(directory);
  expect([...members.keys()].sort()).toEqual(['means_l.webp', 'means_u.webp', 'meta.json', 'quats.webp',
    'scales.webp', 'sh0.webp', 'shN_centroids.webp', 'shN_labels.webp'].sort());
  for (const [name, data] of members) if (name.endsWith('.webp')) {
    expect(data.toString('ascii', 0, 4)).toBe('RIFF'); expect(data.readUInt32LE(4) + 8).toBe(data.length);
    expect(data.toString('ascii', 8, 12)).toBe('WEBP'); expect(data.toString('ascii', 12, 16)).toBe('VP8L');
  }
  return JSON.parse(members.get('meta.json')!.toString('utf8'));
}

async function save(page: Page, format: number, scope: number) {
  await page.mouse.move(640, 400);
  await page.getByRole('button', { name: 'Save scene', exact: true }).click();
  const popup = page.getByRole('dialog', { name: 'Save scene', exact: true });
  await popup.getByLabel('Export format', { exact: true }).selectOption(String(format));
  await popup.getByLabel('Export scope', { exact: true }).selectOption(String(scope));
  const pending = page.waitForEvent('download');
  await popup.getByRole('button', { name: 'Download', exact: true }).click();
  const download = await pending, path = await download.path(); expect(path).not.toBeNull();
  const bytes = await readFile(path!);
  await page.getByRole('status').filter({ hasText: 'Download prepared' }).getByRole('button', { name: 'Stay', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  return { bytes, filename: download.suggestedFilename() };
}

for (const format of formats) test(`admitted format ${format.id} preserves all/selected/remainder bytes and executable selection Redo`, async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/'); await expect(page.getByRole('button', { name: 'Open scene', exact: true })).toBeEnabled();
  await page.getByLabel('Open scene files').setInputFiles({ name: 'bounded-sh3.ply', mimeType: 'application/octet-stream', buffer: Buffer.from(gaussianPly()) });
  await expect(page).toHaveTitle('bounded-sh3.ply \u2014 SplatView');
  await page.mouse.move(640, 400); await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const tools = page.getByRole('complementary', { name: 'Tools', exact: true }), stats = tools.locator('.model-stats');
  await tools.getByRole('button', { name: 'Select all', exact: true }).click();
  await tools.getByRole('button', { name: 'Invert selection', exact: true }).click();
  await tools.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(stats).toHaveText('3/3 splats | SH3');
  const all = await save(page, format.id, 0);
  expect(all.filename).toBe(`bounded-sh3-edited.${format.extension}`); expect(all.bytes.length).toBeGreaterThan(0);
  if (format.id === 1) {
    expect([...all.bytes.subarray(0, 2)]).toEqual([0x1f, 0x8b]);
    const payload = gunzipSync(all.bytes);
    expect(payload.readUInt32LE(0)).toBe(0x5053474e); expect(payload.readUInt32LE(4)).toBe(3); expect(payload.readUInt32LE(8)).toBe(3);
    expect(payload[12]).toBe(3);
  } else if (format.id === 2) expect(all.bytes.length).toBe(3 * 32);
  else if (format.id === 4) expect(all.bytes.length).toBe(5132 + 3 * (44 + 12 * 15));
  else if (format.id === 5) expect(all.bytes.toString().trim().split(/\r?\n/)).toHaveLength(4);
  else if (format.id === 8) {
    expect(all.bytes.readUInt32LE(0)).toBe(0x5053474e); expect(all.bytes.readUInt32LE(4)).toBe(4); expect(all.bytes.readUInt32LE(8)).toBe(3);
  } else if (format.id === 6 || format.id === 7) {
    const metadata = sogMetadata(all.bytes);
    expect(metadata.means.files).toEqual(['means_l.webp', 'means_u.webp']);
    expect(metadata.shN.files).toEqual(['shN_centroids.webp', 'shN_labels.webp']);
    if (format.id === 6) {
      expect(metadata.version).toBe(2); expect(metadata.count).toBe(3);
      expect(metadata.shN.bands).toBe(3); expect(metadata.shN.count).toBe(3);
    } else {
      expect(metadata.version).toBeUndefined(); expect(metadata.means.shape).toEqual([3, 3]);
      expect(metadata.shN.shape).toEqual([3, 45]); expect(metadata.shN.quantization).toBe(8);
    }
  } else expect(all.bytes.toString('ascii', 0, all.bytes.indexOf('end_header\n'))).toMatch(/element vertex 3\n/);
  await expect(tools.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
  expect((await save(page, format.id, 1)).bytes.equals(all.bytes)).toBe(true);
  await expect(stats).toHaveText('3/3 splats | SH3');
  await tools.getByRole('button', { name: 'Redo', exact: true }).click(); await expect(stats).toHaveText('0/3 splats | SH3');
  expect((await save(page, format.id, 2)).bytes.equals(all.bytes)).toBe(true);
  await tools.getByRole('button', { name: 'Undo', exact: true }).click(); await expect(stats).toHaveText('3/3 splats | SH3');
  await expect(tools.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
  await info.attach(`format-${format.id}-all.${format.extension}`, { body: all.bytes, contentType: 'application/octet-stream' });
  expect(errors).toEqual([]);
});

for (const format of [{ id: 6, extension: 'sog', version: 2 }, { id: 7, extension: 'sogs', version: 1 }]) {
  test(`format ${format.id} downloads real scoped SOG v${format.version} bundles and reopens exact SH3 membership with executable Undo/Redo`, async ({ page }, info) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto('/'); await expect(page.getByRole('button', { name: 'Open scene', exact: true })).toBeEnabled();
    await page.getByLabel('Open scene files').setInputFiles({ name: 'roundtrip-sh3.ply', mimeType: 'application/octet-stream', buffer: Buffer.from(gaussianPly()) });
    await expect(page).toHaveTitle('roundtrip-sh3.ply \u2014 SplatView');
    const tools = page.getByRole('complementary', { name: 'Tools', exact: true });
    await page.mouse.move(640, 401); await page.getByRole('button', { name: 'Tools', exact: true }).click();
    await chooseSelectionTool(page, 'Box select');
    await page.getByRole('button', { name: 'Replace', exact: true }).click();
    const edges = page.getByRole('group', { name: 'Options', exact: true }).getByRole('button', { name: 'Include splat edges', exact: true });
    if (await edges.getAttribute('aria-pressed') !== 'false') await edges.click();
    await expect(edges).toHaveAttribute('aria-pressed', 'false');
    const canvas = await page.getByLabel('SplatView scene', { exact: true }).boundingBox(); expect(canvas).not.toBeNull();
    // In the ordinary fitted view, this right-hand rectangle contains the
    // literal (+0.4, 0, 0) center and excludes both other fixture centers.
    await page.mouse.move(canvas!.x + canvas!.width * .55, canvas!.y + canvas!.height * .15);
    await page.mouse.down();
    await page.mouse.move(canvas!.x + canvas!.width * .70, canvas!.y + canvas!.height * .85, { steps: 5 });
    await page.mouse.up(); await expect(tools.locator('.model-stats')).toHaveText('1/3 splats | SH3');
    await tools.getByRole('button', { name: 'Invert selection', exact: true }).click();
    await expect(tools.locator('.model-stats')).toHaveText('2/3 splats | SH3');
    await tools.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(tools.locator('.model-stats')).toHaveText('1/3 splats | SH3');
    const all = await save(page, format.id, 0), selected = await save(page, format.id, 1), remainder = await save(page, format.id, 2);
    await expect(tools.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
    await tools.getByRole('button', { name: 'Redo', exact: true }).click();
    await expect(tools.locator('.model-stats')).toHaveText('2/3 splats | SH3');
    expect((await save(page, format.id, 1)).bytes.equals(remainder.bytes)).toBe(true);
    await tools.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(tools.locator('.model-stats')).toHaveText('1/3 splats | SH3');
    expect((await save(page, format.id, 1)).bytes.equals(selected.bytes)).toBe(true);
    await expect(tools.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
    for (const output of [
      { ...all, scope: 'all', ids: [0, 1, 2] }, { ...selected, scope: 'selected', ids: [1] }, { ...remainder, scope: 'remainder', ids: [0, 2] },
    ]) {
      const metadata = sogMetadata(output.bytes), count = output.ids.length;
      expect(output.filename).toBe(`roundtrip-sh3-edited.${format.extension}`);
      if (format.id === 6) {
        expect(metadata.version).toBe(2); expect(metadata.count).toBe(count); expect(metadata.shN.bands).toBe(3); expect(metadata.shN.count).toBe(count);
      } else {
        expect(metadata.version).toBeUndefined(); expect(metadata.means.shape).toEqual([count, 3]); expect(metadata.shN.shape).toEqual([count, 45]);
      }
      const name = `roundtrip-${output.scope}-sh3.${format.extension}`;
      await page.getByLabel('Open scene files').setInputFiles({ name, mimeType: 'application/octet-stream', buffer: output.bytes });
      await expect(page).toHaveTitle(`${name} \u2014 SplatView`);
      await page.mouse.move(640, 401);
      if (!await tools.isVisible()) await page.getByRole('button', { name: 'Tools', exact: true }).click();
      await expect(tools.locator('.model-stats')).toHaveText(`0/${count} splats | SH3`);
      await expect(tools.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
      await expect(tools.getByRole('button', { name: 'Redo', exact: true })).toBeDisabled();
      const csv = (await save(page, 5, 0)).bytes.toString('utf8').trim().split(/\r?\n/);
      expect(csv.shift()!.split(',').slice(0, 3)).toEqual(['x', 'y', 'z']);
      const points = [[-.4, 0, 0], [.4, 0, 0], [0, .4, .1]];
      const ids = csv.map(row => {
        const point = row.split(',').slice(0, 3).map(Number);
        // This fixture spans at most 0.8 source units; its 16-bit log-position
        // quantization and float conversion stay within 2e-5 of each literal.
        return points.findIndex(source => source.every((value, axis) => Math.abs(value - point[axis]) <= 2e-5));
      }).sort((a, b) => a - b);
      expect(ids).toEqual(output.ids);
      await info.attach(`roundtrip-${output.scope}.${format.extension}`, { body: output.bytes, contentType: 'application/octet-stream' });
    }
    await expect(page.getByRole('alert')).toHaveCount(0); expect(errors).toEqual([]);
  });
}
