# SplatView product contract 2.0.0

This is an independent contract version, not an application release. `manifest.json` seals every payload by SHA-256. Each checkout pins that manifest in `contracts/product-adapter.json`; consumers build against their local copy. No sibling source, network service, installation or legal acceptance change is required.

`features.json` records intended scope for all four platforms and independent UI/API/CLI/internal surfaces. The host allowlist defaults to refusal. `profiles.json` defines native desktop and web-lite scope. Conditions supplement existing permission, dataset, resource and implementation checks; product policy alone never establishes availability or native qualification.

`tokens.json`, `layout.json`, `components.json`, `workflows.json` and `tutorial.json` define presentation and behavior. Generated C++/TypeScript policy comes from those inputs. Native font metrics, accessibility, chrome, files and renderers retain their platform owners. The standard-library geometry header is independent of JSON; request/schema helpers use the consumer's existing nlohmann-json dependency.

From a checkout, run:

```text
python -B contracts/product/tool.py verify --root .
```

The local adapter names its actual registries, explicitly maps every observed declaration to a reviewed feature and pins the review bytes. Verification rejects unknown/missing/changed registrations, unknown policies, mismatched payloads/pins and stale projections. Windows additionally runs its original API inventory guard. Existing source/native/WASM/command/behavior contracts remain mandatory. These checks cover the listed registered boundaries; semantic changes outside a registry still require the contribution review.

To maintain a feature, amend its platform review first, update policy/bindings and checks, then explicitly regenerate. Never add an unknown member to a frozen compatibility inventory just to pass. The producer seals reviewed changes using `tool.py seal --contract-version <semver>`; consumers import using `tool.py import --root . --from-bundle <reviewed-bundle> --pin <manifest-sha256>`, update their pin/reviewed adapter and run `tool.py generate --root .`. Generation changes projections only; verification does not rewrite sources or locks. A source archive without history needs the same explicit review, not an inferred qualification.

The shared availability fixture runs through native C++ and browser TypeScript. Native build graphs check the local bundle before consumers compile; browser source/build checks call the local verifier. Report exact source/configuration and actual outcomes separately from Apple SDK, desktop/session, browser/GPU and installed-provider qualification.
