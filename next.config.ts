import type { NextConfig } from "next"
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare"

// Gives `next dev` access to the Cloudflare bindings (D1) from wrangler.jsonc.
initOpenNextCloudflareForDev()

const nextConfig: NextConfig = {
  // Cloudflare (OpenNext) needs the default output; Docker builds set
  // NEXT_OUTPUT=standalone to keep the container image working.
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,
  serverExternalPackages: [],
  // Next's file tracer otherwise copies only pg-cloudflare's Node fallback.
  // OpenNext bundles with the `workerd` condition and needs these socket files.
  outputFileTracingIncludes: {
    "**/*": [
      "./node_modules/pg-cloudflare/dist/**",
      "./node_modules/pg-cloudflare/esm/**",
    ],
  },
}

export default nextConfig
