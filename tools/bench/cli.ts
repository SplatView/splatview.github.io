import { readJsonBounded, sha256, writeJsonExclusive } from './io.ts';
import { validateBenchmark } from './validate.ts';

const arguments_ = process.argv.slice(2);
if (arguments_.length !== 8 || arguments_.some((argument, index) => index % 2 === 0 && argument !== ['--report', '--target', '--build', '--output'][index / 2])) throw new Error('Usage: cli.ts --report FILE --target FILE --build FILE --output NEW_RECEIPT');
const [report, target, build] = await Promise.all([readJsonBounded(arguments_[1]!), readJsonBounded(arguments_[3]!, 1024 * 1024), readJsonBounded(arguments_[5]!, 64 * 1024)]);
const validation = validateBenchmark(report.value, target.value, { targetSha256: sha256(target.bytes), build: build.value });
await writeJsonExclusive(arguments_[7]!, {
  receiptVersion: 1,
  scope: 'benchmark-json-consistency-only',
  createdAtUtc: new Date().toISOString(),
  inputs: { report: { path: arguments_[1], sha256: sha256(report.bytes) }, target: { path: arguments_[3], sha256: sha256(target.bytes) }, expectedBuild: { path: arguments_[5], sha256: sha256(build.bytes) } },
  validation,
});
process.stdout.write(JSON.stringify({ valid: validation.valid, accepted: validation.accepted, issueCount: validation.issues.length }) + '\n');
// Exit 0 requires acceptance. Exit 2 retains a valid unaccepted diagnostic; exit 1 means invalid.
process.exitCode = validation.accepted ? 0 : validation.valid ? 2 : 1;
