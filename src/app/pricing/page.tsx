import Link from "next/link"
import { ArrowRight, CheckCircle2, CloudCog } from "lucide-react"
import { BillingCheckoutButton } from "../BillingCheckoutButton"

export const runtime = "nodejs"

const PLANS = [
  {
    name: "Free",
    price: "$0",
    detail: "For trying Ambrium on a couple of side projects.",
    features: ["2 projects", "2 providers", "Monthly refresh", "Project cost cockpit", "Free-tier runway"],
  },
  {
    name: "Indie",
    price: "$5",
    detail: "For active indie developers who want daily visibility and alerts.",
    features: ["Unlimited personal projects", "Daily refresh", "Surprise-bill alerts", "AI-tool cost", "Custom providers"],
  },
]

export default function PricingPage() {
  return (
    <main className="pricing-page">
      <header className="landing-nav">
        <Link href="/" className="brand pricing-brand">
          <span className="brand-mark">
            <CloudCog aria-hidden />
          </span>
          <strong>Ambrium</strong>
        </Link>
        <nav className="landing-nav-actions">
          <Link href="/dashboard" className="link-button">
            Dashboard
          </Link>
          <Link href="/sign-up" className="command-button">
            Get started <ArrowRight aria-hidden />
          </Link>
        </nav>
      </header>

      <section className="pricing-hero">
        <p className="landing-eyebrow">Simple indie pricing</p>
        <h1>Start free. Upgrade when Ambrium is watching all your projects.</h1>
        <span>
          The paid tier is intentionally small: $5/month for daily refresh, alerts, AI usage, custom providers, and
          unlimited personal projects.
        </span>
      </section>

      <section className="pricing-plan-grid" aria-label="Ambrium plans">
        {PLANS.map((plan) => (
          <article className={plan.name === "Indie" ? "pricing-plan featured" : "pricing-plan"} key={plan.name}>
            <div>
              <p>{plan.name}</p>
              <h2>
                {plan.price}
                <span>{plan.name === "Free" ? " forever" : " / month"}</span>
              </h2>
              <small>{plan.detail}</small>
            </div>
            <ul>
              {plan.features.map((feature) => (
                <li key={feature}>
                  <CheckCircle2 aria-hidden />
                  {feature}
                </li>
              ))}
            </ul>
          </article>
        ))}
      </section>

      <section className="clerk-pricing-shell" aria-label="Checkout">
        <div>
          <p>Checkout</p>
          <h2>Dodo Payments</h2>
          <span>
            Ambrium uses Clerk for sign-in and Dodo Payments for global USD checkout, tax handling, invoices, and
            subscription webhooks.
          </span>
        </div>
        <div className="billing-disabled-note" role="status">
          <strong>Indie checkout is hosted by Dodo Payments.</strong>
          <span>Sign in, start checkout, and Dodo returns you to the dashboard after payment.</span>
          <BillingCheckoutButton />
        </div>
      </section>
    </main>
  )
}
