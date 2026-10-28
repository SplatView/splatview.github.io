"""Frozen-reference bootstrap preserves byte locks and refuses partial admission."""
import hashlib
import importlib.util
import json
from pathlib import Path
import stat
import tempfile
import unittest
import warnings
import zipfile

SPEC = importlib.util.spec_from_file_location('restore_references', Path(__file__).resolve().parents[1] / 'restore-references.py')
references = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(references)


class RestoreReferencesTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.files = {'reference/windows/src/core.cpp': b'frozen\r\nsource\r\n'}
        lock = {'schemaVersion': 1, 'files': [{
            **self.record('reference/windows/src/core.cpp', self.files['reference/windows/src/core.cpp']),
            'package': 'windows-reference', 'originPath': 'src/core.cpp',
        }]}
        self.write('native/SOURCE_LOCK.json', json.dumps(lock).encode())
        for capture in references.CAPTURES:
            name = f'reference/targets/{capture}/source/.gitattributes'
            self.files[name] = b'* text=auto\r\n'
            self.write(f'reference/targets/{capture}/CAPTURE_MANIFEST.json', json.dumps({
                'schemaVersion': 1, 'files': [self.record('.gitattributes', self.files[name])],
            }).encode())
        self.archive = self.root / references.ARCHIVE
        self.members = {'sha256/' + hashlib.sha256(data).hexdigest(): data for data in self.files.values()}
        self.pack()

    @staticmethod
    def record(name, data):
        return {'path': name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}

    def write(self, name, data):
        target = self.root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)

    def pack(self, members=None):
        with zipfile.ZipFile(self.archive, 'w', compression=zipfile.ZIP_DEFLATED) as bundle:
            for name, data in (self.members if members is None else members).items():
                # Preserve raw malformed names in refusal fixtures even on
                # Windows, where ZipInfo normally normalizes backslashes.
                info = zipfile.ZipInfo()
                info.filename = info.orig_filename = name
                bundle.writestr(info, data)

    def assert_no_sources(self):
        for name in self.files:
            self.assertFalse((self.root / name).exists(), name)

    def test_fresh_checkout_and_idempotency_preserve_exact_bytes(self):
        before = {path: path.read_bytes() for path in self.root.rglob('*.json')}
        self.assertEqual(references.restore(self.root), (3, 0))
        for name, data in self.files.items():
            self.assertEqual((self.root / name).read_bytes(), data)
        stamps = {name: (self.root / name).stat().st_mtime_ns for name in self.files}
        self.assertEqual(references.restore(self.root), (0, 3))
        self.assertEqual(stamps, {name: (self.root / name).stat().st_mtime_ns for name in self.files})
        self.assertEqual(before, {path: path.read_bytes() for path in before})

    def test_conflicting_existing_source_prevents_all_restoration(self):
        name = list(self.files)[-1]
        self.write(name, b'local changes\n')
        with self.assertRaisesRegex(ValueError, 'bytes differ'):
            references.restore(self.root)
        self.assertEqual((self.root / name).read_bytes(), b'local changes\n')
        for missing in list(self.files)[:-1]:
            self.assertFalse((self.root / missing).exists())

    def test_corrupt_member_prevents_all_restoration(self):
        changed = dict(self.members)
        name = list(changed)[-1]
        changed[name] = b'x' * len(changed[name])
        self.pack(changed)
        with self.assertRaisesRegex(ValueError, 'bytes differ'):
            references.restore(self.root)
        self.assert_no_sources()

    def test_missing_or_additional_member_prevents_all_restoration(self):
        for extra in (False, True):
            with self.subTest(extra=extra):
                changed = dict(self.members)
                if extra:
                    changed['sha256/' + hashlib.sha256(b'unreviewed').hexdigest()] = b'unreviewed'
                else:
                    changed.pop(next(iter(changed)))
                self.pack(changed)
                with self.assertRaisesRegex(ValueError, 'complete manifest inventory'):
                    references.restore(self.root)
                self.assert_no_sources()

    def test_unsafe_archive_paths_prevent_all_restoration(self):
        for name in ('../escaped', '/absolute', 'C:/drive', 'reference\\windows\\alias',
                     'reference/windows/../escape', 'reference//alias'):
            with self.subTest(name=name):
                self.pack({**self.members, name: b'unsafe'})
                with self.assertRaisesRegex(ValueError, 'Unsafe reference path'):
                    references.restore(self.root)
                self.assert_no_sources()

    def test_duplicate_and_case_alias_members_are_refused(self):
        name = next(iter(self.members))
        for alias in (name, name.upper()):
            with self.subTest(alias=alias):
                self.pack()
                with warnings.catch_warnings():
                    warnings.simplefilter('ignore', UserWarning)
                    with zipfile.ZipFile(self.archive, 'a') as bundle:
                        bundle.writestr(alias, self.members[name])
                with self.assertRaisesRegex(ValueError, 'duplicate archive member'):
                    references.restore(self.root)
                self.assert_no_sources()

    def test_archive_symlink_is_refused(self):
        self.pack()
        with zipfile.ZipFile(self.archive, 'a') as bundle:
            info = zipfile.ZipInfo('reference/windows/link')
            info.create_system = 3
            info.external_attr = (stat.S_IFLNK | 0o777) << 16
            bundle.writestr(info, '../../outside')
        with self.assertRaisesRegex(ValueError, 'Unsafe or duplicate'):
            references.restore(self.root)
        self.assert_no_sources()

    def test_file_in_parent_path_prevents_all_restoration(self):
        name = list(self.files)[-1]
        self.write(str(Path(name).parent), b'local file')
        with self.assertRaisesRegex(ValueError, 'parent is not a directory'):
            references.restore(self.root)
        self.assert_no_sources()

    def test_manifest_cannot_escape_reference_tree(self):
        path = self.root / 'native/SOURCE_LOCK.json'
        lock = json.loads(path.read_bytes())
        lock['files'][0]['originPath'] = '../escape'
        path.write_text(json.dumps(lock), encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'Unsafe reference path'):
            references.restore(self.root)
        self.assert_no_sources()


if __name__ == '__main__':
    unittest.main()
