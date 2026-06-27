export const DASHBOARD_WIDGET_IDS = ["projects", "runway", "leaks", "attention", "cloud", "usage", "spend", "ai", "history"] as const
export type DashboardWidgetId = (typeof DASHBOARD_WIDGET_IDS)[number]
export const DASHBOARD_WIDGET_SIZES = ["compact", "medium", "wide", "full"] as const
export type DashboardWidgetSize = (typeof DASHBOARD_WIDGET_SIZES)[number]
export const DASHBOARD_WIDGET_MIN_SPAN = 3
export const DASHBOARD_WIDGET_MAX_SPAN = 12

export interface DashboardWidgetLayout {
  id: DashboardWidgetId
  span: number
}

export const DEFAULT_DASHBOARD_LAYOUT: DashboardWidgetLayout[] = [
  { id: "projects", span: 12 },
  { id: "runway", span: 6 },
  { id: "leaks", span: 6 },
  { id: "attention", span: 12 },
  { id: "cloud", span: 12 },
  { id: "usage", span: 6 },
  { id: "spend", span: 6 },
  { id: "ai", span: 12 },
  { id: "history", span: 12 },
]

const ids = new Set<string>(DASHBOARD_WIDGET_IDS)
const sizes = new Set<string>(DASHBOARD_WIDGET_SIZES)
const legacySizeSpans: Record<DashboardWidgetSize, number> = {
  compact: 3,
  medium: 6,
  wide: 8,
  full: 12,
}

function isDashboardWidgetSize(value: unknown): value is DashboardWidgetSize {
  return typeof value === "string" && sizes.has(value)
}

export function clampDashboardWidgetSpan(value: unknown): number {
  const numeric = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : DASHBOARD_WIDGET_MAX_SPAN
  return Math.max(DASHBOARD_WIDGET_MIN_SPAN, Math.min(numeric, DASHBOARD_WIDGET_MAX_SPAN))
}

function dashboardWidgetSpanFromEntry(entry: object): number {
  const span = (entry as { span?: unknown }).span
  if (typeof span === "number" && Number.isFinite(span)) return clampDashboardWidgetSpan(span)
  const size = (entry as { size?: unknown }).size
  if (isDashboardWidgetSize(size)) return legacySizeSpans[size]
  return DASHBOARD_WIDGET_MAX_SPAN
}

export function normalizeDashboardLayout(value: unknown): DashboardWidgetLayout[] {
  const input = Array.isArray(value) ? value : []
  const seen = new Set<DashboardWidgetId>()
  const valid: DashboardWidgetLayout[] = []

  for (const entry of input) {
    if (!entry || typeof entry !== "object") continue
    const id = (entry as { id?: unknown }).id
    if (typeof id !== "string" || !ids.has(id) || seen.has(id as DashboardWidgetId)) continue
    valid.push({
      id: id as DashboardWidgetId,
      span: dashboardWidgetSpanFromEntry(entry),
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
    const currentLegacyIndex = DASHBOARD_WIDGET_SIZES.findIndex((size) => legacySizeSpans[size] >= entry.span)
    const index = currentLegacyIndex >= 0 ? currentLegacyIndex : DASHBOARD_WIDGET_SIZES.length - 1
    const size = DASHBOARD_WIDGET_SIZES[(index + 1) % DASHBOARD_WIDGET_SIZES.length]
    return { ...entry, span: legacySizeSpans[size] }
  })
}

export function setDashboardWidgetSize(
  layout: DashboardWidgetLayout[],
  id: DashboardWidgetId,
  size: DashboardWidgetSize
): DashboardWidgetLayout[] {
  return setDashboardWidgetSpan(layout, id, legacySizeSpans[size])
}

export function dashboardWidgetSizeFromRatio(ratio: number): DashboardWidgetSize {
  const value = Math.max(0, Math.min(ratio, 1))
  if (value < 0.375) return "compact"
  if (value < 0.585) return "medium"
  if (value < 0.835) return "wide"
  return "full"
}

export function dashboardWidgetSpanFromRatio(ratio: number): number {
  const value = typeof ratio === "number" && Number.isFinite(ratio) ? ratio : 1
  return clampDashboardWidgetSpan(Math.round(Math.max(0, Math.min(value, 1)) * DASHBOARD_WIDGET_MAX_SPAN))
}

export function setDashboardWidgetSpan(
  layout: DashboardWidgetLayout[],
  id: DashboardWidgetId,
  span: number
): DashboardWidgetLayout[] {
  const nextSpan = clampDashboardWidgetSpan(span)
  return normalizeDashboardLayout(layout).map((entry) => entry.id === id ? { ...entry, span: nextSpan } : entry)
}

export function nudgeDashboardWidgetSpan(
  layout: DashboardWidgetLayout[],
  id: DashboardWidgetId,
  delta: number
): DashboardWidgetLayout[] {
  const normalized = normalizeDashboardLayout(layout)
  const current = normalized.find((entry) => entry.id === id)
  if (!current) return normalized
  return setDashboardWidgetSpan(normalized, id, current.span + delta)
}
