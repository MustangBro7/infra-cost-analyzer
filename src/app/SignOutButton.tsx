"use client"

import * as React from "react"
import { LogOut } from "lucide-react"

export function SignOutButton() {
  const [busy, setBusy] = React.useState(false)
  return (
    <button
      type="button"
      className="ghost-button"
      disabled={busy}
      onClick={async () => {
        setBusy(true)
        await fetch("/api/auth/sign-out", { method: "POST" })
        window.location.href = "/"
      }}
    >
      <LogOut aria-hidden />
      Sign out
    </button>
  )
}
