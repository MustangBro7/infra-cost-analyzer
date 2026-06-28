import { SignUp } from "@clerk/nextjs"
import { CloudCog } from "lucide-react"
import { authAppearance } from "@/app/authAppearance"

export default function SignUpPage() {
  return (
    <main className="signin-shell">
      <section className="signin-panel">
        <div className="signin-intro">
          <div className="signin-mark">
            <CloudCog aria-hidden />
          </div>
          <p>Ambrium</p>
          <h1>Create your project cockpit</h1>
          <span>
            Connect repos, cloud accounts, and AI tools to see which projects cost money.
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
              <div key="signup-fallback" className="signin-fallback" role="status">
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
