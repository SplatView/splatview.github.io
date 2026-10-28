"""Regression coverage for bootstrap integrity and failure propagation."""
import hashlib
import io
import json
from pathlib import Path
import shutil
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch
import warnings
import zipfile

import artifact_io as artifacts
import bootstrap_runtime as runtime
import dev


def record(data):
    return {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}


class ArtifactTests(unittest.TestCase):
    def test_archive_rejects_traversal_aliases_links_and_expansion(self):
        for members in ([('../outside', b'x')], [('/absolute', b'x')], [('a', b'x'), ('A', b'y')],
                        [('con.txt', b'x')]):
            with self.subTest(members=members), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / 'test.zip'
                with zipfile.ZipFile(path, 'w') as bundle:
                    for name, data in members:
                        bundle.writestr(name, data)
                with zipfile.ZipFile(path) as bundle, self.assertRaises(ValueError):
                    artifacts.archive_members(bundle)
        for mode, limit in ((stat.S_IFLNK, artifacts.MAX_BYTES), (stat.S_IFREG, 0)):
            stream = io.BytesIO()
            with zipfile.ZipFile(stream, 'w') as bundle:
                info = zipfile.ZipInfo('a')
                info.external_attr = (mode | 0o644) << 16
                bundle.writestr(info, b'x')
            stream.seek(0)
            with zipfile.ZipFile(stream) as bundle, patch.object(artifacts, 'MAX_BYTES', limit), self.assertRaises(ValueError):
                artifacts.archive_members(bundle)

    def test_checksum_and_duplicate_archive_failure(self):
        with self.assertRaisesRegex(ValueError, 'checksum'):
            artifacts.verify_bytes(b'bad', record(b'good'), 'fixture')
        stream = io.BytesIO()
        with warnings.catch_warnings():
            warnings.simplefilter('ignore', UserWarning)
            with zipfile.ZipFile(stream, 'w') as bundle:
                bundle.writestr('a', b'one')
                bundle.writestr('a', b'two')
        stream.seek(0)
        with zipfile.ZipFile(stream) as bundle, self.assertRaisesRegex(ValueError, 'duplicate'):
            artifacts.archive_members(bundle)
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, 'w') as bundle:
            bundle.writestr('a/b', b'x')
        # Zip writers normalize Windows separators; tamper actual wire names.
        stream = io.BytesIO(stream.getvalue().replace(b'a/b', b'a\\b'))
        with zipfile.ZipFile(stream) as bundle, self.assertRaisesRegex(ValueError, 'Unsafe'):
            artifacts.archive_members(bundle)

    def test_download_verifies_cache_and_cleans_partial_files(self):
        class Response(io.BytesIO):
            url = 'https://example.invalid/artifact'
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)
            with patch.object(artifacts.urllib.request, 'urlopen', return_value=Response(b'bad')):
                with self.assertRaises(ValueError):
                    artifacts.download(Response.url, record(b'good'), cache)
            self.assertEqual(list(cache.iterdir()), [])
            with patch.object(artifacts.urllib.request, 'urlopen', return_value=Response(b'good')):
                result = artifacts.download(Response.url, record(b'good'), cache)
            with patch.object(artifacts.urllib.request, 'urlopen', side_effect=AssertionError('Must use verified cache')):
                self.assertEqual(result, artifacts.download(Response.url, record(b'good'), cache))
                result.write_bytes(b'bad!')
                with self.assertRaisesRegex(ValueError, 'checksum'):
                    artifacts.download(Response.url, record(b'good'), cache)


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        verifier = runtime.load_tool(runtime.ROOT, 'verify-toolchain')
        inputs = ['native/SOURCE_LOCK.json', 'native/TOOLCHAIN_LOCK.json', 'native/DEPENDENCIES.json',
                  *('tools/' + name for name in verifier.build_inputs()['buildScripts'])]
        inputs += [p.relative_to(runtime.ROOT).as_posix() for p in (runtime.ROOT / 'native/wasm').rglob('*') if p.is_file()]
        for name in inputs:
            destination = self.root / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(runtime.ROOT / name, destination)
        self.contents = {name: ('test-only ' + name).encode() for name in runtime.NATIVE_FILES[:-1]}
        report = {'schemaVersion': 1, 'buildMode': 'clean-first', 'inputs': verifier.build_inputs(self.root),
                  'nativeInputId': verifier.native_input_id(self.root), 'nativeIdentity': verifier.runtime_identities(self.root),
                  'outputs': {name: record(data) for name, data in self.contents.items()}}
        self.contents['build-provenance.json'] = json.dumps(report).encode()
        self.pin = {'schemaVersion': 1, 'release': 'v0.2.2', 'nativeInputId': report['nativeInputId'],
                    'archive': {'url': 'https://github.com/SplatView/splatview.github.io/releases/download/v0.2.2/SplatView-web-v0.2.2.zip',
                                **record(b'archive')}, 'files': {name: record(data) for name, data in self.contents.items()}}
        self.write_pin()
        self.archive = self.root / 'fixture.zip'
        self.pack()
        self.fetch = patch.object(runtime, 'download', return_value=self.archive).start()
        self.addCleanup(patch.stopall)

    def write_pin(self):
        (self.root / 'tools/native-runtime.json').write_text(json.dumps(self.pin), encoding='utf-8')

    def pack(self):
        with zipfile.ZipFile(self.archive, 'w') as bundle:
            for name, data in self.contents.items():
                bundle.writestr('wasm/' + name, data)

    def test_fresh_restore_partial_resume_and_existing_build(self):
        path = self.root / 'public/wasm/splatview-core.mjs'
        path.parent.mkdir(parents=True)
        path.write_bytes(self.contents[path.name])
        self.assertIn('Restored five', runtime.restore(self.root))
        self.assertEqual(self.fetch.call_count, 1)
        self.pin['nativeInputId'] = '0' * 64
        self.write_pin()
        self.assertIn('Existing WASM verified', runtime.restore(self.root))
        self.assertEqual(self.fetch.call_count, 1)

    def test_stale_inputs_refused_before_download(self):
        path = self.root / 'native/wasm/runtime-contract.json'
        path.write_bytes(path.read_bytes() + b'\n')
        with self.assertRaisesRegex(ValueError, 'seed is stale'):
            runtime.restore(self.root)
        self.fetch.assert_not_called()
        self.assertFalse((self.root / 'public/wasm').exists())

    def test_partial_conflicting_file_is_preserved(self):
        path = self.root / 'public/wasm/splatview-core.mjs'
        path.parent.mkdir(parents=True)
        path.write_bytes(b'local work')
        with self.assertRaisesRegex(ValueError, 'checksum'):
            runtime.restore(self.root)
        self.assertEqual(path.read_bytes(), b'local work')
        self.fetch.assert_not_called()

    def test_corrupt_member_is_not_partially_published(self):
        self.contents['splatview-camera.wasm'] = b'corrupt'
        self.pack()
        with self.assertRaises(ValueError):
            runtime.restore(self.root)
        self.assertFalse((self.root / 'public/wasm').exists())

    def test_report_freshness_is_checked_before_publication(self):
        report = json.loads(self.contents['build-provenance.json'])
        report['inputs']['sourceLock']['sha256'] = '0' * 64
        self.contents['build-provenance.json'] = json.dumps(report).encode()
        self.pin['files']['build-provenance.json'] = record(self.contents['build-provenance.json'])
        self.write_pin()
        self.pack()
        with self.assertRaisesRegex(ValueError, 'stale'):
            runtime.restore(self.root)
        self.assertFalse((self.root / 'public/wasm').exists())


class DeveloperCommandTests(unittest.TestCase):
    def test_failed_command_stops_and_retains_full_log_and_status(self):
        with tempfile.TemporaryDirectory() as directory:
            run = dev.Run(directory, 'fixture')
            with self.assertRaisesRegex(ValueError, 'failed'):
                run.step('broken', [sys.executable, '-c', 'print("failure evidence"); raise SystemExit(7)'])
            report = json.loads((run.directory / 'run.json').read_bytes())
            self.assertEqual(report['status'], 'failed')
            self.assertEqual(report['steps'][0]['exitCode'], 7)
            self.assertIn('failure evidence', (run.directory / report['steps'][0]['log']).read_text(encoding='utf-8'))
