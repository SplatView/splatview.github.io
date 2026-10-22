import { Workspace } from './files.ts';
import { validateRelease } from './validate.ts';

const arguments_ = process.argv.slice(2);
if (arguments_.length !== 4 || arguments_[0] !== '--request' || arguments_[2] !== '--output') throw new Error('Usage: node tools/release/cli.ts --request WORKSPACE_RELATIVE_JSON --output NEW_WORKSPACE_RELATIVE_JSON');
// Current + three genuine80MiB source inventories are read twice, plus repeated
// pinned executables, shipping hashes and the large offline report.
// This is a validator I/O bound, independent of the application's resource ledger.
const workspace = new Workspace(process.cwd(), 128 * 1024 * 1024, 3 * 1024 * 1024 * 1024);
const input = await workspace.read(arguments_[1]!);
const bundle = await validateRelease(workspace, input.reference);
await workspace.writeExclusive(arguments_[3]!, bundle);
process.stdout.write(JSON.stringify({ valid: bundle.valid, boundedAccepted: bundle.boundedAccepted, fullEditorAccepted: bundle.fullEditorAccepted, acceptedCells: bundle.acceptedCells.length, pendingCells: bundle.pendingCells.length, issueCount: bundle.issues.length, readBytes: workspace.readBytes, maximumTotalReadBytes: workspace.maximumTotalBytes }) + '\n');
process.exitCode = bundle.valid ? bundle.fullEditorAccepted ? 0 : 2 : 1;
