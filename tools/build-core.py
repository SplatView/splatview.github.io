"""Reproducible browser build around the verified desktop dependency snapshot."""
from pathlib import Path, PurePosixPath
import hashlib
import importlib.util
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
SDK = Path(os.environ.get('EMSDK', ROOT / '.tools/emsdk'))
BUILD = ROOT / '.build/wasm'
OVERLAY = ROOT / '.build/desktop-package'
DEPS = ROOT / 'native/deps'
ZSTD_OMITTED_LINKS = {'tests/cli-tests/bin/unzstd': 'zstd', 'tests/cli-tests/bin/zstdcat': 'zstd'}

PROVENANCE_SPEC = importlib.util.spec_from_file_location('toolchain_provenance', ROOT / 'tools/verify-toolchain.py')
provenance = importlib.util.module_from_spec(PROVENANCE_SPEC)
PROVENANCE_SPEC.loader.exec_module(provenance)
SPZ_CLEANUP_SPEC = importlib.util.spec_from_file_location('spz_stream_cleanup', ROOT / 'tools/spz_stream_cleanup.py')
spz_cleanup = importlib.util.module_from_spec(SPZ_CLEANUP_SPEC)
SPZ_CLEANUP_SPEC.loader.exec_module(spz_cleanup)
JSON_CLEANUP_SPEC = importlib.util.spec_from_file_location('json_cleanup_overlay', ROOT / 'tools/json_cleanup_overlay.py')
json_cleanup = importlib.util.module_from_spec(JSON_CLEANUP_SPEC)
JSON_CLEANUP_SPEC.loader.exec_module(json_cleanup)

