# Consume only this checkout's sealed bundle and adapter; no sibling paths.
if(NOT TARGET splatview_product_contract)
    add_library(splatview_product_contract INTERFACE)
    target_include_directories(splatview_product_contract INTERFACE
        "${PROJECT_SOURCE_DIR}/contracts/product/include" "${PROJECT_SOURCE_DIR}/contracts/generated")
endif()
add_library(splatview_product_json INTERFACE)
target_sources(splatview_product_json INTERFACE FILE_SET HEADERS
    BASE_DIRS "${PROJECT_SOURCE_DIR}/contracts/product/include" FILES
    "${PROJECT_SOURCE_DIR}/contracts/product/include/splatview_product/measurement_request.hpp"
    "${PROJECT_SOURCE_DIR}/contracts/product/include/splatview_product/measurement_schema.hpp")
target_link_libraries(splatview_product_json INTERFACE splatview_product_contract nlohmann_json::nlohmann_json)
# A customer/source build without tests keeps its existing no-Python toolchain.
# CMake still checks the sealed payload and explicit consumer pin on configure.
set(product_bundle_root "${PROJECT_SOURCE_DIR}/contracts/product")
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS
    "${product_bundle_root}/manifest.json" "${PROJECT_SOURCE_DIR}/contracts/product-adapter.json")
file(READ "${product_bundle_root}/manifest.json" product_manifest)
file(READ "${PROJECT_SOURCE_DIR}/contracts/product-adapter.json" product_adapter)
file(SHA256 "${product_bundle_root}/manifest.json" product_manifest_sha)
string(JSON product_expected_pin GET "${product_adapter}" bundleSha256)
if(NOT product_expected_pin STREQUAL product_manifest_sha)
    message(FATAL_ERROR "Product bundle pin mismatch; import the reviewed sealed bundle explicitly")
endif()
string(JSON product_file_count LENGTH "${product_manifest}" files)
math(EXPR product_file_last "${product_file_count} - 1")
foreach(product_index RANGE 0 ${product_file_last})
    string(JSON product_path GET "${product_manifest}" files ${product_index} path)
    cmake_path(APPEND product_bundle_root "${product_path}" OUTPUT_VARIABLE product_file)
    cmake_path(NORMAL_PATH product_file)
    cmake_path(IS_PREFIX product_bundle_root "${product_file}" NORMALIZE product_local)
    if(NOT product_local OR NOT EXISTS "${product_file}")
        message(FATAL_ERROR "Missing or escaping product bundle payload: ${product_path}")
    endif()
    file(REAL_PATH "${product_file}" product_resolved_file)
    file(REAL_PATH "${product_bundle_root}" product_resolved_root)
    cmake_path(IS_PREFIX product_resolved_root "${product_resolved_file}" NORMALIZE product_local)
    if(NOT product_local)
        message(FATAL_ERROR "Product bundle symlink escapes the local bundle: ${product_path}")
    endif()
    set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${product_file}")
    string(JSON product_expected GET "${product_manifest}" files ${product_index} sha256)
    file(SHA256 "${product_file}" product_actual)
    if(NOT product_expected STREQUAL product_actual)
        message(FATAL_ERROR "Product bundle payload changed: ${product_path}")
    endif()
endforeach()
if(NOT BUILD_TESTING)
    return()
endif()
find_package(Python3 3.10 REQUIRED COMPONENTS Interpreter)
add_custom_target(SplatViewProductContractCheck ALL
    COMMAND "${Python3_EXECUTABLE}" -B "${PROJECT_SOURCE_DIR}/contracts/product/tool.py" verify
        --root "${PROJECT_SOURCE_DIR}"
    COMMENT "Checking pinned product bundle, local registrations and generated policy"
    VERBATIM)
add_dependencies(splatview_product_contract SplatViewProductContractCheck)
if(BUILD_TESTING)
    add_executable(SplatViewProductPolicyTests "${PROJECT_SOURCE_DIR}/contracts/product/tests/policy_contracts.cpp")
    target_link_libraries(SplatViewProductPolicyTests PRIVATE splatview_product_contract nlohmann_json::nlohmann_json)
    add_test(NAME ProductPolicyContracts COMMAND SplatViewProductPolicyTests
        "${PROJECT_SOURCE_DIR}/contracts/product/fixtures/availability.json")
    set_tests_properties(ProductPolicyContracts PROPERTIES TIMEOUT 10 LABELS "portable;contract;release;policy")
    add_test(NAME ProductBundleContracts
        COMMAND "${Python3_EXECUTABLE}" -B "${PROJECT_SOURCE_DIR}/contracts/product/tool.py" verify
            --root "${PROJECT_SOURCE_DIR}")
    set_tests_properties(ProductBundleContracts PROPERTIES TIMEOUT 120 LABELS "portable;contract;release;policy")
endif()
