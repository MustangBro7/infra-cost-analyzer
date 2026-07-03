import { NextRequest, NextResponse } from "next/server"
import { AuthRequiredError, requireUserFromRequest } from "@/lib/localAuth"
import { readWorkspace } from "@/lib/localStore"
import { planLimits } from "@/lib/plan"
import { sendEmail } from "@/lib/email"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// Sends a test alert email to the signed-in user so they can verify delivery
// end-to-end (Email Service domain onboarding, spam placement, address).
export async function POST(request: NextRequest) {
  try {
    const user = await requireUserFromRequest(request)
    const workspace = await readWorkspace(user.id)
    if (!planLimits(workspace).emailAlerts) {
      return NextResponse.json(
        { error: "Email alerts are an Indie plan feature. Upgrade to enable delivery." },
        { status: 402 }
      )
    }
    const result = await sendEmail({
      to: user.email,
      subject: "Ambrium test alert",
      html: `<div style="font-family:-apple-system,'Segoe UI',Roboto,sans-serif;padding:24px;"><p style="letter-spacing:0.14em;text-transform:uppercase;color:#6f6b62;font-size:13px;">Ambrium</p><h1 style="font-size:18px;">Email alerts are working</h1><p>This is a test message. Budget and free-tier alerts will arrive at this address.</p></div>`,
      text: "Ambrium: email alerts are working. Budget and free-tier alerts will arrive at this address.",
    })
    if (!result.sent) {
      return NextResponse.json(
        { error: `Email not sent: ${result.skipped ?? "unknown reason"}` },
        { status: 503 }
      )
    }
    return NextResponse.json({ status: "sent", to: user.email, messageId: result.messageId ?? null })
  } catch (error) {
    if (error instanceof AuthRequiredError) return NextResponse.json({ error: error.message }, { status: 401 })
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to send test email." }, { status: 400 })
  }
}
