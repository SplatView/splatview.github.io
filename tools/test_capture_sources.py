"""Publication override probes use fake roots; frozen real captures stay intact."""
from contextlib import redirect_stdout
from pathlib import Path
import copy
import importlib.util
import io
import json
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('capture_sources', Path(__file__).with_name('capture-sources.py'))
capture = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(capture)

CURRENT_PIVOT = (b'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" '
                 b'fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">\n'
                 b'  <circle cx="12" cy="12" r="9"/>\n  <circle cx="12" cy="12" r="3"/>\n</svg>\n')
SELECTION_PIVOT = (b'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" '
                   b'fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">\n'
                   b'  <path d="M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5"/>\n'
                   b'  <path d="M12 7v3M12 14v3M7 12h3M14 12h3"/>\n  <circle cx="12" cy="12" r="2"/>\n</svg>\n')
ORIGIN_PIVOT = (b'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" '
                b'fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">\n'
                b'  <circle cx="11" cy="13" r="2.5"/>\n'
                b'  <path d="M11 10.5V3m-2 2 2-2 2 2M13.5 13H22m-2-2 2 2-2 2M9.2 14.8 3 21m0-3v3h3"/>\n</svg>\n')


class PublishedArtworkOverrideTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.packages = {
            'splatview': {'destination': self.root / 'native/upstream/splatview'},
            'windows-reference': {'destination': self.root / 'reference/windows'},
        }
        self.patched = patch.multiple(capture, ROOT=self.root, LOCK=self.root / 'native/SOURCE_LOCK.json',
                                      PACKAGES=self.packages)
        self.patched.start()
        self.addCleanup(self.patched.stop)
        self.addCleanup(self.temporary.cleanup)
        baseline = [
            ('splatview', 'src/core.cpp', b'fixed native source\n'),
            ('windows-reference', 'assets/icons/other.svg', b'other frozen artwork\n'),
            ('windows-reference', 'assets/opsiclear.png', b'frozen logo'),
        ]
        lock = {'schemaVersion': 1, 'packages': {}, 'files': []}
        for package in self.packages:
            tree = []
            rows = sorted((relative, data) for owner, relative, data in baseline if owner == package)
            for relative, data in rows:
                target = self.packages[package]['destination'] / relative
                self.write(target, data)
                lock['files'].append({'package': package, 'originPath': relative,
                                      'path': target.relative_to(self.root).as_posix(),
                                      'bytes': len(data), 'sha256': capture.digest(data)})
                tree.append(f'{relative}\0{capture.digest(data)}\n')
            lock['packages'][package] = {'files': len(rows), 'treeSha256': capture.digest(''.join(tree).encode())}
        self.write(capture.LOCK, json.dumps(lock).encode())
        self.legacy = self.root / 'reference/windows/assets/icons/other.svg'
        self.absent_legacy_pivot = self.root / 'reference/windows/assets/icons/pivot-center.svg'
        self.published = self.root / 'public/icons/pivot-center.svg'
        self.write(self.published, CURRENT_PIVOT)
        self.write(self.root / 'public/icons/other.svg', b'other frozen artwork\n')
        self.write(self.root / 'public/opsiclear.png', b'frozen logo')
        override = capture.REVIEWED_ICON_OVERRIDES['pivot-center.svg']
        capture_root = self.root / override['captureRoot']
        self.source = capture_root / 'source' / override['record']['path']
        self.manifest = capture_root / 'CAPTURE_MANIFEST.json'
        self.descriptor = {'schemaVersion': override['schemaVersion'], 'kind': override['kind'],
                           'captureId': override['captureId'], 'files': [copy.deepcopy(override['record'])]}
        self.write(self.source, CURRENT_PIVOT)
        self.save_manifest(self.descriptor)
        self.new_pivot_sources = {}
        pivot_override = capture.REVIEWED_ICON_OVERRIDES['pivot-selection.svg']
        pivot_root = self.root / pivot_override['captureRoot']
        self.new_pivot_manifest = pivot_root / 'CAPTURE_MANIFEST.json'
        self.new_pivot_descriptor = {
            'schemaVersion': pivot_override['schemaVersion'], 'captureId': pivot_override['captureId'],
            'desktopCommit': pivot_override['desktopCommit'], 'desktopVersion': pivot_override['desktopVersion'],
            'files': [],
        }
        for name, data in [('pivot-selection.svg', SELECTION_PIVOT), ('pivot-origin.svg', ORIGIN_PIVOT)]:
            reviewed = capture.REVIEWED_ICON_OVERRIDES[name]
            source = pivot_root / 'source' / reviewed['record']['path']
            self.new_pivot_sources[name] = source
            self.write(source, data)
            self.write(self.root / 'public/icons' / name, data)
            self.new_pivot_descriptor['files'].append(copy.deepcopy(reviewed['record']))
        self.write(self.new_pivot_manifest, json.dumps(self.new_pivot_descriptor).encode())
        self.lock_before = capture.LOCK.read_bytes()
        self.legacy_before = self.legacy.read_bytes()

    @staticmethod
    def write(path, data):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def save_manifest(self, value):
        self.write(self.manifest, json.dumps(value).encode())

    def verify(self):
        with redirect_stdout(io.StringIO()):
            capture.verify()

    def refuses(self, message):
        with self.assertRaisesRegex(SystemExit, message):
            self.verify()
        self.assertEqual(capture.LOCK.read_bytes(), self.lock_before)
        self.assertEqual(self.legacy.read_bytes(), self.legacy_before)
        self.assertFalse(self.absent_legacy_pivot.exists())

    def test_exact_reviewed_override_preserves_source_lock_and_historical_artwork(self):
        self.assertEqual(len(CURRENT_PIVOT), 260)
        self.assertEqual(capture.digest(CURRENT_PIVOT),
                         '371619a63f9a803ed520beb9319639e36963d7c4f5c8034790774bd29c500142')
        self.verify()
        self.assertEqual(capture.LOCK.read_bytes(), self.lock_before)
        self.assertEqual(self.legacy.read_bytes(), self.legacy_before)
        self.assertFalse(self.absent_legacy_pivot.exists())
        self.assertEqual(self.published.read_bytes(), CURRENT_PIVOT)

    def test_legacy_public_pivot_is_refused_after_reviewed_override(self):
        self.published.write_bytes(b'legacy pivot artwork\n')
        self.refuses('Published product icon differs: pivot-center.svg')

    def test_matching_altered_capture_and_manifest_cannot_authorize_new_bytes(self):
        changed = CURRENT_PIVOT + b'changed'
        self.source.write_bytes(changed)
        self.published.write_bytes(changed)
        descriptor = copy.deepcopy(self.descriptor)
        descriptor['files'][0].update(bytes=len(changed), sha256=capture.digest(changed))
        self.save_manifest(descriptor)
        self.refuses('exact single reviewed icon record')

    def test_source_mutation_without_manifest_change_is_refused(self):
        self.source.write_bytes(CURRENT_PIVOT + b'changed')
        self.refuses('Reviewed icon source differs from pinned bytes')

    def test_wrong_or_missing_capture_identity_is_refused(self):
        for field, value in [('captureId', 'different-capture'), ('captureId', None),
                             ('schemaVersion', 2), ('schemaVersion', True), ('kind', 'other-capture')]:
            with self.subTest(field=field, value=value):
                descriptor = copy.deepcopy(self.descriptor)
                descriptor[field] = value
                self.save_manifest(descriptor)
                self.refuses('Capture manifest identity differs')

    def test_duplicate_record_and_case_alias_are_refused(self):
        for alias in ['assets/icons/pivot-center.svg', 'assets/icons/PIVOT-center.svg']:
            with self.subTest(alias=alias):
                descriptor = copy.deepcopy(self.descriptor)
                duplicate = copy.deepcopy(descriptor['files'][0])
                duplicate['path'] = alias
                descriptor['files'].append(duplicate)
                self.save_manifest(descriptor)
                self.refuses('exact single reviewed icon record')

    def test_duplicate_manifest_identity_key_is_refused(self):
        text = json.dumps(self.descriptor)
        self.manifest.write_text('{"captureId":"cc71f0df-8f38-4900-8aff-5c9ee0d6814c",' + text[1:], encoding='utf-8')
        self.refuses('Duplicate capture manifest field: captureId')

    def test_missing_extra_or_wrong_reviewed_record_is_refused(self):
        for mutation in [lambda value: value.update(files=[]),
                         lambda value: value['files'][0].update(bytes=260.0),
                         lambda value: value['files'][0].update(extra='unreviewed'),
                         lambda value: value['files'][0].update(path='assets/icons/other.svg')]:
            descriptor = copy.deepcopy(self.descriptor)
            mutation(descriptor)
            self.save_manifest(descriptor)
            self.refuses('exact single reviewed icon record')

    def test_missing_or_nonregular_capture_leaves_are_refused(self):
        self.source.unlink()
        self.refuses('Reviewed icon source must be an unaliased regular file')
        self.source.mkdir()
        self.refuses('Reviewed icon source must be an unaliased regular file')
        self.source.rmdir()
        self.write(self.source, CURRENT_PIVOT)
        self.manifest.unlink()
        self.refuses('Capture manifest must be an unaliased regular file')

    def test_other_published_icon_mutation_remains_refused(self):
        self.write(self.root / 'public/icons/other.svg', b'changed unrelated icon')
        self.refuses('Published product icon differs: other.svg')

    def test_injected_published_icon_remains_refused(self):
        self.write(self.root / 'public/icons/injected.svg', b'not in frozen closure')
        self.refuses('Published product icon differs: injected.svg')

    def test_logo_mutation_remains_refused(self):
        self.write(self.root / 'public/opsiclear.png', b'changed logo')
        self.refuses('Published product logo differs')

    def test_exact_selection_and_origin_supplements_preserve_the_frozen_lock(self):
        for name, data in [('pivot-selection.svg', SELECTION_PIVOT), ('pivot-origin.svg', ORIGIN_PIVOT)]:
            with self.subTest(name=name):
                record = capture.REVIEWED_ICON_OVERRIDES[name]['record']
                self.assertEqual(len(data), record['bytes'])
                self.assertEqual(capture.digest(data), record['sha256'])
                self.assertFalse((self.root / 'reference/windows/assets/icons' / name).exists())
        self.verify()
        self.assertEqual(capture.LOCK.read_bytes(), self.lock_before)

    def test_later_pivot_capture_requires_the_exact_commit_and_version(self):
        for field, value in [('desktopCommit', 'other-commit'), ('desktopCommit', None),
                             ('desktopVersion', '1.0.4'), ('desktopVersion', None), ('captureId', 'other-capture')]:
            with self.subTest(field=field, value=value):
                descriptor = copy.deepcopy(self.new_pivot_descriptor)
                descriptor[field] = value
                self.write(self.new_pivot_manifest, json.dumps(descriptor).encode())
                self.refuses('Capture manifest identity differs')

    def test_later_pivot_matching_altered_source_manifest_and_publication_are_refused(self):
        for name in self.new_pivot_sources:
            with self.subTest(name=name):
                descriptor = copy.deepcopy(self.new_pivot_descriptor)
                data = self.new_pivot_sources[name].read_bytes() + b'changed'
                self.new_pivot_sources[name].write_bytes(data)
                self.write(self.root / 'public/icons' / name, data)
                record = next(row for row in descriptor['files'] if row['path'].endswith('/' + name))
                record.update(bytes=len(data), sha256=capture.digest(data))
                self.write(self.new_pivot_manifest, json.dumps(descriptor).encode())
                self.refuses('exact single reviewed icon record')
                original = SELECTION_PIVOT if name == 'pivot-selection.svg' else ORIGIN_PIVOT
                self.new_pivot_sources[name].write_bytes(original)
                self.write(self.root / 'public/icons' / name, original)

    def test_later_pivot_case_alias_in_manifest_is_refused(self):
        descriptor = copy.deepcopy(self.new_pivot_descriptor)
        alias = copy.deepcopy(descriptor['files'][0])
        alias['path'] = 'assets/icons/PIVOT-selection.svg'
        descriptor['files'].append(alias)
        self.write(self.new_pivot_manifest, json.dumps(descriptor).encode())
        self.refuses('exact single reviewed icon record')

    def test_unreviewed_pivot_filename_remains_refused(self):
        self.write(self.root / 'public/icons/pivot-other.svg', SELECTION_PIVOT)
        self.refuses('Published product icon differs: pivot-other.svg')


if __name__ == '__main__':
    unittest.main()
