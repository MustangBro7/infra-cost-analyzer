import { NextRequest, NextResponse } from "next/server"
import { appUrl } from "@/lib/appUrl"
import { createDodoCheckout, dodoConfig } from "@/lib/dodoBilling"
import { AuthRequiredError, requireUserFromRequest } from "@/lib/localAuth"
import { startBillingCheckout } from "@/lib/localStore"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: NextRequest) {
  try {
    const user = await requireUserFromRequest(request)
    const config = await dodoConfig()
    if (!config) {
      return NextResponse.json(
        { error: "Dodo billing is not configured. Set DODO_PAYMENTS_API_KEY and DODO_INDIE_PRODUCT_ID." },
        { status: 503 }
      )
    }

    const origin = request.nextUrl.origin
    const checkout = await createDodoCheckout({
      config,
      user,
      returnUrl: appUrl("/dashboard?billing=success", origin).toString(),
      cancelUrl: appUrl("/pricing?billing=cancelled", origin).toString(),
    })
    await startBillingCheckout(user.id, {
      checkoutSessionId: checkout.sessionId,
      productId: config.productId,
    })
    return NextResponse.json({ checkoutUrl: checkout.checkoutUrl })
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      return NextResponse.json({ error: error.message }, { status: 401 })
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to start checkout." },
      { status: 500 }
    )
  }
}
