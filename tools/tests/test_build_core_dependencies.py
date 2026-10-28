"""Bounded dependency preparation tests; no compiler, network or browser work."""
from pathlib import Path
import hashlib
import importlib.util
import io
import json
import tarfile
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('tested_build_core', Path(__file__).resolve().parents[1] / 'build-core.py')
builder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builder)


class ReviewedDependencyMaterializationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='splatview-dependency-test-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.archive = self.root / 'input.tar.gz'
        self.destination = self.root / 'sources'

    def make_archive(self, extra=(), include_links=True):
        with tarfile.open(self.archive, 'w:gz') as target:
            root = tarfile.TarInfo('zstd-1.5.6')
            root.type = tarfile.DIRTYPE
            target.addfile(root)
            entries = [('zstd-1.5.6/build/cmake/CMakeLists.txt', 'file', b'project(reviewed_fixture)\n', None)]
            if include_links:
                entries.extend(('zstd-1.5.6/' + name, 'symlink', b'', link)
                               for name, link in builder.ZSTD_OMITTED_LINKS.items())
            entries.extend(extra)
            for name, kind, data, link in entries:
                info = tarfile.TarInfo(name)
                if kind == 'file':
                    info.size = len(data)
                    target.addfile(info, io.BytesIO(data))
                else:
                    info.type = {'symlink': tarfile.SYMTYPE, 'hardlink': tarfile.LNKTYPE, 'directory': tarfile.DIRTYPE}[kind]
                    info.linkname = link or ''
                    target.addfile(info)
        return hashlib.sha256(self.archive.read_bytes()).hexdigest()

    def materialize(self, expected=None):
        return builder.materialize_reviewed_archive(self.archive, self.destination,
            expected or hashlib.sha256(self.archive.read_bytes()).hexdigest(), 'zstd-1.5.6', builder.ZSTD_OMITTED_LINKS)

    def test_writes_real_files_and_omits_only_the_two_reviewed_links(self):
        expected = self.make_archive()
        tree = self.materialize(expected)
        self.assertEqual(tree['files'], 1)
        self.assertEqual((self.destination / 'build/cmake/CMakeLists.txt').read_bytes(), b'project(reviewed_fixture)\n')
        for name in builder.ZSTD_OMITTED_LINKS:
            self.assertFalse((self.destination / name).exists())
        self.assertEqual(builder.provenance.verify_archive_tree(self.archive, self.destination,
            omitted_links=builder.ZSTD_OMITTED_LINKS), tree)

    def test_wrong_archive_hash_refuses_before_creating_sources(self):
        self.make_archive()
        with self.assertRaisesRegex(ValueError, 'SHA256'):
            self.materialize('0' * 64)
        self.assertFalse(self.destination.exists())

    def test_unsafe_archive_paths_refuse_before_writing_any_files(self):
        for name in ('/absolute', '../outside', 'zstd-1.5.6/../outside', 'zstd-1.5.6/a\\outside',
                     'other-root/file', 'zstd-1.5.6/drive:stream', 'zstd-1.5.6/./file',
                     'zstd-1.5.6//file', 'zstd-1.5.6/NUL.txt', 'zstd-1.5.6/trailing.'):
            with self.subTest(name=name):
                self.make_archive([(name, 'file', b'not admitted', None)])
                with self.assertRaisesRegex(ValueError, 'Unsafe'):
                    self.materialize()
                self.assertFalse(self.destination.exists())

    def test_duplicate_and_windows_case_aliases_refuse_before_writing(self):
        for name in ('zstd-1.5.6/build/cmake/CMakeLists.txt', 'zstd-1.5.6/build/cmake/cmakelists.txt',
                     'zstd-1.5.6/BUILD/another-file.txt'):
            with self.subTest(name=name):
                self.make_archive([(name, 'file', b'conflict', None)])
                with self.assertRaisesRegex(ValueError, 'Duplicate or case-aliased'):
                    self.materialize()
                self.assertFalse(self.destination.exists())

    def test_archive_drift_retains_unqualified_materialization_and_refuses(self):
        expected = self.make_archive()
        with patch.object(builder.provenance, 'digest_file', side_effect=[expected, '0' * 64]):
            with self.assertRaisesRegex(ValueError, 'changed during materialization'):
                self.materialize(expected)
        self.assertEqual((self.destination / 'build/cmake/CMakeLists.txt').read_bytes(), b'project(reviewed_fixture)\n')

    def test_unsupported_links_refuse_before_writing(self):
        for kind, name, link in (('symlink', 'unexpected-link', 'build/cmake'),
                                 ('hardlink', 'unexpected-link', 'zstd-1.5.6/build/cmake/CMakeLists.txt'),
                                 ('symlink', 'tests/cli-tests/bin/unzstd', 'different-target')):
            with self.subTest(kind=kind, name=name):
                self.make_archive([('zstd-1.5.6/' + name, kind, b'', link)], include_links=False)
                with self.assertRaisesRegex(ValueError, 'Unsupported'):
                    self.materialize()
                self.assertFalse(self.destination.exists())

    def test_file_directory_prefix_conflicts_refuse_before_writing(self):
        self.make_archive([('zstd-1.5.6/build', 'file', b'conflict', None)])
        with self.assertRaisesRegex(ValueError, 'file/link as a directory'):
            self.materialize()
        self.assertFalse(self.destination.exists())

    def test_missing_reviewed_link_metadata_refuses(self):
        self.make_archive(include_links=False)
        with self.assertRaisesRegex(ValueError, 'link omissions differ'):
            self.materialize()
        self.assertFalse(self.destination.exists())

    def test_existing_destination_is_never_overwritten_or_completed(self):
        self.make_archive()
        self.destination.mkdir()
        sentinel = self.destination / 'retained.txt'
        sentinel.write_bytes(b'retain this partial capture')
        with self.assertRaisesRegex(ValueError, 'new destination'):
            self.materialize()
        self.assertEqual(sentinel.read_bytes(), b'retain this partial capture')
        self.assertEqual(list(self.destination.iterdir()), [sentinel])

    def prepare_fixture(self):
        expected = self.make_archive()
        build = self.root / '.build/wasm'
        archive = build / '_deps/zstd-subbuild/zstd-populate-prefix/src/zstd-1.5.6.tar.gz'
        archive.parent.mkdir(parents=True)
        archive.write_bytes(self.archive.read_bytes())
        lock = self.root / 'native/DEPENDENCIES.json'
        lock.parent.mkdir()
        lock.write_text(json.dumps({'zstd': {'version': '1.5.6', 'sha256': expected}}), encoding='utf-8')
        return build

    def test_prepare_zstd_verifies_before_reusing_an_existing_source_tree(self):
        build = self.prepare_fixture()
        with patch.object(builder, 'ROOT', self.root), patch.object(builder, 'BUILD', build), \
                patch.object(builder.provenance, 'ROOT', self.root), \
                patch.object(builder.urllib.request, 'urlretrieve', side_effect=AssertionError('Unexpected network')):
            initial = builder.prepare_zstd()
            self.assertEqual(initial, builder.prepare_zstd())
            source = build / '_deps/zstd-src/build/cmake/CMakeLists.txt'
            source.write_bytes(b'tampered CMake before configure')
            with self.assertRaisesRegex(ValueError, 'differs from pinned archive'):
                builder.prepare_zstd()
            self.assertEqual(source.read_bytes(), b'tampered CMake before configure')

    def test_prepare_zstd_refuses_extra_or_missing_materialized_files(self):
        build = self.prepare_fixture()
        with patch.object(builder, 'ROOT', self.root), patch.object(builder, 'BUILD', build), \
                patch.object(builder.provenance, 'ROOT', self.root), \
                patch.object(builder.urllib.request, 'urlretrieve', side_effect=AssertionError('Unexpected network')):
            builder.prepare_zstd()
            source = build / '_deps/zstd-src'
            extra = source / 'injected.cmake'
            extra.write_bytes(b'not in pinned archive')
            with self.assertRaisesRegex(ValueError, 'missing or unexpected files'):
                builder.prepare_zstd()
            extra.unlink()
            (source / 'build/cmake/CMakeLists.txt').unlink()
            with self.assertRaisesRegex(ValueError, 'differs from pinned archive'):
                builder.prepare_zstd()


class RecoveryMaskOverlayTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='splatview-mask-overlay-test-')
        self.addCleanup(self.temporary.cleanup)
        self.header = Path(self.temporary.name) / 'mask_storage.hpp'

    def test_adds_only_the_browser_friend_to_a_disposable_copy(self):
        upstream = builder.ROOT / 'native/upstream/splatview/src/core/mask_storage.hpp'
        frozen = upstream.read_bytes()
        self.header.write_bytes(frozen)
        builder.adapt_checkpoint_mask_header(self.header)
        self.assertEqual(self.header.read_text(encoding='utf-8'),
            frozen.decode('utf-8').replace('\r\n', '\n').replace(
                '    friend class Document;\n',
                '    friend class Document;\n    friend struct BrowserSelectionAccess;\n    friend struct BrowserViewScopeMaskAccess;\n'))
        self.assertEqual(upstream.read_bytes(), frozen)

    def test_refuses_changed_or_ambiguous_private_boundary_without_rewriting(self):
        for text in ('class MaskStorage {};\n',
                     '    friend class Document;\n    friend class Document;\n'):
            with self.subTest(text=text):
                self.header.write_text(text, encoding='utf-8')
                before = self.header.read_bytes()
                with self.assertRaisesRegex(SystemExit, 'Portable mask access changed'):
                    builder.adapt_checkpoint_mask_header(self.header)
                self.assertEqual(self.header.read_bytes(), before)

    def test_refuses_a_previously_adapted_overlay_without_adding_another_friend(self):
        self.header.write_text('    friend class Document;\n', encoding='utf-8')
        builder.adapt_checkpoint_mask_header(self.header)
        before = self.header.read_bytes()
        with self.assertRaisesRegex(SystemExit, 'Portable mask access changed'):
            builder.adapt_checkpoint_mask_header(self.header)
        self.assertEqual(self.header.read_bytes(), before)


class CurrentViewScopeOverlayTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='splatview-view-scope-overlay-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.header = self.root / 'editing.hpp'
        self.source = self.root / 'editing.cpp'
        upstream = builder.ROOT / 'native/upstream/splatview/src/core'
        self.frozen_header = (upstream / 'editing.hpp').read_bytes()
        self.frozen_source = (upstream / 'editing.cpp').read_bytes()
        self.header.write_bytes(self.frozen_header)
        self.source.write_bytes(self.frozen_source)

    def test_exact_predicate_and_five_scoped_mutations_keep_global_history_reset(self):
        before = self.source.read_text(encoding='utf-8')
        global_tail = before[before.index('bool SceneEdits::restoreDeleted() {'):]
        builder.adapt_current_view_scope(self.header, self.source)
        header = self.header.read_text(encoding='utf-8')
        source = self.source.read_text(encoding='utf-8')
        self.assertIn('browser_view_scope::Scope selectionView_;', header)
        self.assertIn('const bool eligible = scopeContains(i);', source)
        self.assertIn('next = eligible && next;', source)
        self.assertEqual(source.count('const auto after=scopeContains(i) ?'), 5)
        self.assertIn('selectedInside && before == 0 ? 2 : before', source)
        self.assertEqual(source[source.index('bool SceneEdits::restoreDeleted() {'):], global_tail)
        upstream = builder.ROOT / 'native/upstream/splatview/src/core'
        self.assertEqual((upstream / 'editing.hpp').read_bytes(), self.frozen_header)
        self.assertEqual((upstream / 'editing.cpp').read_bytes(), self.frozen_source)

    def test_drift_or_second_transform_refuses_without_touching_either_leaf(self):
        original = self.source.read_text(encoding='utf-8')
        for source in (original.replace('if (!states_[i])', 'if (states_[i] == 1)', 1),
                       original.replace('bool inside = contains(i);', 'bool inside = true;'),
                       original.replace('bool SceneEdits::selectAll() {', 'bool SceneEdits::selectAllX() {')):
            with self.subTest(source=source[:40]):
                self.source.write_text(source, encoding='utf-8')
                before_header, before_source = self.header.read_bytes(), self.source.read_bytes()
                with self.assertRaisesRegex(SystemExit, 'Portable selection changed'):
                    builder.adapt_current_view_scope(self.header, self.source)
                self.assertEqual(self.header.read_bytes(), before_header)
                self.assertEqual(self.source.read_bytes(), before_source)
        self.source.write_bytes(self.frozen_source)
        builder.adapt_current_view_scope(self.header, self.source)
        before_header, before_source = self.header.read_bytes(), self.source.read_bytes()
        with self.assertRaisesRegex(SystemExit, 'Portable selection changed'):
            builder.adapt_current_view_scope(self.header, self.source)
        self.assertEqual(self.header.read_bytes(), before_header)
        self.assertEqual(self.source.read_bytes(), before_source)


