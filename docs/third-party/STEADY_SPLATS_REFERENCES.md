# SteadySplats rendering references

The requested reference is [PlayCanvas engine PR 9819](https://github.com/playcanvas/engine/pull/9819),
reviewed October 25, 2026 at immutable head
[`12542cf99f2b2b23c7e84c6602f8b5e537e74e73`](https://github.com/lyehe/engine/tree/12542cf99f2b2b23c7e84c6602f8b5e537e74e73).
It was a draft at review time. SplatView does not depend on its branch or the
PlayCanvas runtime and does not import native-port sources at build time.

The scalar 32×32×64 STBN data in `src/renderer/steadyNoise.ts` is copied
from that revision's `src/core/math/spatiotemporal-blue-noise.js`, with its MIT
copyright/license retained. `steady.wgsl` adapts the same revision's WGSL noise,
visibility, common PDF, history, spatial, temporal, convergence and composite
logic. This includes the four-neighbor proposal ratios, four distinct-occluder
FIFO, YCoCg history rejection, cubic reprojection and FP32 stationary average.
The backend lifecycles and SplatView integration are original implementation.
The WebGL2 `steady*.glsl` shaders port the same reviewed WebGPU equations and
use the same STBN data; framebuffer plumbing follows the reviewed upstream
WebGL2 approach while retaining SplatView axes, opacity and alpha support.

SplatView uses its existing non-normalized Gaussian profile, native cutoff,
SH/grade domain and source IDs for both sampling and density ratios. It keeps
exact sorted picking, editing maps and clean captures. The default remains
sorted rendering. No PlayCanvas benchmark is a SplatView performance result.

Research attribution: Felix Windisch, Thomas Köhler, Lukas Radl, Chris Wyman,
Georgios Kopanas, Bernhard Kerbl and Markus Steinberger,
[*SteadySplats: Resampling of Low-Variance Gaussians for High-Fidelity Stochastic Rendering*](https://arxiv.org/abs/2610.05576)
(2026), [authors' project](https://derthomy.github.io/SteadySplats/).
The PlayCanvas integration credits Yehe Liu's related LichtFeld-Studio rendering
and color-variance training work. This change implements rendering only.

## PlayCanvas MIT license

Copyright (c) 2011-2026 PlayCanvas Ltd.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
