import assert from "node:assert/strict"
import test from "node:test"
import {
  DEFAULT_DASHBOARD_LAYOUT,
  cycleDashboardWidgetSize,
  dashboardWidgetSizeFromRatio,
  moveDashboardWidget,
  moveDashboardWidgetRelative,
  normalizeDashboardLayout,
  setDashboardWidgetSize,
} from "../src/lib/dashboardLayout"

test("normalizeDashboardLayout preserves valid order and fills missing widgets", () => {
  const layout = normalizeDashboardLayout([
    { id: "ai", size: "compact" },
    { id: "cloud", size: "wide" },
  ])
  assert.deepEqual(layout.slice(0, 2), [
    { id: "ai", size: "compact" },
    { id: "cloud", size: "wide" },
  ])
  assert.equal(layout.length, DEFAULT_DASHBOARD_LAYOUT.length)
  assert.deepEqual(new Set(layout.map((entry) => entry.id)), new Set(DEFAULT_DASHBOARD_LAYOUT.map((entry) => entry.id)))
})

test("normalizeDashboardLayout rejects unknown, duplicate, and invalid values", () => {
  const layout = normalizeDashboardLayout([
    { id: "cloud", size: "nope" },
    { id: "cloud", size: "compact" },
    { id: "unknown", size: "full" },
    null,
  ])
  assert.deepEqual(layout[0], { id: "cloud", size: "full" })
  assert.equal(layout.filter((entry) => entry.id === "cloud").length, 1)
  assert.equal(layout.length, DEFAULT_DASHBOARD_LAYOUT.length)
})

test("dashboard widgets move and resize without losing other layout state", () => {
  const moved = moveDashboardWidget(DEFAULT_DASHBOARD_LAYOUT, "history", 1)
  assert.equal(moved[1].id, "history")
  const resized = cycleDashboardWidgetSize(moved, "history")
  assert.deepEqual(resized[1], { id: "history", size: "compact" })
  assert.equal(resized.length, DEFAULT_DASHBOARD_LAYOUT.length)
})

test("pointer resize ratios snap to supported dashboard widths", () => {
  assert.equal(dashboardWidgetSizeFromRatio(0.25), "compact")
  assert.equal(dashboardWidgetSizeFromRatio(0.5), "medium")
  assert.equal(dashboardWidgetSizeFromRatio(0.67), "wide")
  assert.equal(dashboardWidgetSizeFromRatio(0.95), "full")
  const resized = setDashboardWidgetSize(DEFAULT_DASHBOARD_LAYOUT, "cloud", "medium")
  assert.equal(resized.find((entry) => entry.id === "cloud")?.size, "medium")
})

test("pointer movement remains stable on the same target", () => {
  const afterCloud = moveDashboardWidgetRelative(DEFAULT_DASHBOARD_LAYOUT, "attention", "cloud", true)
  assert.deepEqual(afterCloud.slice(0, 2).map((entry) => entry.id), ["cloud", "attention"])
  assert.deepEqual(
    moveDashboardWidgetRelative(afterCloud, "attention", "cloud", true),
    afterCloud
  )

  const beforeCloud = moveDashboardWidgetRelative(DEFAULT_DASHBOARD_LAYOUT, "usage", "cloud", false)
  assert.deepEqual(beforeCloud.slice(0, 3).map((entry) => entry.id), ["attention", "usage", "cloud"])
  assert.deepEqual(
    moveDashboardWidgetRelative(beforeCloud, "usage", "cloud", false),
    beforeCloud
  )
})
