import { NextResponse } from "next/server"
import { PROVIDERS } from "@/lib/providerCatalog"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  return NextResponse.json({
    providers: Object.values(PROVIDERS).map((provider) => ({
      ...provider,
      configured: provider.requiredSecrets.every((secret) => Boolean(process.env[secret])),
    })),
  })
}
