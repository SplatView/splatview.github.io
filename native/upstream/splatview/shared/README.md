# Shared C++ source entry point

This entry point builds the port's scene and editing algorithms from their existing files in `../src/core`. Both the full application build and an independent consumer must use these files. No source is copied, and the build never reads `../../SplatPreview`. The complete checkout, including its pinned math headers, is the source package; copying only this `shared` directory is insufficient.

| Target | Contents | Public dependencies |
| --- | --- | --- |
| `splatview_scene`, alias `SplatView::Scene` | Scene/Gaussian/SavedView types, Gaussian packing and SH access, bounds and preview budgets, camera/roll/alignment math | C++20, vendored DirectXMath/SAL headers |
| `splatview_domain`, alias `SplatView::Domain` | Editing history and selection drafts, center/surface/volume selection, navigation, calibration/floor geometry, pure preview kernels and byte-reservation policy | `SplatView::Scene`, Threads, nlohmann-json |
| `splatview_render_cpu`, alias `SplatView::RenderCPU` | Optional CPU projection/rasterization, picking, depth/visibility maps and immutable clean capture with storage-owned admission | `SplatView::Domain` |

The scene target provides an initial adoption boundary for the original Windows app. Its renderer can retain native D3D state and its selection/UI adapters while using the same scene/camera implementation. [Isolated candidates](../UPSTREAM_SHARED_ADOPTION.md) preserve the frozen original and known test failures; the second candidate adds shared-tree workflow fingerprint contracts. The live original has not adopted them; final integration, smoke/package checks and upstream review remain required. Later draft/executor/capture/resource changes in this checkout are outside their frozen 43-file packages.

For a standalone library build from this checkout:

```sh
cmake -S shared -B build-shared -DCMAKE_BUILD_TYPE=Release
cmake --build build-shared --parallel
```

Provide `CMAKE_PREFIX_PATH` or a CMake toolchain containing nlohmann-json when it is not installed in the default search path. For a Visual Studio generator, use `--config Release` during the build. The standalone configuration requires Threads and nlohmann-json for the domain target, but does not configure codecs, ImGui, the CLI, AppKit or Metal. Merely linking `SplatView::Scene` does not propagate JSON or Threads.

For a Scene-only consumer, set `SPLATVIEW_BUILD_DOMAIN=OFF` before adding this directory, or pass it to the standalone configuration. That configuration also skips finding Threads and nlohmann-json. The root application and domain-contract builds require Domain to remain enabled.

`SPLATVIEW_BUILD_CPU_RENDERER=OFF` omits the optional CPU target. The root `SPLATVIEW_DOMAIN_ONLY=ON` configuration builds domain/header contracts plus CPU contracts when enabled, without configuring codec/platform/application layers. The full core/CLI currently require the CPU target. Pure preview kernels perform no path, image or codec acquisition; processing job orchestration remains above Domain.

A CMake host consumes the same implementation:

```cmake
add_subdirectory(path/to/splatview_macos/shared "${CMAKE_CURRENT_BINARY_DIR}/splatview-shared")
target_link_libraries(MyHost PRIVATE SplatView::Scene)
# An editing host can instead link SplatView::Domain.
```

Add the directory once. The package reports a conflicting preexisting target instead of silently reusing a different implementation. Compile flags and dependencies belong to these targets; they do not replace a host's platform security, signing, application version or deployment settings. The standalone MSVC configuration uses the static runtime; a parent host retains control of its runtime selection.

Include `scene.hpp` and `camera.hpp` for the smallest API. `geometry_tools.hpp`, `editing.hpp`, `navigation.hpp` and `surface_selection.hpp` expose the domain layer. `model.hpp` remains a compatibility include for format/path-facing consumers, whose loaders and filesystem services are supplied by the application core and are not part of these targets. `Scene` stores opaque source identity strings but never resolves paths or computes file identities itself. The current interface is a source API, with no promised binary ABI or installable SDK.

`SceneVector<T>` uses the dependency-neutral allocator in `scene_storage.hpp`. Plain scenes need no admission service. Hosts can supply a `SceneMemory` service; each payload allocation obtains a lifetime-owning grant before allocating, copies obtain their own grants, and moves retain existing grants. `sceneMemoryForBudget` in Domain adapts the byte ledger without adding it to Scene. This changes the C++ vector types and Scene ABI; rebuild consumers and review vector-specific adapters before updating either frozen Windows adoption candidate. Bookkeeping, strings, decoder scratch and native/GPU storage are separate accounting work.

The package checks all vendored DirectXMath/SAL headers and license records against [HEADER_DEPENDENCIES.json](../third_party/HEADER_DEPENDENCIES.json) during configuration. It does not download dependencies or substitute platform SDK math headers. The revision and license notices are in [THIRD_PARTY_PORT_NOTICES.txt](../THIRD_PARTY_PORT_NOTICES.txt). Set `SPLATVIEW_ENABLE_SANITIZERS=ON` with GCC or Clang for ASan/UBSan instrumentation; the full project owns domain contracts and standalone-header checks.
