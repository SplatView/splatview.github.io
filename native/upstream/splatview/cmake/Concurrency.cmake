include(CheckCXXSourceCompiles)
include(CMakePushCheckState)
cmake_push_check_state(RESET)
set(CMAKE_REQUIRED_LIBRARIES Threads::Threads)
if(APPLE)
    set(CMAKE_REQUIRED_FLAGS "-Werror=unguarded-availability")
endif()
check_cxx_source_compiles([=[
#include <version>
#include <thread>
#include <stop_token>
#include <latch>
#include <semaphore>
#if !defined(__cpp_lib_jthread) || __cpp_lib_jthread < 201911L
#error Stable C++20 jthread and stop-token support is required
#endif
#if !defined(__cpp_lib_latch) || __cpp_lib_latch < 201907L
#error C++20 latch support is required
#endif
#if !defined(__cpp_lib_semaphore) || __cpp_lib_semaphore < 201907L
#error C++20 semaphore support is required
#endif
int main() {
    std::stop_source owner;
    std::stop_callback callback(owner.get_token(), [] {});
    std::latch finished(1);
    std::binary_semaphore entered(0);
    std::jthread worker([&](std::stop_token stop) {
        (void)stop.stop_requested();
        entered.release(); finished.count_down();
    });
    entered.acquire(); finished.wait();
    worker.request_stop(); owner.request_stop();
}
]=] SPLATVIEW_HAS_CXX20_CONCURRENCY)
cmake_pop_check_state()
if(NOT SPLATVIEW_HAS_CXX20_CONCURRENCY)
    message(FATAL_ERROR
        "SplatView needs a C++20 standard library with jthread, stop_token, stop_callback, latch and semaphore. "
        "For Apple's stable library use Xcode 26 or later; select it with DEVELOPER_DIR/xcode-select, "
        "then configure a fresh build tree. See docs/BUILD_PRESETS.md and the CMake configure log.")
endif()
