"use client"

import * as React from "react"

/**
 * Dismiss behavior for native <details> dropdowns (the date-range picker):
 * clicking outside, pressing Escape, or choosing a menu item closes the menu.
 * A bare <details> otherwise stays open until its summary is clicked again —
 * and React never resets the browser-toggled `open` property across
 * searchParams navigations, so the menu used to stick open while the page
 * changed underneath it. Render this inside the <details> element.
 */
export function DetailsAutoClose() {
  const ref = React.useRef<HTMLSpanElement>(null)

  React.useEffect(() => {
    const details = ref.current?.closest("details")
    if (!details) return
    const close = () => {
      details.open = false
    }
    const onPointerDown = (event: PointerEvent) => {
      if (details.open && event.target instanceof Node && !details.contains(event.target)) close()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && details.open) close()
    }
    const onClick = (event: MouseEvent) => {
      // Selecting an item (a link inside the menu) starts a navigation; close
      // immediately instead of leaving the menu open over the next render.
      if (event.target instanceof Element && event.target.closest("a")) close()
    }
    document.addEventListener("pointerdown", onPointerDown)
    document.addEventListener("keydown", onKeyDown)
    details.addEventListener("click", onClick)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown)
      document.removeEventListener("keydown", onKeyDown)
      details.removeEventListener("click", onClick)
    }
  }, [])

  return <span ref={ref} hidden />
}
