# Feature review: WebGL worker sorting throughput

Reviewed October 25, 2026 before implementation. The user approved the benchmark's
next optimization target and accepts a small display-quality tradeoff if useful.
The first implementation candidate improves exact sorting without changing the
existing 16/24/32-bit precision, ties or display freshness policy.

## Authority and scope

Read AGENTS, the shared product contract/template, README, WEB_PORT_PLAN,
IMPLEMENTATION_STATUS, capability ledger, approved UI differences and selection
module/validation guide. Use sealed local bundle 2.0.0, SHA-256
`fff64dad4589c07b26821cb23a866aaec6f824e7786d719ca6e3122b3750895a`.
Preserve the 133 registration bindings, native/WASM/source/toolchain locks,
generated assets and verified app/standalone worker identity contracts.

Existing evidence: [comparison](../../docs/validation/runs/renderer-comparison-20261025-01/validation.json)
and [throughput](../../docs/validation/runs/rendering-throughput-20261025-01/validation.json).
Keep both receipts and pinned reviews immutable. Capture source and the old SDK
artifact closure before changes; measure matched old/new frozen browser builds.

Feature `view.render`, application and reusable browser provider. Work is confined
to pure WebGL worker key/radix kernels and their existing retained-scratch budget
contract. Exact picks also use the shared pure sorter. Surface maps retain their
existing tiled comparator/kernel. No product UI, action/native/API registration,
CLI, format, default, persistence, history, tutorial or profile change. An internal
benchmark filter permits repeating only affected configurations with the same
scene/camera/framebuffer/sampling/fence method.

## Platform and host policy

| Target | Policy and source/capability evidence | Implementation and qualification |
| --- | --- | --- |
| Windows editor | Required existing D3D11 rendering (`../SplatPreview/src/renderer.hpp`); this browser optimization is conditional on WebGL2 and worker/admission support. | No native change or new native runtime claim. |
| macOS editor | Required existing Metal rendering (`../splatview_macos/src/render/render_frame.cpp`); browser optimization conditional on existing WebGL2/worker/resource checks. | Apple/browser execution remains unobserved, not a policy exclusion. |
| Ubuntu editor | Required existing Vulkan rendering (`../splatview_ubuntu/src/vulkan/vulkan_renderer.hpp`); browser optimization conditional on existing browser capabilities/admission. | Linux/browser execution remains unobserved; no native qualification. |
| Web-lite / standalone browser hosts | Conditional on the current WebGL2 precision/texture checks, browser workers/CSP and admitted resources. WebGPU is unchanged and automatic startup fallback remains. | Qualify actual Windows Chromium/GPU/localhost observations separately from portable tests. Refused optional scratch retains the bounded original-size fallback. |

Windows Explorer, Quick Look, GNOME preview, KDE preview and native thumbnail
providers are unaffected. Browser capture/saved-view semantics, source protection
and disk/OS-thumbnail boundaries remain unchanged. Measurement remains developer/
agent-only; no product agent server or UI/tutorial measurement entry is added.

## Algorithm, memory and ownership decisions

Move checkpoint awaits outside bounded synchronous inner loops, retaining the
current maximum key/histogram/scatter work between cancellation opportunities.
Hoist immutable frame constants and avoid allocating transformed-point tuples in
the key-generation hot path. Preserve the exact float32 operation sequence used
by the current shader-compatible depth key, including affine/projective transform
scope, candidate IDs, signed depth and deterministic stable ties.

Use exact counting when the quantized key span fits admitted histogram storage;
otherwise retain stable radix. Uniform digits may be skipped because they cannot
change the permutation. These are permutation-preserving optimizations, not new
quantization. Images must remain identical at the same requested precision.

Large retained display scratch may add a bounded histogram (up to 65,536 uint32
bins). Its byte planner is shared by host admission, worker allocation/reporting
and diagnostics. Keep the existing 16 MiB retained-scratch cap and acknowledge
retirement before releasing credit. Small/transient/query allocations keep the
original 256-bin storage and existing admission formulas; refusal falls back to
that path. Do not charge independently admitted storage twice.

