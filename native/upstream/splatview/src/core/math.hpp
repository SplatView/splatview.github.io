#pragma once
// The upstream non-Windows SAL shim defines __valid, also used as a local
// identifier by libstdc++ <charconv>. Do not leak that macro into consumers.
#pragma push_macro("__valid")
#include <DirectXMath.h>
#include <DirectXPackedVector.h>
#pragma pop_macro("__valid")
