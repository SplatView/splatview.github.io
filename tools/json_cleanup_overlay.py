"""Generate exact JSON/hash cleanup adaptations in disposable build files."""
from pathlib import Path
import hashlib
import stat


ROOT = Path(__file__).resolve().parents[1]
JSON_HEADER = ROOT / 'native/deps/include/nlohmann/json.hpp'
MODEL_SOURCE = ROOT / '.build/desktop-package/src/core/model.cpp'
FILE_IO_SOURCE = ROOT / '.build/desktop-package/src/platform/file_io.cpp'
GENERATED_HEADER = ROOT / '.build/desktop-package/browser-include/nlohmann/json.hpp'
PINNED_JSON_SHA256 = 'aaf127c04cb31c406e5b04a63f1ae89369fccde6d8fa7cdda1ed4f32dfc5de63'
PINNED_FILE_IO_SHA256 = '094b71a3982a42a47001d2e5167b2c895995ef53b11d68c38959ea5c91d40fa1'
PINNED_MODEL_SHA256 = 'ddfe812e09467afc3113b32fff7c777aa6421413d76686c2676643878b26e523'
POST_JSON_MODEL_SHA256 = '906ef7e42596c209d77206ace8478810cae57a49aa1cb2d3f41c598807a5e8f2'

_DESTROY = '''            if (t == value_t::array || t == value_t::object)
            {
                // flatten the current json_value to a heap-allocated stack'''
_PARSE = '''    const auto meta = Json::parse(metadata.begin(), metadata.end());'''
_LOAD_SOG = '''Scene loadSog(const std::function<std::span<const uint8_t>(const std::string &)> &read,
              const LoadOptions &o) {'''
_CONTENT_KEY = '''std::string contentKey(std::span<const uint8_t> data, std::stop_token stop) {'''
_CONTENT_KEY_RETURN = '    return picosha2::get_hash_hex_string(hash);'
_CONTENT_KEY_FINISH = '''    hash.finish();
    return picosha2::get_hash_hex_string(hash);
}'''


def transform_header(data: bytes) -> str:
    """Adapt only the pinned single header; refuse repeated or changed inputs."""
    if hashlib.sha256(data).hexdigest() != PINNED_JSON_SHA256:
        raise ValueError('Pinned nlohmann JSON header changed; review cleanup authority.')
    text = data.decode('utf-8')
    if text.count(_DESTROY) != 1 or 'sv_json_bounded_recursive_destroy_active' in text:
        raise ValueError('JSON destroy anchor is not unique or has already been adapted.')
    return ('bool sv_json_bounded_recursive_destroy_active() noexcept;\n' +
            text.replace(_DESTROY, _DESTROY.replace(
                'if (t == value_t::array || t == value_t::object)',
                'if (!::sv_json_bounded_recursive_destroy_active() &&\n'
                '                (t == value_t::array || t == value_t::object))')))


def transform_model(text: str) -> str:
    """Own only loadSog's exact metadata parse; no request/export adaptations."""
    if (text.count(_LOAD_SOG) != 1 or text.count(_PARSE) != 1 or
            text.count('#include <nlohmann/json.hpp>\n') != 1 or
            'ParsedSogMetadata' in text or 'json_preflight.hpp' in text):
        raise ValueError('Portable SOG metadata parse changed; review its exact cleanup owner.')
    parse_offset = text.index(_PARSE)
    function_offset = text.index(_LOAD_SOG)
    if parse_offset < function_offset or text[function_offset:parse_offset].count('{') != 1:
        raise ValueError('SOG metadata parse escaped the reviewed loadSog entry.')
    return text.replace('#include <nlohmann/json.hpp>\n',
                        '#include <nlohmann/json.hpp>\n#include "json_preflight.hpp"\n').replace(
        _PARSE,
        '''    const ::sv_json::ParsedSogMetadata parsedMetadata(std::string_view{
        reinterpret_cast<const char *>(metadata.data()), metadata.size()});
    const auto &meta = parsedMetadata.get();''')


