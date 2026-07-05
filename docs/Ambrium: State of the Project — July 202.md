Ambrium: State of the Project — July 2026

TL;DR

Ambrium is in genuinely good shape as an engineering artifact: clean typecheck, 114/114 tests passing, a solid normalized data model, encrypted credential storage, a real deploy pipeline, staging environment, and an unusually honest treatment of provider API limitations. Its differentiators — repo-level cost attribution, free-tier headroom tracking, first-class AI-tool spend, and the declarative custom-provider engine — are real and rare.

The gap is that it's still a dashboard you have to visit, not a product that works for you. The three highest-leverage things missing are: (1) alerts/anomaly detection delivered to email or Slack — zero code exists for this today, (2) a first-value onboarding path for new production users (the seeded demo workspace exists but only in dev preview mode), and (3) plan enforcement — you charge $5/month via Dodo, but nothing in the code actually gates the free tier, so there's currently no reason to pay. There's also a launch blocker hiding in plain sight: Clerk is still on a dev instance in production.

---
1. What the product is (purpose)

Ambrium ("Cloud cost, mapped to your code") is a personal cost cockpit for indie developers and small teams. The core question it answers: "Across GitHub, Vercel, Cloudflare, AWS, GCP, and my AI tools — what is each of my projects costing me right now, and where's the next surprise bill coming from?"

It's deliberately project-first, not account-first — indie devs think in repos and free tiers, not cost centers. That positioning is the right wedge: enterprise FinOps tools (CloudZero, Vantage, Finout) ignore this user, native cloud tools can't cross providers, and nobody treats AI subscription/API spend as first-class.

2. Current state — what's actually built

Architecture (all verified working):
- Next.js 16 / React 19 on Cloudflare Workers via OpenNext, served at ambrium.io; Clerk auth; D1 as the app store (per-user scoped, tokens encrypted with APP_ENCRYPTION_KEY); MotherDuck via Hyperdrive for historical analytics; a separate cron Worker refreshing free-tier data every 6h; GitHub Actions auto-deploy.
- A companion CLI (npx ambrium connect) with RFC 8628 device-code pairing, designed so a coding agent can complete provider setup — this is a genuinely novel onboarding idea.

Integrations: GitHub App, Vercel (OAuth + token), AWS (one-click cross-account role via your SaaS principal), GCP (BigQuery billing export), Cloudflare (GraphQL analytics), MotherDuck, Anthropic/OpenAI/Cursor org APIs, local AI usage detection, and the custom HTTP provider engine (/api/extend/spec). Azure/DigitalOcean/Docker are signal-detected but not live-billed.

Product surfaces: six dashboard views (Projects, Limits, Leaks with the unassigned-cost queue, AI, Insights with 12-month history, Connect), repo drill-downs, drag-to-arrange widgets, date-range filtering, a single monthly budget with a forecast that now correctly counts flat subscriptions once instead of run-rating them.

Engineering health: tsc clean, 114/114 tests, 25 test files covering the core engines, a dev-preview mode with seeded fixtures, hard-won durability guards in the D1 store (post-data-loss), and month-boundary leak guards in range filtering. For a 127-commit solo project this is disciplined work.

Progress since the June 27 gap report: date-range filtering + month-boundary fixes, the subscription-aware forecast, staging replica environment, AI usage deep dives, connect-page tabs, and lots of UI polish. The unassigned-cost queue (a P0 from that report) shipped just before it.

3. Where the real gaps are

🔴 Gap 1: No alerting of any kind — the product only works if you open it

I grepped the entire codebase: there is zero Slack, email, notification, or anomaly-detection code. This was the report's top competitive gap a week ago and it's still fully open. A cost-surprise product that requires you to check a dashboard is structurally unable to deliver its core promise — the surprise bill lands precisely on the day you didn't look. Everything needed already exists: the cron worker ticks every 6h, snapshots are persisted, and MotherDuck has the history to baseline against.

🔴 Gap 2: Billing exists but the paywall doesn't

Dodo checkout, webhooks, and subscription state are all wired into D1 — but I found no enforcement anywhere of the free plan's advertised limits (2 projects, 2 providers, monthly refresh). Free users currently get everything Indie users get. This isn't just lost revenue; it means you have no signal about willingness to pay.

