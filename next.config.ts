import type { NextConfig } from "next"
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare/cloudflare-context"

// Gives `next dev` access to the Cloudflare bindings (D1) from wrangler.jsonc.
initOpenNextCloudflareForDev()

const nextConfig: NextConfig = {
  // Cloudflare (OpenNext) needs the default output; Docker builds set
  // NEXT_OUTPUT=standalone to keep the container image working.
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,
  experimental: {
    // Client Router Cache TTL for dynamic pages. Dashboard view switches are
    // searchParams navigations over the same D1 snapshot; caching the RSC
    // payload for 2 minutes makes revisits/tab flips instant. Mutations call
    // router.refresh(), which invalidates the cache, and "Refresh now" always
    // recomputes — so nothing user-visible goes stale past its action.
    staleTimes: {
      dynamic: 120,
      static: 300,
    },
  },
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
