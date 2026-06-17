"use client"

import * as React from "react"
import { LogOut } from "lucide-react"
import { useClerk } from "@clerk/nextjs"

export function SignOutButton() {
  const { signOut } = useClerk()
  const [busy, setBusy] = React.useState(false)
  return (
    <button
      type="button"
      className="ghost-button"
      disabled={busy}
      onClick={async () => {
        setBusy(true)
        await signOut({ redirectUrl: "/sign-in" })
      }}
    >
      <LogOut aria-hidden />
      Sign out
    </button>
  )
}
