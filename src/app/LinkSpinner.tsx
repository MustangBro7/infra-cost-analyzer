"use client"

import { useLinkStatus } from "next/link"
import { Loader2 } from "lucide-react"

/**
 * Inline pending indicator for <Link> navigations. View/tab switches on the
 * dashboard are searchParams-only navigations, which do NOT re-trigger the
 * route's loading.tsx — the old page just sits there until the new server
 * payload streams in, so clicks feel dead. Rendered as a child of the Link it
 * reports on (useLinkStatus reads the nearest Link ancestor), it shows a
 * spinner for exactly that link while its navigation is in flight.
 */
export function LinkSpinner({ className }: { className?: string }) {
  const { pending } = useLinkStatus()
  if (!pending) return null
  return <Loader2 className={`amb-link-spin${className ? ` ${className}` : ""}`} aria-label="Loading" />
}
