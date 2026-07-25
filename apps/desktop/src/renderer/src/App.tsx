import {
  AlertTriangle,
  LoaderCircle
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { BrandIcon } from './components/BrandIcon'
import { useSidebarResize } from './hooks/useSidebarResize'
import {
  TOOL_DOCK_MAX_WIDTH,
  getRenderedToolDockWidth,
  getToolDockMinimumWidth
} from './lib/surface-tool-dock'
import { SettingsPanel, type SettingsSectionId } from './components/SettingsPanel'
import { AgentStatusBar } from './components/AgentStatusBar'
import { ProjectRailToolbar } from './components/ProjectRailToolbar'
import { QuickSwitcher } from './components/QuickSwitcher'
import { isQuickSwitchShortcut } from './lib/quick-switch-shortcut'
import { SurfaceSwitch, TopRowLeadingChrome } from './components/TopRowChrome'
import { WorkspaceBoard } from './components/WorkspaceBoard'
import { WorkspaceSidebar } from './components/WorkspaceSidebar'
import { SurfaceToolDock } from './components/SurfaceToolDock'
import { WorkspaceWorkbench } from './components/WorkspaceWorkbench'
import { api } from './lib/api'
import { useAppStore } from './store'

export function App() {
  const [settingsRoute, setSettingsRoute] = useState<{ section: SettingsSectionId } | null>(null)
  const [windowResizeActive, setWindowResizeActive] = useState(false)
  const [quickSwitchOpen, setQuickSwitchOpen] = useState(false)
  const initialize = useAppStore((state) => state.initialize)
  const loading = useAppStore((state) => state.loading)
  const error = useAppStore((state) => state.error)
  const config = useAppStore((state) => state.config)
  const activeWorkspaceId = useAppStore((state) => state.activeWorkspaceId)
  const mainSurface = useAppStore((state) => state.mainSurface)
  const projectRailOpen = useAppStore((state) => state.projectRailOpen)
  const toolsOpen = useAppStore((state) => state.toolsOpen)
  const toolDockWidth = useAppStore((state) => state.toolDockWidth)
  const setToolDockWidth = useAppStore((state) => state.setToolDockWidth)
  const workspace = config?.workspaces.find((item) => item.id === activeWorkspaceId)
  const toolsAvailable = mainSurface === 'board' || Boolean(workspace)
  const toolsVisible = toolsAvailable && toolsOpen
  const toolDockMinimumWidth = getToolDockMinimumWidth(projectRailOpen)
  const renderedToolDockWidth = getRenderedToolDockWidth(toolDockWidth, projectRailOpen)
  // MERGE：workbench + workspace 时顶行下沉进 pane（root tabbar / chromeline），
  // 主区不再占用独立 topbar 行；Board 与欢迎页仍走顶栏。
  const mergedTopRow = mainSurface === 'workbench' && Boolean(workspace)
  const { containerRef, isResizing, onResizeStart } = useSidebarResize<HTMLDivElement>({
    isOpen: toolsVisible,
    width: toolDockWidth,
    minWidth: toolDockMinimumWidth,
    maxWidth: TOOL_DOCK_MAX_WIDTH,
    deltaSign: 1,
    setWidth: setToolDockWidth
  })

  useEffect(() => {
    let cancelled = false
    let dispose = () => {}
    void initialize().then((value) => {
      if (cancelled) value()
      else dispose = value
    })
    return () => {
      cancelled = true
      dispose()
    }
  }, [initialize])

  useEffect(() => api.ui.onWindowResize(({ active }) => setWindowResizeActive(active)), [])

  // The window's only global navigation gesture. Captured at the window so it fires before the
  // focused xterm textarea can swallow the keystroke; the toggle lets the same chord dismiss.
  useEffect(() => {
    const isMac = navigator.userAgent.includes('Mac')
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isQuickSwitchShortcut(event, isMac)) return
      event.preventDefault()
      setQuickSwitchOpen((current) => !current)
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [])

  if (loading) {
    return (
      <div className="boot" role="status" aria-live="polite">
        <span className="brand-mark"><BrandIcon size={18} /></span>
        <strong>Starting AgentMux</strong>
        <span className="boot__progress"><LoaderCircle className="spin" size={13} /> Starting the local Runtime…</span>
        <small>This is a normal startup state.</small>
      </div>
    )
  }

  if (!config && error) {
    return (
      <div className="boot boot--error" role="alert">
        <AlertTriangle size={22} />
        <strong>Runtime connection failed</strong>
        <span>{error}</span>
        <button className="small-button" onClick={() => window.location.reload()}>Retry startup</button>
      </div>
    )
  }

  if (settingsRoute) return (
    <SettingsPanel
      initialSection={settingsRoute.section}
      onClose={() => setSettingsRoute(null)}
    />
  )

  return (
    <div className={`app-shell ${projectRailOpen ? '' : 'app-shell--project-rail-collapsed'}`}>
      {projectRailOpen ? (
        <WorkspaceSidebar
          onOpenSettings={(section) => setSettingsRoute({ section })}
        />
      ) : (
        <ProjectRailToolbar
          collapsed
          onOpenSettings={(section) => setSettingsRoute({ section })}
        />
      )}
      <main className={`main-shell ${mergedTopRow ? 'main-shell--merged' : ''}`}>
        {!mergedTopRow ? (
          <header className="topbar">
            <TopRowLeadingChrome />
            <div className="topbar__actions">
              <SurfaceSwitch />
            </div>
          </header>
        ) : null}
        {!workspace && mainSurface === 'workbench' ? (
          <section className="welcome">
            <span className="brand-mark brand-mark--large"><BrandIcon size={34} /></span>
            <div className="eyebrow">Terminal-first agent workbench</div>
            <h1>Bring a workspace.<br />Keep the agents visible.</h1>
            <p>Add a local folder from the sidebar, or configure an SSH host and remote path.</p>
            <button className="primary-button" onClick={() => setSettingsRoute({ section: 'hosts' })}>Configure a host</button>
          </section>
        ) : (
          <div className="workbench-shell">
            {toolsVisible ? (
              <div
                ref={containerRef}
                className={`surface-tool-dock ${isResizing ? 'surface-tool-dock--resizing' : ''}`}
                data-surface-tool-dock
              >
                <SurfaceToolDock surface={mainSurface} workspace={workspace} />
                <div
                  className="surface-tool-width-handle"
                  role="separator"
                  aria-label="Resize surface tools"
                  aria-orientation="vertical"
                  aria-valuemin={toolDockMinimumWidth}
                  aria-valuemax={TOOL_DOCK_MAX_WIDTH}
                  aria-valuenow={renderedToolDockWidth}
                  tabIndex={0}
                  onMouseDown={onResizeStart}
                  onKeyDown={(event) => {
                    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
                    event.preventDefault()
                    setToolDockWidth(
                      renderedToolDockWidth + (event.key === 'ArrowRight' ? 16 : -16)
                    )
                  }}
                />
              </div>
            ) : null}
            <section className="workspace-main-surface">
              {mainSurface === 'board'
                ? <WorkspaceBoard />
                : workspace ? (
                  <WorkspaceWorkbench
                    workspaceId={workspace.id}
                    interactiveResize={windowResizeActive || isResizing}
                  />
                ) : null}
            </section>
          </div>
        )}
        {error ? <div className="error-toast"><AlertTriangle size={14} /><span>{error}</span></div> : null}
      </main>
      <AgentStatusBar />
      <QuickSwitcher open={quickSwitchOpen} onClose={() => setQuickSwitchOpen(false)} />
    </div>
  )
}
