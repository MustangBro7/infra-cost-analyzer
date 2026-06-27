# Indie Developer and Agent-Assisted Onboarding Strategy

Date: 2026-06-27

## Product stance

Ambrium should not assume cloud-provider setup is easy. For indie developers, the product should assume setup is annoying, provider-specific, and sometimes intimidating. The product advantage should be:

> Even when provider setup is hard, Ambrium gives the user and their coding agent a safe, guided path to complete it.

The CLI should remain central. The app should not only support manual setup; it should generate precise instructions that Codex, Claude Code, Cursor, or another local coding agent can execute or guide the user through.

## Target user promise

For an indie developer:

> Run one command, approve read-only access, and see what each project costs.

For an agent-assisted workflow:

> Ask your coding agent to connect Ambrium. It can run the CLI, inspect your local cloud tooling, prepare read-only credentials, and hand you only the approval steps that require your consent.

## Why this matters

Indie developers often have fragmented infrastructure:

- Vercel for frontend/apps.
- Cloudflare for Workers, Pages, DNS, R2, D1.
- AWS for experiments, S3, Lambda, SES, or forgotten resources.
- GCP for Firebase, BigQuery, or AI projects.
- OpenAI, Anthropic, Cursor, Claude Code, Codex, Copilot, or other AI tools.
- Niche providers like Railway, Render, Fly.io, Supabase, Neon, Upstash, Sentry, PostHog, and MotherDuck.

The value is not only cost reporting. The value is reducing the cognitive load of connecting all of this safely.

## Setup principle

Every connection path should have three modes:

1. **One-command mode**
   The user runs `npx ambrium connect`. The CLI detects local auth, pairs with the signed-in workspace, and completes whatever can be completed locally.

2. **Agent mode**
   The app and CLI generate an agent-readable setup spec. Codex/Claude Code can run commands, check local configuration, explain missing prerequisites, and help create read-only credentials.

3. **Manual mode**
   The user can still paste tokens or follow instructions when they prefer direct control.

The product should bias toward one-command and agent mode. Manual mode should be a fallback, not the main story.

## Agent mode design

Add a first-class "Connect with your coding agent" path.

The user should be able to copy a prompt like:

```text
Use the Ambrium CLI to connect this machine's cloud and AI provider accounts to my Ambrium workspace.

Rules:
- Only create or use read-only credentials.
- Never print secrets into chat.
- Prefer existing local CLI sessions where available.
- Ask me before opening provider dashboards or approving OAuth/IAM changes.
- After each provider, verify the connection and summarize what was connected.

Start with:
npx ambrium connect
```

The product should also expose a machine-readable setup spec at an endpoint like:

```text
GET /api/extend/spec
```

This already exists in the codebase. It should become a core public contract for coding agents.

The spec should include:

- supported providers;
- required local CLIs;
- exact commands;
- permission requirements;
- expected success signals;
- known provider limitations;
- safe handling rules for secrets;
- next action after each provider connects.

## CLI roadmap

The CLI should become the main onboarding product, not a hidden helper.

### Phase 1: Detect and explain

The CLI should detect:

- current Git repo and remote;
- GitHub auth status;
- `vercel` CLI auth;
- `wrangler` auth;
- `aws` CLI profiles and SSO sessions;
- `gcloud` auth and active project;
- local Claude Code / Codex / OpenAI / Cursor usage logs where available;
- common provider config files.

For each provider, show:

```text
Cloudflare
Status: wrangler login found
Can connect: yes
Permission needed: read account analytics, Workers, Pages, billing where available
Action: approve pairing in browser
```

### Phase 2: Guided connect

The CLI should connect providers in priority order:

1. GitHub repo/project identity.
2. Vercel and Cloudflare, because they are common for indie apps.
3. AI providers and local AI usage.
4. AWS/GCP if local CLI sessions exist.
5. Custom providers from detected config files.

Each provider should finish with:

