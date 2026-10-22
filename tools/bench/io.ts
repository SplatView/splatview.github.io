/** Node-only adapter. The validator itself has no Node/filesystem dependencies. */
import { createHash } from 'node:crypto';
import { open, writeFile } from 'node:fs/promises';
import { validateBenchmark } from './validate.ts';
import type { BenchmarkReportPacket, BenchmarkTargetPacket, ExpectedPacket, ValidationResult } from './schema.ts';

export const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
export async function readJsonBounded(path: string, maximumBytes = 128 * 1024 * 1024): Promise<{ bytes: Uint8Array; value: unknown }> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new RangeError('Invalid JSON input bound');
  const handle = await open(path, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maximumBytes) throw new RangeError('JSON input byte bound exceeded/not regular');
    const buffer = new Uint8Array(stat.size + 1);
    let used = 0;
    while (used < buffer.length) { const { bytesRead } = await handle.read(buffer, used, buffer.length - used, null); if (!bytesRead) break; used += bytesRead; }
    if (used !== stat.size) throw new Error('JSON input changed size during read');
    const bytes = buffer.subarray(0, used);
    return { bytes, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown };
  } finally { await handle.close(); }
}
export async function writeJsonExclusive(path: string, value: unknown): Promise<void> {
  const bytes = JSON.stringify(value, null, 2) + '\n';
  await writeFile(path, bytes, { encoding: 'utf8', flag: 'wx' });
}
/** Diagnostic reports may be valid but unaccepted. Never erase an earlier attempt/report. */
export async function writeBenchmarkReportExclusive(path: string, report: BenchmarkReportPacket, target: BenchmarkTargetPacket, expected: ExpectedPacket): Promise<ValidationResult> {
  const validation = validateBenchmark(report, target, expected);
  if (!validation.valid) throw new Error('Refusing to publish a structurally inconsistent report');
  await writeJsonExclusive(path, report);
  return validation;
}
