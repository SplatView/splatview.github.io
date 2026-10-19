# SplatView web and publisher pages

Public privacy information, license terms and support links for SplatView, published by OpsiClear LLC. The app source is maintained separately in a private repository.

GitHub Pages: https://splatview.github.io/

Publish from the `main` branch and `/` root. Keep the plain-text legal documents and their HTML pages synchronized with the released application. The publisher and legal pages use no JavaScript, cookies, external fonts or application analytics. The browser application uses JavaScript, WebAssembly, WebGPU and browser-local storage. GitHub handles web hosting under its own privacy policies.

## Browser application

The root serves the Basic SplatView browser viewer and lightweight editor over HTTPS. Selected scene files are processed locally in the browser. WebGPU is required. The previous desktop publisher homepage is retained at [/publisher/](https://splatview.github.io/publisher/); existing privacy and license URLs remain unchanged.

This repository contains the emitted static site. Publish the complete verified `dist` closure from the application workspace, retaining the existing publisher/legal pages and `.nojekyll`. Do not copy build caches, toolchains, fixtures or test reports. Keep all application assets, native modules, workers, notices, maps and `build-manifest.json` together.

Published application input: `9df66f670600481add5f211691b624cbafbe25648d47c7cc101850b54f8cf8da`.

Deployment identity: `375b238cfd855e5dc739a43846c430ac6e3b3662f1f23cecabf43d45ccbcca1e`.

## Demo data

The browser demo and tutorial use the same Bench reconstruction and authored
view as the desktop application: 5,124,962 bytes (5.1 MB), 262,556 splats.
The app owner identifies its source data as
[Mip-NeRF 360](https://jonbarron.info/mipnerf360/), by Jonathan T. Barron,
Ben Mildenhall, Dor Verbin, Pratul P. Srinivasan and Peter Hedman (CVPR 2022).
See the [sample provenance and authored view](examples/bench.json) and the
[distributed dataset attribution](licenses/Mip-NeRF-360-NOTICE.txt).
Data and model rights are separate from application and dependency licenses;
this attribution assigns no new license to the dataset or reconstruction.
