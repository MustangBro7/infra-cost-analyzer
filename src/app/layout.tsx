import type { Metadata } from "next"
import "./globals.css"

export const metadata: Metadata = {
  title: "Infra Cost Analyzer",
  description: "Connect a GitHub repository and map the infrastructure costs behind it.",
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