- connected account label;
- what data Ambrium can read;
- what is unavailable;
- whether actual cost, usage only, or partial coverage is expected.

### Phase 3: Repair and refresh

The CLI should support:

```bash
ambrium doctor
ambrium connect --provider cloudflare
ambrium connect --provider aws --profile personal
ambrium refresh
ambrium status
```

`ambrium doctor` should be especially important. Indie users and coding agents need a clear way to fix broken setup.

## Provider setup UX

The app should not show a wall of credentials first. It should show a connection map:

```text
1. Identify projects
   GitHub connected: 6 repos

2. Connect common indie providers
   Vercel: ready to connect from local CLI
   Cloudflare: ready to connect from wrangler
   OpenAI: local usage found, API admin key optional

3. Optional advanced cloud billing
   AWS: CLI profile found, cost data requires read-only access
   GCP: gcloud found, detailed cost requires Billing Export
```

Each provider card should answer:

- What will Ambrium read?
- What cost/usage data will appear?
- What can the CLI or agent do automatically?
- What requires human approval?
- What will not work because of provider limitations?

## Human approval boundaries

Agent-assisted setup must be safe. The agent can prepare and verify, but the user should approve sensitive actions.

The agent can:

- run local detection commands;
- open provider auth URLs;
- generate read-only policy templates;
- create local files where appropriate;
- call Ambrium pairing endpoints;
- verify connection status;
- summarize what happened.

The user should approve:

- OAuth consent screens;
- GitHub App installation;
- creating IAM roles or service accounts;
- copying/pasting provider secrets when unavoidable;
- enabling paid APIs such as AWS Cost Explorer;
- adding billing exports.

The product should state this clearly so users trust the automation.

## Copy and positioning

Use phrases like:

- "Connect with one command."
- "Let your coding agent set this up safely."
- "Ambrium uses read-only access."
- "Your agent can prepare the setup; you approve access."
- "No provider writes, no infrastructure changes."
- "See what each project costs."

Avoid:

- "Enterprise onboarding."
- "FinOps setup."
- "Configure cost allocation dimensions."
- "Contact your cloud administrator."

## Indie-first onboarding flow

Recommended flow:

1. User signs in.
2. App shows two primary choices:
   - Run `npx ambrium connect`
   - Connect with coding agent
3. User runs CLI or copies agent prompt.
4. CLI pairs with browser session.
5. CLI detects providers and asks before each connection.
6. App updates live as providers connect.
7. First dashboard shows:
   - projects found;
   - providers connected;
   - cost coverage level;
   - free-tier runway;
   - old projects still costing money;
   - next best connection or fix.

## Implementation priorities

### P0

- Make CLI the default onboarding call-to-action.
- Add "Connect with coding agent" copy and prompt.
- Expand `/api/extend/spec` into a stable agent setup contract.
- Add `ambrium doctor` or equivalent diagnostics to the CLI.
- Add provider coverage statuses: cost live, usage only, partial, blocked.

### P1

- Add local provider detection for Vercel, Cloudflare, AWS, GCP, and AI tools.
- Add repair flows for broken credentials.
- Add progress streaming from CLI to app during pairing.
- Add provider-specific agent instructions.

### P2

- Add custom provider recipes for common indie tools.
- Add a public connector recipe library.
- Add agent-generated custom connector drafts from API docs.

## Success metrics

Track:

- time from sign-up to first connected provider;
- time from sign-up to first project cost;
- percentage of users who complete CLI pairing;
- percentage of users who use agent setup copy/spec;
- provider connection failure rate;
- `doctor` success rate after a failed setup;
- number of projects with cost or usage coverage;
- number of users who enable alerts after first dashboard.

## Strategic takeaway

Ambrium should not hide the complexity of provider setup by pretending it is simple. It should productize the complexity into a safe, agent-friendly setup system.

The best indie product experience is:

> I ask my coding agent to connect Ambrium, approve a few read-only access steps, and then Ambrium shows what every project is costing me.
