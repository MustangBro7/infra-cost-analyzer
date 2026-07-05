# Local AI usage — keeping it fresh automatically

Flat personal AI plans (Claude Pro/Max, ChatGPT Plus/Pro) expose no cost API, so
Ambrium reads usage from your **local** Claude Code (`~/.claude/projects`) and
Codex (`~/.codex/sessions`) logs via the companion CLI and pushes it up.

Two halves keep it current:

1. **Server side (already wired):** Ambrium's cron Worker refreshes every ~6h and
   re-renders your last-pushed local usage into the dashboard snapshot — so the
   numbers never disappear between pushes. Nothing to set up.
2. **Local side (re-read fresh numbers):** the CLI must re-run on your machine to
   pick up new tokens, because Cloudflare can't see your disk. Pairing is saved to
   `~/.ambrium/credentials.json` (0600) and reused for 30 days, so scheduled runs
   need **no browser approval**. Use the lightweight usage-only mode:

   ```
   AMBRIUM_API=https://ambrium.io npx --yes github:MustangBro7/infra-cost-analyzer --ai-only
   ```

## Schedule it on macOS (launchd)

Save as `~/Library/LaunchAgents/io.ambrium.ai-usage.plist` (runs at login and
every 6 hours), then `launchctl load ~/Library/LaunchAgents/io.ambrium.ai-usage.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>io.ambrium.ai-usage</string>
  <key>EnvironmentVariables</key>
  <dict><key>AMBRIUM_API</key><string>https://ambrium.io</string></dict>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string><string>-lc</string>
    <string>npx --yes github:MustangBro7/infra-cost-analyzer --ai-only</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>21600</integer>
  <key>StandardOutPath</key><string>/tmp/ambrium-ai-usage.log</string>
  <key>StandardErrorPath</key><string>/tmp/ambrium-ai-usage.log</string>
</dict>
</plist>
```

## Schedule it on Linux (crontab)

```
0 */6 * * * AMBRIUM_API=https://ambrium.io npx --yes github:MustangBro7/infra-cost-analyzer --ai-only >> /tmp/ambrium-ai-usage.log 2>&1
```

Re-pair (run the CLI once interactively) if the saved token expires after 30 days.

## On-demand pulls from the dashboard ("Pull from this device")

The AI page has a **Pull from this device** button. It talks to a small local
agent on `127.0.0.1:41414` that reads your logs and pushes them with its saved
pairing token — so a pull is one click instead of a terminal round-trip:

```
AMBRIUM_API=https://ambrium.io npx --yes github:MustangBro7/infra-cost-analyzer serve
```

Keep it running (or swap the launchd/cron command above for `serve` with
`KeepAlive`) and the button works whenever you're browsing from that machine.
The agent binds loopback only, answers CORS only for the Ambrium origins, and
never returns usage data to the browser — `POST /v1/refresh` makes the agent
itself push to your account, identical to `--ai-only`.
