import { NextRequest, NextResponse } from "next/server"
import { dodoRuntimeEnv, parseDodoWebhook, verifyDodoWebhook } from "@/lib/dodoBilling"
import { markBillingWebhookProcessed, upsertBillingSubscription } from "@/lib/localStore"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: NextRequest) {
  const body = await request.text()
  const webhookId = request.headers.get("webhook-id") ?? ""
  const env = await dodoRuntimeEnv()

  if (!verifyDodoWebhook({ body, headers: request.headers, secret: env.DODO_PAYMENTS_WEBHOOK_KEY })) {
    return NextResponse.json({ error: "Invalid webhook signature." }, { status: 401 })
  }

  if (webhookId && !(await markBillingWebhookProcessed(webhookId))) {
    return NextResponse.json({ received: true, duplicate: true })
  }

  try {
    const event = parseDodoWebhook(body)
    if (!event.userId) {
      return NextResponse.json({ received: true, ignored: "missing user_id metadata" })
    }
    await upsertBillingSubscription(event.userId, {
      provider: "dodo",
      plan: "indie",
      status: event.status,
      customerId: event.customerId,
      subscriptionId: event.subscriptionId,
      checkoutSessionId: event.checkoutSessionId,
      productId: event.productId,
      currentPeriodEnd: event.currentPeriodEnd,
    })
    return NextResponse.json({ received: true })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to process webhook." },
      { status: 400 }
    )
  }
}