class Spz3ExportOverlayTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='splatview-spz3-overlay-test-')
        self.addCleanup(self.temporary.cleanup)
        self.source = Path(self.temporary.name) / 'scene_exports.cpp'
        self.upstream = builder.ROOT / 'native/upstream/splatview/src/core/scene_exports.cpp'
        self.frozen = self.upstream.read_bytes()
        self.source.write_bytes(self.frozen)

    def test_keeps_original_byte_oracle_and_packing_but_bounds_serial_storage(self):
        original = self.source.read_text(encoding='utf-8')
        gzip = original[original.index('class GzipOutput {\n'):original.index('\ntemplate <class Function>\n')]
        packing = original[original.index('void writeSpz('):]
        builder.adapt_spz3_export(self.source)
        adapted = self.source.read_text(encoding='utf-8')
        self.assertIn(gzip.replace('GzipOutput', 'LegacyGzipOutput'), adapted)
        self.assertEqual(adapted[adapted.index('void writeSpz('):], packing)
        serial = adapted[adapted.index('class BoundedGzipOutput {'):adapted.index('// Only the native contract oracle')]
        self.assertNotIn('pending_', serial)
        self.assertNotIn('std::async', serial)
        self.assertNotIn('std::vector', serial)
        self.assertNotIn('std::ofstream', serial)
        self.assertIn('browser_export::OutputStream file_;', serial)
        self.assertEqual(serial.count('browser_export::Vector<uint8_t>'), 3)
        self.assertIn('codec.configure(stream);', serial)
        self.assertEqual(serial.count('codec.rethrowFailure();'), 2)
        self.assertIn('append(compress(input_, final, stop_));', serial)
        self.assertIn('        submit(true);\n', serial)
        self.assertIn('deflate(&stream, final ? Z_FINISH : Z_SYNC_FLUSH)', serial)
        self.assertIn('deflateInit2(&stream, 3, Z_DEFLATED, -MAX_WBITS, 8, Z_DEFAULT_STRATEGY)', serial)
        self.assertIn('if (browser_export::directActive()) bounded_.emplace(path, stop);', adapted)
        self.assertEqual(self.upstream.read_bytes(), self.frozen)

    def test_refuses_changed_or_ambiguous_anchors_without_rewriting(self):
        original = self.source.read_text(encoding='utf-8')
        for changed in (original.replace('input_.resize(used_);', 'input_.clear();'),
                        original.replace('class GzipOutput {', 'class GzipOutput {\nclass GzipOutput {'),
                        original.replace('std::ofstream file_;', 'std::fstream file_;')):
            with self.subTest(changed=changed[:80]):
                self.source.write_text(changed, encoding='utf-8')
                before = self.source.read_bytes()
                with self.assertRaisesRegex(SystemExit, 'Portable SPZ3 changed'):
                    builder.adapt_spz3_export(self.source)
                self.assertEqual(self.source.read_bytes(), before)

    def test_refuses_reapplying_an_existing_overlay(self):
        builder.adapt_spz3_export(self.source)
        before = self.source.read_bytes()
        with self.assertRaisesRegex(SystemExit, 'Portable SPZ3 changed'):
            builder.adapt_spz3_export(self.source)
        self.assertEqual(self.source.read_bytes(), before)


class SogExportOverlayTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='splatview-sog-overlay-test-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.frozen = builder.ROOT / 'native/upstream/splatview/src/core/sog_export.cpp'
        self.original = self.frozen.read_text(encoding='utf-8')
        self.adapted_order = '#include "browser_export_sink.hpp"\n' + self.original.replace(
            'std::vector<uint64_t>', 'browser_export::Vector<uint64_t>')

    def test_changes_storage_and_fixed_builder_only(self):
        result = builder.transform_sog_export(self.adapted_order)
        self.assertNotIn('std::vector<', result)
        self.assertNotIn('std::ofstream', result)
        self.assertIn('browser_export::OutputStream out_;', result)
        self.assertIn('browser_sog::MetadataOwner metadataOwner;', result)
        self.assertIn('archive.text("meta.json", metadataOwner.dump());', result)
        self.assertEqual(result.count('codecMemory.rethrowFailure();'), 3)
        self.assertIn('WebPConfigLosslessPreset(&config, 1)', result)
        self.assertIn('config.exact = 1;', result)
        self.assertIn('using ScaleBuckets = browser_export::Vector<Range>;', result)
        self.assertEqual(self.frozen.read_text(encoding='utf-8'), self.original)

    def test_refuses_changed_or_reapplied_storage_boundaries(self):
        for text in (self.adapted_order.replace('    Json meta;', '    Json metadata;'),
                     self.adapted_order.replace('std::ofstream out_;', 'std::fstream out_;'),
                     builder.transform_sog_export(self.adapted_order)):
            with self.subTest(text=text[:80]), self.assertRaisesRegex(SystemExit, 'Portable SOG'):
                builder.transform_sog_export(text)

    def test_generates_the_original_namespace_order_only_oracle(self):
        source = self.root / 'sog_export.cpp'
        oracle = self.root / 'oracle/sog.cpp'
        source.write_text(self.adapted_order, encoding='utf-8')
        builder.adapt_sog_export(self.root, oracle)
        self.assertEqual(oracle.read_text(encoding='utf-8'), self.adapted_order.replace(
            'namespace preview::detail {\n',
            'namespace preview::browser_sog_oracle {\nusing namespace preview::detail;\n'))
        self.assertEqual(source.read_text(encoding='utf-8'), builder.transform_sog_export(self.adapted_order))
        before = source.read_bytes()
        with self.assertRaisesRegex(SystemExit, 'Portable SOG changed'):
            builder.adapt_sog_export(self.root, self.root / 'unexpected.cpp')
        self.assertEqual(source.read_bytes(), before)
        self.assertFalse((self.root / 'unexpected.cpp').exists())

    def test_json_cleanup_requires_exact_specialization_and_owner_hook(self):
        header = self.root / 'json.hpp'
        original = builder.json_cleanup.transform_header(builder.json_cleanup.JSON_HEADER.read_bytes())
        header.write_text(original, encoding='utf-8')
        builder.adapt_sog_json_header(header)
        text = header.read_text(encoding='utf-8')
        self.assertIn('!::sv_json_bounded_recursive_destroy_active()', text)
        self.assertIn('::sv_sog_export_metadata_cleanup_active() &&', text)
        self.assertIn('std::is_same<AllocatorType<basic_json>, ::preview::browser_sog::MetadataAllocator<basic_json>>::value', text)
        self.assertEqual(text.count('std::vector<basic_json> stack;'), 1)
        before = header.read_bytes()
        with self.assertRaisesRegex(SystemExit, 'metadata cleanup boundary changed'):
            builder.adapt_sog_json_header(header)
        self.assertEqual(header.read_bytes(), before)
        header.write_text(original.replace('!::sv_json_bounded_recursive_destroy_active()', 'true'), encoding='utf-8')
        before = header.read_bytes()
        with self.assertRaisesRegex(SystemExit, 'metadata cleanup boundary changed'):
            builder.adapt_sog_json_header(header)
        self.assertEqual(header.read_bytes(), before)

    def test_webp_copy_preserves_symbols_and_original_source(self):
        source = builder.ROOT / 'tests/fixtures/webp-1.6.0/utils.c'
        before = source.read_bytes()
        destination = self.root / 'codec/webp_utils.c'
        builder.adapt_webp_utils(source, destination)
        text = destination.read_text(encoding='utf-8')
        self.assertIn('Copyright 2012 Google Inc.', text)
        self.assertIn('void* WebPSafeMalloc(uint64_t nmemb, size_t size)', text)
        self.assertIn('void* WebPSafeCalloc(uint64_t nmemb, size_t size)', text)
        self.assertIn('void WebPSafeFree(void* const ptr)', text)
        self.assertIn('void* WebPMalloc(size_t size)', text)
        self.assertIn('void WebPFree(void* ptr)', text)
        self.assertIn('sv_sog_webp_allocate(nmemb, size, 0)', text)
        self.assertIn('sv_sog_webp_allocate(nmemb, size, 1)', text)
        self.assertIn('sv_sog_webp_free(ptr);', text)
        self.assertEqual(source.read_bytes(), before)
        changed = self.root / 'changed.c'
        changed.write_bytes(before + b'\n// unreviewed change\n')
        missing = self.root / 'not-created/output.c'
        with self.assertRaisesRegex(SystemExit, 'Pinned WebP utils changed'):
            builder.adapt_webp_utils(changed, missing)
        self.assertFalse(missing.exists())


if __name__ == '__main__':
    unittest.main()
