/**
 * Calendar date ranges for cost reporting. Everything is UTC and month-grained:
 * providers report month-to-date aggregates (a row's billingPeriodStart/End
 * spans its billing month), and the analytics store rolls history up per
 * calendar month — so months are the smallest unit we can filter honestly.
 */

export type DateRangeKey =
  | "this-month"
  | "last-month"
  | "this-quarter"
  | "last-quarter"
  | "this-year"
  | "last-6-months"
  | "last-12-months"

export interface ResolvedDateRange {
  /** The preset key, or the explicit "YYYY-MM" month that was requested. */
  key: DateRangeKey | string
  /** Human label, e.g. "This month", "Q2 2026", "June 2026". */
  label: string
  /** Inclusive calendar bounds, YYYY-MM-DD. */
  from: string
  to: string
  /** Every calendar month the range covers, as YYYY-MM, oldest first. */
  months: string[]
  /** Whether the range covers the current (in-progress) calendar month. */
  includesCurrentMonth: boolean
  /** True only for the default "this month" view (live snapshot, no history). */
  isCurrentMonthOnly: boolean
}

const MONTH_KEY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/

export const DATE_RANGE_PRESETS: Array<{ key: DateRangeKey; label: string }> = [
  { key: "this-month", label: "This month" },
  { key: "last-month", label: "Last month" },
  { key: "this-quarter", label: "This quarter" },
  { key: "last-quarter", label: "Last quarter" },
  { key: "this-year", label: "This year" },
  { key: "last-6-months", label: "Last 6 months" },
  { key: "last-12-months", label: "Last 12 months" },
]

function utcMonthStart(year: number, monthIndex: number): Date {
  return new Date(Date.UTC(year, monthIndex, 1))
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function monthKey(date: Date): string {
  return date.toISOString().slice(0, 7)
}

/** First and last day of the calendar month `offset` months from `now`. */
function monthBounds(now: Date, offset: number): { from: Date; to: Date } {
  const from = utcMonthStart(now.getUTCFullYear(), now.getUTCMonth() + offset)
  const to = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 0))
  return { from, to }
}

function monthsBetween(from: Date, to: Date): string[] {
  const out: string[] = []
  const cursor = utcMonthStart(from.getUTCFullYear(), from.getUTCMonth())
  while (cursor.getTime() <= to.getTime()) {
    out.push(monthKey(cursor))
    cursor.setUTCMonth(cursor.getUTCMonth() + 1)
  }
  return out
}

function monthLongLabel(key: string): string {
  return new Date(`${key}-01T00:00:00Z`).toLocaleString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  })
}

function build(key: DateRangeKey | string, label: string, from: Date, to: Date, now: Date): ResolvedDateRange {
  const currentMonth = monthKey(now)
  const months = monthsBetween(from, to)
  return {
    key,
    label,
    from: isoDate(from),
    to: isoDate(to),
    months,
    includesCurrentMonth: months.includes(currentMonth),
    isCurrentMonthOnly: months.length === 1 && months[0] === currentMonth,
  }
}

/** The current calendar month as a range — the dashboard's default view. */
export function currentMonthRange(now: Date = new Date()): ResolvedDateRange {
  const { from, to } = monthBounds(now, 0)
  return build("this-month", "This month", from, to, now)
}

/**
 * Resolves a ?range= value into calendar bounds. Accepts the preset keys plus
 * an explicit month ("YYYY-MM"). Anything unrecognized falls back to the
 * current month so a bad/stale URL can never widen or corrupt the report.
 */
export function resolveDateRange(raw: string | null | undefined, now: Date = new Date()): ResolvedDateRange {
  const year = now.getUTCFullYear()
  const month = now.getUTCMonth()
  const quarterStartMonth = Math.floor(month / 3) * 3

  switch (raw) {
    case "last-month": {
      const { from, to } = monthBounds(now, -1)
      return build("last-month", monthLongLabel(monthKey(from)), from, to, now)
    }
    case "this-quarter": {
      const from = utcMonthStart(year, quarterStartMonth)
      const to = new Date(Date.UTC(year, quarterStartMonth + 3, 0))
      return build("this-quarter", `Q${quarterStartMonth / 3 + 1} ${year}`, from, to, now)
    }
    case "last-quarter": {
      const from = utcMonthStart(year, quarterStartMonth - 3)
      const to = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 3, 0))
      return build("last-quarter", `Q${from.getUTCMonth() / 3 + 1} ${from.getUTCFullYear()}`, from, to, now)
    }
    case "this-year": {
      const from = utcMonthStart(year, 0)
      const to = new Date(Date.UTC(year, 12, 0))
      return build("this-year", `${year}`, from, to, now)
    }
    case "last-6-months": {
      const from = utcMonthStart(year, month - 5)
      const { to } = monthBounds(now, 0)
      return build("last-6-months", "Last 6 months", from, to, now)
    }
    case "last-12-months": {
      const from = utcMonthStart(year, month - 11)
      const { to } = monthBounds(now, 0)
      return build("last-12-months", "Last 12 months", from, to, now)
    }
    default: {
      if (raw && MONTH_KEY_PATTERN.test(raw)) {
        const [y, m] = raw.split("-").map(Number)
        const from = utcMonthStart(y, m - 1)
        const to = new Date(Date.UTC(y, m, 0))
        return build(raw, monthLongLabel(raw), from, to, now)
      }
      return currentMonthRange(now)
    }
  }
}

/**
 * Whether a billing row belongs in a date range: its billing period must
 * overlap the range. This is the guard that keeps last month's rows out of
 * this month's totals — a row stamped June can never count toward July.
 * ISO date strings compare correctly as strings.
 */
export function rowOverlapsRange(
  row: { billingPeriodStart: string; billingPeriodEnd: string },
  range: { from: string; to: string }
): boolean {
  return row.billingPeriodStart <= range.to && row.billingPeriodEnd >= range.from
}

/** True when two ISO timestamps/dates fall in the same UTC calendar month. */
export function sameUtcMonth(a: string | Date, b: string | Date): boolean {
  const da = typeof a === "string" ? new Date(a) : a
  const db = typeof b === "string" ? new Date(b) : b
  if (Number.isNaN(da.getTime()) || Number.isNaN(db.getTime())) return false
  return da.getUTCFullYear() === db.getUTCFullYear() && da.getUTCMonth() === db.getUTCMonth()
}

/** The months of a range that are strictly before the current month. */
export function pastMonthsOf(range: ResolvedDateRange, now: Date = new Date()): string[] {
  const currentMonth = monthKey(now)
  return range.months.filter((m) => m < currentMonth)
}
