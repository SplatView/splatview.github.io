import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'vitest';
import { Workspace } from '../tools/release/files.ts';
import { inspectLedger, parseCsv } from '../tools/release/ledger.ts';
import { assertShape } from '../tools/release/schema.ts';
import type { CapabilityLedger } from '../tools/release/types.ts';

const load = async (): Promise<CapabilityLedger> => {
  const value: unknown = JSON.parse(await readFile('docs/parity/capabilities-v1.json', 'utf8'));
  assertShape<CapabilityLedger>('CapabilityLedger', value);
  return value;
};

test('published capability inventory covers every historical feature and binds its actual source bytes', async () => {
  const ledger = await load();
  const cells = await inspectLedger(new Workspace(resolve('.')), ledger);
  assert.equal(ledger.capabilities.length, 33);
  assert.equal(ledger.capabilities.filter(row => row.scope === 'retained').length, 31);
  assert(cells.length > 60);
  for (const reference of [ledger.sourceFeatureLedger, ledger.capabilityInventory, ledger.desktopContract.capture]) {
    const bytes = await readFile(reference.path);
    assert.equal(bytes.byteLength, reference.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), reference.sha256);
  }
  assert.equal(ledger.desktopContract.revision, 'windows-r0-20261012-02');
});

test('optional WebGL and native shell are the only excluded browser-editor features', async () => {
  const ledger = await load();
  assert.deepEqual(ledger.capabilities.filter(row => row.scope === 'excluded').map(row => row.id).sort(),
    ['native-shell-integration', 'webgl-compatibility']);
  assert(ledger.capabilities.filter(row => row.scope === 'retained').every(row => row.requiredCells.length > 0 && row.exclusionReason === null));
});

test('thumbnail and desktop visual differences remain unresolved instead of silently approved', async () => {
  const ledger = await load();
  for (const id of ['saved-views', 'desktop-appearance']) {
    const feature = ledger.capabilities.find(row => row.id === id)!;
    assert.equal(feature.implementation, 'partial');
    assert(feature.requiredCells.some(cell => cell.kind === 'visual'));
    assert.deepEqual(feature.approvedDifferenceIds, []);
  }
  assert.deepEqual(ledger.differences, []);
});

test('measured capacity and actual deployed HTTPS remain required without any Mac-only configuration', async () => {
  const ledger = await load();
  const operating = ledger.capabilities.find(row => row.id === 'browser-operating-budgets')!;
  assert.equal(operating.implementation, 'planned');
  assert.equal(operating.requiredCells[0]!.kind, 'benchmark');
  assert(ledger.gates.some(cell => cell.kind === 'https'));
  assert(ledger.gates.some(cell => cell.kind === 'benchmark'));
  assert(ledger.gates.some(cell => cell.kind === 'format'));
  assert(ledger.gates.some(cell => cell.kind === 'visual'));
  for (const cell of [...ledger.capabilities.flatMap(row => row.requiredCells), ...ledger.gates]) {
    assert.deepEqual(cell.configurationIds, []);
  }
  const mapped = ledger.capabilities.flatMap(row => row.requiredCells).filter(cell => cell.requiredCaseIds.length);
  const caseMap = await readFile('docs/parity/cpu-case-map-v1.json', 'utf8').then(text => JSON.parse(text) as {
    mappings: { cellId: string; files: { path: string; fullNames: string[] }[] }[];
  }).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
  const offlineMap = await readFile('docs/parity/offline-case-map-v1.json', 'utf8').then(text => JSON.parse(text) as {
    cellId: string; files: { path: string; leaves: { id: string; title: string; project: string }[] }[];
  }).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
  const expectedIds = ['capture-clipboard:confirmation', 'manual-selection:feedback', ...(caseMap?.mappings.map(mapping => mapping.cellId) ?? []), ...(offlineMap ? [offlineMap.cellId] : [])];
  assert.deepEqual(mapped.map(cell => cell.id).sort(), expectedIds.sort());
  assert(mapped.filter(cell => cell.id === 'manual-selection:feedback' || cell.id === 'capture-clipboard:confirmation').every(cell => cell.kind === 'playwright' && cell.requiredCaseIds.length === 3));
  if (caseMap) {
    assert.deepEqual(caseMap.mappings.map(mapping => mapping.cellId).sort(),
      ['dirty-recovery:protocol', 'languages-accessibility:translations', 'wasm-codecs:identity']);
    for (const mapping of caseMap.mappings) {
      const cell = mapped.find(cell => cell.id === mapping.cellId)!;
      assert.equal(cell.kind, 'vitest');
      const cases = mapping.files.flatMap(file => file.fullNames.map(name => `${file.path}::${name}`)).sort();
      assert(cases.length > 0);
      assert.equal(new Set(cases).size, cases.length);
      assert.deepEqual([...cell.requiredCaseIds].sort(), cases);
    }
  }
  if (offlineMap) {
    assert.equal(offlineMap.cellId, 'static-offline:offline-update');
    assert.deepEqual(offlineMap.files.map(file => file.path), ['tests/offline/offline.spec.ts']);
    const cell = mapped.find(item => item.id === offlineMap.cellId)!;
    assert.equal(cell.kind, 'playwright');
    assert.deepEqual([...cell.requiredCaseIds].sort(), offlineMap.files.flatMap(file => file.leaves.map(leaf => `${leaf.project}::${leaf.id}`)).sort());
  }
  assert(ledger.gates.every(cell => cell.requiredCaseIds.length === 0));
});

test('compact capability CSV cannot omit a retained row or silently replace its stable ID', async () => {
  const rows = parseCsv(await readFile('docs/parity/capabilities-v1.csv', 'utf8'));
  const ledger = await load();
  assert.equal(rows.length, ledger.capabilities.length + 1);
  assert.deepEqual(new Set(rows.slice(1).map(row => row[0])), new Set(ledger.capabilities.map(row => row.id)));
  assert.equal(new Set(rows.slice(1).map(row => row[1])).size, ledger.capabilities.length);
});
