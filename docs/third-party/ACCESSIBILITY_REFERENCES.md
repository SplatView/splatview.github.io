# Accessibility references

The web viewer keeps the desktop SplatView layout and controls. Browser-specific accessibility behavior was designed using these primary references:

- [W3C: Understanding status messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html): a persistent polite status region describes stable scene state without moving focus. Transient previews and numeric progress do not repeatedly announce selection counts. Existing errors retain their alert owner.
- [W3C: Understanding reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html): controls and dialogs remain reachable at narrow effective viewport sizes. The visual scene still requires a two-dimensional canvas.
- [Playwright: Chrome extensions](https://playwright.dev/docs/chrome-extensions): test-only extension loading uses a fresh persistent Chromium context.
- [Chrome extensions: tabs.setZoom](https://developer.chrome.com/docs/extensions/reference/api/tabs#method-setZoom): the browser qualification fixture changes and verifies actual tab zoom through `setZoom` and `getZoom`.

These are design and API references; no third-party implementation was copied for this packet. The test extension is not included in the deployed app. Automated DOM and keyboard checks establish application behavior, not observed screen-reader speech or full WCAG conformance. Nonvisual exploration of arbitrary 3D scene geometry needs additional interaction design.

Build and deployment hygiene remain governed by the existing build manifest: only current runtime assets and the explicitly retained debug maps belong in `dist`. Historical diagnostics and qualification fixtures stay outside deployment.
