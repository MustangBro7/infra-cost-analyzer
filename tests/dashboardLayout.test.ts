import assert from "node:assert/strict"
import test from "node:test"
import {
  DEFAULT_DASHBOARD_LAYOUT,
  clampDashboardWidgetSpan,
  cycleDashboardWidgetSize,
  dashboardWidgetSpanFromRatio,
  dashboardWidgetSizeFromRatio,
  moveDashboardWidget,
  moveDashboardWidgetRelative,
  nudgeDashboardWidgetSpan,
  normalizeDashboardLayout,
  setDashboardWidgetSpan,
  setDashboardWidgetSize,
} from "../src/lib/dashboardLayout"

test("normalizeDashboardLayout preserves valid order and fills missing widgets", () => {
  const layout = normalizeDashboardLayout([
    { id: "ai", span: 4 },
    { id: "cloud", span: 9 },
  ])
  assert.deepEqual(layout.slice(0, 2), [
    { id: "ai", span: 4 },
    { id: "cloud", span: 9 },
  ])
  assert.equal(layout.length, DEFAULT_DASHBOARD_LAYOUT.length)
  assert.deepEqual(new Set(layout.map((entry) => entry.id)), new Set(DEFAULT_DASHBOARD_LAYOUT.map((entry) => entry.id)))
})

test("normalizeDashboardLayout migrates legacy preset sizes to column spans", () => {
  const layout = normalizeDashboardLayout([
    { id: "ai", size: "compact" },
    { id: "cloud", size: "wide" },
  ])
  assert.deepEqual(layout.slice(0, 2), [
    { id: "ai", span: 3 },
    { id: "cloud", span: 8 },
  ])
})

test("normalizeDashboardLayout rejects unknown, duplicate, and invalid values", () => {
  const layout = normalizeDashboardLayout([
    { id: "cloud", span: 200 },
    { id: "cloud", span: 3 },
    { id: "unknown", size: "full" },
    null,
  ])
  assert.deepEqual(layout[0], { id: "cloud", span: 12 })
  assert.equal(layout.filter((entry) => entry.id === "cloud").length, 1)
  assert.equal(layout.length, DEFAULT_DASHBOARD_LAYOUT.length)
})

test("dashboard widgets move and resize without losing other layout state", () => {
  const moved = moveDashboardWidget(DEFAULT_DASHBOARD_LAYOUT, "history", 1)
  assert.equal(moved[1].id, "history")
  const resized = cycleDashboardWidgetSize(moved, "history")
  assert.deepEqual(resized[1], { id: "history", span: 3 })
  assert.equal(resized.length, DEFAULT_DASHBOARD_LAYOUT.length)
})

test("pointer resize ratios preserve legacy preset helper and snap to column spans", () => {
  assert.equal(dashboardWidgetSizeFromRatio(0.25), "compact")
  assert.equal(dashboardWidgetSizeFromRatio(0.5), "medium")
  assert.equal(dashboardWidgetSizeFromRatio(0.67), "wide")
  assert.equal(dashboardWidgetSizeFromRatio(0.95), "full")
  assert.equal(dashboardWidgetSpanFromRatio(0.1), 3)
  assert.equal(dashboardWidgetSpanFromRatio(0.5), 6)
  assert.equal(dashboardWidgetSpanFromRatio(0.67), 8)
  assert.equal(dashboardWidgetSpanFromRatio(0.95), 11)
  assert.equal(dashboardWidgetSpanFromRatio(1.4), 12)
  const resized = setDashboardWidgetSize(DEFAULT_DASHBOARD_LAYOUT, "cloud", "medium")
  assert.equal(resized.find((entry) => entry.id === "cloud")?.span, 6)
})

test("dashboard widget spans clamp and nudge one column at a time", () => {
  assert.equal(clampDashboardWidgetSpan(1), 3)
  assert.equal(clampDashboardWidgetSpan(14), 12)
  assert.equal(clampDashboardWidgetSpan(7.4), 7)

  const compact = setDashboardWidgetSpan(DEFAULT_DASHBOARD_LAYOUT, "cloud", 3)
  assert.equal(compact.find((entry) => entry.id === "cloud")?.span, 3)
  assert.equal(nudgeDashboardWidgetSpan(compact, "cloud", -1).find((entry) => entry.id === "cloud")?.span, 3)
  assert.equal(nudgeDashboardWidgetSpan(compact, "cloud", 2).find((entry) => entry.id === "cloud")?.span, 5)
})

test("pointer movement remains stable on the same target", () => {
  const afterCloud = moveDashboardWidgetRelative(DEFAULT_DASHBOARD_LAYOUT, "attention", "cloud", true)
  const cloudIndex = afterCloud.findIndex((entry) => entry.id === "cloud")
  assert.deepEqual(afterCloud.slice(cloudIndex, cloudIndex + 2).map((entry) => entry.id), ["cloud", "attention"])
  assert.deepEqual(
    moveDashboardWidgetRelative(afterCloud, "attention", "cloud", true),
    afterCloud
  )

  const beforeCloud = moveDashboardWidgetRelative(DEFAULT_DASHBOARD_LAYOUT, "usage", "cloud", false)
  const beforeCloudIndex = beforeCloud.findIndex((entry) => entry.id === "usage")
  assert.deepEqual(beforeCloud.slice(beforeCloudIndex, beforeCloudIndex + 2).map((entry) => entry.id), ["usage", "cloud"])
  assert.deepEqual(
    moveDashboardWidgetRelative(beforeCloud, "usage", "cloud", false),
    beforeCloud
  )
})
