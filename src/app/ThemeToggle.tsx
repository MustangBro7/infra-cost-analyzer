"use client"

import * as React from "react"
import { Moon, Sun } from "lucide-react"

/**
 * Light/dark switch. The saved value is applied before first paint by the
 * inline script in the root layout; this control just flips the html
 * data-theme attribute and persists the choice.
 */
export function ThemeToggle() {
  const [theme, setTheme] = React.useState<"light" | "dark" | null>(null)

  React.useEffect(() => {
    setTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light")
  }, [])

  function toggle() {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark"
    document.documentElement.dataset.theme = next
    try {
      localStorage.setItem("amb-theme", next)
    } catch {
      // Private-mode storage failures just lose persistence, not the switch.
    }
    setTheme(next)
  }

  return (
    <button type="button" className="amb-theme-toggle" onClick={toggle} aria-label="Switch color theme">
      {theme === "dark" ? <Sun aria-hidden /> : <Moon aria-hidden />}
      <span>{theme === "dark" ? "Light mode" : theme === "light" ? "Dark mode" : "Theme"}</span>
    </button>
  )
}
