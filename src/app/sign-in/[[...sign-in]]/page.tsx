import { SignIn } from "@clerk/nextjs"
import { CloudCog } from "lucide-react"
import { ThemeToggle } from "@/app/ThemeToggle"

export default function SignInPage() {
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
        <h1>Sign in to your workspace</h1>
        <span>
          Use your email to map the infrastructure costs behind your repositories. Each account
          gets isolated repos, provider credentials, and cost snapshots.
        </span>
        <div className="signin-clerk">
          <SignIn
            fallback={
              <div className="signin-fallback" role="status">
                <span>Loading secure sign-in…</span>
                <a href="https://accounts.ambrium.io/sign-in">Open sign-in directly</a>
              </div>
            }
          />
        </div>
      </section>
    </main>
  )
}