The existing serial executor owns submission/cancellation acknowledgements; the
renderer owns publication, fences and GPU retirement. Neither sorter/planner
adds a scheduler, background worker, history owner or dispatcher. Keep pool-owned
input/output arrays resident by copying whichever result belongs to the pool
before transfer. No asynchronous/stale display order is introduced in this
candidate. Any later freshness/quality/default change needs its own amendment
and explicit reviewed registration pin if applicable.

## Validation and handoff

Compare against an independent stable depth/key oracle across 16/24/32 bits,
small/large spans, uniform digits, negative/positive depths, float32 boundaries,
candidate lists and divergent transform masks. Test cancellation during key,
count/scatter and remapping stages, pool reuse/detachment, scratch refusal/cap,
held preparation/retirement and shared byte accounting. Do not weaken existing
selection/query/image or worker-identity tests.

Measure unchanged representative/synthetic scenes with matched precision and
actual current-sort completion. The filtered benchmark keeps the existing common
fixtures, 12 warm-up, 60 moving/60 fixed samples and three repetitions. Retain
rejected candidates and image/permutation evidence; do not claim physical FPS
from submission/fence timings. Apply real browser/SDK/app query/output/lifecycle
checks, both typechecks, portable and source/product/native-build/artifact gates.

Record actual results, source/build hashes and failures in a new packet. Keep
native/installed-host, other browser/OS/GPU/hosting and external-engine parity
qualification separate. The existing motion-24/rest-32 policy and sorted binding
remain unchanged if the permutation-equivalence contract holds.

## Implementation and measured decision

Accepted the exact candidate. The shared pure byte planner is
`src/renderer/webgl2/sortScratchLayout.ts`; host admission and worker allocation
both use it. The optional pool is capped at 16 MiB, with 256 bins below 65,536
sources and 65,536 bins at or above that count. At one million sources it uses
12,262,144 bytes. Pools above 1,376,256 sources or refused optional credit use the
existing transient allocation; scene limits and query admission are unchanged.

Synchronous key/count/scatter helpers retain bounded checkpoints. Counting is
stable at the requested precision; wide spans use uniform-digit-skipping radix.
Float32 projective/scoped transform order and candidate/source ties match the
independent oracle. The existing executor still copies either pool-owned output
before transfer. No precision, freshness, scheduler or registration change was
needed, so the existing reviewed bindings remain pinned.

Matched frozen SDK source IDs are
`4cefb913f6306a516bf21b4d1dbf85eb771197faae887923bd32baf85692fe4a` (before) and
`898a19650c3808b3c132739b87c06f2c4b80ffa4903d7e11d68b15739667fbc8` (after).
Both 24-case cohorts and their calibration probes passed. Worker round-trip
medians fell 43–75%; million-source exact medians fell from 40.9/41.2 to
20.8/20.75 ms for sparse/dense scenes. The dense 24-bit case fell from 31.9 to
8.0 ms. All 48 before/after snapshot pairs are byte-identical at matching
precision. No additional quality loss was necessary.

The actual observed environment is Windows build 10.0.26100, Chromium
156.0.8078.4, NVIDIA RTX 5090 through ANGLE Direct3D11, secure loopback and no
cross-origin isolation. The benchmark uses `--enable-unsafe-webgpu` and no CSP;
the SDK cohort separately exercises nested assets and same-origin CSP. These
measurements do not remove the app's GL fence-polling floor or establish physical
presentation FPS. Native/installed preview hosts, other OS/browser/GPU, SH1–3
performance, real datasets and deployed-host qualification remain unobserved.

The [delivery packet](../../docs/validation/runs/webgl-sort-20261025-01/validation.json)
records actual check results, raw samples, images, complete frozen SDK/source
archives, app artifact closure and unchanged earlier review/receipt digests.
The independent oracle and full portable suite passed. The first focused run's
one failure was an incorrect expected diagnostic pass name; both that report
and its successful correction are retained. No measured candidate was discarded.
