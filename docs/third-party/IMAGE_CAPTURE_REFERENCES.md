# Image capture and thumbnail references

Desktop behavior comes from the captured SplatView sources:

- `reference/windows/src/thumbnails.cpp:78–109,234–249`: straight BGRA32,
  integer-centered square crop, requested-size clamp to 1–1024, no upscale,
  Windows WIC Fant interpolation, then output alpha forced to 255.
- `reference/windows/src/image_capture.cpp`: PNG BGRA input and JPEG BGR
  conversion with quality 0.95. The current sibling desktop implementation has
  the same capture/thumbnail API boundaries.
- The preserved `../splatview-web-image-parity-draft-20261012` contains actual
  Factory1/Factory2 WIC outputs for 17 independent fixtures, repeat comparisons,
  source/SDK/DLL provenance, and raw pre-alpha/final pixel hashes. The small
  input/output pairs and complete reference manifest are retained under
  `tests/fixtures/thumbnail-wic`; the large constant case is formula-generated.

[Microsoft's WIC interpolation documentation](https://learn.microsoft.com/en-us/windows/win32/api/wincodec/ne-wincodec-wicbitmapinterpolationmode)
identifies Fant as weighted sampling of mapped input pixels. It does not specify
the implementation's complete weights, phase, alpha treatment or rounding.
[Microsoft DirectXTex filter flags](https://github.com/microsoft/DirectXTex/wiki/Filter-Flags)
describe Fant/box relationships; its public header describes a linear/box
combination. Those descriptions do not establish byte equality with the
installed Windows codec endpoint.

The browser's filter is independently derived from raw native measurements;
it uses no copied third-party filtering implementation. Start with exact area
overlap. For a fractional left boundary `f` and scale `source/target`, move
`f*(1-f)/scale` from the first source sample to its successor. The first weight
is computed directly as `(target-remainder)^2/(source*target)` to retain the
measured rounding at half boundaries. Each multiply and accumulation uses f32.
RGB is premultiplied by source alpha and rounded to bytes before filtering.
Filtered alpha and premultiplied RGB are rounded to bytes; straight RGB uses
a floored fixed16 reciprocal of `255/alpha`. Fixed16, fixed24 and fixed32 are
indistinguishable on the measured inputs; fixed16 is the explicit portable
choice, not a claim about the private codec's table width. Identity crops skip
association and preserve their straight RGB. Output alpha is then forced to 255.

All 17 preserved final fixtures now match the production filter, including the
full-size 1025-to-1024 constant case generated from its independently captured
formula. The center impulse is 70, matching the native output. Fresh execution
of both factory CLSIDs with WindowsCodecs 10.0.26100.9711 reproduced every raw
pre-alpha and final fixture from the original 10.0.26100.9457 reference run.
The bounded calibration and candidate diagnostics are preserved under
`.build/thumbnail-fant-tests`; they establish measured agreement, not a complete
implementation specification for every Windows codec version.

Additional calibration contains 338 small impulse, complement, amplitude, ramp,
alpha, grid and constant inputs at seven integer/noninteger ratios. The selected
general rule matches 324 of those native measurements. Fourteen vertical alpha
ramps still differ: some native rows retain associated RGB while corresponding
horizontal ramps return straight RGB. This asymmetry is unresolved, and no
input-specific compatibility branch is added. These 14 remain diagnostic gaps
separate from the 17-fixture acceptance and selected opaque impulse checks.
Complete native Fant compatibility remains open.

Raw capture removes row padding and explicitly swizzles BGRA targets to RGBA.
PNG/JPEG use the browser's OffscreenCanvas encoder after raw processing, with
an exact returned-MIME check and quality 0.95 for JPEG. This is an explicit browser
adapter: PNG decoded pixels and image framing can be compared independently;
identical encoded bytes, JPEG quantization, metadata, ICC behavior and complete
display color-transfer parity across encoders are not claimed. The encoder
contract is specified by the
[HTML canvas serialization algorithm](https://html.spec.whatwg.org/multipage/canvas.html#serialising-bitmaps-to-a-file).

Raw pixels remain admitted while asynchronous consumers borrow them, and encoded
Blob ownership survives hashing, storage, download or clipboard work until its
owner is disposed. Unit encoder doubles verify ownership ordering; real browser
observations are required for actual codecs, GPU capture and clipboard behavior.

## Observed opaque saved-thumbnail input

The [capture-opacity qualification](../validation/runs/capture-opacity-20261016-01/validation.json) observes the complete raw RGBA plane returned by the actual GPU capture before the controller passes it to the thumbnail filter. Gaussian, point and mesh scenes each exercise Black, Gray and White backgrounds at 1027 by 1025 pixels, followed by a centered 1025-square crop and an actual 1024-square thumbnail. Every observed input alpha byte is 255, with nonempty rendered foreground. Each workflow also checks one PNG encode, matching stored metadata/image bytes, native-state preservation and joined Close.

The 14 arbitrary transparent-input vertical-alpha diagnostics above remain unresolved; they do not occur in these observed opaque compositor inputs. This bounded workflow evidence does not establish a universal Fant specification, every possible rendered frame, or encoded-byte/color equality across browser and desktop encoders.
