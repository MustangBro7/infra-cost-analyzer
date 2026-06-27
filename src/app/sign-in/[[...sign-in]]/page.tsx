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
          <p>Ambrium</p>
          <h1>Sign in to your project cockpit</h1>
          <span>
            See what each side project, cloud provider, and AI tool is costing before a surprise bill.
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
              <div key="signin-fallback" className="signin-fallback" role="status">
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
