"use client"

import { useState } from "react"

// Small clipboard button used inside the Connect command boxes. Keeps its own
// transient "Copied" state; the surrounding box markup is server-rendered.
export function CopyButton({
  text,
  className,
  copyLabel = "Copy",
  copiedLabel = "Copied",
}: {
  text: string
  className?: string
  copyLabel?: string
  copiedLabel?: string
}) {
  const [copied, setCopied] = useState(false)

  function copy() {
    // writeText rejects asynchronously when the document lacks clipboard
    // permission (insecure context, no focus), so catch the promise too — not
    // just a synchronous throw — to avoid an unhandled rejection. The command
    // stays visible to select manually either way.
    try {
      void navigator.clipboard?.writeText(text)?.catch(() => {})
    } catch {
      // navigator.clipboard itself is undefined in some contexts.
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }

  return (
    <button type="button" className={className} onClick={copy}>
      {copied ? copiedLabel : copyLabel}
    </button>
  )
}
