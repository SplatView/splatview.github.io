"""Fault probes use disposable source/capture trees, never accepted inputs."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location('capture_target', Path(__file__).with_name('capture-target.py'))
capture_target = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(capture_target)


class TargetCaptureTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.source = self.root / 'origin'
        self.source.mkdir()
        for directory in capture_target.DIRECTORY_ROOTS:
            target = self.source / directory
            target.mkdir()
            (target / 'fixture.txt').write_bytes((directory + '\n').encode())
        (self.source / 'src/core.cpp').write_bytes(b'int core = 1;\n')
        (self.source / 'src/build_win32.bat').write_bytes(b'@echo off\r\nexit /b 0\r\n')
        (self.source / 'src/empty').mkdir()
        (self.source / 'CMakeLists.txt').write_text(
            'cmake_minimum_required(VERSION 3.25)\n'
            'project(SplatView VERSION 0.12.116 LANGUAGES C CXX)\n'
            'find_package(ZLIB REQUIRED)\n', encoding='utf-8')
        (self.source / 'CMakePresets.json').write_text(json.dumps({
            'version': 6, 'configurePresets': [{
                'name': 'base', 'generator': 'Visual Studio 17 2022',
                'cacheVariables': {'CMAKE_TOOLCHAIN_FILE': '$env{VCPKG_ROOT}/scripts/buildsystems/vcpkg.cmake'},
            }]}), encoding='utf-8')
        (self.source / 'vcpkg.json').write_text(json.dumps({
            'name': 'fixture', 'dependencies': ['zlib']}), encoding='utf-8')
        for name in ('LICENSE', 'EULA.txt', 'README.md', 'CHANGELOG.md', 'CONTRIBUTING.md',
                     'Package-Store.ps1', 'Prepare-Release.ps1', 'Prepare-StoreSubmission.ps1',
                     '.gitmodules', '.clang-format', '.editorconfig'):
            (self.source / name).write_bytes(name.encode())
        self.git_patch = patch.object(capture_target, 'git_observation', return_value={
            'available': False, 'reason': 'disposable fixture without Git'})
        self.git_patch.start()
        self.addCleanup(self.git_patch.stop)
        self.addCleanup(self.temporary.cleanup)
        self.counter = 0

    def destination(self):
        self.counter += 1
        return self.root / f'capture-{self.counter}'

    def captured(self):
        destination = self.destination()
        capture_target.capture(self.source, destination)
        return destination

    def manifest(self, destination):
        return json.loads((destination / capture_target.MANIFEST_NAME).read_text(encoding='utf-8'))

    def rewrite_manifest(self, destination, manifest, repin_status=False):
        path = destination / capture_target.MANIFEST_NAME
        data = (json.dumps(manifest, indent=2) + '\n').encode()
        path.write_bytes(data)
        if repin_status:
            status_path = destination / capture_target.STATUS_NAME
            status_record = json.loads(status_path.read_text(encoding='utf-8'))
            status_record['manifestSha256'] = hashlib.sha256(data).hexdigest()
            status_record['treeSha256'] = manifest['treeSha256']
            status_path.write_text(json.dumps(status_record), encoding='utf-8')

    def assert_quarantined(self, destination):
        status_record = json.loads((destination / capture_target.STATUS_NAME).read_text(encoding='utf-8'))
        self.assertEqual(status_record['state'], 'quarantined')
        self.assertTrue(status_record['diagnostic'])
        with self.assertRaisesRegex(capture_target.CaptureError, 'quarantined'):
            capture_target.verify(destination)

    def test_complete_capture_has_independently_reproducible_closure_and_no_live_origin_dependency(self):
        destination = self.captured()
        manifest = capture_target.verify(destination)
        self.assertEqual(manifest['product']['version'], '0.12.116')
        paths = {row['path'] for row in manifest['files']}
        self.assertTrue(set(capture_target.DIRECTORY_ROOTS) <= set(manifest['directories']))
        self.assertIn('src/empty', manifest['directories'])
        self.assertIn('Prepare-StoreSubmission.ps1', paths)
        self.assertIn('.github/fixture.txt', paths)
        self.assertIn('src/build_win32.bat', paths)
        for row in manifest['files']:
            data = (destination / 'source' / row['path']).read_bytes()
            self.assertEqual(len(data), row['bytes'])
            self.assertEqual(hashlib.sha256(data).hexdigest(), row['sha256'])
        canonical = json.dumps({'directories': manifest['directories'], 'files': manifest['files']},
                               ensure_ascii=True, sort_keys=True, separators=(',', ':')).encode()
        self.assertEqual(hashlib.sha256(canonical).hexdigest(), manifest['treeSha256'])
        self.assertFalse(manifest['stability']['atomicFilesystemSnapshot'])
        self.assertEqual(manifest['externalRequirements']['vcpkgManifest']['dependencies'], ['zlib'])
        self.source.rename(self.root / 'moved-origin')
        with patch.object(capture_target, 'git_observation', side_effect=AssertionError('must not consult origin')):
            self.assertEqual(capture_target.verify(destination), manifest)

    def test_prunes_build_git_and_unknown_namespaces_without_descending(self):
        forbidden = []
        for relative in ('public/wasm', 'build', 'dist', '.git', 'src/build',
                         'third_party/vendor/.git', 'src/node_modules'):
            path = self.source / relative
            path.mkdir(parents=True)
            (path / 'do-not-read').write_bytes(b'excluded')
            forbidden.append(path)
        # Submodule administration files are excluded too, without losing vendored sources.
        submodule = self.source / 'third_party/other'
        submodule.mkdir()
        (submodule / '.git').write_text('gitdir: ../../../external-metadata', encoding='utf-8')
        (submodule / 'source.cpp').write_bytes(b'int vendor;\n')
        original = os.scandir

        def guarded(path):
            self.assertNotIn(Path(path), forbidden)
            self.assertNotEqual(Path(path), self.source / 'public')
            return original(path)

        with patch.object(capture_target.os, 'scandir', side_effect=guarded):
            destination = self.captured()
            manifest = capture_target.verify(destination)
        paths = {row['path'] for row in manifest['files']}
        self.assertIn('third_party/other/source.cpp', paths)
        self.assertNotIn('third_party/other/.git', paths)
        self.assertIn('third_party/other/.git', manifest['source']['excludedEntries'])
        self.assertFalse(any('/build/' in path or path.startswith('public/') for path in paths))

    def test_version_is_parsed_from_literal_multiline_cmake_ignoring_comments(self):
        data = (b'# project(SplatView VERSION 99.0.0)\n'
                b'#[=[ project(SplatView VERSION 88.0.0) ]=]\n'
                b'project(\n "SplatView"\n VERSION "0.12.117"\n LANGUAGES C CXX)\n')
        self.assertEqual(capture_target.product_version(data)['version'], '0.12.117')

    def test_invalid_or_ambiguous_versions_quarantine_and_new_capture_can_recover(self):
        path = self.source / 'CMakeLists.txt'
        original = path.read_bytes()
        for text in ('project(SplatView VERSION ${VERSION})', 'project(SplatView LANGUAGES CXX)',
                     '# project(SplatView VERSION 1.2.3)',
                     'project(SplatView VERSION 1.2.3)\nproject(SplatView VERSION 2.3.4)',
                     'project(SplatView VERSION 1.2.3'):
            with self.subTest(text=text):
                path.write_text(text, encoding='utf-8')
                destination = self.destination()
                with self.assertRaisesRegex(capture_target.CaptureError, 'quarantined'):
                    capture_target.capture(self.source, destination)
                self.assert_quarantined(destination)
        path.write_bytes(original)
        capture_target.verify(self.captured())

    def test_existing_destination_is_refused_without_modification(self):
        destination = self.captured()
        original = (destination / capture_target.MANIFEST_NAME).read_bytes()
        with self.assertRaisesRegex(capture_target.CaptureError, 'already exists'):
            capture_target.capture(self.source, destination)
        self.assertEqual((destination / capture_target.MANIFEST_NAME).read_bytes(), original)
        occupied = self.destination()
        occupied.mkdir()
        (occupied / 'sentinel').write_bytes(b'leave in place')
        with self.assertRaisesRegex(capture_target.CaptureError, 'already exists'):
            capture_target.capture(self.source, occupied)
        self.assertEqual([path.name for path in occupied.iterdir()], ['sentinel'])

    def test_mutation_during_copy_is_quarantined_with_original_bytes_retained(self):
        original_copy = capture_target._copy_file
        destination = self.destination()

        def mutate(source, target, row, stamp):
            original_copy(source, target, row, stamp)
            if row['path'] == 'src/core.cpp':
                (source / 'src/core.cpp').write_bytes(b'int core = 2;\n')

        with patch.object(capture_target, '_copy_file', side_effect=mutate):
            with self.assertRaisesRegex(capture_target.CaptureError, 'changed between inventories'):
                capture_target.capture(self.source, destination)
        self.assertEqual((destination / 'source/src/core.cpp').read_bytes(), b'int core = 1;\n')
        self.assert_quarantined(destination)
        with self.assertRaisesRegex(capture_target.CaptureError, 'already exists'):
            capture_target.capture(self.source, destination)
        self.assertEqual(capture_target.verify(self.captured())['product']['version'], '0.12.116')

    def test_added_and_removed_source_files_during_copy_are_detected(self):
        original_copy = capture_target._copy_file
        for action in ('add', 'remove'):
            with self.subTest(action=action):
                victim = self.source / 'src/fixture.txt'
                victim.write_bytes(b'removable')
                addition = self.source / 'src/added.cpp'
                if addition.exists():
                    addition.unlink()
                destination = self.destination()

                def mutate(source, target, row, stamp):
                    original_copy(source, target, row, stamp)
                    if row['path'] == 'src/core.cpp':
                        if action == 'add':
                            addition.write_bytes(b'new source')
                        else:
                            victim.unlink()

                with patch.object(capture_target, '_copy_file', side_effect=mutate):
                    with self.assertRaisesRegex(capture_target.CaptureError, 'quarantined'):
                        capture_target.capture(self.source, destination)
                self.assert_quarantined(destination)

    def test_captured_byte_mutation_is_detected(self):
        destination = self.captured()
        (destination / 'source/src/core.cpp').write_bytes(b'int core = 9;\n')
        with self.assertRaisesRegex(capture_target.CaptureError, 'bytes/hash mismatch'):
            capture_target.verify(destination)

    def test_captured_addition_and_removal_are_detected(self):
        for action in ('add', 'remove'):
            with self.subTest(action=action):
                destination = self.captured()
                if action == 'add':
                    (destination / 'source/src/injected.cpp').write_bytes(b'injected')
                else:
                    (destination / 'source/src/core.cpp').unlink()
                with self.assertRaisesRegex(capture_target.CaptureError, 'Unexpected|Missing'):
                    capture_target.verify(destination)

    def test_unknown_capture_namespaces_are_rejected_without_descent(self):
        for relative in ('public/wasm', 'source/public/wasm', 'source/src/unlisted/subtree'):
            with self.subTest(relative=relative):
                destination = self.captured()
                unknown = destination / relative
                unknown.mkdir(parents=True)
                original = os.scandir

                def guarded(path):
                    self.assertFalse(Path(path) == unknown or Path(path).is_relative_to(unknown))
                    return original(path)

                with patch.object(capture_target.os, 'scandir', side_effect=guarded):
                    with self.assertRaisesRegex(capture_target.CaptureError, 'Unexpected'):
                        capture_target.verify(destination)

    def test_manifest_metadata_tamper_is_bound_by_completion_hash(self):
        destination = self.captured()
        manifest = self.manifest(destination)
        manifest['source']['path'] = 'different origin'
        self.rewrite_manifest(destination, manifest)
        with self.assertRaisesRegex(capture_target.CaptureError, 'manifest hash mismatch'):
            capture_target.verify(destination)

    def test_path_traversal_and_windows_aliases_are_refused_even_if_metadata_hash_is_repinned(self):
        destination = self.captured()
        original = self.manifest(destination)
        for unsafe in ('../outside.cpp', '/absolute.cpp', 'C:/outside.cpp', 'src/../outside.cpp',
                       'src\\outside.cpp', 'src/file:stream', 'src/CON.cpp', 'src/trailing.'):
            with self.subTest(path=unsafe):
                manifest = copy.deepcopy(original)
                row = next(item for item in manifest['files'] if item['path'] == 'src/core.cpp')
                row['path'] = unsafe
                manifest['files'].sort(key=lambda item: item['path'])
                manifest['treeSha256'] = capture_target.tree_digest(manifest['directories'], manifest['files'])
                self.rewrite_manifest(destination, manifest, repin_status=True)
                with self.assertRaisesRegex(capture_target.CaptureError, 'Unsafe'):
                    capture_target.verify(destination)

    def test_noncanonical_or_invalid_manifest_inventory_is_refused(self):
        destination = self.captured()
        original = self.manifest(destination)
        for action in ('duplicate', 'bool-size', 'bad-hash', 'wrong-tree', 'missing-parent'):
            with self.subTest(action=action):
                manifest = copy.deepcopy(original)
                if action == 'duplicate':
                    manifest['files'].append(dict(manifest['files'][-1]))
                elif action == 'bool-size':
                    manifest['files'][0]['bytes'] = True
                elif action == 'bad-hash':
                    manifest['files'][0]['sha256'] = 'z' * 64
                elif action == 'wrong-tree':
                    manifest['treeSha256'] = '0' * 64
                else:
                    manifest['directories'].remove('src')
                self.rewrite_manifest(destination, manifest, repin_status=True)
                with self.assertRaises(capture_target.CaptureError):
                    capture_target.verify(destination)

    def test_version_and_dependency_claims_are_rechecked_against_captured_inputs(self):
        destination = self.captured()
        original = self.manifest(destination)
        for action in ('version', 'dependency'):
            with self.subTest(action=action):
                manifest = copy.deepcopy(original)
                if action == 'version':
                    manifest['product']['version'] = '0.12.82'
                else:
                    manifest['externalRequirements']['vcpkgManifest']['dependencies'] = []
                self.rewrite_manifest(destination, manifest, repin_status=True)
                with self.assertRaisesRegex(capture_target.CaptureError, 'differs'):
                    capture_target.verify(destination)

    def test_symlinks_are_rejected_in_source_and_capture_where_supported(self):
        external = self.root / 'external'
        external.mkdir()
        (external / 'secret.txt').write_bytes(b'not a source input')
        link = self.source / 'src/linked'
        try:
            link.symlink_to(external, target_is_directory=True)
        except (OSError, NotImplementedError) as error:
            self.skipTest(f'Symlink creation unavailable on this host: {error}')
        destination = self.destination()
        with self.assertRaisesRegex(capture_target.CaptureError, 'Symlink|reparse'):
            capture_target.capture(self.source, destination)
        self.assert_quarantined(destination)
        link.unlink()
        destination = self.captured()
        target = destination / 'source/src/core.cpp'
        target.unlink()
        target.symlink_to(external / 'secret.txt')
        with self.assertRaisesRegex(capture_target.CaptureError, 'Symlink|reparse'):
            capture_target.verify(destination)

    def test_windows_reparse_attribute_is_rejected_even_for_regular_mode(self):
        original = Path.lstat
        victim = self.source / 'src/core.cpp'

        def marked(path, *arguments, **keywords):
            info = original(path, *arguments, **keywords)
            if path == victim:
                return SimpleNamespace(st_mode=stat.S_IFREG | 0o666,
                                       st_file_attributes=getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0x400))
            return info

        destination = self.destination()
        with patch.object(Path, 'lstat', new=marked):
            with self.assertRaisesRegex(capture_target.CaptureError, 'reparse'):
                capture_target.capture(self.source, destination)
        self.assert_quarantined(destination)

    @unittest.skipUnless(os.name == 'nt', 'Windows junction probe')
    def test_real_windows_junction_is_rejected_without_following_it(self):
        external = self.root / 'junction-target'
        external.mkdir()
        (external / 'secret.txt').write_bytes(b'outside declared source')
        junction = self.source / 'src/junction'
        result = subprocess.run(['cmd.exe', '/d', '/c', 'mklink', '/J', str(junction), str(external)],
                                capture_output=True, text=True, check=False)
        if result.returncode:
            self.skipTest('Junction creation unavailable: ' + result.stderr.strip())
        try:
            destination = self.destination()
            with self.assertRaisesRegex(capture_target.CaptureError, 'reparse'):
                capture_target.capture(self.source, destination)
            self.assert_quarantined(destination)
            self.assertEqual((external / 'secret.txt').read_bytes(), b'outside declared source')
        finally:
            # rmdir removes the junction itself and never traverses its target.
            junction.rmdir()

    def test_metadata_namespace_changes_during_verification_are_detected(self):
        destination = self.captured()
        original = capture_target._inventory
        calls = 0

        def inject(root, expected=None):
            nonlocal calls
            result = original(root, expected)
            calls += 1
            if calls == 1:
                (destination / 'unlisted-metadata').write_bytes(b'injected during verification')
            return result

        with patch.object(capture_target, '_inventory', side_effect=inject):
            with self.assertRaisesRegex(capture_target.CaptureError, 'metadata entries changed'):
                capture_target.verify(destination)

    def test_missing_completion_status_and_duplicate_json_keys_are_refused(self):
        destination = self.captured()
        (destination / capture_target.STATUS_NAME).unlink()
        with self.assertRaisesRegex(capture_target.CaptureError, 'Incomplete/quarantined'):
            capture_target.verify(destination)
        destination = self.captured()
        path = destination / capture_target.MANIFEST_NAME
        data = path.read_bytes().replace(b'{', b'{"schemaVersion": 1,', 1)
        path.write_bytes(data)
        with self.assertRaisesRegex(capture_target.CaptureError, 'Duplicate JSON key'):
            capture_target.verify(destination)
        destination = self.captured()
        (destination / capture_target.MANIFEST_NAME).write_text('[]', encoding='utf-8')
        with self.assertRaisesRegex(capture_target.CaptureError, 'Unsupported or incomplete'):
            capture_target.verify(destination)

    def test_cli_capture_and_verify_use_only_explicit_destinations(self):
        destination = self.destination()
        script = Path(capture_target.__file__)
        for arguments in (['capture', '--source', str(self.source), '--destination', str(destination)],
                          ['verify', '--destination', str(destination)]):
            result = subprocess.run([sys.executable, '-B', str(script), *arguments],
                                    capture_output=True, text=True, check=False)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('SplatView 0.12.116', result.stdout)


if __name__ == '__main__':
    unittest.main()
