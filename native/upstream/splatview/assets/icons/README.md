# Viewer icons

These outline SVGs are from [Lucide](https://github.com/lucide-icons/lucide), pinned to commit `a04f228cd01185e09c188b7227b9600c08c565ec`. The additional `selection-*.svg`, `volume-brush.svg`, `settings.svg` and `fullscreen*.svg` are original SplatView icons using the same grid and stroke style, covered by this project's MIT license. The selection filters include sphere, box, ellipsoid, camera frustum and opacity glyphs; scale reuses Lucide's scaling glyph.

The `color-*.svg` and `flip-*.svg` icons are also original SplatView designs under this project's MIT license. Color actions use a magic wand for automatic correction, the camera exposure-compensation symbol, a half-filled contrast circle, a thermometer with sun rays for white balance and a palette for presets. The flip icons identify the X/Y/Z axes.

The spherical brush (`volume-brush.svg`) uses an outline of the Opsiclear ring: its outer contour, tilted opening and connecting edges. It has no fill or fixed color and follows the same stroke weight and hover/selection tint as the other tool icons.

`LICENSE.txt` includes Lucide's ISC license and the MIT notice for icons derived from Feather. Source Lucide SVGs are unchanged. CMake assembles the selected icons into an embedded white atlas, using 1.75-unit strokes on their original 24-unit grid to match the visual weight of COLMAPView's controls. The SVGs render locally through Windows Direct2D at twice the display resolution; runtime downloads are unnecessary.

