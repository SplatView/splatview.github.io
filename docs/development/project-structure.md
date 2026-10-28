# Project structure

Start with [README](../../README.md), [AGENTS](../../AGENTS.md), the
[port plan](../../WEB_PORT_PLAN.md) and [implementation status](../../IMPLEMENTATION_STATUS.md).
The source branch is `source`; `main` contains the published static website.

| Location | Maintained responsibility |
| --- | --- |
| `src/app/` | Controller, state, typed actions and application ownership. |
| `src/renderer/` | Shared rendering contracts plus WebGPU/WebGL2 resource owners. |
| `src/engine/` | Standalone browser renderer entry and public types. |
| `src/document/` | Native worker, scene protocol, budgets, history and recovery. |
| `src/ui/` | App composition, feature components and shared UI primitives; see the [UI module map](ui.md). |
| `src/ui/dialogs/`, `src/ui/settings/` | Focused modal implementations and Settings components. |
| `src/input/`, `src/io/` | Pure navigation/input policies and browser file/view boundaries. |
| `tests/`, `e2e/` | Portable tests, required fixtures and actual browser journeys. |
| `tools/` | Source/build verification, benchmark/release tools and evidence inspection. |
| `contracts/` | Sealed product bundle, explicit adapter and generated policy inputs. |
| `native/`, `reference/` | Locked native/WASM sources, toolchains and source captures. |
| `public/` | Curated runtime assets; `public/wasm/` is generated and verified separately. |
| `design/feature-reviews/` | Required platform decisions and implementation reviews. |
| `docs/development/`, `docs/parity/`, `docs/third-party/` | Maintainer guides, capability contracts and attribution. |
| `docs/validation/` | Active evidence schemas/templates and the historical archive catalog. |
| `.build/validation/` | Ignored local reports, traces, archive cache and restored evidence. |
| `dist/`, `dist-engine/` | Generated application and standalone renderer distributions. |

The root keeps entry documents, package/dependency locks and conventional build
configuration. JSON contracts, source captures, localization and fixtures are
maintained inputs. Test logs, reports and screenshots belong to validation runs.

## Working commands

```sh
npm run verify:project
npm run verify:sources
npm run typecheck
npm run typecheck:bench
npm test
npm run build
npm run build:engine
```

`verify:project` checks the source layout, archive catalog and active-guide
archive links without fetching historical data. See [historical evidence](../validation/README.md) to fetch,
verify or restore exact original reports. Historical evidence is optional for
building and running the application.

## Collecting new evidence

Give each run a fresh directory under `.build/validation/`. The Playwright
configs already put normal browser output there. Pin explicit report paths:

```sh
npm test -- --reporter=json --outputFile=.build/validation/my-run/unit.json
```

For Playwright JSON, set `PLAYWRIGHT_JSON_OUTPUT_FILE` to a file in the same run
directory and use `--reporter=json`. Capture the real command, failures, browser,
OS/GPU/security context and actual source/build identities. Do not relabel old
receipts as current qualification. Curate summaries and checksum-pinned archive
records when publishing evidence; do not force-add raw generated files to source.

Run [the product gate](../../AGENTS.md) for feature changes and preserve the
existing source/toolchain/native/browser checks. Use the
[selection module map](selection.md) and [renderer ownership guide](renderer-engine.md)
for work in those areas. Keep resource lifecycle and publication with their
existing explicit owners.
