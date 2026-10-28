import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from evidence import CATALOG, Evidence, check_layout, digest, safe_path


class ArchiveResponse(io.BytesIO):
    def geturl(self):
        return 'https://release-assets.githubusercontent.com/example'


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

    def interrupt_cache_write(self, replacement=None):
        original_open, cache = Path.open, self.cache

        class InterruptedWriter:
            def __init__(self, stream):
                self.stream = stream

            def __enter__(self):
                self.stream.__enter__()
                return self

            def __exit__(self, *args):
                result = self.stream.__exit__(*args)
                if replacement is not None:
                    replacement.replace(cache)
                return result

            def fileno(self):
                return self.stream.fileno()

            def write(self, data):
                self.stream.write(data[:len(data) // 2])
                raise OSError('Interrupted cache write')

        def open_file(path, mode='r', *args, **kwargs):
            stream = original_open(path, mode, *args, **kwargs)
            return InterruptedWriter(stream) if path == cache and mode == 'xb' else stream

        return patch.object(Path, 'open', open_file)

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
        with patch('urllib.request.urlopen', return_value=ArchiveResponse(b'corrupt')):
            with self.assertRaisesRegex(ValueError, 'download hash/size'):
                Evidence(self.root).fetch()
        self.assertFalse(self.cache.exists())
        with patch('urllib.request.urlopen', return_value=ArchiveResponse(data)):
            Evidence(self.root).fetch()
        self.assertEqual(self.cache.read_bytes(), data)

    def test_interrupted_cache_publication_is_removed_and_fetch_can_retry(self):
        data = self.cache.read_bytes()
        self.cache.unlink()
        with patch('urllib.request.urlopen', return_value=ArchiveResponse(data)), self.interrupt_cache_write():
            with self.assertRaisesRegex(OSError, 'Interrupted cache write'):
                Evidence(self.root).fetch()
        self.assertFalse(self.cache.exists())
        self.assertEqual(list(self.cache.parent.iterdir()), [])
        with patch('urllib.request.urlopen', return_value=ArchiveResponse(data)):
            Evidence(self.root).fetch()
        self.assertEqual(self.cache.read_bytes(), data)

    def test_failed_publication_preserves_a_concurrent_replacement(self):
        data = self.cache.read_bytes()
        self.cache.unlink()
        replacement = self.cache.with_name('concurrent.zip')
        replacement.write_bytes(b'concurrent replacement')
        with patch('urllib.request.urlopen', return_value=ArchiveResponse(data)), self.interrupt_cache_write(replacement):
            with self.assertRaisesRegex(OSError, 'Interrupted cache write'):
                Evidence(self.root).fetch()
        self.assertEqual(self.cache.read_bytes(), b'concurrent replacement')
        with patch('urllib.request.urlopen') as network:
            with self.assertRaisesRegex(ValueError, 'Archive hash/size'):
                Evidence(self.root).fetch()
        network.assert_not_called()
        self.assertEqual(self.cache.read_bytes(), b'concurrent replacement')

    def test_fetch_does_not_overwrite_or_remove_a_competing_publication(self):
        data = self.cache.read_bytes()
        self.cache.unlink()
        original_open, cache = Path.open, self.cache

        def open_file(path, mode='r', *args, **kwargs):
            if path == cache and mode == 'xb':
                with original_open(cache, 'wb') as stream:
                    stream.write(b'other publisher')
            return original_open(path, mode, *args, **kwargs)

        with patch('urllib.request.urlopen', return_value=ArchiveResponse(data)), patch.object(Path, 'open', open_file):
            with self.assertRaises(FileExistsError):
                Evidence(self.root).fetch()
        self.assertEqual(self.cache.read_bytes(), b'other publisher')

    def test_fetched_archive_with_invalid_members_does_not_remain_in_cache(self):
        data = self.cache.read_bytes()
        self.cache.unlink()
        self.catalog['files'][0]['sha256'] = '1' * 64
        self.save_catalog()
        with patch('urllib.request.urlopen', return_value=ArchiveResponse(data)):
            with self.assertRaisesRegex(ValueError, 'Historical evidence hash/size'):
                Evidence(self.root).fetch()
        self.assertFalse(self.cache.exists())

    def test_project_layout_check_is_offline_and_rejects_loose_generated_evidence(self):
        check_layout(self.root)
        path = self.root / 'test-results-new.json'
        path.write_text('{}', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'Loose generated evidence'):
            check_layout(self.root)

    def test_project_layout_rejects_non_entrypoint_root_files_in_a_source_export(self):
        for name in ['playwright.ci.config.ts', 'REVIEW_BASELINE.json', 'WEB_PORT_PLAN.md', 'scratch.txt']:
            with self.subTest(name=name):
                target = self.root / name
                target.write_text('extra root file', encoding='utf-8')
                with self.assertRaisesRegex(ValueError, 'outside the repository root'):
                    check_layout(self.root)
                target.unlink()

    def test_relocated_port_guides_keep_the_strict_archive_link_check(self):
        guide = self.root / 'docs/porting/plan.md'
        guide.parent.mkdir(parents=True)
        guide.write_text('[old report](../validation/runs/example/report.json)', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'Maintained guide links to archived evidence'):
            check_layout(self.root)
        guide.write_text('[archive catalog](../validation/README.md#example)', encoding='utf-8')
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

    def test_project_check_rejects_archive_links_in_active_guides_only(self):
        frozen = self.root / 'design/feature-reviews/historical.md'
        frozen.parent.mkdir(parents=True)
        frozen.write_text('[original](../../test-results-example.command.json)', encoding='utf-8')
        check_layout(self.root)
        guide = self.root / 'tools/bench/README.md'
        guide.parent.mkdir(parents=True)
        guide.write_text('[original](../../docs/validation/runs/example/report.json#scope)', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'Maintained guide links to archived evidence'):
            check_layout(self.root)
        guide.write_text('[archived](../../docs/validation/README.md#example)', encoding='utf-8')
        check_layout(self.root)

    def test_maintained_guide_can_link_to_a_retained_byte_pinned_witness(self):
        name = next(iter(self.payloads))
        self.catalog['retainedInputs'] = [name]
        self.save_catalog()
        target = self.root / name
        target.parent.mkdir(parents=True)
        target.write_bytes(self.payloads[name])
        (self.root / 'README.md').write_text(f'[fixture witness]({name})', encoding='utf-8')
        check_layout(self.root)


if __name__ == '__main__':
    unittest.main()
