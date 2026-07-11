export type AiAgentRecoveryKind = "not-running" | "pairing-expired" | "continuous-off" | "upload-failed"

export interface AiAgentRecovery {
  kind: AiAgentRecoveryKind
  title: string
  detail: string
  showPairCommand: boolean
}

const AUTH_FAILURE = /(?:401|403|unauthori[sz]ed|forbidden|token|credential|pair(?:ing)?|expired)/i

/** Converts the local agent's low-level failure into an actionable dashboard diagnosis. */
export function diagnoseAiAgent(input: {
  reachable: boolean
  autoSync?: boolean | null
  error?: string | null
}): AiAgentRecovery | null {
  if (!input.reachable) {
    return {
      kind: "not-running",
      title: "The background sync job is not responding.",
      detail: "It is stopped, unloaded, not installed on this device, or blocked by the browser's local-network permission.",
      showPairCommand: false,
    }
  }
  if (input.error && AUTH_FAILURE.test(input.error)) {
    return {
      kind: "pairing-expired",
      title: "The agent is running, but its saved pairing no longer works.",
      detail: input.error,
      showPairCommand: true,
    }
  }
  if (input.autoSync === false) {
    return {
      kind: "continuous-off",
      title: "The agent is running, but continuous updates are turned off.",
      detail: "Reinstall the background job below to keep it running and checking every minute.",
      showPairCommand: false,
    }
  }
  if (input.error) {
    return {
      kind: "upload-failed",
      title: "The agent is running, but its latest upload failed.",
      detail: input.error,
      showPairCommand: false,
    }
  }
  return null
}

export function aiAgentCommands(origin: string) {
  const runner = "npx --yes github:MustangBro7/infra-cost-analyzer"
  const pair = `AMBRIUM_API=${origin} ${runner} --ai-only`
  const serve = `AMBRIUM_API=${origin} ${runner} serve`
  const macInstall = `NPX="$(command -v npx)"; ND="$(dirname "$(command -v node)")"; P="$HOME/Library/LaunchAgents/io.ambrium.ai-usage.plist"; mkdir -p "$HOME/Library/LaunchAgents"; cat > "$P" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>io.ambrium.ai-usage</string>
<key>EnvironmentVariables</key><dict><key>AMBRIUM_API</key><string>${origin}</string><key>PATH</key><string>$ND:/usr/bin:/bin</string></dict>
<key>ProgramArguments</key><array><string>$NPX</string><string>--yes</string><string>github:MustangBro7/infra-cost-analyzer</string><string>serve</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>/tmp/ambrium-ai-usage.log</string><key>StandardErrorPath</key><string>/tmp/ambrium-ai-usage.log</string>
</dict></plist>
EOF
launchctl unload "$P" 2>/dev/null || true; launchctl load "$P" && echo "Ambrium continuous AI sync installed"`
  const linuxInstall = `NPX="$(command -v npx)"; ND="$(dirname "$(command -v node)")"; P="$HOME/.config/systemd/user/ambrium-ai-usage.service"; mkdir -p "$HOME/.config/systemd/user"; cat > "$P" <<EOF
[Unit]
Description=Ambrium continuous AI usage sync
After=network-online.target

[Service]
Type=simple
Environment=AMBRIUM_API=${origin}
Environment=PATH=$ND:/usr/local/bin:/usr/bin:/bin
ExecStart=$NPX --yes github:MustangBro7/infra-cost-analyzer serve
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload && systemctl --user enable --now ambrium-ai-usage.service && echo "Ambrium continuous AI sync installed"`

  return { pair, serve, macInstall, linuxInstall }
}
