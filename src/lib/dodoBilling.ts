import { createHmac, timingSafeEqual } from "node:crypto"
import type { BillingStatus, LocalUser } from "./types"

const LIVE_BASE_URL = "https://live.dodopayments.com"
const TEST_BASE_URL = "https://test.dodopayments.com"

export interface DodoConfig {
  apiKey: string
  productId: string
  environment: "test" | "live"
}

export interface DodoCheckoutSession {
  sessionId: string
  checkoutUrl: string
}

export interface DodoWebhookUpdate {
  userId: string | null
  status: BillingStatus
  customerId: string | null
  subscriptionId: string | null
  checkoutSessionId: string | null
  productId: string | null
  currentPeriodEnd: string | null
}

type DodoRuntimeEnv = Record<string, string | undefined> & {
  DODO_PAYMENTS_API_KEY?: string
  DODO_INDIE_PRODUCT_ID?: string
  DODO_PAYMENTS_ENVIRONMENT?: string
  DODO_PAYMENTS_WEBHOOK_KEY?: string
}

export async function dodoRuntimeEnv(): Promise<DodoRuntimeEnv> {
  let cloudflareEnv: DodoRuntimeEnv = {}
  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare/cloudflare-context")
    cloudflareEnv = getCloudflareContext().env as unknown as DodoRuntimeEnv
  } catch {
    cloudflareEnv = {}
  }
  return { ...(process.env as DodoRuntimeEnv), ...cloudflareEnv }
}

export function dodoConfigFromEnv(env: DodoRuntimeEnv): DodoConfig | null {
  const apiKey = env.DODO_PAYMENTS_API_KEY?.trim()
  const productId = env.DODO_INDIE_PRODUCT_ID?.trim()
  if (!apiKey || !productId) return null
  return {
    apiKey,
    productId,
    environment: env.DODO_PAYMENTS_ENVIRONMENT === "live" ? "live" : "test",
  }
}

export async function dodoConfig(): Promise<DodoConfig | null> {
  return dodoConfigFromEnv(await dodoRuntimeEnv())
}

export async function createDodoCheckout(input: {
  config: DodoConfig
  user: LocalUser
  returnUrl: string
  cancelUrl: string
}): Promise<DodoCheckoutSession> {
  const response = await fetch(`${baseUrl(input.config)}/checkouts`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${input.config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      product_cart: [{ product_id: input.config.productId, quantity: 1 }],
      customer: { email: input.user.email, name: input.user.name },
      metadata: {
        app: "ambrium",
        user_id: input.user.id,
        plan: "indie",
      },
      return_url: input.returnUrl,
      cancel_url: input.cancelUrl,
      short_link: true,
      customization: {
        show_order_details: true,
        theme: "dark",
      },
    }),
  })

  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null
  if (!response.ok) {
    const detail =
      payload && typeof payload === "object"
        ? JSON.stringify(payload)
        : `${response.status} ${response.statusText}`
    throw new Error(`Dodo checkout creation failed: ${detail}`)
  }

  const sessionId = stringValue(payload?.session_id)
  const checkoutUrl = stringValue(payload?.checkout_url)
  if (!sessionId || !checkoutUrl) {
    throw new Error("Dodo checkout creation succeeded but did not return checkout_url.")
  }
  return { sessionId, checkoutUrl }
}

export function verifyDodoWebhook(input: {
  body: string
  headers: Headers
  secret: string | undefined
}): boolean {
  const secret = input.secret?.trim()
  if (!secret) return true
  const id = input.headers.get("webhook-id")
  const timestamp = input.headers.get("webhook-timestamp")
  const signature = input.headers.get("webhook-signature")
  if (!id || !timestamp || !signature) return false

  const signedPayload = `${id}.${timestamp}.${input.body}`
  const expected = createHmac("sha256", decodeWebhookSecret(secret)).update(signedPayload).digest("base64")
  return signature
    .split(" ")
    .flatMap((part) => part.split(","))
    .some((part) => {
      const value = part.startsWith("v1,") ? part.slice(3) : part.startsWith("v1=") ? part.slice(3) : part
      return secureEqual(value.trim(), expected)
    })
}

export function parseDodoWebhook(body: string): DodoWebhookUpdate {
  const payload = JSON.parse(body) as Record<string, unknown>
  const eventType = stringValue(payload.type) ?? stringValue(payload.event_type) ?? stringValue(payload.event)
  const data = objectValue(payload.data) ?? objectValue(payload.payload) ?? payload
  const metadata = objectValue(data.metadata) ?? objectValue(payload.metadata) ?? {}
  const customer = objectValue(data.customer) ?? {}

  return {
    userId: stringValue(metadata.user_id),
    status: statusFromEvent(eventType, stringValue(data.status)),
    customerId:
      stringValue(data.customer_id) ??
      stringValue(customer.customer_id) ??
      stringValue(customer.id),
    subscriptionId:
      stringValue(data.subscription_id) ??
      stringValue(data.id),
    checkoutSessionId:
      stringValue(data.checkout_session_id) ??
      stringValue(data.session_id) ??
      stringValue(payload.session_id),
    productId:
      stringValue(data.product_id) ??
      productIdFromCart(data.product_cart) ??
      stringValue(metadata.product_id),
    currentPeriodEnd:
      stringValue(data.current_period_end) ??
      stringValue(data.next_billing_date) ??
      stringValue(data.expires_at),
  }
}

function baseUrl(config: DodoConfig) {
  return config.environment === "live" ? LIVE_BASE_URL : TEST_BASE_URL
}

function decodeWebhookSecret(secret: string) {
  const raw = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret
  try {
    return Buffer.from(raw, "base64")
  } catch {
    return Buffer.from(secret)
  }
}

function secureEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

function statusFromEvent(eventType: string | null, rawStatus: string | null): BillingStatus {
  const event = (eventType ?? "").toLowerCase()
  const status = (rawStatus ?? "").toLowerCase()
  if (event.includes("cancel") || status === "cancelled" || status === "canceled") return "cancelled"
  if (event.includes("expire") || status === "expired") return "expired"
  if (event.includes("fail") || event.includes("past_due") || status === "past_due" || status === "failed") {
    return "past_due"
  }
  if (event.includes("subscription") || event.includes("payment.succeeded") || status === "active") return "active"
  return "checkout_started"
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function productIdFromCart(value: unknown): string | null {
  if (!Array.isArray(value)) return null
  const first = objectValue(value[0])
  return stringValue(first?.product_id)
}
