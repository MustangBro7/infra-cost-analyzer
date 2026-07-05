import Link from "next/link"
import { ChevronDown } from "lucide-react"
import { LinkSpinner } from "../LinkSpinner"
import { DetailsAutoClose } from "./DetailsAutoClose"
import { DATE_RANGE_PRESETS, type ResolvedDateRange } from "@/lib/dateRange"

function monthShortLabel(key: string): string {
  return new Date(`${key}-01T00:00:00Z`).toLocaleString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  })
}

/**
 * Header date-range selector for the cost report. Server-rendered: a plain
 * <details> dropdown of links, so switching ranges is a normal navigation that
 * re-renders the dashboard with `?range=`. Besides the presets it offers the
 * few most recent explicit months (any YYYY-MM works in the URL).
 */
export function DateRangePicker({
  range,
  baseParams,
  now = new Date(),
}: {
  range: ResolvedDateRange
  baseParams: Record<string, string>
  now?: Date
}) {
  const hrefFor = (key: string) => {
    const params = new URLSearchParams(baseParams)
    if (key === "this-month") params.delete("range")
    else params.set("range", key)
    const qs = params.toString()
    return qs ? `/dashboard?${qs}` : "/dashboard"
  }

  // Previous explicit months (skipping the current month and "last month",
  // which the presets already cover).
  const explicitMonths: string[] = []
  for (let offset = 2; offset <= 4; offset += 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1))
    explicitMonths.push(d.toISOString().slice(0, 7))
  }

  return (
    <details className="amb-range">
      <DetailsAutoClose />
      <summary className="amb-chip amb-range-summary" aria-label="Change date range">
        <span>{range.label}</span>
        <ChevronDown aria-hidden width={13} height={13} />
      </summary>
      <div className="amb-range-menu" role="menu">
        {DATE_RANGE_PRESETS.map((preset) => (
          <Link
            key={preset.key}
            href={hrefFor(preset.key)}
            prefetch={false}
            role="menuitem"
            className={range.key === preset.key ? "amb-range-item active" : "amb-range-item"}
          >
            {preset.label}
            <LinkSpinner />
          </Link>
        ))}
        <div className="amb-range-divider" aria-hidden />
        {explicitMonths.map((month) => (
          <Link
            key={month}
            href={hrefFor(month)}
            prefetch={false}
            role="menuitem"
            className={range.key === month ? "amb-range-item active" : "amb-range-item"}
          >
            {monthShortLabel(month)}
            <LinkSpinner />
          </Link>
        ))}
      </div>
    </details>
  )
}
