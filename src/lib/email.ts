/**
 * Transactional email via Cloudflare Email Service (the `send_email` Worker
 * binding named EMAIL in wrangler.jsonc). The sending domain must be onboarded
 * once with `npx wrangler email sending enable ambrium.io`.
 *
 * Outside the Workers runtime (local dev, tests) or before the binding/domain
 * is provisioned, sends degrade to a skipped result instead of throwing so the
 * cron sweep never fails because email isn't set up yet.
 */

interface EmailSenderLike {
  send(message: {
    to: string
    from: { email: string; name: string }
    replyTo?: string
    subject: string
    html: string
    text: string
  }): Promise<{ messageId?: string }>
}

export interface SendEmailResult {
  sent: boolean
  messageId?: string
  skipped?: string
}

export function alertsFromAddress(): { email: string; name: string } {
  return {
    email: process.env.ALERTS_FROM_EMAIL || "alerts@ambrium.io",
    name: "Ambrium",
  }
}

async function emailBinding(): Promise<EmailSenderLike | null> {
  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare/cloudflare-context")
    const env = getCloudflareContext().env as { EMAIL?: EmailSenderLike }
    return env.EMAIL ?? null
  } catch {
    return null
  }
}

export async function sendEmail(input: {
  to: string
  subject: string
  html: string
  text: string
}): Promise<SendEmailResult> {
  const binding = await emailBinding()
  if (!binding) {
    return { sent: false, skipped: "Email binding unavailable (not in Workers runtime or send_email not configured)." }
  }
  const response = await binding.send({
    to: input.to,
    from: alertsFromAddress(),
    subject: input.subject,
    html: input.html,
    text: input.text,
  })
  return { sent: true, messageId: response?.messageId }
}