def download(url, path, expected=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        print('Fetching', url, flush=True)
        urllib.request.urlretrieve(url, path)
    sha = hashlib.sha256(path.read_bytes()).hexdigest()
    if expected and sha != expected:
        raise SystemExit(f'Dependency hash mismatch: {path}')
    return sha

def verify_archive_tree(archive, directory):
    return provenance.verify_archive_tree(archive, directory)


def assert_plain_path(path):
    """Reject links/junctions before using an existing input or output ancestor."""
    path = Path(path).absolute()
    for entry in (path, *path.parents):
        try:
            info = entry.lstat()
        except FileNotFoundError:
            continue
        if entry.is_symlink() or getattr(info, 'st_file_attributes', 0) & 0x400:
            raise ValueError(f'Linked dependency path is not admitted: {entry}')


def materialize_reviewed_archive(archive, destination, expected_sha256, top_directory, omitted_links):
    """Write a pinned archive directly into a new tree, never rename a directory.

    Validate all archive entries before creating the destination. Do not reuse
    objects, populate stamps, CMake caches or directory metadata. The only link
    omissions are the explicitly reviewed non-build aliases supplied by caller.
    A partially written tree is retained for diagnosis and must fail verification
    on the next attempt; it is never silently replaced or completed.
    """
    archive, destination = Path(archive), Path(destination)
    assert_plain_path(archive)
    assert_plain_path(destination)
    if not stat.S_ISREG(archive.lstat().st_mode):
        raise ValueError(f'Dependency archive is not a regular file: {archive}')
    if provenance.digest_file(archive) != expected_sha256:
        raise ValueError('Dependency archive differs from the pinned SHA256')
    if destination.exists():
        raise ValueError(f'Materialization requires a new destination: {destination}')
    if not top_directory or '/' in top_directory or '\\' in top_directory:
        raise ValueError('Invalid reviewed archive root')
    with tarfile.open(archive) as source:
        entries = source.getmembers()
        seen, component_names, seen_links = {}, {}, set()
        directories, files = set(), set()
        admitted = []
        for member in entries:
            name = member.name
            # PurePosixPath normalizes dot/empty components; reject those first.
            parts = name.rstrip('/').split('/')
            if (not name or name.startswith('/') or '\\' in name or
                    any(part in ('', '.', '..') for part in parts) or parts[0] != top_directory):
                raise ValueError(f'Unsafe dependency archive path: {name}')
            for part in parts:
                if (any(ord(char) < 32 or char in '<>:"|?*' for char in part) or part.endswith(('.', ' ')) or
                        re.fullmatch(r'(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?', part)):
                    raise ValueError(f'Unsafe Windows dependency archive path: {name}')
            path = PurePosixPath(*parts)
            key = path.as_posix().casefold()
            if key in seen:
                raise ValueError(f'Duplicate or case-aliased dependency archive path: {name}')
            seen[key] = name
            for count in range(1, len(parts) + 1):
                component = PurePosixPath(*parts[:count]).as_posix()
                alias = component.casefold()
                if alias in component_names and component_names[alias] != component:
                    raise ValueError(f'Duplicate or case-aliased dependency archive path: {name}')
                component_names[alias] = component
            if len(parts) == 1 and not member.isdir():
                raise ValueError('Archive root must be a directory')
            relative = PurePosixPath(*parts[1:]).as_posix() if len(parts) > 1 else ''
            for count in range(1, len(parts)):
                directories.add(PurePosixPath(*parts[:count]).as_posix().casefold())
            if member.isdir():
                directories.add(key)
            elif member.issym() and omitted_links.get(relative) == member.linkname:
                seen_links.add(relative)
                files.add(key)
            elif member.isfile():
                files.add(key)
                admitted.append((member, parts[1:]))
            else:
                raise ValueError(f'Unsupported dependency archive entry: {name}')
        if files & directories:
            raise ValueError('Dependency archive uses a file/link as a directory')
        if seen_links != set(omitted_links):
            raise ValueError('Reviewed dependency archive link omissions differ')
        destination.mkdir(parents=True, exist_ok=False)
        for member, parts in admitted:
            target = destination.joinpath(*parts)
            if not target.resolve().is_relative_to(destination.resolve()):
                raise ValueError(f'Escaping dependency output path: {member.name}')
            target.parent.mkdir(parents=True, exist_ok=True)
            content = source.extractfile(member)
            if content is None:
                raise ValueError(f'Dependency archive entry has no file data: {member.name}')
            with content, target.open('xb') as output:
                shutil.copyfileobj(content, output)
    if provenance.digest_file(archive) != expected_sha256:
        raise ValueError('Dependency archive changed during materialization')
    return provenance.verify_archive_tree(archive, destination, omitted_links=omitted_links)


def prepare_zstd():
    """Admit a complete Zstd source tree before CMake can execute its scripts."""
    locked = json.loads((ROOT / 'native/DEPENDENCIES.json').read_text(encoding='utf-8'))['zstd']
    if locked.get('version') != '1.5.6':
        raise ValueError('Zstd version changed; review browser dependency preparation')
    archive = BUILD / '_deps/zstd-subbuild/zstd-populate-prefix/src/zstd-1.5.6.tar.gz'
    source = BUILD / '_deps/zstd-src'
    assert_plain_path(archive)
    assert_plain_path(source)
    if not archive.resolve().is_relative_to(BUILD.resolve()) or not source.resolve().is_relative_to(BUILD.resolve()):
        raise ValueError('Zstd preparation escapes the admitted build directory')
    download('https://github.com/facebook/zstd/releases/download/v1.5.6/zstd-1.5.6.tar.gz', archive, locked['sha256'])
    if not source.exists():
        materialize_reviewed_archive(archive, source, locked['sha256'], 'zstd-1.5.6', ZSTD_OMITTED_LINKS)
        print('Materialized pinned Zstd directly into a new verified source tree', flush=True)
    admitted = provenance.verify_zstd(BUILD)
    print('Verified complete pinned Zstd source tree before CMake configuration', flush=True)
    return admitted


def adapt_selection_checkpoint_header(header):
    text = header.read_text(encoding='utf-8')
    anchor = '    friend class Document;\n'
    if text.count(anchor) != 1 or 'BrowserSelectionAccess' in text:
        raise SystemExit('Portable edit access changed; review the browser checkpoint adapter.')
    header.write_text(text.replace(anchor, anchor + '    friend struct BrowserSelectionAccess;\n'), encoding='utf-8')


def adapt_current_view_scope(header, source):
    """Fixed camera predicate; no upstream edits and no unadmitted N-byte scope."""
    h = header.read_text(encoding='utf-8')
    s = source.read_text(encoding='utf-8')
    include = '#include "render_types.hpp"\n'
    member = '    MaskStorage states_;\n'
    match = '        bool inside = contains(i);\n'
    commit = '        if (next != selected)\n'
    if (s.count('bool SceneEdits::selectAll() {') != 1 or
            s.count('bool SceneEdits::restoreDeleted() {') != 1):
        raise SystemExit('Portable selection changed; review the current view adapter.')
    start = s.index('bool SceneEdits::selectAll() {')
    end = s.index('bool SceneEdits::restoreDeleted() {', start)
    original = s[start:end]
    expected = '''bool SceneEdits::selectAll() {
    Changes changes{AdmittedAllocator<Change>{historyMemory_}};
    for (size_t i = 0; i < states_.size(); ++i)
        if (!states_[i])
            changes.push_back({static_cast<uint32_t>(i), 0, 1});
    return commit(std::move(changes));
}
bool SceneEdits::selectNone() {
    Changes changes{AdmittedAllocator<Change>{historyMemory_}};
    for (size_t i = 0; i < states_.size(); ++i)
        if (states_[i] & 1)
            changes.push_back({static_cast<uint32_t>(i), states_[i], 0});
    return commit(std::move(changes));
}
bool SceneEdits::invertSelection() {
    Changes changes{AdmittedAllocator<Change>{historyMemory_}};
    for (size_t i = 0; i < states_.size(); ++i)
        if (!(states_[i] & 2))
            changes.push_back({static_cast<uint32_t>(i), states_[i], uint8_t(states_[i] ^ 1)});
    return commit(std::move(changes));
}
bool SceneEdits::deleteSelected() {
    Changes changes{AdmittedAllocator<Change>{historyMemory_}};
    for (size_t i = 0; i < states_.size(); ++i)
        if (states_[i] & 1)
            changes.push_back({static_cast<uint32_t>(i), states_[i], 2});
    return commit(std::move(changes));
}
bool SceneEdits::keepSelected() {
    if (!selected_)
        return false;
    Changes changes{AdmittedAllocator<Change>{historyMemory_}};
    for (size_t i = 0; i < states_.size(); ++i)
        if (!states_[i])
            changes.push_back({static_cast<uint32_t>(i), 0, 2});
    return commit(std::move(changes));
}
'''
    if (h.count(include) != 1 or h.count(member) != 1 or s.count(match) != 1 or
            s.count(commit) != 1 or 'selectionView_' in h or
            original != expected):
        raise SystemExit('Portable selection changed; review the current view adapter.')
    h = h.replace(include, include + '#include "browser_view_scope.hpp"\n').replace(member,
        member + '    browser_view_scope::Scope selectionView_;\n'
        '    bool scopeContains(size_t i) const noexcept { return selectionView_.contains(scene_->gaussians[i]); }\n')
    s = s.replace(match, '        const bool eligible = scopeContains(i);\n        bool inside = eligible && contains(i);\n').replace(
        commit, '        next = eligible && next;\n' + commit)
    functions = []
    for name, expression in [('selectAll', 'uint8_t(1)'), ('selectNone', 'uint8_t(0)'),
                             ('invertSelection', 'uint8_t(before ^ 1)'), ('deleteSelected', 'uint8_t(before == 1 ? 2 : before)'),
                             ('keepSelected', 'uint8_t(before == 0 ? 2 : before)')]:
        guard = ''
        if name == 'keepSelected':
            guard = ('    bool selectedInside=false;\n'
                     '    for(size_t i=0;i<states_.size();++i) selectedInside |= states_[i]==1 && scopeContains(i);\n')
            expression = 'uint8_t(selectedInside && before == 0 ? 2 : before)'
        functions.append('bool SceneEdits::' + name + '() {\n' + guard +
            '    Changes changes{AdmittedAllocator<Change>{historyMemory_}};\n'
            '    for(size_t i=0;i<states_.size();++i) {\n'
            '        const auto before=states_[i];if(before&2)continue;\n'
            '        const auto after=scopeContains(i) ? ' + expression + ' : uint8_t(before==1?0:before);\n'
            '        if(after!=before)changes.push_back({uint32_t(i),before,after});\n'
            '    }\n    return commit(std::move(changes));\n}\n')
    s = s.replace(original, ''.join(functions))
    header.write_text(h, encoding='utf-8')
    source.write_text(s, encoding='utf-8')


def adapt_selection_commit_revision(header, source):
    """Port the desktop committed-selection notification into the disposable core.

    The scalar is worker-lifetime UI notification state, not durable history.
    Sparse edits reuse their existing deltas; dense replacements reuse their
    admitted masks. No second retained mask or per-revision field is introduced.
    Every throwing caller proves the complete increment before history append;
    apply/applyHistory remain noexcept publication operations.
    """
    h = header.read_text(encoding='utf-8')
    s = source.read_text(encoding='utf-8')
    def once(text, before, after):
        if text.count(before) != 1:
            raise SystemExit('Portable selection changed; review committed-selection revision adapter.')
        return text.replace(before, after)
    h = once(h, '    uint64_t revision() const { return revision_; }\n',
        '    uint64_t revision() const { return revision_; }\n'
        '    uint64_t selectionCommitRevision() const noexcept { return selectionCommitRevision_; }\n')
    h = once(h, '    void apply(const Changes &, bool forward) noexcept;\n',
        '    static bool changesSelection(const Changes &) noexcept;\n'
        '    static bool selectionBitsDiffer(std::span<const uint8_t>,std::span<const uint8_t>) noexcept;\n'
        '    void requireSelectionCommits(unsigned) const;\n'
        '    void apply(const Changes &, bool forward) noexcept;\n')
    h = once(h, '    uint64_t revision_{};\n',
        '    uint64_t revision_{};\n    uint64_t selectionCommitRevision_{};\n')
    s = once(s, 'void SceneEdits::apply(const Changes &changes, bool forward) noexcept {\n',
        '''bool SceneEdits::changesSelection(const Changes &changes) noexcept {
    return std::any_of(changes.begin(),changes.end(),[](const Change &change) {
        return ((change.before^change.after)&1)!=0;
    });
}
bool SceneEdits::selectionBitsDiffer(std::span<const uint8_t> before,std::span<const uint8_t> after) noexcept {
    return before.size()!=after.size() || !std::equal(before.begin(),before.end(),after.begin(),
        [](uint8_t a,uint8_t b){return (a&1)==(b&1);});
}
void SceneEdits::requireSelectionCommits(unsigned count) const {
    constexpr uint64_t maximum=9007199254740991ULL;
    if(selectionCommitRevision_>maximum || count>maximum-selectionCommitRevision_)
        throw std::overflow_error("Committed selection revision exhausted");
}
void SceneEdits::apply(const Changes &changes, bool forward) noexcept {
    bool selectionChanged=false;
''')
    s = once(s, '        writable[change.index] = after;\n    }\n}\n',
        '        selectionChanged|=((before^after)&1)!=0;\n'
        '        writable[change.index] = after;\n    }\n'
        '    if(selectionChanged && !draftStates_) ++selectionCommitRevision_;\n}\n')
    s = once(s, '    Revision revision{std::move(changes),{},{},{},{},beforeContent,next};\n',
        '    const bool draftSelection=draft && changesSelection(draft->changes);\n'
        '    requireSelectionCommits(unsigned(draftSelection)+unsigned(changesSelection(changes)));\n'
        '    Revision revision{std::move(changes),{},{},{},{},beforeContent,next};\n')
    s = once(s, '    // All potentially allocating work is complete. Keep the live selection\n',
        '    selectionCommitRevision_+=unsigned(draftSelection);\n'
        '    // All potentially allocating work is complete. Keep the live selection\n')
    s = once(s, '    auto revision=stageSelectionDraft(nextContent);\n    if(revision) {\n',
        '    auto revision=stageSelectionDraft(nextContent);\n'
        '    const bool selectionChanged=revision && changesSelection(revision->changes);\n'
        '    requireSelectionCommits(unsigned(selectionChanged));\n'
        '    if(revision) {\n')
    s = once(s, '    // Live states already display the delta. Confirmation only records it.\n',
        '    selectionCommitRevision_+=unsigned(selectionChanged);\n'
        '    // Live states already display the delta. Confirmation only records it.\n')
    s = once(s, '    scene_ = forward ? revision.after : revision.before;\n    states_.swap(states);\n',
        '    const bool selectionChanged=selectionBitsDiffer(states_,states);\n'
        '    scene_ = forward ? revision.after : revision.before;\n    states_.swap(states);\n'
        '    selectionCommitRevision_+=unsigned(selectionChanged);\n')
    s = once(s, '    const bool confirmed=bool(draft);\n    appendHistory(revision,draft);\n    draftStates_.reset();\n',
        '    const bool confirmed=bool(draft);\n'
        '    const bool draftSelection=draft && changesSelection(draft->changes);\n'
        '    const bool selectionChanged=selectionBitsDiffer(states_,nextStates);\n'
        '    requireSelectionCommits(unsigned(draftSelection)+unsigned(selectionChanged));\n'
        '    appendHistory(revision,draft);\n'
        '    selectionCommitRevision_+=unsigned(draftSelection)+unsigned(selectionChanged);\n'
        '    draftStates_.reset();\n')
    s = once(s, '    auto writable=baseline.copyForWriteIfShared();\n',
        '    requireSelectionCommits(unsigned(changesSelection(changes)));\n'
        '    auto writable=baseline.copyForWriteIfShared();\n')
    for stack, target in [('undo_', 'beforeStates'), ('redo_', 'afterStates')]:
        anchor = ('    if (' + stack + '.empty())\n        return false;\n    MaskStorage states;\n')
        s = once(s, anchor, '    if (' + stack + '.empty())\n        return false;\n'
            '    const auto &entry=' + stack + '.back();\n'
            '    requireSelectionCommits(unsigned(entry.before ? selectionBitsDiffer(states_,entry.' + target + ') : changesSelection(entry.changes)));\n'
            '    MaskStorage states;\n')
    header.write_text(h, encoding='utf-8')
    source.write_text(s, encoding='utf-8')


def adapt_selection_history_revision(header, source):
    """Port desktop's per-entry selection stamp, without changing codec3.

    Stamps are ordinary revision creation/amendment values, not the committed
    selection notification counter. Copies and Undo/Redo move them naturally;
    recovery deliberately defaults old entries to zero. No N-sized state or
    per-summary history scan is introduced. Keep cancellation noexcept.
    """
    h = header.read_text(encoding='utf-8')
    s = source.read_text(encoding='utf-8')
    def once(text, before, after):
        if text.count(before) != 1:
            raise SystemExit('Portable history changed; review exact selection history stamp adapter.')
        return text.replace(before, after)
    h = once(h, '    uint64_t selectionCommitRevision() const noexcept { return selectionCommitRevision_; }\n',
        '    uint64_t selectionCommitRevision() const noexcept { return selectionCommitRevision_; }\n'
        '    uint64_t undoSelectionRevision() const noexcept { return undo_.empty()?0:undo_.back().selectionRevision; }\n')
    h = once(h, '        uint64_t beforeContent{}, afterContent{};\n',
        '        uint64_t beforeContent{}, afterContent{};\n'
        '        uint64_t selectionRevision{}; // Runtime-only; recovery entries default to zero.\n')
    h = once(h, '    void requireSelectionCommits(unsigned) const;\n',
        '    void requireSelectionCommits(unsigned) const;\n'
        '    uint64_t nextSelectionHistoryRevision(unsigned steps=1) const;\n')
    s = once(s, 'bool SceneEdits::changesSelection(const Changes &changes) noexcept {\n',
        '''uint64_t SceneEdits::nextSelectionHistoryRevision(unsigned steps) const {
    constexpr uint64_t maximum=9007199254740991ULL;
    if(revision_>maximum || steps>maximum-revision_)
        throw std::overflow_error("Selection history revision exhausted");
    return revision_+steps;
}
bool SceneEdits::changesSelection(const Changes &changes) noexcept {
''')
    s = once(s, '    Revision revision{std::move(changes),{},{},{},{},beforeContent,next};\n',
        '    Revision revision{std::move(changes),{},{},{},{},beforeContent,next};\n'
        '    if(!modifiesContent) revision.selectionRevision=nextSelectionHistoryRevision(1+unsigned(bool(draft)));\n')
    s = once(s, '    return Revision{std::move(changes),{},{},{},{},contentRevision_,content ? ++nextContent : contentRevision_};\n',
        '    const auto stamp=content?0:nextSelectionHistoryRevision();\n'
        '    return Revision{std::move(changes),{},{},{},{},contentRevision_,content ? ++nextContent : contentRevision_,stamp};\n')
    # Reset cancels a draft before its final selection-only history event.
    # Reuse the existing baseline walk to count that ordinary revision step.
    s = once(s, '    for(size_t i=0;i<baseline.size();++i)\n'
        '        if(baseline[i]) changes.push_back({static_cast<uint32_t>(i),baseline[i],0});\n',
        '    bool cancelledDraft=false;\n'
        '    for(size_t i=0;i<baseline.size();++i) {\n'
        '        cancelledDraft|=baseline[i]!=states_[i];\n'
        '        if(baseline[i]) changes.push_back({static_cast<uint32_t>(i),baseline[i],0});\n'
        '    }\n')
    s = once(s, '    Revision revision{std::move(changes),{},{},{},{},contentRevision_,next};\n'
        '    std::optional<Revision> noDraft;\n',
        '    Revision revision{std::move(changes),{},{},{},{},contentRevision_,next};\n'
        '    if(!content) revision.selectionRevision=nextSelectionHistoryRevision(1+unsigned(cancelledDraft));\n'
        '    std::optional<Revision> noDraft;\n')
    header.write_text(h, encoding='utf-8')
    source.write_text(s, encoding='utf-8')


def adapt_checkpoint_mask_header(header):
    """Expose shared mask identity only in the disposable browser overlay.

    data() is not an owner identity for an allocated zero-length mask. Recovery
    must preserve that distinction without exposing addresses in its wire data.
    """
    text = header.read_text(encoding='utf-8')
    anchor = '    friend class Document;\n'
    if text.count(anchor) != 1 or 'BrowserSelectionAccess' in text:
        raise SystemExit('Portable mask access changed; review the browser recovery adapter.')
    header.write_text(text.replace(anchor, anchor + '    friend struct BrowserSelectionAccess;\n    friend struct BrowserViewScopeMaskAccess;\n'), encoding='utf-8')


def adapt_allocation_census(scene_header, admitted_header):
    """Tag only the exact direct new after an actual payload grant exists."""
    scene = scene_header.read_text(encoding='utf-8')
    admitted = admitted_header.read_text(encoding='utf-8')
    scene_anchor = ('            // Envelope/control-block overhead is not payload and is not included\n'
                    '            // in the admission amount. Over-aligned types retain matching delete.\n'
                    '            void *block;')
    admitted_anchor = ('        // If allocation fails, the local grant rolls back before propagation.\n'
                       '        void *block;')
    include = '#include <cstddef>\n'
    if (scene.count(scene_anchor) != 1 or admitted.count(admitted_anchor) != 1 or
            scene.count('            auto grant=memory_->admit(bytes);\n') != 1 or
            admitted.count('            if (memory_) grant = memory_->admit(bytes);\n') != 1 or
            scene.count(include) != 1 or admitted.count(include) != 1 or
            'allocation_census.hpp' in scene or 'allocation_census.hpp' in admitted):
        raise SystemExit('Portable admitted allocators changed; review the exact allocation census hooks.')
    scene = scene.replace(include, '#include "allocation_census.hpp"\n' + include).replace(
        scene_anchor, scene_anchor.replace('            void *block;',
            '            ::sv_allocation::PayloadTag allocationPayload(bytes);\n            void *block;'))
    admitted = admitted.replace(include, '#include "allocation_census.hpp"\n' + include).replace(
        admitted_anchor, admitted_anchor.replace('        void *block;',
            '        ::sv_allocation::PayloadTag allocationPayload(grant ? bytes : 0);\n        void *block;'))
    scene_header.write_text(scene, encoding='utf-8')
    admitted_header.write_text(admitted, encoding='utf-8')


def adapt_selection_map_view(header, sampler):
    text = header.read_text(encoding='utf-8')
    anchor = ('struct SelectionMap {\n    unsigned width{}, height{};\n'
              '    SceneVector<uint32_t> ids;\n    SceneVector<float> depths;\n'
              '    SceneVector<uint32_t> visible;\n};')
    replacement = anchor.replace('SceneVector<float> depths;', 'std::span<const float> depths;').replace(
        'SceneVector<uint32_t> visible;', 'std::span<const uint32_t> visible;\n    std::span<const float> opacities;')
    include = '#include <memory>\n'
    if text.count(anchor) != 1 or text.count(include) != 1 or '#include <span>' in text:
        raise SystemExit('Portable selection map changed; review the browser borrowed-channel adapter.')
    sample_text = sampler.read_text(encoding='utf-8')
    limit = "map.width>8192 || map.height>8192 || uint64_t(map.width)*map.height>16'000'000"
    if sample_text.count(limit) != 1:
        raise SystemExit('Portable volume sampling changed; review the admitted browser map limit.')
    # This target compiles map consumers, never desktop render/readback writers.
    # Borrow immutable admitted channels instead of allocating duplicate arrays.
    header.write_text(text.replace(include, include + '#include <span>\n').replace(anchor, replacement), encoding='utf-8')
    sampler.write_text(sample_text.replace(limit, 'uint64_t(map.width)*map.height>262144'), encoding='utf-8')


def adapt_attribute_export_sink(core):
    """Keep frozen serializers/bytes, changing retained writers' storage.

    Spatial order shares a signature with compressed PLY. The unchanged
    nonshipping filesystem oracle uses its default allocator outside a scope.
    """
    changes = {
        'ply_export.cpp': [('std::ofstream out(path, std::ios::binary);',
                            'browser_export::OutputStream out(path, std::ios::binary);', 1)],
        'extra_exports.cpp': [('std::ofstream', 'browser_export::OutputStream', 4),
                              ('std::vector<uint64_t>', 'browser_export::Vector<uint64_t>', 3)],
        'export_internal.hpp': [('std::vector<uint64_t>', 'browser_export::Vector<uint64_t>', 2)],
        'sog_export.cpp': [('std::vector<uint64_t>', 'browser_export::Vector<uint64_t>', 2)],
        'scene_exports.cpp': [
            ('    std::ofstream out(path, std::ios::binary);',
             '    browser_export::OutputStream out(path, std::ios::binary);', 1),
            ('    AtomicFile output(path);',
             '    if (browser_export::directActive()) {\n'
             '        switch (format) {\n'
             '        case SceneExportFormat::Ply: writeVisiblePly(scene, states, path, stop); break;\n'
             '        case SceneExportFormat::Spz: writeSpz(scene, states, path, uint32_t(count), stop); break;\n'
             '        case SceneExportFormat::Splat: writeSplat(scene, states, path, stop); break;\n'
             '        case SceneExportFormat::CompressedPly: detail::writeCompressedPly(scene, states, path, uint32_t(count), stop); break;\n'
             '        case SceneExportFormat::Ksplat: detail::writeKsplat(scene, states, path, uint32_t(count), stop); break;\n'
             '        case SceneExportFormat::Csv: detail::writeCsv(scene, states, path, stop); break;\n'
             '        case SceneExportFormat::Sog:\n'
             '        case SceneExportFormat::Sogs: detail::writeSog(scene, states, path, uint32_t(count), format == SceneExportFormat::Sogs, stop); break;\n'
             '        default: throw std::runtime_error("Codec export has no direct attribute sink");\n'
             '        }\n'
             '        return;\n'
             '    }\n'
             '    AtomicFile output(path);', 1)],
    }
    for name, replacements in changes.items():
        path = core / name
        source = path.read_text(encoding='utf-8')
        if 'browser_export' in source or 'browser_export_sink.hpp' in source:
            raise SystemExit(f'Portable export source already adapted: {name}')
        for before, after, count in replacements:
            if source.count(before) != count:
                raise SystemExit(f'Portable export changed; review the exact sink adapter: {name} ({before})')
            source = source.replace(before, after)
        source = '#include "browser_export_sink.hpp"\n' + source
        path.write_text(source, encoding='utf-8')


def adapt_spz3_export(source):
    """Serial admitted gzip storage; preserve packing and a nonshipping oracle.

    The original class remains byte-for-byte (apart from its name) for calls
    outside the direct export scope. Browser calls cannot enter its async queue.
    All guards run before rewriting this disposable source leaf.
    """
    text = source.read_text(encoding='utf-8')
    start = 'class GzipOutput {\n'
    end = '\ntemplate <class Function>\n'
    if text.count(start) != 1 or text.count(end) != 1 or 'BoundedGzipOutput' in text:
        raise SystemExit('Portable SPZ3 changed; review the bounded gzip adapter')
    begin, finish = text.index(start), text.index(end)
    original = text[begin:finish]
    serial = original
    changes = [
        ('    static constexpr size_t blockSize = 1024 * 1024;',
         '    static constexpr size_t blockSize = 1024 * 1024;', 1),
        ('        input_.resize(used_);', '        input_.resize(used_);', 1),
        ('class GzipOutput {', 'class BoundedGzipOutput {', 1),
        ('    GzipOutput(const std::filesystem::path &path, std::stop_token stop)',
         '    BoundedGzipOutput(const std::filesystem::path &path, std::stop_token stop)', 1),
        ('std::vector<uint8_t>', 'browser_export::Vector<uint8_t>', 3),
        ('    std::ofstream file_;', '    browser_export::OutputStream file_;', 1),
        ('        // At most three compression workers plus the packing caller; a single\n'
         '        // CPU and small files use serial compression without worker overhead.\n'
         '        maxPending_ = std::clamp(std::thread::hardware_concurrency(), 1u, 4u) - 1;\n', '', 1),
        ('        while (!pending_.empty())\n            drain();\n', '', 1),
        ('        z_stream stream{};\n'
         '        if (deflateInit2(&stream, 3, Z_DEFLATED, -MAX_WBITS, 8, Z_DEFAULT_STRATEGY) != Z_OK)\n'
         '            throw std::runtime_error("Cannot create the SPZ encoder");',
         '        browser_spz3::CodecMemory codec(browser_export::scratchMemory());\n'
         '        z_stream stream{};\n'
         '        codec.configure(stream);\n'
         '        const int initialized = deflateInit2(&stream, 3, Z_DEFLATED, -MAX_WBITS, 8, Z_DEFAULT_STRATEGY);\n'
         '        if (initialized != Z_OK) {\n'
         '            codec.rethrowFailure();\n'
         '            throw std::runtime_error("Cannot create the SPZ encoder");\n'
         '        }', 1),
        ('        const int result = deflate(&stream, final ? Z_FINISH : Z_SYNC_FLUSH);',
         '        const int result = deflate(&stream, final ? Z_FINISH : Z_SYNC_FLUSH);\n'
         '        codec.rethrowFailure();', 1),
        ('    void drain() {\n'
         '        auto block = pending_.front().get();\n'
         '        pending_.pop_front();\n'
         '        append(std::move(block));\n'
         '    }\n', '', 1),
        ('        if (!maxPending_ || (final && !size_ && pending_.empty())) {\n'
         '            append(compress(input_, final, stop_));\n'
         '        } else {\n'
         '            if (pending_.size() >= maxPending_)\n'
         '                drain();\n'
         '            pending_.push_back(\n'
         '                std::async(std::launch::async, [input = std::move(input_), final, stop = stop_] {\n'
         '                    return compress(input, final, stop);\n'
         '                }));\n'
         '        }', '        append(compress(input_, final, stop_));', 1),
        ('    std::deque<std::future<Block>> pending_;\n', '', 1),
        ('    size_t maxPending_{};\n', '', 1),
    ]
    for before, after, count in changes:
        if serial.count(before) != count:
            raise SystemExit(f'Portable SPZ3 changed; review the bounded gzip adapter ({before})')
        serial = serial.replace(before, after)
    legacy = original.replace('GzipOutput', 'LegacyGzipOutput')
    wrapper = '''
// Only the native contract oracle uses the original filesystem/parallel class.
// Shipping direct exports always select the admitted serial writer.
class GzipOutput {
  public:
    GzipOutput(const std::filesystem::path &path, std::stop_token stop) {
        if (browser_export::directActive()) bounded_.emplace(path, stop);
        else legacy_.emplace(path, stop);
    }
    void put(uint8_t value) { if (bounded_) bounded_->put(value); else legacy_->put(value); }
    void integer(uint32_t value, unsigned bytes = 4) {
        if (bounded_) bounded_->integer(value, bytes); else legacy_->integer(value, bytes);
    }
    void finish() { if (bounded_) bounded_->finish(); else legacy_->finish(); }
  private:
    std::optional<BoundedGzipOutput> bounded_;
    std::optional<LegacyGzipOutput> legacy_;
};
'''
    source.write_text('#include "browser_spz3_memory.hpp"\n#include <optional>\n' +
                      text[:begin] + legacy + serial + wrapper + text[finish:], encoding='utf-8')


def transform_sog_export(text):
    """Storage/cleanup only; preserve fixed desktop palette, JSON and ZIP bytes."""
    if 'browser_sog' in text:
        raise SystemExit('Portable SOG already adapted; review its admitted writer')
    changes = [
        ('using Json = nlohmann::json;', 'using Json = browser_sog::Json;', 1),
        ('std::ofstream out_;', 'browser_export::OutputStream out_;', 1),
        ('std::string name;', 'browser_sog::String name;', 1),
        ('std::vector<Entry>', 'browser_export::Vector<Entry>', 1),
        ('const std::string &value', 'const browser_sog::String &value', 1),
        ('std::vector<float>', 'browser_export::Vector<float>', 3),
        ('std::vector<uint16_t>', 'browser_export::Vector<uint16_t>', 2),
        ('std::vector<uint8_t>', 'browser_export::Vector<uint8_t>', 2),
        ('std::vector<Range>', 'browser_export::Vector<Range>', 4),
        ('using ScaleBuckets = std::array<Range, scaleBucketCount>;',
         'using ScaleBuckets = browser_export::Vector<Range>;', 1),
        ('    ScaleBuckets scaleBuckets;', '    ScaleBuckets scaleBuckets(legacy ? 0 : scaleBucketCount);', 1),
        ('    Json meta;', '    browser_sog::MetadataOwner metadataOwner;\n    auto &meta = metadataOwner.value();', 1),
        ('archive.text("meta.json", meta.dump());', 'archive.text("meta.json", metadataOwner.dump());', 1),
        ('    struct Picture : WebPPicture {',
         '    browser_sog::TextureMemory codecMemory;\n'
         '    struct Picture : WebPPicture {', 1),
        ('    if (!WebPPictureImportRGBA(&picture, rgba.data(), int(width * 4)))\n'
         '        throw std::runtime_error("Cannot allocate the SOG property texture");',
         '    if (!WebPPictureImportRGBA(&picture, rgba.data(), int(width * 4))) {\n'
         '        codecMemory.rethrowFailure();\n'
         '        throw std::runtime_error("Cannot allocate the SOG property texture");\n'
         '    }', 1),
        ('    if (!WebPEncode(&config, &picture)) {\n        checkSaveStop(stop);',
         '    if (!WebPEncode(&config, &picture)) {\n        codecMemory.rethrowFailure();\n        checkSaveStop(stop);', 1),
        ('    checkSaveStop(stop);\n    archive.end();',
         '    codecMemory.rethrowFailure();\n    checkSaveStop(stop);\n    archive.end();', 1),
    ]
    for before, after, count in changes:
        if text.count(before) != count:
            raise SystemExit(f'Portable SOG changed; review admitted storage ({before})')
        text = text.replace(before, after)
    return '#include "browser_sog_export.hpp"\n' + text


def adapt_sog_export(core, oracle):
    source = core / 'sog_export.cpp'
    original = (ROOT / 'native/upstream/splatview/src/core/sog_export.cpp').read_text(encoding='utf-8')
    # The oracle keeps original JSON/vector/WebP/ZIP behavior. Only the namespace
    # and shared order signature differ from the frozen source; never shipped.
    namespace = 'namespace preview::detail {\n'
    if original.count(namespace) != 1 or original.count('std::vector<uint64_t>') != 2:
        raise SystemExit('Portable SOG oracle namespace/order boundary changed')
    expected = '#include "browser_export_sink.hpp"\n' + original.replace(
        'std::vector<uint64_t>', 'browser_export::Vector<uint64_t>')
    if source.read_text(encoding='utf-8') != expected:
        raise SystemExit('Portable SOG changed before the admitted writer overlay')
    transformed = transform_sog_export(expected)
    oracle_text = expected.replace(namespace, 'namespace preview::browser_sog_oracle {\nusing namespace preview::detail;\n')
    source.write_text(transformed, encoding='utf-8')
    oracle.parent.mkdir(parents=True, exist_ok=True)
    oracle.write_text(oracle_text, encoding='utf-8')


def adapt_sog_json_header(header):
    text = header.read_text(encoding='utf-8')
    anchor = ('if (!::sv_json_bounded_recursive_destroy_active() &&\n'
              '                (t == value_t::array || t == value_t::object))')
    if text.count(anchor) != 1 or 'sv_sog_export_metadata_cleanup_active' in text:
        raise SystemExit('SOG export metadata cleanup boundary changed')
    replacement = ('if (!::sv_json_bounded_recursive_destroy_active() &&\n'
        '                !(::sv_sog_export_metadata_cleanup_active() &&\n'
        '                  std::is_same<AllocatorType<basic_json>, ::preview::browser_sog::MetadataAllocator<basic_json>>::value) &&\n'
        '                (t == value_t::array || t == value_t::object))')
    header.write_text('namespace preview::browser_sog { template<class T> class MetadataAllocator; }\n'
        'bool sv_sog_export_metadata_cleanup_active() noexcept;\n' + text.replace(anchor,replacement), encoding='utf-8')


def adapt_webp_utils(source, destination):
    """Replace only checked allocator endpoints in one verified disposable leaf.

    All original symbols are compiled as a forced object, preventing the cached
    archive's unadapted utils object from being selected. Codec math is untouched.
    """
    data = source.read_bytes()
    if hashlib.sha256(data).hexdigest() != 'c8d90b4ccd536136ac710321c2632912a1f6ee2492a423e14ab9deb159490a56':
        raise SystemExit('Pinned WebP utils changed; review scoped allocation bridge')
    text = data.decode('utf-8').replace('\r\n','\n')
    changes = [
        ('  ptr = malloc((size_t)(nmemb * size));', '  ptr = sv_sog_webp_allocate(nmemb, size, 0);', 1),
        ('  ptr = calloc((size_t)nmemb, size);', '  ptr = sv_sog_webp_allocate(nmemb, size, 1);', 1),
        ('  free(ptr);', '  sv_sog_webp_free(ptr);', 1),
    ]
    for before, after, count in changes:
        if text.count(before) != count:
            raise SystemExit('Pinned WebP allocator endpoints changed')
        text = text.replace(before,after)
    declarations = ('#include <stdint.h>\n#include <stddef.h>\n'
        'extern void* sv_sog_webp_allocate(uint64_t, size_t, int);\n'
        'extern void sv_sog_webp_free(void*);\n')
    destination.parent.mkdir(parents=True,exist_ok=True)
    destination.write_text(declarations+text,encoding='utf-8')


def adapt_selection_flood(source):
    text = source.read_text(encoding='utf-8')
    replacements = {
        '        bits_.resize(size_t(stride_) * height_);':
            '        bits_.resize(size_t(stride_) * height_);\n        scaleX_=scaleY_=float(scale_);',
        'const float columnValue = x / scale_, rowValue = y / scale_;':
            'const float columnValue = x / scaleX_, rowValue = y / scaleY_;',
        ('        x /= scale_;\n        y /= scale_;\n        const float squared = float(scale_) * scale_;\n'
         '        a /= squared;\n        b /= squared;\n        c /= squared;'):
            ('        x /= scaleX_;\n        y /= scaleY_;\n        a /= scaleX_*scaleX_;\n'
             '        b /= scaleX_*scaleY_;\n        c /= scaleY_*scaleY_;'),
        '  private:\n    // Clamp the rounded pixel boundary':
            '  private:\n    friend struct BrowserSelectionAccess;\n    // Clamp the rounded pixel boundary',
        '    unsigned scale_, width_, height_, stride_;':
            '    unsigned scale_, width_, height_, stride_;\n    float scaleX_{},scaleY_{};',
    }
    if 'flood_selection.hpp' in text or any(text.count(anchor) != 1 for anchor in replacements):
        raise SystemExit('Portable mask changed; review the browser flood/footprint adapter.')
    for anchor, replacement in replacements.items():
        text = text.replace(anchor, replacement)
    source.write_text(text + '\n#include "flood_selection.hpp"\n', encoding='utf-8')


def adapter_inputs():
    return provenance.build_inputs()


def write_runtime_identity_header(identities):
    # Generated material is deliberately outside native/wasm and its input
    # digest. Including it in the digest would create an identity hash cycle.
    header = BUILD / 'generated/runtime_build_identity.hpp'
    header.parent.mkdir(parents=True, exist_ok=True)
    declarations = []
    for kind in ('core', 'camera'):
        serialized = json.dumps(identities[kind], sort_keys=True, separators=(',', ':'), ensure_ascii=True)
        if ')SV_BUILD_ID"' in serialized:
            raise ValueError('Unsafe runtime identity literal')
        declarations.append(f'inline constexpr char {kind}[] = R"SV_BUILD_ID({serialized})SV_BUILD_ID";')
    header.write_text('#pragma once\nnamespace splatview_runtime_identity {\n' +
                      '\n'.join(declarations) + '\n}\n', encoding='utf-8', newline='\n')
    return header


def normalized_command(command):
    cmake, ninja = provenance.tool_locations()
    return [str(argument).replace(str(cmake), '{cmake}').replace(str(ninja), '{ninja}')
            .replace(str(SDK), '{sdk}').replace(str(ROOT), '{workspace}') for argument in command]


def build_environment(ninja, bytecode_directory):
    env = os.environ.copy()
    # Use the locked SDK/config/cache, rather than ambient compiler flags,
    # alternate ports, compiler launchers or Python/Node injection settings.
    excluded = {'CFLAGS', 'CXXFLAGS', 'CPPFLAGS', 'LDFLAGS', 'CPATH', 'C_INCLUDE_PATH',
                'CPLUS_INCLUDE_PATH', 'LIBRARY_PATH', 'PYTHONPATH', 'PYTHONHOME',
                'NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD'}
    for name in list(env):
        if name.upper() in excluded or name.upper().startswith(('EMCC_', 'EMMAKEN_', 'EMSDK_', 'EM_', 'CMAKE_')):
            del env[name]
    env.update({
        'EMSDK': str(SDK), 'EM_CONFIG': str(SDK / '.emscripten'),
        'EM_CACHE': str(SDK / 'upstream/emscripten/cache'),
        'EM_PORTS': str(SDK / 'upstream/emscripten/cache/ports'),
        'EM_LLVM_ROOT': str(SDK / 'upstream/bin'), 'EM_BINARYEN_ROOT': str(SDK / 'upstream'),
        'EMSDK_PYTHON': str(SDK / 'python/3.13.3_64bit/python.exe'),
        'PYTHONNOUSERSITE': '1', 'PYTHONDONTWRITEBYTECODE': '1',
        # A fresh empty prefix prevents execution of unverified stale .pyc.
        'PYTHONPYCACHEPREFIX': str(bytecode_directory),
    })
    env['PATH'] = str(Path(ninja).parent) + os.pathsep + env.get('PATH', '')
    return env


def prepare_dependencies():
    lock_path = ROOT / 'native/DEPENDENCIES.json'
    locked = json.loads(lock_path.read_text(encoding='utf-8'))
    versions = {'nlohmann_json': '3.12.0', 'libdeflate': '1.24', 'emscripten': '6.0.12', 'libwebp': '1.6.0', 'zstd': '1.5.6'}
    if any(locked.get(name, {}).get('version') != version for name, version in versions.items()):
        raise SystemExit('Dependency versions changed; review the browser build adapters.')
    sdk_version = (SDK / 'upstream/emscripten/emscripten-version.txt').read_text().strip().strip('"')
    if sdk_version != locked['emscripten']['version']:
        raise SystemExit(f'Use Emscripten {locked["emscripten"]["version"]}; observed {sdk_version}.')
    json_url = 'https://raw.githubusercontent.com/nlohmann/json/v3.12.0/single_include/nlohmann/json.hpp'
    download(json_url, DEPS / 'include/nlohmann/json.hpp', locked['nlohmann_json']['sha256'])
    lib_url = 'https://codeload.github.com/ebiggers/libdeflate/tar.gz/refs/tags/v1.24'
    archive = DEPS / 'downloads/libdeflate-1.24.tar.gz'
    download(lib_url, archive, locked['libdeflate']['sha256'])
    if not (DEPS / 'libdeflate-1.24/CMakeLists.txt').exists():
        with tarfile.open(archive) as source:
            for member in source.getmembers():
                destination = (DEPS / member.name).resolve()
                if not destination.is_relative_to(DEPS.resolve()) or member.issym() or member.islnk():
                    raise SystemExit('Unsafe dependency archive entry')
            source.extractall(DEPS, filter='data')
    verify_archive_tree(archive, DEPS / 'libdeflate-1.24')

def main():
    subprocess.run([sys.executable, str(ROOT / 'tools/capture-sources.py'), 'verify'], check=True)
    if not (SDK / 'upstream/emscripten/emcc.py').is_file():
        raise SystemExit('Install and activate Emscripten 6.0.12, then set EMSDK or use .tools/emsdk.')
    prepare_dependencies()
    print('Verifying compiler/runtime/cache inputs against native/TOOLCHAIN_LOCK.json', flush=True)
    toolchain_inputs = provenance.verify_toolchain()
    ports = provenance.verify_ports()
    zstd = prepare_zstd()
    inputs = adapter_inputs()
    identities = provenance.runtime_identities(ROOT, inputs)
    identity_header = write_runtime_identity_header(identities)
    identity_header_input = provenance.file_summary(identity_header)
    # Zstd sources were fully checked above, before executing their CMake files.
    # Remove stale/injected overlay files before applying the explicit adapters.
    if OVERLAY.exists():
        resolved = OVERLAY.resolve()
        if resolved.parent != (ROOT / '.build').resolve() or resolved.name != 'desktop-package':
            raise SystemExit(f'Refusing to replace unexpected overlay path: {resolved}')
        shutil.rmtree(resolved)
    shutil.copytree(ROOT / 'native/upstream/splatview', OVERLAY)
    spz_cleanup.adapt_spz_stream_cleanup(OVERLAY / 'third_party/spz/src/cc/load-spz.cc')
    shutil.copy2(ROOT / 'native/wasm/parallel_for.hpp', OVERLAY / 'src/core/parallel_for.hpp')
    # Browser-only admitted implementation of Windows' completed selection
    # checkpoint. Its one friend declaration lives only in this disposable copy.
    adapt_selection_checkpoint_header(OVERLAY / 'src/core/editing.hpp')
    adapt_current_view_scope(OVERLAY / 'src/core/editing.hpp', OVERLAY / 'src/core/editing.cpp')
    adapt_selection_commit_revision(OVERLAY / 'src/core/editing.hpp', OVERLAY / 'src/core/editing.cpp')
    adapt_selection_history_revision(OVERLAY / 'src/core/editing.hpp', OVERLAY / 'src/core/editing.cpp')
    adapt_checkpoint_mask_header(OVERLAY / 'src/core/mask_storage.hpp')
    adapt_allocation_census(OVERLAY / 'src/core/scene_storage.hpp', OVERLAY / 'src/core/admitted_storage.hpp')
    adapt_attribute_export_sink(OVERLAY / 'src/core')
    adapt_spz3_export(OVERLAY / 'src/core/scene_exports.cpp')
    adapt_sog_export(OVERLAY / 'src/core', OVERLAY / 'browser-oracle/sog_export_original.cpp')
    adapt_webp_utils(SDK / 'upstream/emscripten/cache/ports/contrib.libwebp/libwebp-1.6.0/src/utils/utils.c',
                     OVERLAY / 'browser-codec/webp_utils.c')
    adapt_selection_map_view(OVERLAY / 'src/core/render_types.hpp', OVERLAY / 'src/core/surface_selection.cpp')
    adapt_selection_flood(OVERLAY / 'src/core/selection.cpp')
    json_cleanup_inputs = json_cleanup.adapt_json_cleanup(
        DEPS / 'include/nlohmann/json.hpp', OVERLAY / 'src/core/model.cpp',
        OVERLAY / 'browser-include/nlohmann/json.hpp')
    adapt_sog_json_header(OVERLAY / 'browser-include/nlohmann/json.hpp')
    json_cleanup_inputs['outputs']['generatedHeader'].update(provenance.file_summary(OVERLAY / 'browser-include/nlohmann/json.hpp'))
    json_cleanup_inputs['scope'] += '; separate fixed-constructed admitted SOG export specialization'
    grouped_sog_reader_inputs = json_cleanup.adapt_grouped_sog_reader(OVERLAY / 'src/core/model.cpp')
    content_key_cleanup_inputs = json_cleanup.adapt_content_key(
        OVERLAY / 'src/platform/file_io.cpp')
    # The desktop vendor intentionally omits Niantic's standalone JS bindings.
    # Compile its codec library through our own ABI instead of enabling those.
    spz_cmake = OVERLAY / 'third_party/spz/CMakeLists.txt'
    spz_text = spz_cmake.read_text(encoding='utf-8')
    if spz_text.count('  set(SPZ_BUILD_WASM ON)') != 1:
        raise SystemExit('SPZ configuration changed; review the browser adapter.')
    spz_cmake.write_text(spz_text.replace('  set(SPZ_BUILD_WASM ON)', '  set(SPZ_BUILD_WASM OFF)'), encoding='utf-8')
    overlay_inputs = provenance.tree_summary(OVERLAY)
    cmake, ninja = provenance.tool_locations()
    toolchain = SDK / 'upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake'
    configure_command = [cmake, '-S', str(ROOT / 'native/wasm'), '-B', str(BUILD), '-G', 'Ninja',
                         '-DCMAKE_BUILD_TYPE=Release', f'-DCMAKE_TOOLCHAIN_FILE={toolchain}',
                         f'-DCMAKE_MAKE_PROGRAM={ninja}', f'-DSPLATVIEW_PACKAGE={OVERLAY}',
                         f'-DSPLATVIEW_WEBP_SOURCE={SDK / "upstream/emscripten/cache/ports/contrib.libwebp/libwebp-1.6.0"}',
                         '-DCMAKE_POLICY_VERSION_MINIMUM=3.5', '-DCMAKE_EXPORT_COMPILE_COMMANDS=ON',
                         '-DCMAKE_DISABLE_FIND_PACKAGE_zstd=ON', '-DCMAKE_FIND_USE_PACKAGE_REGISTRY=OFF',
                         f'-DFETCHCONTENT_SOURCE_DIR_ZSTD={(BUILD / "_deps/zstd-src").resolve()}']
    # Cached .o/.a files are not reviewed build inputs. Recompile source into
    # clean objects rather than claiming their provenance from command equality.
    build_command = [cmake, '--build', str(BUILD), '--clean-first', '--parallel', '6']
    BUILD.mkdir(parents=True, exist_ok=True)
    for old_report in (BUILD / 'build-provenance.json', ROOT / 'public/wasm/build-provenance.json'):
        old_report.unlink(missing_ok=True)
    # Do not inherit unrecorded compiler flags/launchers from a previous CMake
    # cache. Ninja can still reuse objects whose complete commands match.
    (BUILD / 'CMakeCache.txt').unlink(missing_ok=True)
    with tempfile.TemporaryDirectory(prefix='python-bytecode-', dir=BUILD) as bytecode:
        if not Path(bytecode).resolve().is_relative_to(BUILD.resolve()):
            raise SystemExit('Unexpected Python bytecode directory outside the build workspace.')
        env = build_environment(ninja, bytecode)
        subprocess.run(configure_command, env=env, check=True)
        if provenance.verify_zstd(BUILD) != zstd:
            raise SystemExit('Zstd source/archive changed during CMake configuration; outputs are not qualified.')
        subprocess.run(build_command, env=env, check=True)
        commands = subprocess.check_output([ninja, '-C', str(BUILD), '-t', 'commands'], env=env, text=True)
    if adapter_inputs() != inputs or provenance.tree_summary(OVERLAY) != overlay_inputs:
        raise SystemExit('Build input changed while compiling; generated outputs are not qualified. Rebuild after input changes finish.')
    if provenance.file_summary(identity_header) != identity_header_input:
        raise SystemExit('Generated runtime identity changed while compiling; generated outputs are not qualified.')
    provenance.verify_toolchain()
    if provenance.verify_ports() != ports or provenance.verify_zstd(BUILD) != zstd:
        raise SystemExit('Codec input changed while compiling; generated outputs are not qualified.')
    command_file = BUILD / 'build-commands.txt'
    command_file.write_text(commands, encoding='utf-8', newline='\n')
    outputs = {name: provenance.file_summary(ROOT / 'public/wasm' / name)
               for name in ('splatview-core.mjs', 'splatview-core.wasm', 'splatview-camera.mjs', 'splatview-camera.wasm')}
    report = {
        'schemaVersion': 1,
        'buildMode': 'clean-first',
        'qualification': 'Verified source snapshot, adapters, installed Windows toolchain/cache fingerprints and codec trees. Not complete host closure, independent source-to-sysroot-cache reproduction, upstream binary authentication, native executable provenance, or cross-host bit reproducibility.',
        'inputs': inputs, 'toolchain': toolchain_inputs,
        'nativeInputId': identities['core']['nativeInputId'],
        'nativeIdentity': identities,
        'codecDependencies': {'ports': ports, 'zstd': zstd},
        'desktopOverlay': overlay_inputs,
        'jsonCleanup': json_cleanup_inputs,
        'groupedSogReader': grouped_sog_reader_inputs,
        'contentKeyCleanup': content_key_cleanup_inputs,
        'bootstrapPython': {'version': sys.version, 'executable': provenance.file_summary(sys.executable)},
        'configureCommand': normalized_command(configure_command),
        'buildCommand': normalized_command(build_command),
        'commandEvidence': {'path': '.build/wasm/build-commands.txt', **provenance.file_summary(command_file)},
        'compileCommands': provenance.file_summary(BUILD / 'compile_commands.json'),
        'cmakeCache': provenance.file_summary(BUILD / 'CMakeCache.txt'),
        'environmentPolicy': 'Locked SDK paths; ambient compiler/Python/Node overrides removed; empty isolated Python bytecode prefix; fresh root CMake cache; external zstd package discovery disabled.',
        'outputs': outputs,
    }
    serialized = json.dumps(report, indent=2) + '\n'
    (BUILD / 'build-provenance.json').write_text(serialized, encoding='utf-8')
    (ROOT / 'public/wasm/build-provenance.json').write_text(serialized, encoding='utf-8')
    provenance.verify_build_report(require_local_evidence=True)
    print('Build provenance: public/wasm/build-provenance.json (commands: .build/wasm/build-commands.txt)', flush=True)

if __name__ == '__main__':
    main()