def transform_grouped_sog_reader(text: str) -> str:
    """Expose only the grouped read callback after the sole parsed JSON owner.

    Existing two-argument loadSog callers keep their default non-grouped path.
    No frozen source, parser authority, codec math or preference loader changes.
    """
    if hashlib.sha256(text.encode('utf-8')).hexdigest() != POST_JSON_MODEL_SHA256:
        raise ValueError('Post-JSON SOG model changed; review the grouped reader overlay.')
    include = '#include "json_preflight.hpp"\n'
    parsed = '    const auto &meta = parsedMetadata.get();'
    public = '} // namespace\nScene loadScene(std::span<const uint8_t> bytes, LoadOptions o) {'
    if any(text.count(anchor) != 1 for anchor in (include, parsed, public, _LOAD_SOG)):
        raise ValueError('Grouped SOG reader anchors are not unique.')
    wrapper = '''} // namespace
Scene browser_sog_group::load(const browser_sog_group::Read &read, LoadOptions o, size_t originalBytes) {
    if (!o.maxSplats || o.maxSplats > 1'000'000 || !originalBytes ||
        originalBytes > browser_sog_group::maximumOriginalBytes)
        fail("Invalid grouped SOG source or splat budget");
    if (!o.resources)
        fail("Grouped SOG requires resource admission");
    canceled(o);
    o.memory = sceneMemoryForBudget(*o.resources);
    auto scene = loadSog(read, o, true);
    fitBounds(scene, sceneMemoryForBudget(*o.resources, ResourceCategory::Work));
    scene.sourceBytes = originalBytes;
    // Browser identity/preferences belong to the independently checked source
    // group. Borrowed callback spans never acquire file/snapshot provenance.
    return scene;
}
Scene loadScene(std::span<const uint8_t> bytes, LoadOptions o) {'''
    return text.replace(include, include + '#include "browser_sog_group.hpp"\n').replace(
        _LOAD_SOG, _LOAD_SOG.replace('const LoadOptions &o)', 'const LoadOptions &o, bool grouped = false)')).replace(
        parsed, parsed + '\n    if (grouped) ::preview::browser_sog_group::preflight(meta, read, o);').replace(public, wrapper)


def adapt_grouped_sog_reader(model_source: Path) -> dict:
    """Adapt only the newly copied exact post-cleanup disposable model."""
    model_source = _exact_path(model_source, MODEL_SOURCE, required=True)
    before = _summary(model_source)
    model_source.write_text(transform_grouped_sog_reader(model_source.read_text(encoding='utf-8')),
                            encoding='utf-8', newline='\n')
    return {'scope': 'grouped-v1/v2-SH0-3 borrowed callback wrapper and all-role predecode plan; bundled path unchanged',
            'inputs': {'postJsonModelSource': before}, 'outputs': {'modelSource': _summary(model_source)}}


def transform_content_key(data: bytes) -> str:
    """Replace only pinned contentKey hex formatting, preserving hash/cancel work.

    The vendor ostream path can swallow bad_alloc and return a partial digest.
    Fixed stack formatting leaves one ordinary owning-string allocation whose
    failure propagates before candidate publication.
    """
    if hashlib.sha256(data).hexdigest() != PINNED_FILE_IO_SHA256:
        raise ValueError('Pinned portable file_io source changed; review content-key cleanup.')
    text = data.decode('utf-8').replace('\r\n', '\n')
    if (text.count(_CONTENT_KEY) != 1 or text.count(_CONTENT_KEY_FINISH) != 1 or
            text.count('#include <algorithm>\n') != 1 or 'contentKeyHex' in text):
        raise ValueError('Content-key formatting anchor is not unique or is already adapted.')
    return text.replace('#include <algorithm>\n', '#include <algorithm>\n#include <array>\n').replace(
        _CONTENT_KEY_FINISH,
        '''    hash.finish();
    // Browser overlay: stream formatting can swallow an allocation failure.
    // Prepare the complete digest on the stack, then allocate its sole owner.
    std::array<unsigned char, 32> digest{};
    hash.get_hash_bytes(digest.begin(), digest.end());
    constexpr char digits[] = "0123456789abcdef";
    std::array<char, 64> contentKeyHex{};
    for (size_t i = 0; i < digest.size(); ++i) {
        contentKeyHex[i * 2] = digits[digest[i] >> 4];
        contentKeyHex[i * 2 + 1] = digits[digest[i] & 15];
    }
    return std::string(contentKeyHex.data(), contentKeyHex.size());
}''')


