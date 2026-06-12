import type { NextConfig } from "next"
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare"

// Gives `next dev` access to the Cloudflare bindings (D1) from wrangler.jsonc.
initOpenNextCloudflareForDev()

const nextConfig: NextConfig = {
  // Cloudflare (OpenNext) needs the default output; Docker builds set
  // NEXT_OUTPUT=standalone to keep the container image working.
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,
  serverExternalPackages: [],
}

export default nextConfig
