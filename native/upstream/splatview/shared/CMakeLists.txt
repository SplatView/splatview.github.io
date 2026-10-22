cmake_minimum_required(VERSION 3.25)

# The complete source checkout is the package. This directory is an independent
# entry point into that checkout, never a copied implementation or sibling repo.
if(CMAKE_SOURCE_DIR STREQUAL CMAKE_CURRENT_SOURCE_DIR)
    project(SplatViewShared VERSION 0.1.0 LANGUAGES CXX)
    set(CMAKE_CXX_EXTENSIONS OFF)
    set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
    option(SPLATVIEW_ENABLE_SANITIZERS "Enable address and undefined behavior sanitizers" OFF)
endif()

if(TARGET splatview_scene OR TARGET splatview_domain OR TARGET SplatView::Scene OR TARGET SplatView::Domain)
    message(FATAL_ERROR "SplatView shared targets already exist. Add shared/ once and remove competing target definitions.")
endif()
get_filename_component(_splatview_package_root "${CMAKE_CURRENT_LIST_DIR}/.." ABSOLUTE)

# Check the vendored CPU math and non-Windows SAL sources against the same lock
# used by app verification. There is no automatic fetch or SDK fallback.
set(_splatview_math_manifest "${_splatview_package_root}/third_party/HEADER_DEPENDENCIES.json")
file(READ "${_splatview_math_manifest}" _splatview_math_lock)
string(JSON _splatview_lock_count LENGTH "${_splatview_math_lock}")
math(EXPR _splatview_lock_last "${_splatview_lock_count} - 1")
set(_splatview_checked_math_files 0)
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${_splatview_math_manifest}")
foreach(_splatview_lock_index RANGE 0 ${_splatview_lock_last})
    string(JSON _splatview_locked_path GET "${_splatview_math_lock}" ${_splatview_lock_index} path)
    if(_splatview_locked_path MATCHES "^third_party/DirectXMath/")
        string(JSON _splatview_locked_sha GET "${_splatview_math_lock}" ${_splatview_lock_index} sha256)
        set(_splatview_math_file "${_splatview_package_root}/${_splatview_locked_path}")
        file(SHA256 "${_splatview_math_file}" _splatview_actual_sha)
        if(NOT _splatview_actual_sha STREQUAL _splatview_locked_sha)
            message(FATAL_ERROR "Pinned math dependency changed: ${_splatview_locked_path}")
        endif()
        set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${_splatview_math_file}")
        math(EXPR _splatview_checked_math_files "${_splatview_checked_math_files} + 1")
    endif()
endforeach()
if(NOT _splatview_checked_math_files EQUAL 10)
    message(FATAL_ERROR "The shared package needs all 10 pinned DirectXMath/SAL headers and license records.")
endif()

function(_splatview_configure_shared_target target)
    target_compile_features(${target} PUBLIC cxx_std_20)
    set_target_properties(${target} PROPERTIES POSITION_INDEPENDENT_CODE ON CXX_EXTENSIONS OFF)
    target_include_directories(${target} PUBLIC "${_splatview_package_root}/src/core")
    target_include_directories(${target} SYSTEM PUBLIC "${_splatview_package_root}/third_party/DirectXMath/Inc")
    # Do not disable vector operators in a native Windows host's own sources.
    target_compile_definitions(${target} PRIVATE _XM_NO_XMVECTOR_OVERLOADS_)
    target_compile_definitions(${target} PUBLIC $<$<CXX_COMPILER_ID:MSVC>:_ENABLE_EXTENDED_ALIGNED_STORAGE>)
    if(MSVC)
        target_compile_options(${target} PRIVATE /utf-8 /W4 /permissive- /EHsc /fp:precise)
    else()
        target_compile_options(${target} PRIVATE -Wall -Wextra -Wpedantic -ffp-contract=off)
        if(SPLATVIEW_ENABLE_SANITIZERS)
            target_compile_options(${target} PUBLIC -fsanitize=address,undefined -fno-omit-frame-pointer)
            target_link_options(${target} PUBLIC -fsanitize=address,undefined)
        endif()
    endif()
endfunction()

# The smallest adoption unit contains no codec, JSON, UI, graphics API or I/O
# dependency. Windows can migrate its scene/camera definitions independently of
# its native selection types and viewer implementation.
add_library(splatview_scene STATIC
    "${_splatview_package_root}/src/core/scene_math.cpp"
    "${_splatview_package_root}/src/core/camera.cpp")
add_library(SplatView::Scene ALIAS splatview_scene)
_splatview_configure_shared_target(splatview_scene)

option(SPLATVIEW_BUILD_DOMAIN "Build domain services beyond the standalone Scene target" ON)
if(NOT SPLATVIEW_BUILD_DOMAIN)
    return()
endif()

if(NOT TARGET Threads::Threads)
    find_package(Threads REQUIRED)
endif()
if(NOT TARGET nlohmann_json::nlohmann_json)
    find_package(nlohmann_json CONFIG REQUIRED)
endif()

add_library(splatview_domain STATIC
    "${_splatview_package_root}/src/core/resource_budget.cpp"
    "${_splatview_package_root}/src/core/processing_kernels.cpp"
    "${_splatview_package_root}/src/core/navigation.cpp"
    "${_splatview_package_root}/src/core/editing.cpp"
    "${_splatview_package_root}/src/core/selection.cpp"
    "${_splatview_package_root}/src/core/volume_selection.cpp"
    "${_splatview_package_root}/src/core/geometry_tools.cpp"
    "${_splatview_package_root}/src/core/surface_selection.cpp")
add_library(SplatView::Domain ALIAS splatview_domain)
_splatview_configure_shared_target(splatview_domain)
target_link_libraries(splatview_domain PUBLIC SplatView::Scene Threads::Threads nlohmann_json::nlohmann_json)

option(SPLATVIEW_BUILD_CPU_RENDERER "Build the optional portable reference renderer" ON)
if(SPLATVIEW_BUILD_CPU_RENDERER)
    add_library(splatview_render_cpu STATIC
        "${_splatview_package_root}/src/render/render_frame.cpp"
        "${_splatview_package_root}/src/render/software_renderer.cpp"
        "${_splatview_package_root}/src/render/live_preview.cpp"
        "${_splatview_package_root}/src/render/frame_capture.cpp")
    add_library(SplatView::RenderCPU ALIAS splatview_render_cpu)
    _splatview_configure_shared_target(splatview_render_cpu)
    target_include_directories(splatview_render_cpu PUBLIC "${_splatview_package_root}/src/render")
    target_link_libraries(splatview_render_cpu PUBLIC SplatView::Domain)
endif()
