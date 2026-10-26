import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from evidence import CATALOG, Evidence, check_layout, digest, safe_path


class HistoricalEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.payloads = {'docs/validation/runs/example/report.json': b'\xff\xfe{\x00}\x00',
                         'test-results-example.command.json': b'{"originalPath":"test-results-example.log"}\r\n'}
        self.cache = self.root / '.build/validation/archive/history.zip'
        self.cache.parent.mkdir(parents=True)
        self.catalog = {'schemaVersion': 1, 'kind': 'splatview-historical-evidence', 'sourceRevision': 'a' * 40,
                        'archive': {'file': 'history.zip', 'bytes': 0, 'sha256': '0' * 64,
                                    'downloadUrl': 'https://github.com/SplatView/splatview.github.io/releases/download/v0.2.1/history.zip'},
                        'files': [{'path': name, 'bytes': len(data), 'sha256': digest(data), 'group': 'example'} for name, data in self.payloads.items()],
                        'totals': {'files': len(self.payloads), 'bytes': sum(map(len, self.payloads.values()))}}
        self.write_archive(self.payloads)

    def save_catalog(self):
        path = self.root / CATALOG
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self.catalog), encoding='utf-8')

    def write_archive(self, payloads):
        with zipfile.ZipFile(self.cache, 'w', zipfile.ZIP_DEFLATED) as archive:
            for name, data in payloads.items():
                archive.writestr(name, data)
        data = self.cache.read_bytes()
        self.catalog['archive'].update(bytes=len(data), sha256=digest(data))
        self.save_catalog()

    def test_original_bytes_restore_with_encoding_and_provenance_unchanged(self):
        evidence = Evidence(self.root)
        evidence.verify()
        for name, data in self.payloads.items():
            self.assertEqual(evidence.show(name), data)
        self.assertEqual(evidence.extract('.build/restored'), 2)
        self.assertEqual(evidence.extract('.build/restored'), 2)
        for name, data in self.payloads.items():
            self.assertEqual((self.root / '.build/restored' / name).read_bytes(), data)

    def test_catalog_inventory_rejects_extra_and_missing_archive_members(self):
        for payloads in [{**self.payloads, '../escape': b'no'}, {next(iter(self.payloads)): b'wrong'}]:
            with self.subTest(payloads=list(payloads)):
                self.write_archive(payloads)
                with self.assertRaisesRegex(ValueError, 'inventory'):
                    Evidence(self.root).verify()

    def test_both_archive_and_original_member_hashes_are_required(self):
        self.cache.write_bytes(self.cache.read_bytes() + b'changed')
        with self.assertRaisesRegex(ValueError, 'Archive hash/size'):
            Evidence(self.root).verify()
        self.write_archive(self.payloads)
        self.catalog['files'][0]['sha256'] = '1' * 64
        self.save_catalog()
        with self.assertRaisesRegex(ValueError, 'Historical evidence hash/size'):
            Evidence(self.root).verify()

    def test_conflict_is_detected_before_any_extraction_and_never_overwritten(self):
        destination = self.root / '.build/conflict'
        destination.mkdir()
        conflict = destination / 'test-results-example.command.json'
        conflict.write_bytes(b'concurrent work')
        with self.assertRaisesRegex(ValueError, 'overwrite differing'):
            Evidence(self.root).extract(destination)
        self.assertEqual(conflict.read_bytes(), b'concurrent work')
        self.assertFalse((destination / 'docs').exists())
        with self.assertRaisesRegex(ValueError, 'inside the workspace'):
            Evidence(self.root).extract(self.root.parent)

    def test_unsafe_paths_aliases_and_runtime_source_paths_are_refused(self):
        for path in ['../source', '/absolute', 'a\\b', 'a/../b', 'a/NUL.json', 'a/trailing.', 'a//b']:
            with self.subTest(path=path), self.assertRaises(ValueError):
                safe_path(path)
        self.catalog['files'][0]['path'] = 'src/app/controller.ts'
        self.save_catalog()
        with self.assertRaisesRegex(ValueError, 'historical path'):
            Evidence(self.root)

    def test_case_aliases_and_declared_oversized_payloads_are_refused(self):
        self.catalog['files'].append({**self.catalog['files'][0], 'path': self.catalog['files'][0]['path'].replace('report.json', 'REPORT.json')})
        self.save_catalog()
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            Evidence(self.root)
        self.catalog['files'].pop()
        self.catalog['files'][0]['bytes'] = 129 * 1024 * 1024
        self.save_catalog()
        with self.assertRaisesRegex(ValueError, 'byte bound'):
            Evidence(self.root)

    def test_bad_download_does_not_publish_a_cache_and_valid_download_is_verified(self):
        data = self.cache.read_bytes()
        self.cache.unlink()
        class Response(io.BytesIO):
            def geturl(self):
                return 'https://release-assets.githubusercontent.com/example'
        with patch('urllib.request.urlopen', return_value=Response(b'corrupt')):
            with self.assertRaisesRegex(ValueError, 'download hash/size'):
                Evidence(self.root).fetch()
        self.assertFalse(self.cache.exists())
        with patch('urllib.request.urlopen', return_value=Response(data)):
            Evidence(self.root).fetch()
        self.assertEqual(self.cache.read_bytes(), data)

    def test_project_layout_check_is_offline_and_rejects_loose_generated_evidence(self):
        check_layout(self.root)
        path = self.root / 'test-results-new.json'
        path.write_text('{}', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'Loose generated evidence'):
            check_layout(self.root)

    def test_only_declared_byte_exact_fixture_provenance_stays_in_source(self):
        name = next(iter(self.payloads))
        self.catalog['retainedInputs'] = [name]
        self.save_catalog()
        target = self.root / name
        target.parent.mkdir(parents=True)
        target.write_bytes(self.payloads[name])
        check_layout(self.root)
        target.write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'Pinned evidence input'):
            check_layout(self.root)


if __name__ == '__main__':
    unittest.main()