def _plain_path(path: Path) -> None:
    for entry in (path, *path.parents):
        try:
            info = entry.lstat()
        except FileNotFoundError:
            continue
        if entry.is_symlink() or getattr(info, 'st_file_attributes', 0) & 0x400:
            raise ValueError(f'Linked JSON cleanup path is not admitted: {entry}')


def _exact_path(supplied: Path, expected: Path, *, required: bool) -> Path:
    supplied = Path(supplied).absolute()
    if supplied != expected.absolute():
        raise ValueError('JSON cleanup accepts only the exact dependency/disposable overlay paths.')
    _plain_path(supplied)
    if supplied.resolve() != expected.resolve():
        raise ValueError('JSON cleanup accepts only the exact dependency/disposable overlay paths.')
    if required or supplied.exists():
        if not stat.S_ISREG(supplied.lstat().st_mode):
            raise ValueError('JSON cleanup input/output must be a regular file.')
    return supplied


def _summary(path: Path) -> dict:
    data = path.read_bytes()
    return {'path': path.relative_to(ROOT).as_posix(), 'bytes': len(data),
            'sha256': hashlib.sha256(data).hexdigest()}


def adapt_json_cleanup(source_header: Path, model_source: Path,
                       generated_header: Path) -> dict:
    """Generate one reviewed header and adapt the newly copied model source.

    Returned fingerprints must join build provenance. Include browser-include
    before the ordinary dependency include directory for every linked JSON TU.
    """
    source_header = _exact_path(source_header, JSON_HEADER, required=True)
    model_source = _exact_path(model_source, MODEL_SOURCE, required=True)
    generated_header = _exact_path(generated_header, GENERATED_HEADER, required=False)
    inputs = {'dependencyHeader': _summary(source_header), 'modelSource': _summary(model_source)}
    if hashlib.sha256(model_source.read_bytes()).hexdigest() != PINNED_MODEL_SHA256:
        raise ValueError('Pinned portable SOG model changed; review cleanup authority.')
    header = transform_header(source_header.read_bytes())
    model = transform_model(model_source.read_text(encoding='utf-8'))
    generated_header.parent.mkdir(parents=True, exist_ok=True)
    _plain_path(generated_header)
    generated_header.write_text(header, encoding='utf-8', newline='\n')
    model_source.write_text(model, encoding='utf-8', newline='\n')
    return {'scope': 'exact parsed SOG cleanup authority; compatibility fallback; no quotas',
            'inputs': inputs,
            'outputs': {'generatedHeader': _summary(generated_header),
                        'modelSource': _summary(model_source)}}


def adapt_content_key(file_io_source: Path) -> dict:
    """Adapt only the exact newly copied portable file_io overlay source."""
    file_io_source = _exact_path(file_io_source, FILE_IO_SOURCE, required=True)
    before = _summary(file_io_source)
    text = transform_content_key(file_io_source.read_bytes())
    file_io_source.write_text(text, encoding='utf-8', newline='\n')
    return {'scope': 'complete content-key formatting; propagate allocation failure before publication',
            'inputs': {'fileIoSource': before},
            'outputs': {'fileIoSource': _summary(file_io_source)}}
