# Color/Fill Range implementation references

The browser adapts SplatView **1.0.2**, commit `4e1be155511fb49f08fd8c863d785ac008a4c43a`, from the pinned `.build/current-desktop-chrome-tests/desktop-source` checkout. The original desktop source licenses and notices continue to apply.

| Desktop input | SHA-256 | Behavior adapted |
| --- | --- | --- |
| `src/selection_ui.cpp` | `4ca42d85710ed6d216236b37636be3c80d65bb9c0d36661174daa0ee434fddc1` | Range sphere option and conditional logarithmic Radius row; six-digit display; panel/canvas overlay policy. |
| `src/viewer_selection.cpp` | `66196cd6bf505aae0ea2229f66b73eecd6527264a57f65f57817d30a4b9ec1fa` | Independent per-tool preferences, sampled radius bounds/default, immutable click center, same-pick amendments and feedback ownership. |
| `src/selection.cpp` | `4f00773a23b68183ecca1eae0b9e51bfa3aac73f7a8a1702e14e595b8e69cfac` | Native center squared distances rounded to float32 after double accumulation. |
| `src/editing.cpp` | `8913f0ecb49c25c53210ead1525e6176c68a5291f7ebe5068147390e662286b2` | Inclusive float32 squared-radius threshold; Range before Combine against the original baseline. |
| `src/viewport_drawing.cpp` | `a48fb374ba25b65198a7ced8a55f959cce758e5a3e077056bcfa0e8486d76c73` | Three great circles of 64 segments each. |
| `src/translations.inc` | `ac3f88336d930a838f3180e1fe74a018137902bf1f2c2afd9e491ac76f90a4c2` | Range, Radius and tooltip in English plus seven translated locales, rows329-331. |

The web implementation freezes the native Color contributor center or the press-time Fill depth-surface sample, intersects sphere hits before Combine, and retains the original click checkpoint for amendments. Metadata-only changes acknowledge Range without fabricating a selection notification or Undo item. The browser computes center distances inline rather than retaining a per-record float distance cache.

The Radius control uses the existing sampled morphology statistics, half its maximum, and a freshly calculated geometric-mean default. Raw per-tool preferences survive profile/source changes; only the effective command radius is clamped and quantized. The current statistics clamp is not an extra protocol radius limit.

Browser adaptations: Radius drag/key/numeric input publishes selection work at settlement; local sphere feedback remains cheap during input. The 192-segment sphere appears over Tools for the acknowledged pick. Continuous next-pick hover sampling is omitted, so the retained sphere is hidden on the canvas. Native Fill remains synchronous within the retained limited-scene scope; this feature makes no cooperative flood or measured-capacity claim. Recovery preserves accepted selection/history and viewer preferences while dropping transient pick/map/Range-center ownership; another click is required.

The additive `colorFillRange:1` capability keeps core ABI24, protocol28, UI contract23, camera ABI4, receipt2 and checkpoint codec3 unchanged. Receipt2 does not bind Range by itself: worker, client and controller validate captured requests, accepted owners, commit and rollback metadata independently. No PlayCanvas code was added by this feature. Existing project attributions remain in their respective reference records.

Validation passed: 5,960 CPU tests in 180 files, 102 production-browser cases in one complete run, 13 executed native module suites, and 90 Python verification checks; one existing host-dependent filesystem probe was skipped. [Validation record](../validation/runs/color-fill-range-web-20261016-01/validation.json).
