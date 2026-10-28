# Maintainer tools

Use the npm commands from the repository root. Start with the
[developer workflow](../docs/development/automation.md) for prerequisites,
validation logs, CI and release promotion.

| Area | Owner / entry point |
| --- | --- |
| Setup and diagnostics | `dev.py`, `bootstrap_runtime.py`, `restore-references.py`: `npm run setup`, `npm run doctor`. |
| Shared validation | `dev.py`: `npm run check`, `npm run ci`. |
| App identity and output closure | `web-build.mjs`: `npm run prepare:web`, `npm run build`. |
| Standalone renderer | `build-engine.mjs`, `check-engine.mjs`: `npm run build:engine`. |
| Native compilation and freshness | `build-core.py`, `verify-toolchain.py`: `npm run build:core`, `npm run verify:build`. |
| Frozen source/assets | `capture-sources.py`, `generate-assets.py`, `generate-native-translations.py`: `npm run verify:sources`. |
| Browser fixtures | `build-compat-fixtures.py`, `build-offline-fixtures.py`, `offline-test-host.mjs`; see [release evidence](release/README.md). |
| Historical evidence and layout | `evidence.py`: `npm run verify:project`; [archive instructions](../docs/validation/README.md). |
| Performance observations | [Benchmark tools](bench/README.md), [app responsiveness](bench/APP_RESPONSIVENESS.md). |
| Published release promotion | `deploy.py`, `verify-distribution.mjs`: `npm run deploy:check -- --release v0.2.2`. |
| Format fixtures | `generate-*-fixtures.py`, `formats/`; retain the independent format/numeric oracles. |
| Tool regressions | `tests/`: `npm run test:tools`, `npm run test:web-build`. |

Python and Node regression files live together in `tools/tests/`. Python uses
standard unittest discovery with `tools/tests` as the start directory and
`tools` as the top-level directory. Node tests import the production tools from
their parent directory. App/renderer unit tests remain in the repository's
`tests/`; browser configurations are mapped in [config/README](../config/README.md).

Native input scripts and locks retain their reviewed paths and byte identities.
Changing a test location does not qualify a new native build. Put new reports,
traces and generated captures under ignored `.build/validation/` directories;
keep fixture receipts immutable and regenerate captures when their inputs change.
