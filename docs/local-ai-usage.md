# Local AI usage — keeping it fresh automatically

Flat personal AI plans (Claude Pro/Max, ChatGPT Plus/Pro) expose no cost API, so
Ambrium reads usage from your **local** Claude Code (`~/.claude/projects`) and
Codex (`~/.codex/sessions`) logs via the companion CLI and pushes it up.

Two halves keep it current:

1. **Server + UI:** each local push is persisted in D1. While the AI page is
   visible it polls a lightweight revision endpoint every 15 seconds and
   re-renders only when that revision changes. The server cron still rebuilds
   full provider snapshots independently.
2. **Local side (re-read fresh numbers):** Cloudflare cannot see your disk, so an
   always-on loopback agent checks Claude Code / Codex logs every minute. It
   pushes at startup and whenever the collected payload changes. Pairing is
   saved to `~/.ambrium/credentials.json` (0600) and reused for 30 days, so the
   agent needs **no browser approval** after setup:

   ```
   AMBRIUM_API=https://ambrium.io npx --yes github:MustangBro7/infra-cost-analyzer serve
   ```

Opening the AI page also asks a reachable loopback agent for an immediate sync,
so the first screen does not wait for the next one-minute check.

If that check fails, the AI page probes the agent status and explains whether
the background job is not responding, continuous mode is off, the saved pairing
was rejected, or the upload itself failed. The recovery card repeats complete
copy-paste installer that detects macOS launchd or Linux systemd, validates the
generated job, starts it, and verifies it before reporting success, plus a re-pair command
when the credential is the problem. Commands use the current dashboard origin,
so staging recovery stays pointed at staging.

## Schedule it on macOS (launchd)

The verified installer above writes
`~/Library/LaunchAgents/io.ambrium.ai-usage.plist`, validates it with `plutil`,
then uses `launchctl bootstrap` and `kickstart` in the current GUI domain. The
job runs at login and is kept alive. Its generated plist is equivalent to:

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
    <string>npx --yes github:MustangBro7/infra-cost-analyzer serve</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>/tmp/ambrium-ai-usage.log</string>
  <key>StandardErrorPath</key><string>/tmp/ambrium-ai-usage.log</string>
</dict>
</plist>
```

## Run it on Linux (systemd user service)

Create `~/.config/systemd/user/ambrium-ai-usage.service` with an `ExecStart`
that runs the `serve` command above, set `Restart=always`, then enable it with
`systemctl --user enable --now ambrium-ai-usage.service`. The Connect page
generates a copy-paste installer with the correct `npx` and Node paths.

Re-pair (run the CLI once interactively) if the saved token expires after 30 days.

The recommended installer/repair command is:

```
AMBRIUM_API=https://ambrium.io npx --yes github:MustangBro7/infra-cost-analyzer install-agent
```

Claude limits are fetched separately from token logs and Anthropic can
occasionally rate-limit that request. A token sync with no fresh limit response
keeps the last valid windows until each reset time rather than blanking the
dashboard; expired windows are never carried forward.

## On-demand pulls from the dashboard ("Pull from this device")

The AI page has a **Sync this device now** button. It talks to the local
agent on `127.0.0.1:41414` that reads your logs and pushes them with its saved
pairing token. The page invokes this once automatically when it opens (unless
the server was updated in the last 15 seconds), and the button remains as an
explicit retry:

```
AMBRIUM_API=https://ambrium.io npx --yes github:MustangBro7/infra-cost-analyzer serve
```

Keep it running and the button works whenever you're browsing from that machine.
The agent binds loopback only, answers CORS only for the Ambrium origins, and
never returns usage data to the browser — `POST /v1/refresh` makes the agent
itself push to your account, identical to `--ai-only`.
