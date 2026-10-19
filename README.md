# SplatView web and publisher pages

Public privacy information, license terms and support links for SplatView, published by OpsiClear LLC. The app source is maintained separately in a private repository.

GitHub Pages: https://splatview.github.io/

Publish from the `main` branch and `/` root. Keep the plain-text legal documents and their HTML pages synchronized with the released application. The publisher and legal pages use no JavaScript, cookies, external fonts or application analytics. The browser application uses JavaScript, WebAssembly, WebGPU and browser-local storage. GitHub handles web hosting under its own privacy policies.

## Browser application

The root serves the Basic SplatView browser viewer and lightweight editor over HTTPS. Selected scene files are processed locally in the browser. WebGPU is required. The previous desktop publisher homepage is retained at [/publisher/](https://splatview.github.io/publisher/); existing privacy and license URLs remain unchanged.

This repository contains the emitted static site. Publish the complete verified `dist` closure from the application workspace, retaining the existing publisher/legal pages and `.nojekyll`. Do not copy build caches, toolchains, fixtures or test reports. Keep all application assets, native modules, workers, notices, maps and `build-manifest.json` together.

Published application input: `6232ff00fcd17355a90acc5ac658ff0206a06c3dab1080569c8427f95da3fac7`.

Deployment identity: `7e386a6544a4b91f4fa5507a838483c2f9c059375bcdd0dbbcaf9517ff63f035`.
