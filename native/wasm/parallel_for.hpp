#pragma once
#include <cstddef>
#include <stdexcept>
#include <stop_token>

// Browser execution policy. The immutable upstream package stays unchanged;
// build-core.py installs this explicit host adapter into the build overlay.
// Long browser jobs call bounded steps and yield between invocations.
namespace preview::detail {
template <class Function>
void parallelFor(std::size_t count, std::stop_token stop, Function action,
                 std::size_t = 16'384) {
    for (std::size_t i = 0; i < count; ++i) {
        if ((i & 1023) == 0 && stop.stop_requested())
            throw std::runtime_error("Loading canceled");
        action(i);
    }
}
}
