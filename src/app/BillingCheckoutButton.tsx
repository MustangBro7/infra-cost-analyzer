"use client"

import * as React from "react"
import { ArrowRight, Loader2 } from "lucide-react"

export function BillingCheckoutButton() {
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  async function startCheckout() {
    setBusy(true)
    setError(null)
    try {
      const response = await fetch("/api/billing/checkout", { method: "POST" })
      const payload = (await response.json().catch(() => null)) as { checkoutUrl?: string; error?: string } | null
      if (!response.ok || !payload?.checkoutUrl) {
        throw new Error(payload?.error ?? "Checkout is not available yet.")
      }
      window.location.href = payload.checkoutUrl
    } catch (checkoutError) {
      setError(checkoutError instanceof Error ? checkoutError.message : "Checkout failed.")
      setBusy(false)
    }
  }

  return (
    <div className="billing-action">
      <button className="command-button" type="button" onClick={startCheckout} disabled={busy}>
        {busy ? <Loader2 className="spin" aria-hidden /> : <ArrowRight aria-hidden />}
        Upgrade to Indie
      </button>
      {error ? <span role="alert">{error}</span> : null}
    </div>
  )
}
