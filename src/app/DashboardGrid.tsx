"use client"

import * as React from "react"
import { ArrowDown, ArrowUp, GripVertical, Loader2, Maximize2, RotateCcw } from "lucide-react"
import {
  DEFAULT_DASHBOARD_LAYOUT,
  cycleDashboardWidgetSize,
  moveDashboardWidget,
  normalizeDashboardLayout,
  type DashboardWidgetId,
  type DashboardWidgetLayout,
} from "@/lib/dashboardLayout"

export interface DashboardWidgetDefinition {
  id: DashboardWidgetId
  title: string
  content: React.ReactNode
}

export function DashboardGrid({
  initialLayout,
  widgets,
}: {
  initialLayout: DashboardWidgetLayout[]
  widgets: DashboardWidgetDefinition[]
}) {
  const [layout, setLayout] = React.useState(() => normalizeDashboardLayout(initialLayout))
  const [saving, setSaving] = React.useState(false)
  const [message, setMessage] = React.useState<string | null>(null)
  const [dragging, setDragging] = React.useState<DashboardWidgetId | null>(null)
  const saveTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveInFlight = React.useRef(false)
  const queuedLayout = React.useRef<DashboardWidgetLayout[] | null>(null)
  const widgetMap = React.useMemo(() => new Map(widgets.map((widget) => [widget.id, widget])), [widgets])

  React.useEffect(() => () => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
  }, [])

  const saveLayout = React.useCallback(async (next: DashboardWidgetLayout[]) => {
    if (saveInFlight.current) {
      queuedLayout.current = next
      return
    }
    saveInFlight.current = true
    setSaving(true)
    try {
      const response = await fetch("/api/dashboard-layout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ layout: next }),
      })
      if (!response.ok) throw new Error("Could not save layout.")
      setMessage("Layout saved")
    } catch {
      setMessage("Layout save failed")
    } finally {
      saveInFlight.current = false
      const queued = queuedLayout.current
      queuedLayout.current = null
      if (queued) {
        void saveLayout(queued)
      } else {
        setSaving(false)
      }
    }
  }, [])

  const persist = React.useCallback((next: DashboardWidgetLayout[]) => {
    setLayout(next)
    setSaving(true)
    setMessage(null)
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null
      void saveLayout(next)
    }, 350)
  }, [saveLayout])

  function move(id: DashboardWidgetId, delta: number) {
    const index = layout.findIndex((entry) => entry.id === id)
    const target = index + delta
    if (index < 0 || target < 0 || target >= layout.length) return
    persist(moveDashboardWidget(layout, id, target))
  }

  function dropOn(targetId: DashboardWidgetId) {
    if (!dragging || dragging === targetId) return setDragging(null)
    const from = layout.findIndex((entry) => entry.id === dragging)
    const to = layout.findIndex((entry) => entry.id === targetId)
    if (from < 0 || to < 0) return setDragging(null)
    setDragging(null)
    persist(moveDashboardWidget(layout, dragging, to))
  }

  return (
    <section className="dashboard-layout" aria-label="Customizable dashboard widgets">
      <div className="dashboard-layout-toolbar">
        <div>
          <strong>Dashboard layout</strong>
          <span>Drag widgets to reorder. Resize cycles through compact, medium, wide, and full.</span>
        </div>
        <div>
          <span className="dashboard-layout-status" role="status">
            {saving ? <><Loader2 className="spin" aria-hidden /> Saving</> : message}
          </span>
          <button type="button" className="ghost-button" onClick={() => persist(DEFAULT_DASHBOARD_LAYOUT.map((entry) => ({ ...entry })))}>
            <RotateCcw aria-hidden /> Reset
          </button>
        </div>
      </div>

      <div className="dashboard-widget-grid">
        {layout.map((entry, index) => {
          const widget = widgetMap.get(entry.id)
          if (!widget) return null
          return (
            <article
              key={entry.id}
              className={`dashboard-widget size-${entry.size}${dragging === entry.id ? " dragging" : ""}`}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => dropOn(entry.id)}
            >
              <div className="dashboard-widget-controls">
                <span
                  className="dashboard-widget-drag"
                  title="Drag to move"
                  draggable
                  onDragStart={() => setDragging(entry.id)}
                  onDragEnd={() => setDragging(null)}
                >
                  <GripVertical aria-hidden />
                  <span>{widget.title}</span>
                </span>
                <div>
                  <button type="button" onClick={() => move(entry.id, -1)} disabled={index === 0} aria-label={`Move ${widget.title} earlier`}>
                    <ArrowUp aria-hidden />
                  </button>
                  <button type="button" onClick={() => move(entry.id, 1)} disabled={index === layout.length - 1} aria-label={`Move ${widget.title} later`}>
                    <ArrowDown aria-hidden />
                  </button>
                  <button
                    type="button"
                    onClick={() => persist(cycleDashboardWidgetSize(layout, entry.id))}
                    aria-label={`Resize ${widget.title}; current size ${entry.size}`}
                    title={`Resize: ${entry.size}`}
                  >
                    <Maximize2 aria-hidden />
                    <span>{entry.size}</span>
                  </button>
                </div>
              </div>
              <div className="dashboard-widget-content">{widget.content}</div>
            </article>
          )
        })}
      </div>
    </section>
  )
}
