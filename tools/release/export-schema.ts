import { Workspace } from './files.ts';
import { releaseSchema } from './schema.ts';

const arguments_ = process.argv.slice(2), workspace = new Workspace(process.cwd());
const target = 'docs/validation/release-evidence.schema.json';
const bytes = new TextEncoder().encode(JSON.stringify(releaseSchema, null, 2) + '\n');
if (arguments_.length === 1 && arguments_[0] === '--check') {
  const actual = (await workspace.read(target)).bytes;
  if (!Buffer.from(bytes).equals(Buffer.from(actual))) throw new Error('Published release schema differs from runtime contracts');
} else if (arguments_.length === 2 && arguments_[0] === '--output') await workspace.writeExclusive(arguments_[1]!, releaseSchema);
else throw new Error('Usage: node tools/release/export-schema.ts --output NEW_WORKSPACE_RELATIVE_JSON | --check');
