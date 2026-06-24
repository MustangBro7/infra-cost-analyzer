import assert from "node:assert/strict"
import test from "node:test"
import {
  DEFAULT_DASHBOARD_LAYOUT,
  cycleDashboardWidgetSize,
  moveDashboardWidget,
  normalizeDashboardLayout,
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
