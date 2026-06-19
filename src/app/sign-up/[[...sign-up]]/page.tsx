import { SignUp } from "@clerk/nextjs"
import { CloudCog } from "lucide-react"
import { ThemeToggle } from "@/app/ThemeToggle"
import { authAppearance } from "@/app/authAppearance"

export default function SignUpPage() {
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
          <h1>Create your workspace</h1>
          <span>
            Connect repositories and cloud accounts to see where every infrastructure dollar goes.
          </span>
          <div className="signin-status">
            <i aria-hidden />
            Isolated customer workspace
          </div>
        </div>
        <div className="signin-clerk">
          <SignUp
            appearance={authAppearance}
            fallback={
              <div className="signin-fallback" role="status">
                <span>Loading secure sign-up…</span>
                <a href="https://accounts.ambrium.io/sign-up">Open sign-up directly</a>
              </div>
            }
          />
        </div>
      </section>
    </main>
  )
}
