# Feature review: focused repository root

Reviewed October 28, 2026 before implementation, at source
`ea23a6147b4e216a4b59faeb2baa7362fcd66635`. The user requests a less cluttered
root after the developer-workflow cleanup. Read AGENTS, the shared product
contract and review template, README, port/status/details, capabilities and
approved UI differences. Use local product bundle 2.0.0, SHA-256
`fff64dad4589c07b26821cb23a866aaec6f824e7786d719ca6e3122b3750895a`.

## Scope and decisions

Reduce the 25 tracked root files to 12. Keep conventional application/package/
editor entry points, README, changelog, agent instructions and hidden repository/
Node controls. Move all six Playwright profiles and the standalone Vite/TypeScript
configs into a flat `config/`. Move the three maintained port documents and two
frozen review baselines into `docs/porting/`. Preserve the baseline JSON bytes;
their embedded paths describe their original captured workspace and are not new
qualification. Retarget maintained document links without rewriting sealed
contracts, archived reports, old feature reviews or source captures.

Keep existing npm command names. Set config-relative test/output paths and
server working directories explicitly so invocation from the root retains exact
discovery, project identities, origins, process ownership, one-worker retirement,
timeouts, retries, traces and output locations. Update the standalone build's
reviewed source inventory and declarations paths for the actual relocated files.
No forwarding configs, alternate framework or compatibility barrels remain at
the old paths. Keep the primary Vite and TypeScript configs at their conventional
root paths for the application, tests and editor.

Compatibility/offline capture tools and the release fixture inspector currently
name root configs. Update their exact source inventories together to cover the
new `config/` tree, preserving byte/source/authority/native/public/command/owner
checks and negative tests. Do not add missing-file fallbacks, remap a historical
receipt or accept a stale capture. New fixtures must be genuinely regenerated
against the new layout. Existing receipts continue to describe their original
source and configuration. The archive catalog and retained witnesses stay intact.

Extend project-layout verification to reject reintroducing loose root configs,
review baselines or port documents, including a standalone checkout. Native
builder/source/toolchain locks and their identity inputs are unchanged. New app
and SDK build identities must reflect the reviewed configuration/tool changes.
This is maintainer organization, with no new product action/API/CLI registration,
UI change, format/default/input/persistence/tutorial change or profile migration.

## Platform and host policy

| Target | Policy / reason | Implementation and evidence requirement |
| --- | --- | --- |
| Windows | Required equivalent source/build/test entry points. | Run shared CI and browser profiles after moving configs; native SDK qualification remains separate. |
| macOS | Required equivalent source entry points, conditional on Node/Python/browser prerequisites. | Use URL/path-based config roots, preserve conventions and state the absence of a local Apple hardware run. |
| Ubuntu | Required equivalent source/build/test entry points. | Verify hosted CI and the appearance-only browser lane using the relocated CI profile. |
| Web-lite / standalone browser renderer | Required preservation of runtime and host integration behavior. | Build app/SDK and preserve exact runtime ownership/ABI/worker/codec budgets. Portable tests do not establish GPU qualification. |

Windows Explorer, macOS Quick Look, Ubuntu GNOME/KDE preview and thumbnail hosts
are unaffected: this change reaches development/configuration files only. No new
native/provider package, public UI/tutorial or agent-server surface is introduced.

## Validation

Capture pre-move browser inventories and compare all six profiles' case/project
identities afterward. Run project/product/source/native gates, app/benchmark
typechecks, tool/portable tests and app/standalone builds. Exercise actual browser
smoke and standalone/offline boundaries where configs changed; preserve exact
browser/OS/GPU/security-context scope. Regenerate any needed fixture capture
rather than modifying old receipts. Confirm strict fixture refusal cases still
pass, frozen baseline/native/reference/contract bytes remain unchanged, the root
has 12 tracked files and hosted source CI passes. Keep fresh logs and snapshots
under `.build/validation/root-layout-20261028-01/`. No application publication or
new native qualification is part of this cleanup.

The real producer/inspector inventory comparison exposed an existing mismatch:
the Python offline capture included `contracts/` and `design/feature-reviews/`,
but the TypeScript inspector omitted their 64 current leaves (2,502 captured vs
2,438 inspected files). Make the inspector read these exact same trees, and add
a small synthetic cross-language inventory regression comparing every record,
count, byte total and digest. The config tree now contains all profiles, so the
offline generator retains only its one explicit offline acceptance configuration
as an additional file, matching the inspector's exact list. No old receipt is
edited or made acceptable by an alias, missing-file fallback or reduced checks.
