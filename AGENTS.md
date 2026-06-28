# AGENTS.md

Guidance for AI coding agents working in this repo.

## Verify UI/behavior changes in the running app before marking work done

This app's real surface — `/dashboard` and most API routes — is normally gated by
**Clerk auth + a Postgres/Hyperdrive connection**, so you can't just `npm run dev`
and load a page. To remove that friction there is a **local preview mode** that
serves a fixed demo user and a fully-seeded workspace with **no auth and no
database**. Use it to actually run the app and observe your change.

**This is a hard requirement: do not mark a UI or dashboard-behavior task
"done" until you have run it in preview mode and observed the result (a
screenshot or scripted DOM assertion), not just `tsc`/`build`/tests passing.**
Typecheck and build prove it compiles; they do not prove the screen renders or
the interaction works.

### Run it

```bash
npm run dev:preview      # == AMBRIUM_DEV_PREVIEW=1 next dev
# then open http://localhost:3000/dashboard  (no sign-in)
```

`AMBRIUM_DEV_PREVIEW=1` is honored **only in development** (`NODE_ENV !==
"production"`), so it can never leak into a real deploy.

All views render with realistic data:
`/dashboard` (Projects), `?view=limits`, `?view=leaks`, `?view=ai`,
`?view=insights`, `?view=connect`, and repo drill-down `?repo=sam/clip-anywhere`.

Preview mode is **read-only**: page reads come from the fixture; mutations
(assign cost, connect provider, refresh) still call real APIs and won't persist.

### How it works (where to extend the seed)

- `src/lib/devPreview.ts` — `isDevPreview()`, the demo `LocalUser`, the seeded
  `WorkspaceStore` (repos, connections, cost rows, free-tier usage, snapshots),
  sparkline trends, and seeded historical analytics. **Edit the fixtures here**
  if your feature needs new data shapes to be visible.
- Hooks that consult `isDevPreview()`:
  - `src/lib/localAuth.ts` → `resolveCurrentUser()` returns the demo user.
  - `src/lib/localStore.ts` → `readWorkspace()` / `getUserById()` return the seed.
  - `src/lib/analysisService.ts` → `getOrCreateAnalysisSnapshot()` returns the seeded snapshot.
  - `src/lib/analytics/queries.ts` → `getMonthlyTotalsByRepo()` / `getAnalyticsDashboard()` return seeded history.
  - `src/middleware.ts` → bypasses Clerk auth (inlined env check).

### Driving it headlessly (no Playwright/Puppeteer needed)

Node 21+ ships a global `WebSocket`, so you can drive headless Chrome over CDP
directly. Pattern: launch Chrome with `--headless=new --remote-debugging-port=PORT`,
read `http://localhost:PORT/json/version` for the WS URL, then
`Target.createTarget` → `Target.attachToTarget` → `Page.navigate` /
`Runtime.evaluate` / `Page.captureScreenshot`. Navigate to each `?view=` URL,
assert on `document.querySelectorAll(...)`, and screenshot. (Chrome path on
macOS: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`.)

## Standard checks

`npm run check` (tsc) · `npm test` · `npm run build`. The combined gate is
`npm run verify`. Run these **in addition to** the preview observation above —
never as a substitute for it.
