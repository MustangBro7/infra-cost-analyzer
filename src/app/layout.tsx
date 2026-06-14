import type { Metadata } from "next"
import "./globals.css"

export const metadata: Metadata = {
  title: "Infra Cost Analyzer",
  description: "Connect a GitHub repository and map the infrastructure costs behind it.",
}

// Applies the saved theme before first paint so there is no flash of the wrong
// mode. When no explicit choice is stored, the CSS prefers-color-scheme rules
// take over (data-theme stays unset).
const themeInitScript = `(function(){try{var t=localStorage.getItem("theme");if(t==="light"||t==="dark"){document.documentElement.dataset.theme=t;}}catch(e){}})();`

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>{children}</body>
    </html>
  )
}
