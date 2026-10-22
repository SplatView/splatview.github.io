"""Add exception-safe legacy SPZ zlib cleanup to the disposable browser overlay."""
from pathlib import Path
import stat


ROOT = Path(__file__).resolve().parents[1]
OVERLAY_SOURCE = ROOT / '.build/desktop-package/third_party/spz/src/cc/load-spz.cc'

_FUNCTION = '''bool decompressGzippedImpl(
  const uint8_t *compressed, size_t size, int32_t windowSize, std::vector<uint8_t> *out) {'''
_GUARD = '''// Browser overlay: initialized zlib state survives until every throwing
// output-vector operation has completed, including unsuccessful codec exits.
class BrowserZlibStreamCleanup final {
 public:
  BrowserZlibStreamCleanup(z_streamp stream, bool inflating) noexcept
      : stream_(stream), inflating_(inflating) {}
  ~BrowserZlibStreamCleanup() noexcept {
    if (inflating_) inflateEnd(stream_);
    else deflateEnd(stream_);
  }
  BrowserZlibStreamCleanup(const BrowserZlibStreamCleanup &) = delete;
  BrowserZlibStreamCleanup &operator=(const BrowserZlibStreamCleanup &) = delete;
 private:
  z_streamp stream_;
  bool inflating_;
};

'''
_INFLATE_INIT = '''  if (inflateInit2(&stream, windowSize) != Z_OK) {
    return false;
  }
  out->clear();'''
_DEFLATE_INIT = '''  if (deflateInit2(&stream, Z_DEFAULT_COMPRESSION, Z_DEFLATED, 16 + MAX_WBITS, 9, Z_DEFAULT_STRATEGY)
      != Z_OK) {
    return false;
  }
  out->clear();'''
_INFLATE_END = '  inflateEnd(&stream);\n  return success;'
_DEFLATE_END = '  deflateEnd(&stream);\n  return success;'


def transform_source(text: str) -> str:
    """Return an exact, single-application adaptation without filesystem access."""
    anchors = (_FUNCTION, _INFLATE_INIT, _DEFLATE_INIT, _INFLATE_END, _DEFLATE_END)
    if ('BrowserZlibStreamCleanup' in text or any(text.count(anchor) != 1 for anchor in anchors)
            or text.count('  out->reserve(size * 3);\n') != 1
            or text.count('  out->reserve(size / 4);\n') != 1
            or text.count('    out->insert(out->end(), buffer.data(), buffer.data() + buffer.size() - stream.avail_out);\n') != 2):
        raise ValueError('Portable SPZ gzip streams changed; review the exact exception-cleanup adapter.')
    text = text.replace(_FUNCTION, _GUARD + _FUNCTION)
    text = text.replace(_INFLATE_INIT, _INFLATE_INIT.replace(
        '  out->clear();', '  BrowserZlibStreamCleanup cleanup(&stream, true);\n  out->clear();'))
    text = text.replace(_DEFLATE_INIT, _DEFLATE_INIT.replace(
        '  out->clear();', '  BrowserZlibStreamCleanup cleanup(&stream, false);\n  out->clear();'))
    return text.replace(_INFLATE_END, '  return success;').replace(_DEFLATE_END, '  return success;')


def adapt_spz_stream_cleanup(source: Path) -> None:
    """Modify only the one newly copied, plain-file desktop-package overlay."""
    source = Path(source).absolute()
    for entry in (source, *source.parents):
        info = entry.lstat()  # An incomplete overlay is an error, never a fallback.
        if entry.is_symlink() or getattr(info, 'st_file_attributes', 0) & 0x400:
            raise ValueError(f'Linked SPZ cleanup input is not admitted: {entry}')
    if source.resolve() != OVERLAY_SOURCE.resolve():
        raise ValueError('SPZ cleanup may modify only the disposable desktop-package overlay source.')
    if not stat.S_ISREG(source.lstat().st_mode):
        raise ValueError('SPZ cleanup input must be the regular overlay source file.')
    adapted = transform_source(source.read_text(encoding='utf-8'))
    source.write_text(adapted, encoding='utf-8', newline='\n')
