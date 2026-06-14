import type { Provider } from "./types"

// The providers we can connect a billing account for (others can't be "accounts"
// a repo links to).
export const CONNECTABLE_PROVIDERS: Provider[] = ["aws", "vercel", "cloudflare", "gcp"]

/**
 * Resolves which connected provider accounts a repo uses for cost. An explicit
 * link (the user's pick) wins, intersected with what's actually connected.
 * Otherwise the repo defaults to the connected providers its scan detected — so
 * a freshly registered repo links to what it obviously uses, and the user can
 * still adjust. May be empty (then the UI prompts the user to pick/connect).
 */
export function resolveLinkedProviders(input: {
  explicit?: Provider[] | null
  detected: Provider[]
  connected: Provider[]
}): Provider[] {
  const connected = new Set(input.connected)
  if (input.explicit && input.explicit.length > 0) {
    return input.explicit.filter((provider) => connected.has(provider))
  }
  return [...new Set(input.detected)].filter((provider) => connected.has(provider))
}
