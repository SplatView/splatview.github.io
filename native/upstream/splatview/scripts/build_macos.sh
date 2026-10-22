#!/usr/bin/env bash
set -euo pipefail
task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
task_build="${SPLATVIEW_BUILD_DIR:-$task_root/build-macos}"
if [[ "$(uname -s)" != Darwin ]]; then
    echo "The native targets need Xcode and the macOS SDK. Use the portable build on this system." >&2
    exit 1
fi
task_args=(-S "$task_root" -B "$task_build" -G Xcode -DCMAKE_OSX_ARCHITECTURES=arm64 -DCMAKE_OSX_DEPLOYMENT_TARGET=14.0 -DBUILD_TESTING=ON -DSPLATVIEW_BUILD_MACOS=ON)
if [[ -n "${VCPKG_ROOT:-}" ]]; then
    task_args+=("-DCMAKE_TOOLCHAIN_FILE=$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake" -DVCPKG_TARGET_TRIPLET=arm64-osx "-DVCPKG_INSTALLED_DIR=$task_build/vcpkg_installed")
else
    task_args+=("-DCMAKE_PREFIX_PATH=$(brew --prefix)")
fi
task_args+=("-DSPLATVIEW_DEVELOPMENT_TEAM=${SPLATVIEW_DEVELOPMENT_TEAM:-}" "-DSPLATVIEW_APP_GROUP=${SPLATVIEW_APP_GROUP:-}")
cmake "${task_args[@]}"
cmake --build "$task_build" --config Release --parallel 4
ctest --test-dir "$task_build" -C Release --output-on-failure
echo "Built $task_build/macos/Release/SplatView.app (native verification still required)"
