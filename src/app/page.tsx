import type { CSSProperties } from "react"
import Link from "next/link"
import {
  ArrowRight,
  CloudCog,
  GitBranch,
  Gauge,
  ShieldCheck,
  TerminalSquare,
} from "lucide-react"
import { ThemeToggle } from "./ThemeToggle"

export const runtime = "nodejs"

// Public marketing page. Explains Ambrium in plain terms with on-theme (squared,
// warm) UI and CSS-only entrance/float/grow animations. Auth lives behind /sign-in
// and the app behind /dashboard.
const HERO_BARS: Array<{ label: string; width: string; color: string; delay: string }> = [
  { label: "AWS", width: "82%", color: "var(--yellow)", delay: "0.15s" },
  { label: "Google Cloud", width: "61%", color: "var(--blue)", delay: "0.3s" },
  { label: "Cloudflare", width: "44%", color: "var(--red)", delay: "0.45s" },
  { label: "Vercel", width: "28%", color: "var(--violet)", delay: "0.6s" },
]

const STEPS: Array<{ icon: typeof Gauge; title: string; body: string }> = [
  {
    icon: TerminalSquare,
    title: "1 · Connect",
    body: "Run one command — npx @ambrium/connect — or let Codex/Claude Code drive it. You approve the read-only provider steps.",
  },
  {
    icon: GitBranch,
    title: "2 · Detect",
    body: "Ambrium maps GitHub repos, Vercel projects, Cloudflare apps, AWS/GCP usage, and AI-tool spend into project costs.",
  },
  {
    icon: Gauge,
    title: "3 · Understand",
    body: "See which project costs money, which free tier is close to breaking, and which old project may be safe to shut down.",
  },
]

export default function Landing() {
  const year = new Date().getFullYear()
  return (
    <main className="landing">
      <header className="landing-nav">
        <div className="brand">
          <span className="brand-mark">
            <CloudCog aria-hidden />
          </span>
          <strong>Ambrium</strong>
        </div>
        <nav className="landing-nav-actions">
          <ThemeToggle />
          <Link href="/pricing" className="link-button">
            Pricing
          </Link>
          <Link href="/sign-in" className="link-button">
            Sign in
          </Link>
          <Link href="/sign-up" className="command-button">
            Get started <ArrowRight aria-hidden />
          </Link>
        </nav>
      </header>

      <section className="landing-hero">
        <div className="landing-hero-copy">
          <p className="landing-eyebrow">Personal cost cockpit for indie developers</p>
          <h1>
            See what every <span className="hl">side project</span> costs.
          </h1>
          <p className="landing-lede">
            Ambrium connects your GitHub repos, cloud providers, and AI tools, then shows which app is costing money,
            which free tiers are close to limits, and what you can shut down before a surprise bill.
          </p>
          <div className="landing-cta">
            <Link href="/sign-up" className="command-button lg">
              Get started free <ArrowRight aria-hidden />
            </Link>
            <Link href="/dashboard" className="ghost-button lg">
              Open dashboard
            </Link>
          </div>
          <p className="landing-note">
            Run one command, see what your projects cost: <code>npx @ambrium/connect</code>
          </p>
        </div>

        <div className="landing-hero-art" aria-hidden>
          <div className="cost-card">
            <div className="cost-card-head">
              <span>Monthly spend</span>
              <strong>$3,412</strong>
            </div>
            <div className="cost-bars">
              {HERO_BARS.map((bar) => (
                <div className="cost-bar-row" key={bar.label}>
                  <span className="cost-bar-label">{bar.label}</span>
                  <span className="cost-bar-track">
                    <span
                      className="cost-bar-fill"
                      style={{ "--w": bar.width, "--d": bar.delay, background: bar.color } as CSSProperties}
                    />
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="landing-steps">
        {STEPS.map(({ icon: Icon, title, body }) => (
          <article className="landing-step" key={title}>
            <span className="landing-step-icon">
              <Icon aria-hidden />
            </span>
            <h3>{title}</h3>
            <p>{body}</p>
          </article>
        ))}
      </section>

      <section className="landing-providers">
        <span>Works with</span>
        <div className="landing-provider-row">GitHub · Vercel · Cloudflare · AWS · Google Cloud · OpenAI · Claude · Cursor</div>
      </section>

      <section className="landing-trust">
        <ShieldCheck aria-hidden />
        <div>
          <strong>Read-only by design</strong>
          <span>
            Ambrium uses scoped, read-only access — cross-account IAM roles and read-only tokens. It can see your costs,
            never touch your infrastructure.
          </span>
        </div>
      </section>

      <section className="landing-footer-cta">
        <h2>Stop wondering which side project is still billing you.</h2>
        <Link href="/sign-up" className="command-button lg">
          Get started <ArrowRight aria-hidden />
        </Link>
      </section>

      <footer className="landing-foot">
        <span>Ambrium</span>
        <span>© {year}</span>
      </footer>
    </main>
  )
}
