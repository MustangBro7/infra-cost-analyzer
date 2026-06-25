"use client"

import * as React from "react"
import { GripVertical, Loader2, RotateCcw } from "lucide-react"
import {
  DEFAULT_DASHBOARD_LAYOUT,
  cycleDashboardWidgetSize,
  dashboardWidgetSizeFromRatio,
  moveDashboardWidget,
  moveDashboardWidgetRelative,
  normalizeDashboardLayout,
  setDashboardWidgetSize,
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
  const [resizing, setResizing] = React.useState<DashboardWidgetId | null>(null)
  const saveTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveInFlight = React.useRef(false)
  const queuedLayout = React.useRef<DashboardWidgetLayout[] | null>(null)
  const layoutRef = React.useRef(layout)
  const gridRef = React.useRef<HTMLDivElement | null>(null)
  const pointerRef = React.useRef<
    | { type: "move"; id: DashboardWidgetId; changed: boolean }
    | { type: "resize"; id: DashboardWidgetId; startX: number; startWidth: number; changed: boolean }
    | null
  >(null)
  const widgetMap = React.useMemo(() => new Map(widgets.map((widget) => [widget.id, widget])), [widgets])

  React.useEffect(() => {
    layoutRef.current = layout
  }, [layout])

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

  function beginMove(event: React.PointerEvent, id: DashboardWidgetId) {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    pointerRef.current = { type: "move", id, changed: false }
    setDragging(id)
    setMessage(null)
  }

  function beginResize(event: React.PointerEvent, id: DashboardWidgetId) {
    if (event.button !== 0) return
    const widget = event.currentTarget.closest<HTMLElement>("[data-dashboard-widget]")
    if (!widget) return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    pointerRef.current = {
      type: "resize",
      id,
      startX: event.clientX,
      startWidth: widget.getBoundingClientRect().width,
      changed: false,
    }
    setResizing(id)
    setMessage(null)
  }

  function handlePointerMove(event: React.PointerEvent) {
    const pointer = pointerRef.current
    if (!pointer) return
    event.preventDefault()

    if (pointer.type === "move") {
      const target = document
        .elementsFromPoint(event.clientX, event.clientY)
        .map((element) => element.closest<HTMLElement>("[data-dashboard-widget]"))
        .find((element): element is HTMLElement => Boolean(element))
      if (!target) return
      const targetId = target.dataset.dashboardWidget as DashboardWidgetId | undefined
      if (!targetId || targetId === pointer.id) return
      const rect = target.getBoundingClientRect()
      const gridWidth = gridRef.current?.getBoundingClientRect().width ?? rect.width
      const after = rect.width < gridWidth * 0.9
        ? event.clientX > rect.left + rect.width / 2
        : event.clientY > rect.top + rect.height / 2
      const next = moveDashboardWidgetRelative(layoutRef.current, pointer.id, targetId, after)
      if (next.findIndex((entry) => entry.id === pointer.id) === layoutRef.current.findIndex((entry) => entry.id === pointer.id)) {
        return
      }
      pointer.changed = true
      layoutRef.current = next
      setLayout(next)
      return
    }

    const gridWidth = gridRef.current?.getBoundingClientRect().width ?? 0
    if (gridWidth <= 0) return
    const desiredWidth = pointer.startWidth + event.clientX - pointer.startX
    const size = dashboardWidgetSizeFromRatio(desiredWidth / gridWidth)
    const current = layoutRef.current.find((entry) => entry.id === pointer.id)
    if (!current || current.size === size) return
    const next = setDashboardWidgetSize(layoutRef.current, pointer.id, size)
    pointer.changed = true
    layoutRef.current = next
    setLayout(next)
  }

  function finishPointer(event: React.PointerEvent) {
    const pointer = pointerRef.current
    if (!pointer) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    pointerRef.current = null
    setDragging(null)
    setResizing(null)
    if (pointer.changed) persist(layoutRef.current)
  }

  function handleMoveKey(event: React.KeyboardEvent, id: DashboardWidgetId) {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return
    event.preventDefault()
    move(id, event.key === "ArrowUp" ? -1 : 1)
  }

  function handleResizeKey(event: React.KeyboardEvent, id: DashboardWidgetId) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
    event.preventDefault()
    if (event.key === "ArrowRight") {
      persist(cycleDashboardWidgetSize(layoutRef.current, id))
      return
    }
    const reversed = [...layoutRef.current]
    for (let index = 0; index < 3; index += 1) {
      const next = cycleDashboardWidgetSize(reversed, id)
      reversed.splice(0, reversed.length, ...next)
    }
    persist(reversed)
  }

  return (
    <section className="dashboard-layout" aria-label="Customizable dashboard widgets">
      <div className="dashboard-layout-toolbar">
        <div>
          <strong>Dashboard layout</strong>
          <span>Drag a widget header to move it. Drag its bottom-right corner to resize.</span>
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

      <div className="dashboard-widget-grid" ref={gridRef}>
        {layout.map((entry) => {
          const widget = widgetMap.get(entry.id)
          if (!widget) return null
          return (
            <article
              key={entry.id}
              data-dashboard-widget={entry.id}
              className={`dashboard-widget size-${entry.size}${dragging === entry.id ? " dragging" : ""}${resizing === entry.id ? " resizing" : ""}`}
            >
              <div className="dashboard-widget-controls">
                <button
                  type="button"
                  className="dashboard-widget-drag"
                  title="Drag to move. Use Up or Down arrow keys to move with the keyboard."
                  aria-label={`Move ${widget.title}`}
                  onPointerDown={(event) => beginMove(event, entry.id)}
                  onPointerMove={handlePointerMove}
                  onPointerUp={finishPointer}
                  onPointerCancel={finishPointer}
                  onKeyDown={(event) => handleMoveKey(event, entry.id)}
                >
                  <GripVertical aria-hidden />
                  <span>{widget.title}</span>
                </button>
                <span className="dashboard-widget-size">{entry.size}</span>
              </div>
              <div className="dashboard-widget-content">{widget.content}</div>
              <button
                type="button"
                className="dashboard-widget-resize"
                aria-label={`Resize ${widget.title}; current size ${entry.size}`}
                title="Drag to resize. Use Left or Right arrow keys to resize with the keyboard."
                onPointerDown={(event) => beginResize(event, entry.id)}
                onPointerMove={handlePointerMove}
                onPointerUp={finishPointer}
                onPointerCancel={finishPointer}
                onKeyDown={(event) => handleResizeKey(event, entry.id)}
              >
                <span aria-hidden />
              </button>
            </article>
          )
        })}
      </div>
    </section>
  )
}
