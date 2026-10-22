"""Fault probes use disposable fixtures; never alter the qualified SDK."""
from pathlib import Path
import importlib.util
import io
import json
import tarfile
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('verify_toolchain', Path(__file__).with_name('verify-toolchain.py'))
verifier = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(verifier)
BUILD_SPEC = importlib.util.spec_from_file_location('build_core', Path(__file__).with_name('build-core.py'))
builder = importlib.util.module_from_spec(BUILD_SPEC)
BUILD_SPEC.loader.exec_module(builder)


class SpzCleanupOverlayTests(unittest.TestCase):
    def setUp(self):
        self.source = (builder.ROOT / 'native/upstream/splatview/third_party/spz/src/cc/load-spz.cc').read_text(encoding='utf-8')

    def test_adaptation_is_pure_and_installs_both_stream_guards(self):
        adapted = builder.spz_cleanup.transform_source(self.source)
        self.assertEqual(adapted.count('BrowserZlibStreamCleanup cleanup(&stream, true);'), 1)
        self.assertEqual(adapted.count('BrowserZlibStreamCleanup cleanup(&stream, false);'), 1)
        self.assertNotIn('  inflateEnd(&stream);', adapted)
        self.assertNotIn('  deflateEnd(&stream);', adapted)
        self.assertEqual((builder.ROOT / 'native/upstream/splatview/third_party/spz/src/cc/load-spz.cc').read_text(encoding='utf-8'), self.source)

    def test_reapplication_and_changed_codec_anchors_are_refused(self):
        helper = builder.spz_cleanup
        adapted = helper.transform_source(self.source)
        with self.assertRaisesRegex(ValueError, 'review the exact'):
            helper.transform_source(adapted)
        for anchor in (helper._FUNCTION, helper._INFLATE_INIT, helper._DEFLATE_INIT,
                       helper._INFLATE_END, helper._DEFLATE_END):
            with self.subTest(anchor=anchor), self.assertRaisesRegex(ValueError, 'review the exact'):
                helper.transform_source(self.source.replace(anchor, '', 1))

    def test_unrelated_regular_file_is_never_modified(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'load-spz.cc'
            source.write_text(self.source, encoding='utf-8')
            original = source.read_bytes()
            with self.assertRaisesRegex(ValueError, 'only the disposable'):
                builder.spz_cleanup.adapt_spz_stream_cleanup(source)
            self.assertEqual(source.read_bytes(), original)


class JsonCleanupOverlayTests(unittest.TestCase):
    def setUp(self):
        self.header = (builder.ROOT / 'native/deps/include/nlohmann/json.hpp').read_bytes()
        self.model = (builder.ROOT / 'native/upstream/splatview/src/core/model.cpp').read_text(encoding='utf-8')

    def test_pinned_header_and_exact_model_parse_are_adapted_purely(self):
        helper = builder.json_cleanup
        adapted_header = helper.transform_header(self.header)
        adapted_model = helper.transform_model(self.model)
        self.assertEqual(adapted_header.count('if (!::sv_json_bounded_recursive_destroy_active() &&'), 1)
        self.assertEqual(adapted_model.count('const ::sv_json::ParsedSogMetadata parsedMetadata'), 1)
        self.assertEqual(adapted_model.count('const auto &meta = parsedMetadata.get();'), 1)
        self.assertEqual((builder.ROOT / 'native/deps/include/nlohmann/json.hpp').read_bytes(), self.header)
        self.assertEqual((builder.ROOT / 'native/upstream/splatview/src/core/model.cpp').read_text(encoding='utf-8'), self.model)

    def test_changed_or_repeated_generated_inputs_are_refused(self):
        helper = builder.json_cleanup
        for header in (self.header + b'changed', helper.transform_header(self.header).encode()):
            with self.subTest(header_bytes=len(header)), self.assertRaisesRegex(ValueError, 'Pinned nlohmann'):
                helper.transform_header(header)
        for model in (helper.transform_model(self.model), self.model.replace(helper._PARSE, '', 1),
                      self.model + helper._PARSE):
            with self.subTest(model_bytes=len(model)), self.assertRaisesRegex(ValueError, 'metadata parse changed'):
                helper.transform_model(model)

    def test_unrelated_paths_cannot_receive_generated_header_or_model(self):
        helper = builder.json_cleanup
        with tempfile.TemporaryDirectory() as directory:
            header = Path(directory) / 'json.hpp'
            model = Path(directory) / 'model.cpp'
            target = Path(directory) / 'generated.hpp'
            header.write_bytes(self.header)
            model.write_text(self.model, encoding='utf-8')
            original = model.read_bytes()
            with self.assertRaisesRegex(ValueError, 'only the exact'):
                helper.adapt_json_cleanup(header, model, target)
            self.assertEqual(header.read_bytes(), self.header)
            self.assertEqual(model.read_bytes(), original)
            self.assertFalse(target.exists())

    def test_content_key_formatting_uses_fixed_buffers_and_preserves_source(self):
        source = builder.ROOT / 'native/upstream/splatview/src/platform/file_io.cpp'
        original = source.read_bytes()
        adapted = builder.json_cleanup.transform_content_key(original)
        self.assertNotEqual(adapted.encode('utf-8'), original)
        self.assertNotIn('return picosha2::get_hash_hex_string(hash);', adapted)
        self.assertEqual(source.read_bytes(), original)

    def test_content_key_changed_and_already_adapted_inputs_are_refused(self):
        helper = builder.json_cleanup
        original = (builder.ROOT / 'native/upstream/splatview/src/platform/file_io.cpp').read_bytes()
        for changed in (original + b'changed', helper.transform_content_key(original).encode()):
            with self.subTest(bytes=len(changed)), self.assertRaisesRegex(ValueError, 'changed'):
                helper.transform_content_key(changed)

    def test_content_key_unrelated_file_is_never_modified(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'file_io.cpp'
            source.write_bytes((builder.ROOT / 'native/upstream/splatview/src/platform/file_io.cpp').read_bytes())
            original = source.read_bytes()
            with self.assertRaisesRegex(ValueError, 'only the exact'):
                builder.json_cleanup.adapt_content_key(source)
            self.assertEqual(source.read_bytes(), original)


class BuildInputVerificationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.tree = self.root / 'source'
        self.tree.mkdir()
        (self.tree / 'codec.c').write_bytes(b'int codec = 1;\n')

    def tearDown(self):
        self.temporary.cleanup()

    def archive(self, entries=None):
        archive = self.root / 'source.tar.gz'
        with tarfile.open(archive, 'w:gz') as output:
            for name, content in entries or [('codec-1/codec.c', b'int codec = 1;\n')]:
                item = tarfile.TarInfo(name)
                item.size = len(content)
                output.addfile(item, io.BytesIO(content))
        return archive

    def build_report(self):
        for relative in ('native/wasm/bindings.cpp', 'tools/build-core.py', 'tools/verify-toolchain.py', 'tools/capture-sources.py',
                         'tools/spz_stream_cleanup.py', 'tools/json_cleanup_overlay.py',
                         'public/wasm/splatview-core.mjs', 'public/wasm/splatview-core.wasm',
                         'public/wasm/splatview-camera.mjs', 'public/wasm/splatview-camera.wasm'):
            target = self.root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(relative.encode())
        source = {'schemaVersion': 1, 'capturedUtc': 'fixture-time', 'windowsBehaviorVersion': '0.12.82',
                  'packages': {'splatview': {'origin': 'C:\\fixture', 'files': 1, 'treeSha256': 'a' * 64}},
                  'files': [{'package': 'splatview', 'path': 'native/upstream/splatview/src/core/model.cpp',
                             'originPath': 'src/core/model.cpp', 'bytes': 10, 'sha256': 'b' * 64}]}
        (self.root / 'native/SOURCE_LOCK.json').write_text(json.dumps(source))
        (self.root / 'native/DEPENDENCIES.json').write_text(json.dumps({'codec': {'version': '1', 'sha256': 'c' * 64}}))
        (self.root / 'native/TOOLCHAIN_LOCK.json').write_text(json.dumps({
            'schemaVersion': 1, 'qualification': 'fixture',
            'inputs': {'host': 'windows-x86_64', 'files': {'compiler': {'bytes': 20, 'sha256': 'd' * 64}}}}))
        contract = builder.ROOT / 'native/wasm/runtime-contract.json'
        (self.root / 'native/wasm/runtime-contract.json').write_bytes(contract.read_bytes())
        inputs = verifier.build_inputs(self.root)
        identities = verifier.runtime_identities(self.root, inputs)
        report = {'schemaVersion': 1, 'buildMode': 'clean-first', 'inputs': inputs,
                  'nativeInputId': identities['core']['nativeInputId'], 'nativeIdentity': identities,
                  'outputs': {name: verifier.file_summary(self.root / 'public/wasm' / name)
                              for name in ('splatview-core.mjs', 'splatview-core.wasm',
                                           'splatview-camera.mjs', 'splatview-camera.wasm')}}
        (self.root / 'public/wasm/build-provenance.json').write_text(json.dumps(report))
        return report

    def test_native_input_identity_excludes_capture_time_origin_and_generated_outputs(self):
        report = self.build_report()
        identity = report['nativeInputId']
        source_path = self.root / 'native/SOURCE_LOCK.json'
        source = json.loads(source_path.read_text())
        source['capturedUtc'] = 'later'
        source['packages']['splatview']['origin'] = '/another/machine/checkout'
        source_path.write_text(json.dumps(source, indent=4))
        self.assertEqual(verifier.native_input_id(self.root), identity)
        # Full freshness still detects a changed provenance lock, even when its
        # implementation content identity is unchanged.
        with self.assertRaisesRegex(ValueError, 'stale'):
            verifier.verify_build_report(self.root)
        (self.root / 'src').mkdir()
        (self.root / 'src/main.tsx').write_text('UI-only change')
        (self.root / 'public/wasm/splatview-core.wasm').write_bytes(b'generated output')
        with patch.object(builder, 'BUILD', self.root / '.build/wasm'):
            header = builder.write_runtime_identity_header(report['nativeIdentity'])
        self.assertIn(identity, header.read_text())
        self.assertIn('inline constexpr char core[]', header.read_text())
        header.write_text('generated header is not an input')
        self.assertEqual(verifier.native_input_id(self.root), identity)

    def test_native_input_identity_changes_with_reviewed_content_closure(self):
        report = self.build_report()
        identity = report['nativeInputId']
        for relative, mutate in (
                ('native/SOURCE_LOCK.json', lambda item: item['files'][0].update(sha256='e' * 64)),
                ('native/DEPENDENCIES.json', lambda item: item['codec'].update(version='2')),
                ('native/TOOLCHAIN_LOCK.json', lambda item: item['inputs']['files']['compiler'].update(sha256='f' * 64))):
            path = self.root / relative
            original = path.read_bytes()
            value = json.loads(original)
            mutate(value)
            path.write_text(json.dumps(value))
            self.assertNotEqual(verifier.native_input_id(self.root), identity, relative)
            path.write_bytes(original)
        for relative in ('native/wasm/bindings.cpp', 'tools/build-core.py', 'tools/spz_stream_cleanup.py', 'tools/json_cleanup_overlay.py'):
            path = self.root / relative
            original = path.read_bytes()
            path.write_bytes(original + b' changed')
            self.assertNotEqual(verifier.native_input_id(self.root), identity, relative)
            path.write_bytes(original)
        self.assertEqual(verifier.native_input_id(self.root), identity)

    def test_native_input_identity_is_canonical_and_rejects_unsafe_source_rows(self):
        report = self.build_report()
        identity = report['nativeInputId']
        path = self.root / 'native/SOURCE_LOCK.json'
        source = json.loads(path.read_text())
        path.write_text(json.dumps(source, sort_keys=True, indent=4))
        self.assertEqual(verifier.native_input_id(self.root), identity)
        for unsafe in ('/absolute.cpp', '../escape.cpp', 'native/../escape.cpp', 'C:/absolute.cpp', 'native\\bad.cpp'):
            with self.subTest(path=unsafe):
                changed = json.loads(json.dumps(source))
                changed['files'][0]['path'] = unsafe
                path.write_text(json.dumps(changed))
                with self.assertRaisesRegex(ValueError, 'Unsafe or duplicate'):
                    verifier.native_input_id(self.root)
        source['files'].append(source['files'][0])
        path.write_text(json.dumps(source))
        with self.assertRaisesRegex(ValueError, 'Unsafe or duplicate'):
            verifier.native_input_id(self.root)

    def test_runtime_identity_binds_capabilities_and_rejects_wrong_contract(self):
        report = self.build_report()
        identities = report['nativeIdentity']
        self.assertEqual(identities['core']['nativeInputId'], identities['camera']['nativeInputId'])
        self.assertEqual(identities['core']['mapLayoutVersion'], 1)
        self.assertEqual(identities['camera']['abi'], 4)
        self.assertEqual(identities['camera']['capabilities'], {'cameraInput': 1, 'cameraTransform': 1, 'cameraFrame': 1, 'cameraOrientation': 1, 'cameraFilterView': 1, 'cameraFilterGizmo': 1, 'cameraTransformGizmo': 1})
        self.assertEqual(identities['core']['capabilities']['proTransformSession'], 2)
        self.assertEqual(identities['core']['capabilities']['transformPivot'], 2)
        self.assertEqual(identities['core']['capabilities']['colorFillRange'], 1)
        self.assertEqual(identities['core']['abi'], 24)
        self.assertEqual(identities['core']['capabilities']['selectionMorphology'], 2)
        self.assertEqual(identities['core']['capabilities']['selectionFilter'], 2)
        self.assertEqual(identities['core']['capabilities']['selectionActions'], 2)
        self.assertEqual(identities['core']['capabilities']['currentViewScope'], 1)
        self.assertEqual(identities['core']['capabilities']['boundedAttributeExport'], 1)
        self.assertEqual(identities['core']['capabilities']['boundedSpz3Export'], 1)
        self.assertEqual(identities['core']['capabilities']['boundedSogExport'], 1)
        self.assertEqual(identities['core']['capabilities']['transactionReceipt'], 2)
        self.assertEqual(identities['core']['capabilities']['recoveryCheckpoint'], 2)
        self.assertEqual(identities['core']['capabilities']['duplicate'], 1)
        self.assertEqual(identities['core']['capabilities']['absoluteOpacitySession'], 1)
        self.assertEqual(identities['core']['capabilities']['opacityBaseStream'], 1)
        path = self.root / 'native/wasm/runtime-contract.json'
        contract = json.loads(path.read_text())
        self.assertEqual(contract['protocolVersion'], 28)
        self.assertEqual(contract['uiWorkerContract'], 23)
        for mutate in (lambda item: item['core'].update(abi=5),
                       lambda item: item['core'].update(abi=23),
                       lambda item: item['camera'].update(kind='core'),
                       lambda item: item['core'].update(variant='simd'),
                       lambda item: item['core'].update(mapLayoutVersion=2),
                       lambda item: item['camera']['capabilities'].update(cameraInput=True),
                       lambda item: item['core']['capabilities'].pop('boundedAttributeExport'),
                       lambda item: item['core']['capabilities'].pop('boundedSpz3Export'),
                       lambda item: item['core']['capabilities'].pop('boundedSogExport'),
                       lambda item: item['core']['capabilities'].pop('currentViewScope'),
                       lambda item: item['core']['capabilities'].pop('selectionMorphology'),
                       lambda item: item['core']['capabilities'].update(selectionMorphology=1),
                       lambda item: item['core']['capabilities'].pop('selectionFilter'),
                       lambda item: item['core']['capabilities'].update(selectionFilter=1),
                       lambda item: item['core']['capabilities'].update(selectionFilter=3),
                       lambda item: item['core']['capabilities'].pop('selectionActions'),
                       lambda item: item['core']['capabilities'].update(selectionActions=0),
                       lambda item: item['core']['capabilities'].update(selectionActions=1),
                       lambda item: item['core']['capabilities'].update(selectionActions=3),
                       lambda item: item['core']['capabilities'].pop('proTransformSession'),
                       lambda item: item['core']['capabilities'].update(proTransformSession=1),
                       lambda item: item['core']['capabilities'].update(proTransformSession=3),
                       lambda item: item['core']['capabilities'].pop('transformPivot'),
                       lambda item: item['core']['capabilities'].update(transformPivot=1),
                       lambda item: item['core']['capabilities'].update(transformPivot=3),
                       lambda item: item['core']['capabilities'].pop('colorFillRange'),
                       lambda item: item['core']['capabilities'].update(colorFillRange=0),
                       lambda item: item['core']['capabilities'].update(colorFillRange=2),
                       lambda item: item['core']['capabilities'].pop('absoluteOpacitySession'),
                       lambda item: item['core']['capabilities'].pop('opacityBaseStream'),
                       lambda item: item['core']['capabilities'].pop('transactionReceipt'),
                       lambda item: item['core']['capabilities'].update(transactionReceipt=1),
                       lambda item: item['core']['capabilities'].update(transactionReceipt=3),
                       lambda item: item['core']['capabilities'].pop('recoveryCheckpoint'),
                       lambda item: item['core']['capabilities'].update(recoveryCheckpoint=1),
                       lambda item: item['core']['capabilities'].update(recoveryCheckpoint=3),
                       lambda item: item['core']['capabilities'].pop('duplicate'),
                       lambda item: item['core']['capabilities'].update(duplicate=2),
                       lambda item: item['camera']['capabilities'].pop('cameraTransformGizmo'),
                       lambda item: item['core']['capabilities'].update({'bad-name': 1}),
                       lambda item: item['core'].update(nativeInputId='forged')):
            changed = json.loads(json.dumps(contract))
            mutate(changed)
            path.write_text(json.dumps(changed))
            with self.assertRaisesRegex(ValueError, 'Unsupported .* runtime identity contract'):
                verifier.runtime_identities(self.root)
        path.write_text(json.dumps(contract))
        before = verifier.native_input_id(self.root)
        contract['core']['capabilities']['selectionMap'] = 2
        path.write_text(json.dumps(contract))
        after = verifier.runtime_identities(self.root)
        self.assertNotEqual(after['core']['nativeInputId'], before)
        self.assertEqual(after['core']['capabilities']['selectionMap'], 2)

    def test_build_report_rejects_missing_or_forged_native_identity(self):
        report = self.build_report()
        path = self.root / 'public/wasm/build-provenance.json'
        for mutate in (lambda item: item.pop('nativeInputId'),
                       lambda item: item.pop('nativeIdentity'),
                       lambda item: item.update(nativeInputId='0' * 64),
                       lambda item: item['nativeIdentity']['core']['capabilities'].update(selectionMap=2),
                       lambda item: item['nativeIdentity']['camera'].update(abi=6)):
            changed = json.loads(json.dumps(report))
            mutate(changed)
            path.write_text(json.dumps(changed))
            with self.assertRaisesRegex(ValueError, 'native identity differs'):
                verifier.verify_build_report(self.root)

    def test_tree_digest_changes_for_content_rename_addition_and_removal(self):
        expected = verifier.tree_summary(self.tree)
        verifier.verify_tree(self.tree, expected)
        for action in ('content', 'rename', 'addition', 'removal'):
            with self.subTest(action=action):
                original = self.tree / 'codec.c'
                original.write_bytes(b'int codec = 1;\n')
                if action == 'content':
                    original.write_bytes(b'int codec = 2;\n')
                elif action == 'rename':
                    original.rename(self.tree / 'other.c')
                elif action == 'addition':
                    (self.tree / 'injected.c').write_bytes(b'injected')
                else:
                    original.unlink()
                with self.assertRaisesRegex(ValueError, 'differs from lock'):
                    verifier.verify_tree(self.tree, expected)
                for path in self.tree.iterdir():
                    path.unlink()

    def test_selection_checkpoint_friend_overlay_is_exact_and_fails_closed(self):
        header = self.root / 'editing.hpp'
        original = 'class SceneEdits {\n    friend class Document;\n};\n'
        header.write_text(original)
        builder.adapt_selection_checkpoint_header(header)
        self.assertEqual(header.read_text(), original.replace('    friend class Document;\n',
            '    friend class Document;\n    friend struct BrowserSelectionAccess;\n'))
        for changed in (original.replace('Document', 'Other'), original + original,
                        header.read_text(), original.replace('    friend', '  friend')):
            with self.subTest(changed=changed):
                header.write_text(changed)
                with self.assertRaisesRegex(SystemExit, 'Portable edit access changed'):
                    builder.adapt_selection_checkpoint_header(header)
                self.assertEqual(header.read_text(), changed)

    def test_selection_map_view_overlay_borrows_channels_and_rejects_changed_anchors(self):
        header = self.root / 'render_types.hpp'
        sampler = self.root / 'surface_selection.cpp'
        original = ('#include <memory>\nstruct SelectionMap {\n    unsigned width{}, height{};\n'
                    '    SceneVector<uint32_t> ids;\n    SceneVector<float> depths;\n'
                    '    SceneVector<uint32_t> visible;\n};\n')
        limit = "map.width>8192 || map.height>8192 || uint64_t(map.width)*map.height>16'000'000"
        header.write_text(original); sampler.write_text(limit)
        builder.adapt_selection_map_view(header, sampler)
        self.assertIn('std::span<const float> depths;', header.read_text())
        self.assertIn('std::span<const uint32_t> visible;', header.read_text())
        self.assertIn('std::span<const float> opacities;', header.read_text())
        self.assertEqual(sampler.read_text(), 'uint64_t(map.width)*map.height>262144')
        for changed_header, changed_sampler in ((original + original, limit),
                (original.replace('depths;', 'other;'), limit), (original, limit + limit),
                (original, limit.replace('8192', '8193'))):
            with self.subTest(header=changed_header, sampler=changed_sampler):
                header.write_text(changed_header); sampler.write_text(changed_sampler)
                with self.assertRaisesRegex(SystemExit, 'Portable selection map changed|Portable volume sampling changed'):
                    builder.adapt_selection_map_view(header, sampler)
                self.assertEqual(header.read_text(), changed_header)
                self.assertEqual(sampler.read_text(), changed_sampler)

    def test_flood_overlay_preserves_exact_native_mask_path_and_fails_closed(self):
        source = self.root / 'selection.cpp'
        original = (builder.ROOT / 'native/upstream/splatview/src/core/selection.cpp').read_text(encoding='utf-8')
        source.write_text(original)
        builder.adapt_selection_flood(source)
        adapted = source.read_text()
        self.assertIn('friend struct BrowserSelectionAccess;', adapted)
        self.assertIn('a /= scaleX_*scaleX_;', adapted)
        self.assertIn('b /= scaleX_*scaleY_;', adapted)
        self.assertIn('c /= scaleY_*scaleY_;', adapted)
        self.assertTrue(adapted.endswith('#include "flood_selection.hpp"\n'))
        for changed in (adapted, original + original,
                        original.replace('unsigned scale_, width_, height_, stride_;', 'unsigned changed;'),
                        original.replace('const float squared = float(scale_) * scale_;', 'const float squared = 2;'),
                        original.replace('columnValue = x / scale_', 'columnValue = x / 2')):
            with self.subTest(source=changed[:80]):
                source.write_text(changed)
                with self.assertRaisesRegex(SystemExit, 'Portable mask changed'):
                    builder.adapt_selection_flood(source)
                self.assertEqual(source.read_text(), changed)

    def test_build_report_covers_checkpoint_adapter_and_overlay_script(self):
        self.build_report()
        header = self.root / 'native/wasm/selection_checkpoint.hpp'
        header.write_text('reviewed adapter')
        # Adding any adapter after capture already invalidates the report.
        with self.assertRaisesRegex(ValueError, 'stale'):
            verifier.verify_build_report(self.root)
        self.build_report()
        header.write_text('changed adapter')
        with self.assertRaisesRegex(ValueError, 'stale'):
            verifier.verify_build_report(self.root)

    def test_archive_matches_exact_extracted_tree(self):
        expected = verifier.tree_summary(self.tree)
        self.assertEqual(verifier.verify_archive_tree(self.archive(), self.tree), expected)

    def test_archive_rejects_source_mutation_missing_and_extra_file(self):
        archive = self.archive()
        for action in ('mutation', 'missing', 'extra'):
            with self.subTest(action=action):
                original = self.tree / 'codec.c'
                original.write_bytes(b'int codec = 1;\n')
                if action == 'mutation':
                    original.write_bytes(b'int codec = 2;\n')
                elif action == 'missing':
                    original.unlink()
                else:
                    (self.tree / 'injected.c').write_bytes(b'injected')
                with self.assertRaisesRegex(ValueError, 'differs|missing or unexpected'):
                    verifier.verify_archive_tree(archive, self.tree)
                for path in self.tree.iterdir():
                    path.unlink()

    def test_only_explicit_adapter_replacement_is_accepted(self):
        archive = self.archive()
        adapter = self.root / 'sdk-config.h'
        adapter.write_bytes(b'reviewed adapter')
        (self.tree / 'codec.c').write_bytes(adapter.read_bytes())
        verifier.verify_archive_tree(archive, self.tree, {'codec.c': adapter})
        (self.tree / 'codec.c').write_bytes(b'changed adapter')
        with self.assertRaisesRegex(ValueError, 'differs'):
            verifier.verify_archive_tree(archive, self.tree, {'codec.c': adapter})
        (self.tree / 'codec.c').write_bytes(b'int codec = 1;\n')
        with self.assertRaisesRegex(ValueError, 'replacement is absent'):
            verifier.verify_archive_tree(archive, self.tree, {'unknown.c': adapter})

    def test_archive_rejects_traversal_duplicate_and_multiple_roots(self):
        for entries in ([('../escape.c', b'escape')],
                        [('codec-1/../escape.c', b'escape')],
                        [('codec-1/codec.c', b'int codec = 1;\n'), ('codec-1/codec.c', b'int codec = 1;\n')],
                        [('codec-1/codec.c', b'int codec = 1;\n'), ('other/injected.c', b'injected')]):
            with self.subTest(entries=entries):
                with self.assertRaisesRegex(ValueError, 'Unsafe|Duplicate|Multiple'):
                    verifier.verify_archive_tree(self.archive(entries), self.tree)
        self.assertFalse((self.root / 'escape.c').exists())

    def test_archive_rejects_link_entries(self):
        archive = self.root / 'link.tar'
        with tarfile.open(archive, 'w') as output:
            item = tarfile.TarInfo('codec-1/codec.c')
            item.type = tarfile.SYMTYPE
            item.linkname = '../escape.c'
            output.addfile(item)
        with self.assertRaisesRegex(ValueError, 'Unsafe'):
            verifier.verify_archive_tree(archive, self.tree)

    def test_only_named_nonbuild_windows_link_omissions_are_accepted(self):
        archive = self.archive()
        with tarfile.open(archive, 'r:gz') as source:
            regular = [(item, source.extractfile(item).read()) for item in source if item.isfile()]
        with tarfile.open(archive, 'w:gz') as output:
            for item, content in regular:
                output.addfile(item, io.BytesIO(content))
            link = tarfile.TarInfo('codec-1/test-alias')
            link.type = tarfile.SYMTYPE
            link.linkname = 'codec.c'
            output.addfile(link)
        verifier.verify_archive_tree(archive, self.tree, omitted_links={'test-alias': 'codec.c'})
        with self.assertRaisesRegex(ValueError, 'Unsafe'):
            verifier.verify_archive_tree(archive, self.tree, omitted_links={'test-alias': 'changed-target'})
        (self.tree / 'test-alias').write_bytes(b'injected-alias')
        with self.assertRaisesRegex(ValueError, 'unexpectedly exists'):
            verifier.verify_archive_tree(archive, self.tree, omitted_links={'test-alias': 'codec.c'})

    def test_build_removes_ambient_overrides_and_isolates_bytecode(self):
        ambient = {'PATH': 'original-path', 'EMCC_CFLAGS': '-injected',
                   'EMCC_LOCAL_PORTS': 'zlib=unreviewed', 'CXXFLAGS': '-injected',
                   'EM_CACHE': 'unreviewed-cache', 'EMSDK_PYTHON': 'unreviewed-python',
                   'CMAKE_CXX_COMPILER_LAUNCHER': 'unreviewed-launcher',
                   'PYTHONPATH': 'unreviewed-python-packages', 'NODE_OPTIONS': '--require injected'}
        with patch.dict(builder.os.environ, ambient, clear=True):
            env = builder.build_environment(self.root / 'ninja.exe', self.root / 'isolated-bytecode')
        for name in ('EMCC_CFLAGS', 'EMCC_LOCAL_PORTS', 'CXXFLAGS', 'CMAKE_CXX_COMPILER_LAUNCHER', 'PYTHONPATH', 'NODE_OPTIONS'):
            self.assertNotIn(name, env)
        self.assertEqual(env['PYTHONPYCACHEPREFIX'], str(self.root / 'isolated-bytecode'))
        self.assertEqual(env['PYTHONDONTWRITEBYTECODE'], '1')
        self.assertEqual(env['PYTHONNOUSERSITE'], '1')
        self.assertEqual(env['EM_CACHE'], str(builder.SDK / 'upstream/emscripten/cache'))
        self.assertEqual(env['EMSDK_PYTHON'], str(builder.SDK / 'python/3.13.3_64bit/python.exe'))

    def test_build_report_rejects_stale_adapter_and_output(self):
        report = self.build_report()
        self.assertEqual(verifier.verify_build_report(self.root), report['outputs'])
        adapter = self.root / 'native/wasm/bindings.cpp'
        original = adapter.read_bytes()
        adapter.write_bytes(b'changed adapter')
        with self.assertRaisesRegex(ValueError, 'stale'):
            verifier.verify_build_report(self.root)
        adapter.write_bytes(original)
        for name in report['outputs']:
            with self.subTest(output=name):
                path = self.root / 'public/wasm' / name
                original = path.read_bytes()
                path.write_bytes(b'changed generated output')
                with self.assertRaisesRegex(ValueError, 'output differs'):
                    verifier.verify_build_report(self.root)
                path.write_bytes(original)

    def test_build_report_rejects_incremental_or_incomplete_report(self):
        report = self.build_report()
        path = self.root / 'public/wasm/build-provenance.json'
        report['buildMode'] = 'incremental'
        path.write_text(json.dumps(report))
        with self.assertRaisesRegex(ValueError, 'unqualified'):
            verifier.verify_build_report(self.root)
        report['buildMode'] = 'clean-first'
        report['outputs'].pop('splatview-core.wasm')
        path.write_text(json.dumps(report))
        with self.assertRaisesRegex(ValueError, 'missing or unexpected'):
            verifier.verify_build_report(self.root)

    def test_build_report_checks_local_command_evidence(self):
        report = self.build_report()
        overlay = self.root / '.build/desktop-package/browser-include/nlohmann/json.hpp'
        overlay.parent.mkdir(parents=True, exist_ok=True)
        overlay.write_bytes(b'generated JSON cleanup header')
        report['desktopOverlay'] = verifier.tree_summary(self.root / '.build/desktop-package')
        for key, filename in [('commandEvidence', 'build-commands.txt'), ('compileCommands', 'compile_commands.json'), ('cmakeCache', 'CMakeCache.txt')]:
            path = self.root / '.build/wasm' / filename
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(filename.encode())
            report[key] = verifier.file_summary(path)
        (self.root / 'public/wasm/build-provenance.json').write_text(json.dumps(report))
        verifier.verify_build_report(self.root, require_local_evidence=True)
        (self.root / '.build/wasm/build-commands.txt').write_bytes(b'changed command')
        with self.assertRaisesRegex(ValueError, 'command/configuration evidence differs'):
            verifier.verify_build_report(self.root, require_local_evidence=True)

    def test_local_evidence_rejects_changed_generated_overlay_header(self):
        report = self.build_report()
        overlay = self.root / '.build/desktop-package/browser-include/nlohmann/json.hpp'
        overlay.parent.mkdir(parents=True, exist_ok=True)
        overlay.write_bytes(b'qualified generated header')
        report['desktopOverlay'] = verifier.tree_summary(self.root / '.build/desktop-package')
        for key, filename in [('commandEvidence', 'build-commands.txt'), ('compileCommands', 'compile_commands.json'), ('cmakeCache', 'CMakeCache.txt')]:
            path = self.root / '.build/wasm' / filename
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(filename.encode())
            report[key] = verifier.file_summary(path)
        (self.root / 'public/wasm/build-provenance.json').write_text(json.dumps(report))
        verifier.verify_build_report(self.root, require_local_evidence=True)
        overlay.write_bytes(b'changed generated header')
        with self.assertRaisesRegex(ValueError, 'differs from lock'):
            verifier.verify_build_report(self.root, require_local_evidence=True)


if __name__ == '__main__':
    unittest.main()