🔴 Gap 3: New production users hit a cold, empty, setup-heavy first screen

The excellent seeded demo workspace (devPreview.ts) is dev-only. A real sign-up faces: GitHub App authorization → provider tokens → refresh wait, before seeing a single number. The report called for a sample workspace and a guided checklist; neither shipped. You already built 90% of the demo — it just needs to be reachable in prod as a "explore with sample data" mode.

🔴 Launch blocker: Clerk prod instance

Per your own notes, production Clerk is still the dev instance. Everything else (custom domains, secrets, deploy pipeline) is production-ready; this is the odd one out.

🟡 Technical debt worth watching

- src/app/dashboard/page.tsx is 2,844 lines and renders all six views. Every feature touches this file; it's the biggest velocity tax in the codebase. Splitting each view into its own component/route segment would pay for itself within a few features.
- localStore.ts (1,844 lines) mixes D1 persistence, migration, encryption, and workspace logic — second candidate for a split.
- Budget model is a single monthlyBudgetUsd scalar on the workspace; scoped budgets will require a schema change, so worth doing before the alerting work that consumes it.
- No e2e/UI regression tests — AGENTS.md mandates manual preview verification, but nothing runs in CI.

4. Recommended roadmap (sequenced by leverage)

Now — the "it pays and it pings" milestone (~2–3 weeks of work)

1. Alerts v1: email digests + threshold alerts. Weekly digest (spend by project, movers, free-tier runway) + immediate alerts for budget thresholds (50/80/100%, forecast-over) and free-tier ≥80%. Cloudflare Email Service keeps this in-stack with no third party. Hook it into the existing cron refresh — anomaly detection can start as dumb-but-honest rules ("provider X is up >40% vs. 7-day baseline" from MotherDuck history) before anything statistical.
2. Enforce plan limits. Gate project count, provider count, and refresh cadence on billingSubscription.plan, with upgrade prompts at the limits. Alerts land as the Indie-only carrot, giving the $5 plan a reason to exist the same week.
3. Prod Clerk + sample workspace for new sign-ups. Ship the demo fixture as a first-run experience with a persistent "connect your real data" checklist (repo connected → provider connected → first refresh → first attribution).

Next — deepen the differentiators (month 2)

4. "Why did this change?" drill-down. You already store deployments, workflow signals, and daily history — correlate spend deltas with recent deploys/commits ("Workers requests +42% after sam/clip-anywhere deploy on Jun 30"). No competitor does this repo-natively; it's your moat, and most of the data plumbing exists.
5. Scoped budgets (per repo, per provider, per AI category) replacing the single scalar — this multiplies the value of the alerting you just built.
6. Custom-provider template library. The declarative connector engine is your fastest route to coverage. Ship 8–10 pre-filled specs (Railway, Render, Fly.io, Supabase, Neon, Upstash, PlanetScale, Sentry, PostHog) as one-click templates — each is just a JSON definition, hours not weeks, and it's marketing material ("we cover the entire indie stack").
7. Split dashboard/page.tsx into per-view modules while doing #4–5, since they all touch it anyway.

Later — expand the wedge (month 3+)

8. PR cost comments (Infracost-style GitHub check for Terraform/workflow changes) — turns Ambrium from after-the-fact into shift-left, and the GitHub App is already installed on user repos.
9. AI spend recommendations — "your API usage this month would cost less on a Max subscription" / model-mix waste. You're uniquely positioned; nobody else has subscriptions + API + local usage in one place.
10. Slack alerting, CSV export, scheduled reports — table stakes once small teams (vs. solo devs) show up.

Explicitly deprioritize

Kubernetes/OpenCost, RBAC/SSO, team dimensions, and optimization/rightsizing engines. They're enterprise-gravity features that pull against the indie positioning, and the competitor report's own conclusion supports skipping them until the core loop (see → get pinged → fix) exists.

---
The one-sentence thesis: the codebase has already earned the right to stop building visibility and start building the loop — detection → notification → monetization — and almost all the raw material (cron, history, snapshots, billing state) is already sitting there waiting to be connected.

Want me to start on any of these? The alerting v1 + plan enforcement pair is the one I'd pick first — happy to plan the implementation in detail.