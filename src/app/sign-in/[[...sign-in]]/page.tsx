import { SignIn } from "@clerk/nextjs"
import { CloudCog } from "lucide-react"
import { ThemeToggle } from "@/app/ThemeToggle"
import { authAppearance } from "@/app/authAppearance"

export default function SignInPage() {
  return (
    <main className="signin-shell">
      <div className="theme-toggle-floating">
        <ThemeToggle />
      </div>
      <section className="signin-panel">
        <div className="signin-intro">
          <div className="signin-mark">
            <CloudCog aria-hidden />
          </div>
          <p>Infrastructure Cost Analyzer</p>
          <h1>Sign in to your workspace</h1>
          <span>
            Connect repositories and cloud accounts to see where every infrastructure dollar goes.
          </span>
          <div className="signin-status">
            <i aria-hidden />
            Production workspace
          </div>
        </div>
        <div className="signin-clerk">
          <SignIn
            appearance={authAppearance}
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
