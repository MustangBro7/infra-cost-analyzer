import { SignUp } from "@clerk/nextjs"
import { CloudCog } from "lucide-react"
import { ThemeToggle } from "@/app/ThemeToggle"

export default function SignUpPage() {
  return (
    <main className="signin-shell">
      <div className="theme-toggle-floating">
        <ThemeToggle />
      </div>
      <section className="signin-panel">
        <div className="signin-mark">
          <CloudCog aria-hidden />
        </div>
        <p>Infrastructure Cost Analyzer</p>
        <h1>Create your workspace</h1>
        <span>
          Continue with Google to get started. Each account gets isolated repos, provider
          credentials, and cost snapshots.
        </span>
        <div className="signin-clerk">
          <SignUp />
        </div>
      </section>
    </main>
  )
}
