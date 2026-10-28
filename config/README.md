# Tool configurations

Run commands from the repository root; the configs declare their repository,
test, output and server paths explicitly.

| Configuration | Purpose / command |
| --- | --- |
| `playwright.config.ts` | Full browser inventory: `npm run test:e2e`. |
| `playwright.ci.config.ts` | UI-only Chromium smoke: `npm run test:ci`. |
| `playwright.selection.config.ts` | Selection/GPU cohort: `npm run test:selection:e2e`. |
| `playwright.engine.config.ts` | Standalone renderer: `npm run test:engine`. |
| `playwright.compat.config.ts` | Production compatibility: `npx playwright test --config config/playwright.compat.config.ts`. |
| `playwright.offline.config.ts` | Offline lifecycle cohort: `npx playwright test --config config/playwright.offline.config.ts`; prepare genuine fixtures and their host first. |
| `vite.engine.config.ts`, `tsconfig.engine.json` | Standalone bundle/declarations: `npm run build:engine`. |

The primary application Vite and TypeScript configs stay at the root for default
CLI/editor discovery. Browser profiles retain their original projects, timeouts,
one-worker retirement and trace/evidence locations under `.build/validation/`.
See the [workflow guide](../docs/development/automation.md) for scope and hardware
qualification, and [release tooling](../tools/release/README.md) for strict fixture
capture/acceptance. No fixture receipt is relocated or rewritten by these configs.
