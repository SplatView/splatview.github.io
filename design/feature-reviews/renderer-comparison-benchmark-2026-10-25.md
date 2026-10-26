# Feature review: renderer comparison benchmark

Reviewed October 25, 2026 before implementation. The user requests a useful
performance benchmark and explicitly does not require feature parity, identical
algorithms or identical output between SplatView, PlayCanvas and COLMAPView.

## Authority, scope and existing behavior

Read the shared product contract/template, AGENTS, README, WEB_PORT_PLAN,
IMPLEMENTATION_STATUS, capability ledger and approved UI differences. Consume
only the sealed local product bundle 2.0.0, SHA-256
`fff64dad4589c07b26821cb23a866aaec6f824e7786d719ca6e3122b3750895a`.
The existing 133 registration bindings/reviews, native/source/toolchain locks,
worker budgets and published app/standalone artifacts remain authoritative.

Existing internal renderer measurements are in the immutable
[throughput packet](../../docs/validation/runs/rendering-throughput-20261025-01/validation.json).
This packet adds developer/agent-only measurement under `tools/bench/`, with
frozen external references in an ignored build workspace. It introduces no
product feature, UI/tutorial, action/native/API registration, persistence/default,
format, source overwrite, local product agent server or shipping dependency.
There are no history/dirty/selection effects. No application shader/rendering
algorithm is changed to improve benchmark numbers.

## Platform and host policy

| Target | Policy and evidence | Implementation/qualification |
| --- | --- | --- |
| Windows editor | Conditional developer measurement on an available browser/GPU. Existing native rendering remains required and unchanged (`../SplatPreview/src/renderer.hpp`). | Browser measurement only; no native editor qualification. |
| macOS editor | Conditional on a supported browser/GPU and local measurement tooling. Existing Metal owner remains unchanged (`../splatview_macos/src/render/render_frame.cpp`). | Apple/browser execution unobserved, an evidence gap rather than an exclusion. |
| Ubuntu editor | Conditional on supported browser/GPU and local measurement tooling. Existing Vulkan owner remains unchanged (`../splatview_ubuntu/src/vulkan/vulkan_renderer.hpp`). | Linux/browser execution unobserved; no native/runtime claim. |
| Web-lite / reusable browser module | Conditional internal browser benchmark; WebGPU needs a secure context/adapter, WebGL2 needs existing precision/capability checks. External references run only in the benchmark host. | Qualify the actually observed OS/browser/GPU/security context. No interactive measurement surface in the product. |

Windows Explorer, macOS Quick Look, GNOME preview, KDE preview and thumbnail
providers are unaffected: the benchmark does not enter installed hosts or update
OS thumbnails. No native/headless renderer or product CLI is added. The explicit
developer command runs a temporary loopback static browser host, not an agent
service exposed by web-lite.

## Measurement and ownership contract

Freeze each external revision/file inventory before execution; retain licenses,
metadata, hashes and any measured adapter/configuration. Never import or build
against live sibling source. PlayCanvas uses an official pinned release/source;
COLMAPView uses its frozen vendored renderer with its documented configuration.
Distinguish renderer-core results from a complete application/UI benchmark. Keep
external comparison code/assets outside shipping `src`, `public` and `dist`.

Generate the same bounded scene geometry/colors, camera poses, background and
physical framebuffer for each adapter. Start with SH0, dense/sparse views,
approximately 256k/1M sources and low/high overlap. Record conversions, actual
counts, data layout/quantization, sorting precision, output/color-space policy,
requested capabilities and asynchronous sort behavior. Unsupported modes are
explicit missing comparison cells, not a browser/product restriction.

Report warm moving/fixed frame distributions, CPU submission and actual GPU
completion, and GPU pass clocks when supported. Frame fences are not physical
presentation FPS. CPU/worker sorting and stale-order latency must not disappear
behind a fast render call. Bound warm-up/measurement samples and resources, use
one explicit adapter owner for submission/retirement, and stop/retire each case.
Do not overlap independent timed workloads on the same GPU.

Compare image error against SplatView exact output and retain representative
images. This is an explicit common reference, not a claim of perceptual ground
truth or a requirement for pixel equality. Validate simple camera/color probes
before accepting larger measurements; disclose different antialiasing, alpha,
precision and tone/color handling. Quality/error and throughput are separate
results. Keep failed/unsupported cases and scope limitations in the receipt.

## Validation and handoff

Check deterministic fixture/camera generation, source pin enforcement, results
validation and genuine completion/cleanup where needed. Run actual browser
comparisons, product/source/native gates and relevant type/build contracts.
Preserve prior immutable reviews/receipts and the existing renderer/controller/
worker ownership. Record exact commands, reference identities, machine/browser/
GPU/context, source/config hashes and pass/failure/skip counts in a new packet.

This review is internal/provider-only and changes no registration binding. Native
editors and installed hosts remain independently qualified. Results guide future
optimization choices; no parity, identical-implementation or universal fastest
renderer acceptance target is introduced.
