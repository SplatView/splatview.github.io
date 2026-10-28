"""The same setup and validation commands locally and in GitHub Actions."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

from bootstrap_runtime import ROOT, load_tool


def prerequisites(root=ROOT):
    if sys.version_info < (3, 11):
        raise ValueError('Python 3.11+ is required. Install it and retry npm run setup.')
    node = os.environ.get('npm_node_execpath') or shutil.which('node')
    npm = os.environ.get('npm_execpath')
    if not node or not npm or not Path(npm).is_file():
        raise ValueError('Run this command through npm run setup/doctor/check/ci with Node on PATH.')
    expected = (root / '.node-version').read_text(encoding='utf-8').strip()
    observed = subprocess.check_output([node, '--version'], text=True).strip().removeprefix('v')
    if observed != expected:
        raise ValueError(f'Node {expected} is required; found {observed}. Use .node-version with your version manager.')
    return [node, npm]


class Run:
    def __init__(self, root, task):
        self.root = Path(root).resolve()
        parent = self.root / '.build/validation'
        parent.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')
        self.directory = Path(tempfile.mkdtemp(prefix=f'{task}-{stamp}-', dir=parent))
        self.steps = []
        self.task = task

    def save(self, complete=False):
        (self.directory / 'run.json').write_text(json.dumps({
            'schemaVersion': 1, 'task': self.task, 'steps': self.steps,
            'status': 'failed' if any(row['exitCode'] for row in self.steps) else ('passed' if complete else 'running'),
            'qualification': 'Source/build checks; not native compilation or hardware GPU qualification.',
        }, indent=2) + '\n', encoding='utf-8')

    def step(self, name, command):
        logfile = self.directory / f'{len(self.steps) + 1:02}-{name}.log'
        print(f'\n[{name}] {subprocess.list2cmdline(command)}', flush=True)
        started = time.monotonic()
        # Stream to the terminal and UTF-8 log, retaining complete failures.
        with logfile.open('w', encoding='utf-8') as output:
            try:
                with subprocess.Popen(command, cwd=self.root, stdout=subprocess.PIPE,
                                      stderr=subprocess.STDOUT, text=True, encoding='utf-8', errors='replace',
                                      env={**os.environ, 'PYTHONUTF8': '1', 'PYTHONDONTWRITEBYTECODE': '1'}) as process:
                    for line in process.stdout:
                        print(line, end='', flush=True)
                        output.write(line)
                    code = process.wait()
            except OSError as error:
                output.write(str(error) + '\n')
                code = 127
        self.steps.append({'name': name, 'command': command, 'exitCode': code,
                           'seconds': round(time.monotonic() - started, 3), 'log': logfile.name})
        self.save()
        if code:
            raise ValueError(f'{name} failed ({code}). Logs: {self.directory}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('task', choices=('setup', 'doctor', 'check', 'ci'))
    args = parser.parse_args()
    npm = prerequisites()
    python = [sys.executable, '-B']
    if args.task == 'doctor':
        # Read-only: no restore, install, download, generated files or receipts.
        load_tool(ROOT, 'capture-sources').verify()
        load_tool(ROOT, 'verify-toolchain').verify_build_report(ROOT)
        subprocess.run(npm + ['ls', '--depth=0'], cwd=ROOT, check=True)
        print('Node, frozen sources, native freshness and npm dependencies verified. '
              'Use npm run check for the full validation suite.')
        return
    run = Run(ROOT, args.task)
    print(f'Logs: {run.directory}', flush=True)
    if args.task == 'setup':
        run.step('frozen-references', python + ['tools/restore-references.py'])
        run.step('native-runtime', python + ['tools/bootstrap_runtime.py'])
        run.step('dependencies', npm + ['ci', '--no-audit', '--no-fund'])
        run.save(complete=True)
        print('Setup complete. Run npm run dev, npm run doctor or npm run check.')
        return
    for name in ('verify:project', 'verify:sources', 'verify:build', 'typecheck', 'typecheck:bench',
                 'test:tools', 'test:web-build', 'test'):
        run.step(name.replace(':', '-'), npm + ['run', name])
    if args.task == 'ci':
        for name in ('build', 'build:engine'):
            run.step(name.replace(':', '-'), npm + ['run', name])
    run.save(complete=True)
    print(f'All {args.task} steps passed. Logs: {run.directory}')


if __name__ == '__main__':
    # npm may pipe Python on Windows with a legacy console encoding. Keep the
    # parent stream UTF-8 too, including Node's Unicode test reporter output.
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    try:
        main()
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        raise SystemExit(f'{error}\nFor missing setup inputs, run npm run setup. '
                         'Native changes require the reviewed npm run build:core path.') from error
