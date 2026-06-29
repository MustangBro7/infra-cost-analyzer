// Route-level loading UI. Next renders this instantly on navigation while the
// dashboard server component awaits its data, so the user sees the real shell
// (sidebar + header) immediately and a shimmering content region instead of a
// frozen page. The markup reuses the .amb-* shell classes for pixel-faithful
// layout; the data region is replaced by skeletons.

const NAV_ITEMS = ["Projects", "Limits", "Leaks", "AI spend", "Insights", "Connect"]

export default function DashboardLoading() {
  return (
    <main className="amb-app" aria-busy="true">
      <aside className="amb-sidebar">
        <div className="amb-brand">
          <span className="amb-brand-mark" aria-hidden />
          <span className="amb-brand-name">Ambrium</span>
          <span className="amb-brand-beta">BETA</span>
        </div>
        <div className="amb-workspace">
          <span className="amb-workspace-avatar amb-skel" />
          <span className="amb-skel amb-skel-bar" style={{ width: 96 }} />
        </div>
        <nav className="amb-nav" aria-label="Sections">
          {NAV_ITEMS.map((label) => (
            <span key={label} className="amb-nav-item">
              <span className="amb-skel" style={{ width: 16, height: 16 }} aria-hidden />
              <span className="amb-nav-label">{label}</span>
            </span>
          ))}
        </nav>
      </aside>
      <div className="amb-main">
        <header className="amb-header">
          <div className="amb-header-inner">
            <h1 className="amb-skel amb-skel-bar" style={{ width: 160, height: 22 }} />
            <div className="amb-header-actions">
              <span className="amb-skel amb-skel-bar" style={{ width: 120, height: 28 }} />
            </div>
          </div>
        </header>
        <div className="amb-content">
          <div className="amb-skel-kpis">
            <div className="amb-skel amb-skel-kpi" />
            <div className="amb-skel amb-skel-kpi" />
            <div className="amb-skel amb-skel-kpi" />
            <div className="amb-skel amb-skel-kpi" />
          </div>
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="amb-skel amb-skel-row" />
          ))}
        </div>
      </div>
    </main>
  )
}
