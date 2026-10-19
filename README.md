# SplatView web and publisher pages

Public privacy information, license terms and support links for SplatView, published by OpsiClear LLC. The app source is maintained separately in a private repository.

GitHub Pages: https://splatview.github.io/

Publish from the `main` branch and `/` root. Keep the plain-text legal documents and their HTML pages synchronized with the released application. The publisher and legal pages use no JavaScript, cookies, external fonts or application analytics. The browser application uses JavaScript, WebAssembly, WebGPU and browser-local storage. GitHub handles web hosting under its own privacy policies.

## Browser application

The root serves the Basic SplatView browser viewer and lightweight editor over HTTPS. Selected scene files are processed locally in the browser. WebGPU is required. The previous desktop publisher homepage is retained at [/publisher/](https://splatview.github.io/publisher/); existing privacy and license URLs remain unchanged.

This repository contains the emitted static site. Publish the complete verified `dist` closure from the application workspace, retaining the existing publisher/legal pages and `.nojekyll`. Do not copy build caches, toolchains, fixtures or test reports. Keep all application assets, native modules, workers, notices, maps and `build-manifest.json` together.

Published application input: `5cafe5032b182dc92ce9fc414df2a1d22ff90285341d4a8f0e346505327b08e3`.

Deployment identity: `5885f7e52d0d1ba5ddeecf8ea7ccd2ef8100576092230321295ee4ffed1f8fff`.
