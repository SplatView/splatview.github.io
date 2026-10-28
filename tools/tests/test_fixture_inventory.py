"""Python capture and TypeScript acceptance must inspect the same source bytes."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('fixture_inventory_producer', ROOT / 'tools/build-offline-fixtures.py')
producer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(producer)


class FixtureInventoryTests(unittest.TestCase):
    def test_capture_and_inspector_bind_the_entire_same_source_universe(self):
        with tempfile.TemporaryDirectory(prefix='splatview-inventory-') as temporary:
            root = Path(temporary).resolve()
            # Authored data only; this test neither builds nor qualifies a native
            # runtime, archived report, browser or fixture application.
            names = set(producer.helpers.ROOT_FILES) | set(producer.EXTRA_ROOT_FILES)
            for tree in (*producer.helpers.TREES, *producer.EXTRA_TREES):
                names.add(tree + '/synthetic-source.txt')
            names.update(('config/playwright.ci.config.ts', 'config/vite.engine.config.ts',
                          'config/tsconfig.engine.json'))
            for name in names:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(('authored source ' + name + '\r\n').encode())
            expected = producer.source_inventory(root, [], with_native=False)
            node = os.environ.get('npm_node_execpath') or shutil.which('node')
            local_node = ROOT / '.tools/node-v24.21.0-win-x64/node.exe'
            if not node and local_node.is_file():
                node = str(local_node)
            self.assertIsNotNone(node, 'Node from .node-version must be on PATH for tool tests')
            script = ('import {collectFixtureSource} from ' + json.dumps((ROOT / 'tools/release/fixtures.ts').as_uri()) + ';'
                      'import {Workspace} from ' + json.dumps((ROOT / 'tools/release/files.ts').as_uri()) + ';'
                      'console.log(JSON.stringify(await collectFixtureSource(new Workspace(process.argv[1]), [], {withNative:false})));')
            observed = json.loads(subprocess.check_output([node, '--input-type=module', '--eval', script, str(root)], cwd=ROOT))
            self.assertEqual(expected, observed)
            captured = {row['path'] for row in observed['inventory']}
            self.assertIn('contracts/synthetic-source.txt', captured)
            self.assertIn('design/feature-reviews/synthetic-source.txt', captured)
            self.assertIn('config/playwright.ci.config.ts', captured)
