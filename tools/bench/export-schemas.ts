import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { observedReportShape, observedTargetShape, reportShape, targetShape } from './shapes.ts';
import { readJsonBounded, writeJsonExclusive } from './io.ts';

const args = process.argv.slice(2), checking = args.length === 1 && args[0] === '--check';
const fresh = args.length === 2 && args[0] === '--output-dir';
if (args.length && !checking && !fresh) throw new Error('Usage: export-schemas.ts [--check | --output-dir NEW_DIRECTORY]');
const directory = fresh ? resolve(args[1]!) : fileURLToPath(new URL('./schemas/', import.meta.url));
// Explicit exports require a new directory; default writes also remain exclusive.
if (!checking) await mkdir(directory, fresh ? undefined : { recursive: true });
for (const [name, shape] of [['benchmark-target-v1', targetShape], ['benchmark-report-v1', reportShape],
  ['benchmark-target-v2', observedTargetShape], ['benchmark-report-v2', observedReportShape]] as const) {
  const schema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: name,
    description: 'Structural schema only. validateBenchmark also enforces cross-field identities, repeat procedures, metrics, raw summaries and qualification gates. No collected performance evidence.',
    ...shape,
  };
  const path = `${directory}/${name}.schema.json`;
  if (checking) assert.deepEqual((await readJsonBounded(path)).value, schema, `Schema differs: ${name}`);
  else await writeJsonExclusive(path, schema);
}
