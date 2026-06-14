"use client"

import * as React from "react"
import { Moon, Sun } from "lucide-react"

type Theme = "light" | "dark"

function systemTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

function currentTheme(): Theme {
  const explicit = document.documentElement.dataset.theme
  if (explicit === "light" || explicit === "dark") return explicit
  return systemTheme()
}

export function ThemeToggle() {
  const [mounted, setMounted] = React.useState(false)
  const [theme, setTheme] = React.useState<Theme>("light")

  React.useEffect(() => {
    setMounted(true)
    setTheme(currentTheme())

    // Keep in sync with the OS when the user hasn't made an explicit choice.
    const media = window.matchMedia("(prefers-color-scheme: dark)")
    const onChange = () => {
      if (!localStorage.getItem("theme")) setTheme(systemTheme())
    }
    media.addEventListener("change", onChange)
    return () => media.removeEventListener("change", onChange)
  }, [])

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark"
    document.documentElement.dataset.theme = next
    try {
      localStorage.setItem("theme", next)
    } catch {
      /* storage may be unavailable; the in-session toggle still works */
    }
    setTheme(next)
  }

  // Render a stable shell on the server / first paint to avoid hydration drift;
  // the icon settles once we know the effective theme.
  const isDark = mounted && theme === "dark"

  return (
    <button
      type="button"
      className="icon-button theme-toggle"
      onClick={toggle}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
    >
      {isDark ? <Sun aria-hidden /> : <Moon aria-hidden />}
    </button>
  )
}
