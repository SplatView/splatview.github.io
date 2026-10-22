cmake_minimum_required(VERSION 3.25)
project(SplatViewWebCore VERSION 0.1.0 LANGUAGES C CXX)
if(NOT EMSCRIPTEN)
    message(FATAL_ERROR "Use tools/build-core.py with Emscripten 6.0.12")
endif()
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
get_filename_component(WEB_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../.." ABSOLUTE)
if(NOT EXISTS "${CMAKE_CURRENT_BINARY_DIR}/generated/runtime_build_identity.hpp")
    message(FATAL_ERROR "Missing generated runtime identity; configure through tools/build-core.py")
endif()
set(CORE "${SPLATVIEW_PACKAGE}/src/core")
set(PLATFORM "${SPLATVIEW_PACKAGE}/src/platform")
if(NOT EXISTS "${SPLATVIEW_PACKAGE}/browser-include/nlohmann/json.hpp")
    message(FATAL_ERROR "Missing generated JSON cleanup header; configure through tools/build-core.py")
endif()
set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -fexceptions -ffp-contract=off -D_XM_NO_INTRINSICS_ -D_XM_NO_XMVECTOR_OVERLOADS_ --use-port=zlib --use-port=contrib.libwebp")
set(LIBDEFLATE_BUILD_SHARED_LIB OFF CACHE BOOL "" FORCE)
set(LIBDEFLATE_BUILD_GZIP OFF CACHE BOOL "" FORCE)
set(LIBDEFLATE_BUILD_TESTS OFF CACHE BOOL "" FORCE)
add_subdirectory("${WEB_ROOT}/native/deps/libdeflate-1.24" libdeflate EXCLUDE_FROM_ALL)
set(SPZ_BUILD_TOOLS OFF CACHE BOOL "" FORCE)
set(SPZ_BUILD_PYTHON_BINDINGS OFF CACHE BOOL "" FORCE)
set(SPZ_BUILD_EXTENSIONS ON CACHE BOOL "" FORCE)
set(SPZ_BUILD_WASM OFF CACHE BOOL "" FORCE)
set(ZSTD_MULTITHREAD_SUPPORT OFF CACHE BOOL "" FORCE)
set(ZSTD_DISABLE_ASM ON CACHE BOOL "" FORCE)
add_subdirectory("${SPLATVIEW_PACKAGE}/third_party/spz" spz EXCLUDE_FROM_ALL)
file(READ "${CORE}/gsmod_presets.json" GSMOD_PRESET_JSON)
configure_file("${CORE}/gsmod_presets.hpp.in" generated/gsmod_presets.hpp @ONLY)
add_library(desktop_core STATIC
    "${CORE}/scene_math.cpp" "${CORE}/camera.cpp" "${CORE}/navigation.cpp"
    "${CORE}/resource_budget.cpp" "${CORE}/editing.cpp" "${CORE}/selection.cpp"
    "${CORE}/volume_selection.cpp" "${CORE}/surface_selection.cpp"
    "${CORE}/geometry_tools.cpp" "${CORE}/processing_kernels.cpp"
    "${CORE}/model.cpp" "${CORE}/extra_formats.cpp" "${CORE}/ply_preview.cpp"
    "${CORE}/ply_export.cpp" "${CORE}/scene_exports.cpp" "${CORE}/extra_exports.cpp"
    "${CORE}/sog_export.cpp" "${CORE}/processing.cpp"
    "${PLATFORM}/file_io.cpp" "${PLATFORM}/atomic_file.cpp"
    "${PLATFORM}/source_snapshot.cpp" json_preflight.cpp selection_morphology_job.cpp morphology_range_job.cpp
    auto_color_job.cpp auto_color_analysis_job.cpp floor_detection_job.cpp browser_color_session.cpp browser_alignment_session.cpp browser_camera_transform.cpp browser_alignment_frame.cpp browser_sog_group.cpp browser_spz_export.cpp browser_export_sink.cpp browser_spz3_memory.cpp browser_sog_export.cpp browser_filter.cpp browser_filter_gizmo.cpp browser_transform_math.cpp browser_transform_session.cpp browser_opacity_session.cpp browser_document_checkpoint.cpp browser_duplicate.cpp browser_focus_bounds.cpp browser_selection_range.cpp)
target_include_directories(desktop_core BEFORE PUBLIC "${SPLATVIEW_PACKAGE}/browser-include")
target_include_directories(desktop_core PUBLIC "${CORE}" "${PLATFORM}"
    "${SPLATVIEW_PACKAGE}/src/render" "${CMAKE_CURRENT_BINARY_DIR}/generated"
    "${SPLATVIEW_PACKAGE}/third_party/DirectXMath/Inc"
    "${SPLATVIEW_PACKAGE}/third_party/picosha2" "${WEB_ROOT}/native/deps/include")
target_include_directories(desktop_core PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}")

# Private native proof for the bounded Duplicate append/history slice.
add_executable(splatview-duplicate-contracts duplicate_contracts.cpp allocation_census.cpp)
target_link_libraries(splatview-duplicate-contracts PRIVATE desktop_core)
target_compile_definitions(splatview-duplicate-contracts PRIVATE SV_ALLOCATION_CENSUS_CONTRACTS=1)
set_target_properties(splatview-duplicate-contracts PROPERTIES SUFFIX ".mjs"
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/contracts")
target_link_options(splatview-duplicate-contracts PRIVATE -O3 -fexceptions
    "-sDISABLE_EXCEPTION_CATCHING=0" "-sALLOW_MEMORY_GROWTH=1" "-sENVIRONMENT=node"
    "-sEXPORT_ES6=1" "-sSTACK_SIZE=8388608" "-sSTACK_OVERFLOW_CHECK=2")
target_link_libraries(desktop_core PUBLIC spz::spz libdeflate_static zstd::zstd)

# Exact Range predicate and actual completed Color/Fill owner/history contracts.
add_executable(splatview-selection-range-predicate-contracts selection_range_predicate_contracts.cpp allocation_census.cpp)
target_link_libraries(splatview-selection-range-predicate-contracts PRIVATE desktop_core)
set_target_properties(splatview-selection-range-predicate-contracts PROPERTIES SUFFIX ".mjs"
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/contracts")
target_link_options(splatview-selection-range-predicate-contracts PRIVATE -O3 -fexceptions
    "-sDISABLE_EXCEPTION_CATCHING=0" "-sALLOW_MEMORY_GROWTH=1" "-sENVIRONMENT=node" "-sEXPORT_ES6=1"
    "-sSTACK_SIZE=8388608" "-sSTACK_OVERFLOW_CHECK=2")
add_executable(splatview-selection-range-contracts selection_range_contracts.cpp bindings.cpp
    source_hash_bindings.cpp response.cpp allocation_census.cpp)
target_link_libraries(splatview-selection-range-contracts PRIVATE desktop_core)
target_compile_definitions(splatview-selection-range-contracts PRIVATE SV_ALLOCATION_CENSUS_CONTRACTS=1)
set_target_properties(splatview-selection-range-contracts PROPERTIES SUFFIX ".mjs"
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/contracts")
target_link_options(splatview-selection-range-contracts PRIVATE -O3 -fexceptions
    "-sDISABLE_EXCEPTION_CATCHING=0" "-sALLOW_MEMORY_GROWTH=1" "-sENVIRONMENT=node" "-sEXPORT_ES6=1"
    "-sFORCE_FILESYSTEM=1" "-sSTACK_SIZE=8388608" "-sSTACK_OVERFLOW_CHECK=2")

# Worker-lifetime committed-selection notification, real ABI and refusal proof.
add_executable(splatview-selection-commit-contracts selection_commit_contracts.cpp bindings.cpp
    source_hash_bindings.cpp response.cpp allocation_census.cpp)
target_link_libraries(splatview-selection-commit-contracts PRIVATE desktop_core)
target_compile_definitions(splatview-selection-commit-contracts PRIVATE SV_ALLOCATION_CENSUS_CONTRACTS=1)
set_target_properties(splatview-selection-commit-contracts PROPERTIES SUFFIX ".mjs"
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/contracts")
target_link_options(splatview-selection-commit-contracts PRIVATE -O3 -fexceptions
    "-sDISABLE_EXCEPTION_CATCHING=0" "-sALLOW_MEMORY_GROWTH=1" "-sENVIRONMENT=node" "-sEXPORT_ES6=1"
    "-sFORCE_FILESYSTEM=1" "-sSTACK_SIZE=8388608" "-sSTACK_OVERFLOW_CHECK=2")
target_include_directories(desktop_core PRIVATE "${CMAKE_CURRENT_BINARY_DIR}/_deps/zstd-src/lib")
add_executable(splatview-core bindings.cpp source_hash_bindings.cpp response.cpp allocation_census.cpp)

# Readonly cooperative pivot bounds and actual retained-session ABI contracts.
add_executable(splatview-focus-bounds-contracts focus_bounds_contracts.cpp bindings.cpp
    source_hash_bindings.cpp response.cpp allocation_census.cpp)
target_link_libraries(splatview-focus-bounds-contracts PRIVATE desktop_core)
target_compile_definitions(splatview-focus-bounds-contracts PRIVATE SV_ALLOCATION_CENSUS_CONTRACTS=1)
set_target_properties(splatview-focus-bounds-contracts PROPERTIES SUFFIX ".mjs"
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/contracts")
target_link_options(splatview-focus-bounds-contracts PRIVATE -O3 -fexceptions
    "-sDISABLE_EXCEPTION_CATCHING=0" "-sALLOW_MEMORY_GROWTH=1" "-sENVIRONMENT=node" "-sEXPORT_ES6=1"
    "-sFORCE_FILESYSTEM=1" "-sSTACK_SIZE=8388608" "-sSTACK_OVERFLOW_CHECK=2")

# Bounded live-worker operation proof, lost terminal reply and owner fences.
# Fault seams and allocation observations remain private to this executable.
add_executable(splatview-duplicate-binding-contracts duplicate_binding_contracts.cpp bindings.cpp
    source_hash_bindings.cpp response.cpp allocation_census.cpp)
target_link_libraries(splatview-duplicate-binding-contracts PRIVATE desktop_core)
target_compile_definitions(splatview-duplicate-binding-contracts PRIVATE SV_ALLOCATION_CENSUS_CONTRACTS=1)
set_target_properties(splatview-duplicate-binding-contracts PROPERTIES SUFFIX ".mjs"
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/contracts")
target_link_options(splatview-duplicate-binding-contracts PRIVATE -O3 -fexceptions
    "-sDISABLE_EXCEPTION_CATCHING=0" "-sALLOW_MEMORY_GROWTH=1" "-sENVIRONMENT=node" "-sEXPORT_ES6=1"
    "-sFORCE_FILESYSTEM=1" "-sSTACK_SIZE=8388608" "-sSTACK_OVERFLOW_CHECK=2")

add_executable(splatview-operation-receipt-contracts operation_receipt_contracts.cpp bindings.cpp
    source_hash_bindings.cpp response.cpp allocation_census.cpp)
target_link_libraries(splatview-operation-receipt-contracts PRIVATE desktop_core)
target_compile_definitions(splatview-operation-receipt-contracts PRIVATE SV_ALLOCATION_CENSUS_CONTRACTS=1)
set_target_properties(splatview-operation-receipt-contracts PROPERTIES SUFFIX ".mjs"
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/contracts")
target_link_options(splatview-operation-receipt-contracts PRIVATE -O3 -fexceptions
    "-sDISABLE_EXCEPTION_CATCHING=0" "-sALLOW_MEMORY_GROWTH=1" "-sENVIRONMENT=node" "-sEXPORT_ES6=1"
    "-sFORCE_FILESYSTEM=1" "-sSTACK_SIZE=8388608" "-sSTACK_OVERFLOW_CHECK=2")
target_link_libraries(splatview-core PRIVATE desktop_core)
set_target_properties(splatview-core PROPERTIES SUFFIX ".mjs" RUNTIME_OUTPUT_DIRECTORY "${WEB_ROOT}/public/wasm")
target_link_options(splatview-core PRIVATE -O3 -fexceptions
    "-sDISABLE_EXCEPTION_CATCHING=0" "-sALLOW_MEMORY_GROWTH=1" "-sINITIAL_MEMORY=33554432"
    "-sSTACK_SIZE=8388608" "-sSTACK_OVERFLOW_CHECK=2"
    "-sMAXIMUM_MEMORY=2147483648" "-sMODULARIZE=1" "-sEXPORT_ES6=1"
    "-sENVIRONMENT=web,worker,node" "-sFORCE_FILESYSTEM=1"
    "-sEXPORTED_FUNCTIONS=['_malloc','_free','_sv_abi_version','_sv_build_identity','_sv_allocation_snapshot','_sv_open','_sv_open_group','_sv_command','_sv_live_preview','_sv_map_write','_sv_step','_sv_scene_ptr','_sv_states_ptr','_sv_pack','_sv_pack_color_base','_sv_color_base_states_ptr','_sv_pack_transform_base','_sv_transform_base_states_ptr','_sv_pack_opacity_base','_sv_opacity_base_states_ptr','_sv_pack_len','_sv_geometry_range','_sv_geometry_range_len','_sv_output_ptr','_sv_output_len','_sv_spz4_output_bound','_sv_spz4_work_bound','_sv_export_output_bound','_sv_export_work_bound','_sv_recovery_prepare','_sv_recovery_read','_sv_recovery_read_size','_sv_recovery_release','_sv_recovery_restore_begin','_sv_recovery_restore_write','_sv_recovery_restore_finish','_sv_recovery_restore_cancel','_sv_source_hash_create','_sv_source_hash_delete','_sv_source_hash_begin','_sv_source_hash_update','_sv_source_hash_finish','_sv_source_hash_digest','_sv_source_hash_reset','_sv_source_hash_state','_sv_source_hash_expected_bytes','_sv_source_hash_consumed_bytes']"
    "-sEXPORTED_RUNTIME_METHODS=['HEAPU8','HEAPF32','UTF8ToString','stringToUTF8','lengthBytesUTF8']")
add_executable(splatview-camera camera_bindings.cpp browser_camera_transform.cpp browser_alignment_frame.cpp browser_filter_gizmo.cpp browser_transform_math.cpp "${CORE}/camera.cpp" "${CORE}/navigation.cpp")
target_include_directories(splatview-camera BEFORE PRIVATE "${SPLATVIEW_PACKAGE}/browser-include")
target_include_directories(splatview-camera PRIVATE "${CORE}" "${SPLATVIEW_PACKAGE}/third_party/DirectXMath/Inc" "${CMAKE_CURRENT_BINARY_DIR}/generated" "${CMAKE_CURRENT_SOURCE_DIR}")
set_target_properties(splatview-camera PROPERTIES SUFFIX ".mjs" RUNTIME_OUTPUT_DIRECTORY "${WEB_ROOT}/public/wasm")
target_link_options(splatview-camera PRIVATE -O3 -fexceptions "-sDISABLE_EXCEPTION_CATCHING=0" "-sMODULARIZE=1" "-sEXPORT_ES6=1"
    "-sENVIRONMENT=web,worker,node" "-sINITIAL_MEMORY=16777216" "-sALLOW_MEMORY_GROWTH=1"
    "-sSTACK_SIZE=131072" "-sSTACK_OVERFLOW_CHECK=2"
    "-sEXPORTED_FUNCTIONS=['_malloc','_free','_sv_camera_abi_version','_sv_camera_build_identity','_sv_camera','_sv_camera_transform','_sv_camera_frame_change','_sv_camera_orientation_change','_sv_camera_filter_view','_sv_camera_filter_gizmo_frame','_sv_camera_filter_gizmo_begin','_sv_camera_filter_gizmo_update','_sv_camera_transform_compose','_sv_camera_transform_gizmo_frame','_sv_camera_transform_gizmo_begin','_sv_camera_transform_gizmo_update','_sv_camera_input_create','_sv_camera_input_delete','_sv_camera_input','_sv_camera_input_active','_sv_camera_tick']" "-sEXPORTED_RUNTIME_METHODS=['HEAPF32','UTF8ToString']")

add_executable(splatview-transform-session-contracts transform_session_contracts.cpp gizmo_session_contracts.cpp bindings.cpp response.cpp allocation_census.cpp)
target_link_libraries(splatview-transform-session-contracts PRIVATE desktop_core)
target_compile_definitions(splatview-transform-session-contracts PRIVATE SV_ALLOCATION_CENSUS_CONTRACTS=1)
set_target_properties(splatview-transform-session-contracts PROPERTIES SUFFIX ".mjs" RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/contracts")
target_link_options(splatview-transform-session-contracts PRIVATE -O3 -fexceptions "-sDISABLE_EXCEPTION_CATCHING=0" "-sALLOW_MEMORY_GROWTH=1" "-sENVIRONMENT=node" "-sEXPORT_ES6=1" "-sSTACK_SIZE=8388608" "-sSTACK_OVERFLOW_CHECK=2")
# Independent alpha/preservation/history and actual strong-stream/publication
# contracts. Allocation/refusal hooks are linked only into this private main.
add_executable(splatview-opacity-session-contracts opacity_session_contracts.cpp bindings.cpp response.cpp allocation_census.cpp)
target_link_libraries(splatview-opacity-session-contracts PRIVATE desktop_core)
target_compile_definitions(splatview-opacity-session-contracts PRIVATE SV_ALLOCATION_CENSUS_CONTRACTS=1)
set_target_properties(splatview-opacity-session-contracts PROPERTIES SUFFIX ".mjs" RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/contracts")
target_link_options(splatview-opacity-session-contracts PRIVATE -O3 -fexceptions "-sDISABLE_EXCEPTION_CATCHING=0" "-sALLOW_MEMORY_GROWTH=1" "-sENVIRONMENT=node" "-sEXPORT_ES6=1" "-sSTACK_SIZE=8388608" "-sSTACK_OVERFLOW_CHECK=2")
add_executable(splatview-transform-gizmo-contracts transform_gizmo_contracts.cpp camera_bindings.cpp)
target_link_libraries(splatview-transform-gizmo-contracts PRIVATE desktop_core)
set_target_properties(splatview-transform-gizmo-contracts PROPERTIES SUFFIX ".mjs" RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/contracts")
target_link_options(splatview-transform-gizmo-contracts PRIVATE -O3 -fexceptions "-sDISABLE_EXCEPTION_CATCHING=0" "-sALLOW_MEMORY_GROWTH=1" "-sENVIRONMENT=node" "-sEXPORT_ES6=1" "-sSTACK_SIZE=8388608" "-sSTACK_OVERFLOW_CHECK=2")

# Fixed-storage CSS frame/ray/constraint math and actual camera ABI exports.
# Independent analytic oracles have no shipping observation or fault seam.
add_executable(splatview-filter-gizmo-contracts filter_gizmo_contracts.cpp camera_bindings.cpp)
target_link_libraries(splatview-filter-gizmo-contracts PRIVATE desktop_core)
set_target_properties(splatview-filter-gizmo-contracts PROPERTIES SUFFIX ".mjs"
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/contracts")
target_link_options(splatview-filter-gizmo-contracts PRIVATE -O3 -fexceptions
    "-sDISABLE_EXCEPTION_CATCHING=0" "-sALLOW_MEMORY_GROWTH=1" "-sENVIRONMENT=node" "-sEXPORT_ES6=1"
    "-sSTACK_SIZE=8388608" "-sSTACK_OVERFLOW_CHECK=2")

# Compiled with the actual portable core and browser adapter, but kept outside
# public assets. This main-only executable has no exported shipping fault API.
add_executable(splatview-live-selection-contracts live_selection_contracts.cpp allocation_census.cpp)
target_link_libraries(splatview-live-selection-contracts PRIVATE desktop_core)
set_target_properties(splatview-live-selection-contracts PROPERTIES SUFFIX ".mjs"
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/contracts")
target_link_options(splatview-live-selection-contracts PRIVATE -O3 -fexceptions
    "-sDISABLE_EXCEPTION_CATCHING=0" "-sALLOW_MEMORY_GROWTH=1" "-sENVIRONMENT=node" "-sEXPORT_ES6=1"
    "-sSTACK_SIZE=8388608" "-sSTACK_OVERFLOW_CHECK=2")

# Exercises the real shipping entry points and frozen PLY decoder. Kept outside
# the public five-file allowlist; no synthetic fault API is shipped.
add_executable(splatview-geometry-contracts geometry_contracts.cpp bindings.cpp source_hash_bindings.cpp response.cpp allocation_census.cpp)
target_link_libraries(splatview-geometry-contracts PRIVATE desktop_core)
set_target_properties(splatview-geometry-contracts PROPERTIES SUFFIX ".mjs"
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/contracts")
target_link_options(splatview-geometry-contracts PRIVATE -O3 -fexceptions
    "-sDISABLE_EXCEPTION_CATCHING=0" "-sALLOW_MEMORY_GROWTH=1" "-sENVIRONMENT=node" "-sEXPORT_ES6=1"
    "-sFORCE_FILESYSTEM=1" "-sSTACK_SIZE=8388608" "-sSTACK_OVERFLOW_CHECK=2")

# Exercises bounded reply construction and the actual shipping entry points.
# Allocation observations and fault controls exist only in this contract main.
add_executable(splatview-response-contracts response_contracts.cpp bindings.cpp source_hash_bindings.cpp response.cpp allocation_census.cpp)
target_link_libraries(splatview-response-contracts PRIVATE desktop_core)
target_compile_definitions(splatview-response-contracts PRIVATE SV_ALLOCATION_CENSUS_CONTRACTS=1)
set_target_properties(splatview-response-contracts PROPERTIES SUFFIX ".mjs"
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/contracts")
target_link_options(splatview-response-contracts PRIVATE -O3 -fexceptions
    "-sDISABLE_EXCEPTION_CATCHING=0" "-sALLOW_MEMORY_GROWTH=1" "-sENVIRONMENT=node" "-sEXPORT_ES6=1"
    "-sFORCE_FILESYSTEM=1" "-sSTACK_SIZE=8388608" "-sSTACK_OVERFLOW_CHECK=2")

# Exercises the actual core/bindings with fixed-storage, nonshipping backend
# observations. The shipping executable has no observation/injection interface.
add_executable(splatview-allocation-census-contracts allocation_census_contracts.cpp bindings.cpp source_hash_bindings.cpp response.cpp allocation_census.cpp)
target_link_libraries(splatview-allocation-census-contracts PRIVATE desktop_core)
target_compile_definitions(splatview-allocation-census-contracts PRIVATE SV_ALLOCATION_CENSUS_CONTRACTS=1)
set_target_properties(splatview-allocation-census-contracts PROPERTIES SUFFIX ".mjs"
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/contracts")
target_link_options(splatview-allocation-census-contracts PRIVATE -O3 -fexceptions
    "-sDISABLE_EXCEPTION_CATCHING=0" "-sALLOW_MEMORY_GROWTH=1" "-sENVIRONMENT=node" "-sEXPORT_ES6=1"
    "-sFORCE_FILESYSTEM=1" "-sSTACK_SIZE=8388608" "-sSTACK_OVERFLOW_CHECK=2")

# Observe actual zlib stream ownership and fail C++ allocations only in this
# nonshipping main. Shipping SPZ uses the same disposable-overlay RAII cleanup.
add_executable(splatview-spz-cleanup-contracts spz_cleanup_contracts.cpp allocation_census.cpp)
target_link_libraries(splatview-spz-cleanup-contracts PRIVATE spz::spz)
target_compile_definitions(splatview-spz-cleanup-contracts PRIVATE SV_ALLOCATION_CENSUS_CONTRACTS=1)
set_target_properties(splatview-spz-cleanup-contracts PROPERTIES SUFFIX ".mjs"
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/contracts")
target_link_options(splatview-spz-cleanup-contracts PRIVATE -O3 -fexceptions
    "-sDISABLE_EXCEPTION_CATCHING=0" "-sALLOW_MEMORY_GROWTH=1" "-sENVIRONMENT=node" "-sEXPORT_ES6=1"
    "-Wl,--wrap=inflateInit2_,--wrap=deflateInit2_,--wrap=inflateEnd,--wrap=deflateEnd"
    "-sSTACK_SIZE=8388608" "-sSTACK_OVERFLOW_CHECK=2")

# Five retained attribute writers use the actual direct sink and complete-byte
# legacy filesystem oracle; main-only refusal hooks never enter web assets.
add_executable(splatview-attribute-export-contracts attribute_export_contracts.cpp bindings.cpp source_hash_bindings.cpp response.cpp allocation_census.cpp)
target_link_libraries(splatview-attribute-export-contracts PRIVATE desktop_core)
target_compile_definitions(splatview-attribute-export-contracts PRIVATE SV_ALLOCATION_CENSUS_CONTRACTS=1)
set_target_properties(splatview-attribute-export-contracts PROPERTIES SUFFIX ".mjs"
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/contracts")
target_link_options(splatview-attribute-export-contracts PRIVATE -O3 -fexceptions
    "-sDISABLE_EXCEPTION_CATCHING=0" "-sALLOW_MEMORY_GROWTH=1" "-sENVIRONMENT=node" "-sEXPORT_ES6=1"
    "-sFORCE_FILESYSTEM=1" "-sSTACK_SIZE=8388608" "-sSTACK_OVERFLOW_CHECK=2")

# SPZ3 preserves complete original desktop bytes, including the exact 1MiB
# empty-tail boundary, with actual CABI admission/backend teardown contracts.
add_executable(splatview-spz3-export-contracts spz3_export_contracts.cpp bindings.cpp source_hash_bindings.cpp response.cpp allocation_census.cpp)
target_link_libraries(splatview-spz3-export-contracts PRIVATE desktop_core)
target_compile_definitions(splatview-spz3-export-contracts PRIVATE SV_ALLOCATION_CENSUS_CONTRACTS=1)
set_target_properties(splatview-spz3-export-contracts PROPERTIES SUFFIX ".mjs"
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/contracts")
target_link_options(splatview-spz3-export-contracts PRIVATE -O3 -fexceptions
    "-sDISABLE_EXCEPTION_CATCHING=0" "-sALLOW_MEMORY_GROWTH=1" "-sENVIRONMENT=node" "-sEXPORT_ES6=1"
    "-sFORCE_FILESYSTEM=1" "-sSTACK_SIZE=8388608" "-sSTACK_OVERFLOW_CHECK=2")

# Independent SPZ v4 framing/attribute oracles and real export publication,
# cancellation/admission/failure paths. No test hook enters shipping assets.
add_executable(splatview-spz4-export-contracts spz4_export_contracts.cpp bindings.cpp source_hash_bindings.cpp response.cpp allocation_census.cpp)
target_link_libraries(splatview-spz4-export-contracts PRIVATE desktop_core)
target_compile_definitions(splatview-spz4-export-contracts PRIVATE SV_ALLOCATION_CENSUS_CONTRACTS=1)
set_target_properties(splatview-spz4-export-contracts PROPERTIES SUFFIX ".mjs"
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/contracts")
target_link_options(splatview-spz4-export-contracts PRIVATE -O3 -fexceptions
    "-sDISABLE_EXCEPTION_CATCHING=0" "-sALLOW_MEMORY_GROWTH=1" "-sENVIRONMENT=node" "-sEXPORT_ES6=1"
    "-sFORCE_FILESYSTEM=1" "-sSTACK_SIZE=8388608" "-sSTACK_OVERFLOW_CHECK=2")

# Actual bounded metadata parsing/destruction and SOG candidate publication.
# Main-only allocation observations do not enable shipping quotas or faults.
add_executable(splatview-json-cleanup-contracts json_cleanup_contracts.cpp bindings.cpp source_hash_bindings.cpp response.cpp allocation_census.cpp)
target_link_libraries(splatview-json-cleanup-contracts PRIVATE desktop_core)
target_compile_definitions(splatview-json-cleanup-contracts PRIVATE SV_ALLOCATION_CENSUS_CONTRACTS=1)
set_target_properties(splatview-json-cleanup-contracts PROPERTIES SUFFIX ".mjs"
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/contracts")
target_link_options(splatview-json-cleanup-contracts PRIVATE -O3 -fexceptions
    "-sDISABLE_EXCEPTION_CATCHING=0" "-sALLOW_MEMORY_GROWTH=1" "-sENVIRONMENT=node" "-sEXPORT_ES6=1"
    "-sFORCE_FILESYSTEM=1" "-sSTACK_SIZE=8388608" "-sSTACK_OVERFLOW_CHECK=2")

# Calls the exact source-hash C ABI and inspects its private slot only from this
# main translation unit. No contract observation or fault entry point is exported.
add_executable(splatview-source-hash-contracts source_hash_contracts.cpp)
target_include_directories(splatview-source-hash-contracts PRIVATE
    "${SPLATVIEW_PACKAGE}/third_party/picosha2")
set_target_properties(splatview-source-hash-contracts PROPERTIES SUFFIX ".mjs"
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/contracts")
target_link_options(splatview-source-hash-contracts PRIVATE -O3 -fexceptions
    "-sDISABLE_EXCEPTION_CATCHING=0" "-sALLOW_MEMORY_GROWTH=1" "-sENVIRONMENT=node" "-sEXPORT_ES6=1"
    "-sSTACK_SIZE=8388608" "-sSTACK_OVERFLOW_CHECK=2")

# Actual cooperative Grow/Shrink owner, allocator failure paths, edit history
# and public binding dispatch. No observation/failure export enters the app.
add_executable(splatview-morphology-contracts morphology_contracts.cpp bindings.cpp
    source_hash_bindings.cpp response.cpp allocation_census.cpp)
target_link_libraries(splatview-morphology-contracts PRIVATE desktop_core)
target_compile_definitions(splatview-morphology-contracts PRIVATE SV_ALLOCATION_CENSUS_CONTRACTS=1)
set_target_properties(splatview-morphology-contracts PROPERTIES SUFFIX ".mjs"
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/contracts")
target_link_options(splatview-morphology-contracts PRIVATE -O3 -fexceptions
    "-sDISABLE_EXCEPTION_CATCHING=0" "-sALLOW_MEMORY_GROWTH=1" "-sENVIRONMENT=node" "-sEXPORT_ES6=1"
    "-sFORCE_FILESYSTEM=1" "-sSTACK_SIZE=8388608" "-sSTACK_OVERFLOW_CHECK=2")

# Six captured desktop predicates, fixed-baseline drafts and actual public C ABI
# publication/refusal/rollback. All fault seams remain main-only, never shipped.
add_executable(splatview-filter-contracts filter_contracts.cpp bindings.cpp
    source_hash_bindings.cpp response.cpp allocation_census.cpp)
target_link_libraries(splatview-filter-contracts PRIVATE desktop_core)
target_compile_definitions(splatview-filter-contracts PRIVATE SV_ALLOCATION_CENSUS_CONTRACTS=1)
set_target_properties(splatview-filter-contracts PROPERTIES SUFFIX ".mjs"
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/contracts")
target_link_options(splatview-filter-contracts PRIVATE -O3 -fexceptions
    "-sDISABLE_EXCEPTION_CATCHING=0" "-sALLOW_MEMORY_GROWTH=1" "-sENVIRONMENT=node" "-sEXPORT_ES6=1"
    "-sFORCE_FILESYSTEM=1" "-sSTACK_SIZE=8388608" "-sSTACK_OVERFLOW_CHECK=2")

# Read-only automatic-color analysis and retained color-session metadata.
# Actual admission/cancellation/stale-key contracts have no shipping fault API.
add_executable(splatview-auto-color-contracts auto_color_contracts.cpp
    auto_color_metadata_contracts.cpp allocation_census.cpp)
target_link_libraries(splatview-auto-color-contracts PRIVATE desktop_core)
target_compile_definitions(splatview-auto-color-contracts PRIVATE SV_ALLOCATION_CENSUS_CONTRACTS=1)
set_target_properties(splatview-auto-color-contracts PROPERTIES SUFFIX ".mjs"
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/contracts")
target_link_options(splatview-auto-color-contracts PRIVATE -O3 -fexceptions
    "-sDISABLE_EXCEPTION_CATCHING=0" "-sALLOW_MEMORY_GROWTH=1" "-sENVIRONMENT=node" "-sEXPORT_ES6=1"
    "-sSTACK_SIZE=8388608" "-sSTACK_OVERFLOW_CHECK=2")

# Actual public color C ABI, immutable base packing, absolute bake/Auto,
# transaction/Undo/Redo boundaries and export. Kept outside public assets.
add_executable(splatview-color-session-contracts color_session_contracts.cpp bindings.cpp
    source_hash_bindings.cpp response.cpp allocation_census.cpp)
target_link_libraries(splatview-color-session-contracts PRIVATE desktop_core)
target_compile_definitions(splatview-color-session-contracts PRIVATE SV_ALLOCATION_CENSUS_CONTRACTS=1)
set_target_properties(splatview-color-session-contracts PROPERTIES SUFFIX ".mjs"
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/contracts")
target_link_options(splatview-color-session-contracts PRIVATE -O3 -fexceptions
    "-sDISABLE_EXCEPTION_CATCHING=0" "-sALLOW_MEMORY_GROWTH=1" "-sENVIRONMENT=node" "-sEXPORT_ES6=1"
    "-sFORCE_FILESYSTEM=1" "-sSTACK_SIZE=8388608" "-sSTACK_OVERFLOW_CHECK=2")

# Actual Center/Scale/reset C ABI, whole-scene position/covariance, camera validation,
# immutable history/lineage, cancellation and publication refusal contracts.
add_executable(splatview-alignment-contracts alignment_contracts.cpp bindings.cpp
    source_hash_bindings.cpp response.cpp allocation_census.cpp)
target_link_libraries(splatview-alignment-contracts PRIVATE desktop_core)
target_compile_definitions(splatview-alignment-contracts PRIVATE SV_ALLOCATION_CENSUS_CONTRACTS=1)
set_target_properties(splatview-alignment-contracts PROPERTIES SUFFIX ".mjs"
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/contracts")
target_link_options(splatview-alignment-contracts PRIVATE -O3 -fexceptions
    "-sDISABLE_EXCEPTION_CATCHING=0" "-sALLOW_MEMORY_GROWTH=1" "-sENVIRONMENT=node" "-sEXPORT_ES6=1"
    "-sFORCE_FILESYSTEM=1" "-sSTACK_SIZE=8388608" "-sSTACK_OVERFLOW_CHECK=2")

# Calls actual camera ABI4 transform/frame/orientation wrappers and compares complete
# outputs with pinned kernels; refusal must never write a partial result.
add_executable(splatview-camera-transform-contracts camera_transform_contracts.cpp camera_bindings.cpp)
target_link_libraries(splatview-camera-transform-contracts PRIVATE desktop_core)
set_target_properties(splatview-camera-transform-contracts PROPERTIES SUFFIX ".mjs"
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/contracts")
target_link_options(splatview-camera-transform-contracts PRIVATE -O3 -fexceptions
    "-sDISABLE_EXCEPTION_CATCHING=0" "-sALLOW_MEMORY_GROWTH=1" "-sENVIRONMENT=node" "-sEXPORT_ES6=1"
    "-sSTACK_SIZE=8388608" "-sSTACK_OVERFLOW_CHECK=2")

# Actual cooperative Floor detector and retained-result transaction/publication
# contracts. Fault controls are main-only and never exported by shipping core.
add_executable(splatview-floor-contracts floor_contracts.cpp bindings.cpp
    source_hash_bindings.cpp response.cpp allocation_census.cpp)
target_link_libraries(splatview-floor-contracts PRIVATE desktop_core)
target_compile_definitions(splatview-floor-contracts PRIVATE SV_ALLOCATION_CENSUS_CONTRACTS=1)
set_target_properties(splatview-floor-contracts PROPERTIES SUFFIX ".mjs"
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/contracts")
target_link_options(splatview-floor-contracts PRIVATE -O3 -fexceptions
    "-sDISABLE_EXCEPTION_CATCHING=0" "-sALLOW_MEMORY_GROWTH=1" "-sENVIRONMENT=node" "-sEXPORT_ES6=1"
    "-sFORCE_FILESYSTEM=1" "-sSTACK_SIZE=8388608" "-sSTACK_OVERFLOW_CHECK=2")

# Borrowed grouped-v1-SH0 C ABI, independent literal pixel/analytic record
# fixtures and publication refusal/old-document recovery; never shipped.
add_executable(splatview-sog-group-contracts sog_group_contracts.cpp bindings.cpp
    source_hash_bindings.cpp response.cpp allocation_census.cpp)
target_link_libraries(splatview-sog-group-contracts PRIVATE desktop_core)
target_compile_definitions(splatview-sog-group-contracts PRIVATE SV_ALLOCATION_CENSUS_CONTRACTS=1)
set_target_properties(splatview-sog-group-contracts PROPERTIES SUFFIX ".mjs"
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/contracts")
target_link_options(splatview-sog-group-contracts PRIVATE -O3 -fexceptions
    "-sDISABLE_EXCEPTION_CATCHING=0" "-sALLOW_MEMORY_GROWTH=1" "-sENVIRONMENT=node" "-sEXPORT_ES6=1"
    "-sFORCE_FILESYSTEM=1" "-sSTACK_SIZE=8388608" "-sSTACK_OVERFLOW_CHECK=2")

# Original namespace/order-signature-only desktop source is linked exclusively
# into this nonshipping complete-byte oracle and actual admitted CABI main.
add_executable(splatview-sog-export-contracts sog_export_contracts.cpp
    "${SPLATVIEW_PACKAGE}/browser-oracle/sog_export_original.cpp" bindings.cpp
    source_hash_bindings.cpp response.cpp allocation_census.cpp)
target_link_libraries(splatview-sog-export-contracts PRIVATE desktop_core)
target_compile_definitions(splatview-sog-export-contracts PRIVATE SV_ALLOCATION_CENSUS_CONTRACTS=1)
set_target_properties(splatview-sog-export-contracts PROPERTIES SUFFIX ".mjs"
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/contracts")
target_link_options(splatview-sog-export-contracts PRIVATE -O3 -fexceptions
    "-sDISABLE_EXCEPTION_CATCHING=0" "-sALLOW_MEMORY_GROWTH=1" "-sENVIRONMENT=node" "-sEXPORT_ES6=1"
    "-sFORCE_FILESYSTEM=1" "-sSTACK_SIZE=8388608" "-sSTACK_OVERFLOW_CHECK=2")

# Actual homogeneous center predicate, scoped selection/session targets, atomic
# edit+clip, refusal/history and keyed preview-mask ownership. Never shipped.
add_executable(splatview-current-view-contracts current_view_contracts.cpp bindings.cpp
    source_hash_bindings.cpp response.cpp allocation_census.cpp)
target_link_libraries(splatview-current-view-contracts PRIVATE desktop_core)
target_compile_definitions(splatview-current-view-contracts PRIVATE SV_ALLOCATION_CENSUS_CONTRACTS=1)
set_target_properties(splatview-current-view-contracts PROPERTIES SUFFIX ".mjs" RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/contracts")
target_link_options(splatview-current-view-contracts PRIVATE -O3 -fexceptions
    "-sDISABLE_EXCEPTION_CATCHING=0" "-sALLOW_MEMORY_GROWTH=1" "-sENVIRONMENT=node" "-sEXPORT_ES6=1"
    "-sFORCE_FILESYSTEM=1" "-sSTACK_SIZE=8388608" "-sSTACK_OVERFLOW_CHECK=2")

add_executable(splatview-document-checkpoint-contracts document_checkpoint_contracts.cpp allocation_census.cpp)
target_link_libraries(splatview-document-checkpoint-contracts PRIVATE desktop_core)
target_compile_definitions(splatview-document-checkpoint-contracts PRIVATE SV_ALLOCATION_CENSUS_CONTRACTS=1)
set_target_properties(splatview-document-checkpoint-contracts PROPERTIES SUFFIX ".mjs" RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/contracts")
target_link_options(splatview-document-checkpoint-contracts PRIVATE -O3 -fexceptions
    "-sDISABLE_EXCEPTION_CATCHING=0" "-sALLOW_MEMORY_GROWTH=1" "-sENVIRONMENT=node" "-sEXPORT_ES6=1"
    "-sFORCE_FILESYSTEM=1" "-sSTACK_SIZE=8388608" "-sSTACK_OVERFLOW_CHECK=2")

# Preserve every utils.c symbol in one forced object, so the archive's original
# object cannot be selected. Both shipping core and all codec-bearing native
# contract mains link the exact bridge; camera-only executables do not use WebP.
add_library(splatview-webp-utils OBJECT "${SPLATVIEW_PACKAGE}/browser-codec/webp_utils.c")
if(NOT EXISTS "${SPLATVIEW_WEBP_SOURCE}/src/utils/utils.h")
    message(FATAL_ERROR "Missing verified WebP source include root; configure through tools/build-core.py")
endif()
target_include_directories(splatview-webp-utils PRIVATE "${SPLATVIEW_WEBP_SOURCE}")
get_property(splatview_local_targets DIRECTORY PROPERTY BUILDSYSTEM_TARGETS)
foreach(splatview_target IN LISTS splatview_local_targets)
    get_target_property(splatview_target_sources "${splatview_target}" SOURCES)
    if("allocation_census.cpp" IN_LIST splatview_target_sources AND NOT splatview_target STREQUAL "splatview-spz-cleanup-contracts")
        target_sources("${splatview_target}" PRIVATE $<TARGET_OBJECTS:splatview-webp-utils>)
    endif()
endforeach()
