# SplatView web project instructions

Read and follow [AGENTS.md](AGENTS.md) before working here. New and changed features require the shared product contract, every-platform support review and the existing browser/WASM contracts described there.

The local product bundle and normalized inventory adapter are now present. Run `python -B contracts/product/tool.py verify --root .` in addition to all existing port contracts. New/changed registrations require explicit reviewed bindings and all-platform policy, then regenerated local projections; never relax source locks or replace an existing controller/history owner. Testing-enabled native builds and browser source checks run this gate. Native/runtime qualification remains separate.
