export const DASHBOARD_WIDGET_IDS = ["attention", "cloud", "usage", "spend", "ai", "history"] as const
export type DashboardWidgetId = (typeof DASHBOARD_WIDGET_IDS)[number]
export const DASHBOARD_WIDGET_SIZES = ["compact", "medium", "wide", "full"] as const
export type DashboardWidgetSize = (typeof DASHBOARD_WIDGET_SIZES)[number]

export interface DashboardWidgetLayout {
  id: DashboardWidgetId
  size: DashboardWidgetSize
}

export const DEFAULT_DASHBOARD_LAYOUT: DashboardWidgetLayout[] = [
  { id: "attention", size: "full" },
  { id: "cloud", size: "full" },
  { id: "usage", size: "medium" },
  { id: "spend", size: "medium" },
  { id: "ai", size: "full" },
  { id: "history", size: "full" },
]

const ids = new Set<string>(DASHBOARD_WIDGET_IDS)
const sizes = new Set<string>(DASHBOARD_WIDGET_SIZES)

export function normalizeDashboardLayout(value: unknown): DashboardWidgetLayout[] {
  const input = Array.isArray(value) ? value : []
  const seen = new Set<DashboardWidgetId>()
  const valid: DashboardWidgetLayout[] = []

  for (const entry of input) {
    if (!entry || typeof entry !== "object") continue
    const id = (entry as { id?: unknown }).id
    const size = (entry as { size?: unknown }).size
    if (typeof id !== "string" || !ids.has(id) || seen.has(id as DashboardWidgetId)) continue
    valid.push({
      id: id as DashboardWidgetId,
      size: typeof size === "string" && sizes.has(size) ? size as DashboardWidgetSize : "full",
    })
    seen.add(id as DashboardWidgetId)
  }

  for (const entry of DEFAULT_DASHBOARD_LAYOUT) {
    if (!seen.has(entry.id)) valid.push({ ...entry })
  }
  return valid
}

export function moveDashboardWidget(
  layout: DashboardWidgetLayout[],
  id: DashboardWidgetId,
  targetIndex: number
): DashboardWidgetLayout[] {
  const normalized = normalizeDashboardLayout(layout)
  const from = normalized.findIndex((entry) => entry.id === id)
  if (from < 0) return normalized
  const to = Math.max(0, Math.min(targetIndex, normalized.length - 1))
  if (from === to) return normalized
  const next = [...normalized]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

export function moveDashboardWidgetRelative(
  layout: DashboardWidgetLayout[],
  id: DashboardWidgetId,
  targetId: DashboardWidgetId,
  after: boolean
): DashboardWidgetLayout[] {
  const normalized = normalizeDashboardLayout(layout)
  const from = normalized.findIndex((entry) => entry.id === id)
  const target = normalized.findIndex((entry) => entry.id === targetId)
  if (from < 0 || target < 0 || from === target) return normalized

  const targetIndex = target + (after ? (from > target ? 1 : 0) : (from < target ? -1 : 0))
  return moveDashboardWidget(normalized, id, targetIndex)
}

export function cycleDashboardWidgetSize(
  layout: DashboardWidgetLayout[],
  id: DashboardWidgetId
): DashboardWidgetLayout[] {
  return normalizeDashboardLayout(layout).map((entry) => {
    if (entry.id !== id) return entry
    const index = DASHBOARD_WIDGET_SIZES.indexOf(entry.size)
    return { ...entry, size: DASHBOARD_WIDGET_SIZES[(index + 1) % DASHBOARD_WIDGET_SIZES.length] }
  })
}

export function setDashboardWidgetSize(
  layout: DashboardWidgetLayout[],
  id: DashboardWidgetId,
  size: DashboardWidgetSize
): DashboardWidgetLayout[] {
  return normalizeDashboardLayout(layout).map((entry) => entry.id === id ? { ...entry, size } : entry)
}

export function dashboardWidgetSizeFromRatio(ratio: number): DashboardWidgetSize {
  const value = Math.max(0, Math.min(ratio, 1))
  if (value < 0.375) return "compact"
  if (value < 0.585) return "medium"
  if (value < 0.835) return "wide"
  return "full"
}
