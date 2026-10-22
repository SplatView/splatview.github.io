import { Workspace } from './files.ts';
import type { CapabilityLedger, RequiredCell } from './types.ts';

/** RFC4180 field quoting, CRLF/LF, multiline fields; malformed quotes/row widths are rejected. */
export function parseCsv(text: string): string[][] {
  text = text.replace(/^\uFEFF/u, '');
  const rows: string[][] = []; let row: string[] = [], field = '', quoted = false, closed = false;
  const pushField = (): void => { row.push(field); field = ''; closed = false; };
  const pushRow = (): void => { pushField(); rows.push(row); row = []; };
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!;
    if (quoted) { if (character === '"') { if (text[index + 1] === '"') { field += '"'; index++; } else { quoted = false; closed = true; } } else field += character; continue; }
    if (character === '"') { if (field || closed) throw new Error('Malformed CSV quote'); quoted = true; }
    else if (character === ',') pushField();
    else if (character === '\n' || character === '\r') { if (character === '\r' && text[index + 1] === '\n') index++; pushRow(); }
    else { if (closed) throw new Error('Text after closed CSV quote'); field += character; }
  }
  if (quoted) throw new Error('Unterminated CSV quote');
  if (field || row.length || closed) pushRow();
  if (!rows.length || new Set(rows[0]).size !== rows[0]!.length || rows.some(item => item.length !== rows[0]!.length)) throw new Error('CSV header/row width mismatch');
  return rows;
}
const distinct = (values: readonly string[], label: string): void => { if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label}`); };
export async function inspectLedger(workspace: Workspace, ledger: CapabilityLedger): Promise<RequiredCell[]> {
  await workspace.read(ledger.desktopContract.capture.path, ledger.desktopContract.capture);
  const source = parseCsv(new TextDecoder('utf-8', { fatal: true }).decode((await workspace.read(ledger.sourceFeatureLedger.path, ledger.sourceFeatureLedger)).bytes));
  const compact = parseCsv(new TextDecoder('utf-8', { fatal: true }).decode((await workspace.read(ledger.capabilityInventory.path, ledger.capabilityInventory)).bytes));
  const index = source[0]!.indexOf('capability'); if (index < 0) throw new Error('Missing source feature capability column');
  const names = source.slice(1).map(row => row[index]!);
  distinct(names, 'source capability'); distinct(ledger.capabilities.map(row => row.desktopFeature), 'ledger feature'); distinct(ledger.capabilities.map(row => row.id), 'capability ID');
  if ([...names].sort().join('\0') !== ledger.capabilities.map(row => row.desktopFeature).sort().join('\0')) throw new Error('JSON ledger does not cover every source feature exactly once');
  if (compact[0]!.join('|') !== 'id|desktop_feature|scope|implementation|required_cells|exclusion_reason') throw new Error('Unexpected compact capability CSV columns');
  const expected = ledger.capabilities.map(row => [row.id, row.desktopFeature, row.scope, row.implementation, row.requiredCells.map(cell => cell.id).join(';'), row.exclusionReason ?? '']);
  if (JSON.stringify(compact.slice(1).sort((a, b) => a[0]!.localeCompare(b[0]!))) !== JSON.stringify(expected.sort((a, b) => a[0]!.localeCompare(b[0]!)))) throw new Error('Compact capability CSV differs from JSON ledger');
  const differences = ledger.differences.map(row => row.id); distinct(differences, 'difference ID');
  for (const capability of ledger.capabilities) {
    distinct(capability.approvedDifferenceIds, 'approved difference');
    if (capability.approvedDifferenceIds.some(id => !differences.includes(id))) throw new Error('Unknown approved browser difference');
    if (capability.scope === 'excluded' ? capability.implementation !== 'excluded' || !capability.exclusionReason || capability.requiredCells.length !== 0 : capability.implementation === 'excluded' || capability.exclusionReason !== null || capability.requiredCells.length === 0) throw new Error('Inconsistent retained/excluded feature scope');
  }
  const cells = [...ledger.capabilities.flatMap(row => row.requiredCells), ...ledger.gates];
  distinct(cells.map(cell => cell.id), 'required cell ID');
  for (const cell of cells) { distinct(cell.configurationIds, 'cell configuration'); distinct(cell.requiredCaseIds, 'cell case ID'); }
  return cells;
}
