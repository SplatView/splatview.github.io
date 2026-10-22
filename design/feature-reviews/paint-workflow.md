# Paint workflow contract adoption

Reviewed October 18, 2026 before adapter/policy changes. Adopt the identical
producer contract 2.0.0, manifest SHA-256
`fff64dad4589c07b26821cb23a866aaec6f824e7786d719ca6e3122b3750895a`,
from the Windows producer review `design/feature-reviews/paint-workflow.md`.
This local record is self-contained; no live sibling build dependency is added.

Windows, macOS and Ubuntu require human Paint color and Surface/Sphere creation
in Pro, with explicit target and consistent preview/Apply/discard. Procedural
Clone is API-only; technical API parameters and gaussians.clone identity/defaults
remain compatible. Manual entry must enforce the surface decision, not merely
hide a button. Agent access starts disabled, edits need no per-action approval,
and agent saves are create-only. Preview/thumbnail providers remain read-only.
Web-lite excludes this authoring increment while rendering baked saved results.

Current source/status was inspected: Windows has the current native controller;
Ubuntu retains older planar Paint/Clone and requires sphere/recolor/new workflow
port work; macOS has no matching Paint surface and still requires Apple host
build/qualification. Web source/worker preserves its lightweight policy. The
Ubuntu adoption gates manual Clone; it does not claim the rest of the new flow
is implemented. All local product/inventory/source/codec/native/browser contracts
remain mandatory. Windows or portable policy tests do not establish AppKit/Metal,
GNOME/KDE sessions, browser GPU or installed provider qualification. No app
version, legal text, package installation, source lock or existing algorithm is
changed by this adoption.
