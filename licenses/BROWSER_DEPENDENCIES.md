# Browser dependency notices

The browser application includes the following MIT-licensed packages. Versions
match the installed packages and the reviewed `package-lock.json`. Each linked
notice is an exact copy of that installed package's `LICENSE` file.

| Package | Version | Source package | License notice |
| --- | --- | --- | --- |
| React (`react`) | 19.3.0 | [npm archive](https://registry.npmjs.org/react/-/react-19.3.0.tgz) | [MIT](React-MIT.txt) |
| React DOM (`react-dom`) | 19.3.0 | [npm archive](https://registry.npmjs.org/react-dom/-/react-dom-19.3.0.tgz) | [MIT](React-DOM-MIT.txt) |
| Scheduler (`scheduler`) | 0.28.0 | [npm archive](https://registry.npmjs.org/scheduler/-/scheduler-0.28.0.tgz) | [MIT](Scheduler-MIT.txt) |
| Zustand (`zustand`) | 5.0.14 | [npm archive](https://registry.npmjs.org/zustand/-/zustand-5.0.14.tgz) | [MIT](Zustand-MIT.txt) |

React, React DOM and Scheduler are developed in the
[React repository](https://github.com/react/react). Zustand is developed in the
[Zustand repository](https://github.com/pmndrs/zustand).

Other bundled component and codec notices remain alongside these files in this
directory; icon attribution is provided in `../icons/LICENSE.txt`.

The opt-in SteadySplats renderer adapts PlayCanvas engine PR 9819 at commit
`12542cf99f2b2b23c7e84c6602f8b5e537e74e73`, including its STBN volume and
resampling shaders, under the [PlayCanvas MIT license](PlayCanvas-MIT.txt).

The bundled desktop tutorial scene uses source data credited to
[Mip-NeRF 360](Mip-NeRF-360-NOTICE.txt), licensed under
[Creative Commons Attribution 4.0 International (CC-BY-4.0)](https://creativecommons.org/licenses/by/4.0/).
The [full license text](CC-BY-4.0.txt) is bundled here. The owner-supplied edited
Gaussian-splat reconstruction is encoded as SOG and adapted from the original
photographs; its notice identifies the authors, source and changes. These
dataset terms are separate from the software package licenses above.
