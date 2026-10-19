# SplatView web and publisher pages

Public privacy information, license terms and support links for SplatView, published by OpsiClear LLC. The app source is maintained separately in a private repository.

GitHub Pages: https://splatview.github.io/

Publish from the `main` branch and `/` root. Keep the plain-text legal documents and their HTML pages synchronized with the released application. The publisher and legal pages use no JavaScript, cookies, external fonts or application analytics. The browser application uses JavaScript, WebAssembly, WebGPU and browser-local storage. GitHub handles web hosting under its own privacy policies.

## Browser application

The root serves the Basic SplatView browser viewer and lightweight editor over HTTPS. Selected scene files are processed locally in the browser. WebGPU is required. The previous desktop publisher homepage is retained at [/publisher/](https://splatview.github.io/publisher/); existing privacy and license URLs remain unchanged.

This repository contains the emitted static site. Publish the complete verified `dist` closure from the application workspace, retaining the existing publisher/legal pages and `.nojekyll`. Do not copy build caches, toolchains, fixtures or test reports. Keep all application assets, native modules, workers, notices, maps and `build-manifest.json` together.

Published application input: `7cd9a1a4db75e8ee7c2453decdc2084e1134a9d508503bd965d8b2415c0ea893`.

Deployment identity: `4ebb309cb98d0f36344b6b522941a7efd3f53854661002ea378c74e04c49908a`.

## Demo data

The browser demo and tutorial use the same Bench reconstruction and authored
view as the desktop application: 5,124,962 bytes (5.1 MB), 262,556 splats.
The app owner identifies its source data as
[Mip-NeRF 360](https://jonbarron.info/mipnerf360/), by Jonathan T. Barron,
Ben Mildenhall, Dor Verbin, Pratul P. Srinivasan and Peter Hedman (CVPR 2022).
See the [sample provenance and authored view](examples/bench.json) and the
[distributed dataset attribution](licenses/Mip-NeRF-360-NOTICE.txt).
The underlying Mip-NeRF 360 dataset is licensed under
[Creative Commons Attribution 4.0 International](licenses/CC-BY-4.0.txt),
as declared in the official [SMERF dataset release](https://smerf-3d.github.io/#data)
and its [June 18, 2024 source commit](https://github.com/smerf-3d/smerf-3d.github.io/commit/f4fd7c9978164b2cd7eaa718fa19bc6ec62551e8).
Bench is the owner-supplied edited Gaussian reconstruction, encoded as SOG;
these are changes from the original dataset photographs. It is not an official
SMERF teacher checkpoint. The data license is separate from application and
software dependency licenses. The supplied notice credits the dataset authors,
identifies these changes and includes the license link and warranty disclaimer.
