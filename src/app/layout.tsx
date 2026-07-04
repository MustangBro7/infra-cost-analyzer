import type { Metadata } from "next"
import { ClerkProvider } from "@clerk/nextjs"
import "./globals.css"
import "./dashboard-ui.css"

export const metadata: Metadata = {
  title: "Ambrium",
  description: "See what each app, side project, cloud provider, and AI tool is costing before a surprise bill.",
  icons: {
    icon: "/favicon.svg",
  },
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <ClerkProvider>
      <html lang="en" suppressHydrationWarning>
        <head>
          <link rel="preconnect" href="https://fonts.googleapis.com" />
          <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
          <link
            href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500;600&display=swap"
            rel="stylesheet"
          />
          {/* Apply the saved theme before first paint so dark mode never flashes
              light. Falls back to the OS preference on first visit. */}
          <script
            dangerouslySetInnerHTML={{
              __html: `try{var t=localStorage.getItem("amb-theme");if(!t)t=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";document.documentElement.dataset.theme=t}catch(e){}`,
            }}
          />
        </head>
        <body>{children}</body>
      </html>
    </ClerkProvider>
  )
}
