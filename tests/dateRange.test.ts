import test from "node:test"
import assert from "node:assert/strict"
import {
  currentMonthRange,
  pastMonthsOf,
  resolveDateRange,
  rowOverlapsRange,
  sameUtcMonth,
} from "../src/lib/dateRange"

// A fixed "now" mid-month, mid-quarter: 2026-07-02.
const NOW = new Date("2026-07-02T10:30:00Z")

test("defaults to the current calendar month", () => {
  for (const raw of [null, undefined, "", "bogus", "2026-13", "this-week"]) {
    const range = resolveDateRange(raw, NOW)
    assert.equal(range.from, "2026-07-01")
    assert.equal(range.to, "2026-07-31")
    assert.deepEqual(range.months, ["2026-07"])
    assert.equal(range.isCurrentMonthOnly, true)
    assert.equal(range.includesCurrentMonth, true)
  }
})

test("last-month resolves to the full previous calendar month", () => {
  const range = resolveDateRange("last-month", NOW)
  assert.equal(range.from, "2026-06-01")
  assert.equal(range.to, "2026-06-30")
  assert.deepEqual(range.months, ["2026-06"])
  assert.equal(range.includesCurrentMonth, false)
  assert.equal(range.label, "June 2026")
})

test("last-month crosses a year boundary", () => {
  const range = resolveDateRange("last-month", new Date("2026-01-15T00:00:00Z"))
  assert.equal(range.from, "2025-12-01")
  assert.equal(range.to, "2025-12-31")
})

test("this-quarter covers the current calendar quarter", () => {
  const range = resolveDateRange("this-quarter", NOW)
  assert.equal(range.from, "2026-07-01")
  assert.equal(range.to, "2026-09-30")
  assert.deepEqual(range.months, ["2026-07", "2026-08", "2026-09"])
  assert.equal(range.label, "Q3 2026")
  assert.equal(range.includesCurrentMonth, true)
  assert.equal(range.isCurrentMonthOnly, false)
})

test("last-quarter covers the previous quarter, including across years", () => {
  const q2 = resolveDateRange("last-quarter", NOW)
  assert.equal(q2.from, "2026-04-01")
  assert.equal(q2.to, "2026-06-30")
  assert.equal(q2.label, "Q2 2026")

  const q4 = resolveDateRange("last-quarter", new Date("2026-02-10T00:00:00Z"))
  assert.equal(q4.from, "2025-10-01")
  assert.equal(q4.to, "2025-12-31")
  assert.equal(q4.label, "Q4 2025")
})

test("this-year covers January through December", () => {
  const range = resolveDateRange("this-year", NOW)
  assert.equal(range.from, "2026-01-01")
  assert.equal(range.to, "2026-12-31")
  assert.equal(range.months.length, 12)
})

test("last-6-months is a rolling window ending in the current month", () => {
  const range = resolveDateRange("last-6-months", NOW)
  assert.equal(range.from, "2026-02-01")
  assert.equal(range.to, "2026-07-31")
  assert.equal(range.months.length, 6)
  assert.equal(range.includesCurrentMonth, true)
})

test("an explicit YYYY-MM selects exactly that month", () => {
  const range = resolveDateRange("2026-03", NOW)
  assert.equal(range.from, "2026-03-01")
  assert.equal(range.to, "2026-03-31")
  assert.deepEqual(range.months, ["2026-03"])
  assert.equal(range.label, "March 2026")
  assert.equal(range.includesCurrentMonth, false)
})

test("February month-ends are correct, including leap years", () => {
  assert.equal(resolveDateRange("2026-02", NOW).to, "2026-02-28")
  assert.equal(resolveDateRange("2028-02", NOW).to, "2028-02-29")
})

test("rowOverlapsRange keeps last month's rows out of this month", () => {
  const july = currentMonthRange(NOW)
  const juneRow = { billingPeriodStart: "2026-06-01", billingPeriodEnd: "2026-06-30" }
  const julyRow = { billingPeriodStart: "2026-07-01", billingPeriodEnd: "2026-07-31" }
  const spanningRow = { billingPeriodStart: "2026-06-15", billingPeriodEnd: "2026-07-14" }
  assert.equal(rowOverlapsRange(juneRow, july), false)
  assert.equal(rowOverlapsRange(julyRow, july), true)
  assert.equal(rowOverlapsRange(spanningRow, july), true)
})

test("pastMonthsOf excludes the current month", () => {
  assert.deepEqual(pastMonthsOf(resolveDateRange("this-quarter", NOW), NOW), [])
  assert.deepEqual(pastMonthsOf(resolveDateRange("last-quarter", NOW), NOW), ["2026-04", "2026-05", "2026-06"])
  assert.deepEqual(pastMonthsOf(resolveDateRange("last-6-months", NOW), NOW), [
    "2026-02",
    "2026-03",
    "2026-04",
    "2026-05",
    "2026-06",
  ])
})

test("sameUtcMonth compares calendar months, not 30-day windows", () => {
  assert.equal(sameUtcMonth("2026-07-01T00:00:00Z", "2026-07-31T23:59:59Z"), true)
  assert.equal(sameUtcMonth("2026-06-30T23:59:59Z", "2026-07-01T00:00:00Z"), false)
  assert.equal(sameUtcMonth("2025-07-15T00:00:00Z", "2026-07-15T00:00:00Z"), false)
  assert.equal(sameUtcMonth("not-a-date", "2026-07-01T00:00:00Z"), false)
})
