import {
  AlertTriangle,
  LayoutDashboard,
  PanelLeftClose,
  PanelLeftOpen,
  RadioTower,
  SquareTerminal
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { BrandIcon } from './components/BrandIcon'
import { useSidebarResize } from './hooks/useSidebarResize'
import {
  TOOL_DOCK_MAX_WIDTH,
  TOOL_DOCK_MIN_WIDTH
} from './lib/surface-tool-dock'
import { projectWorkspaces } from './lib/workspace-projects'
import { SettingsPanel, type SettingsSectionId } from './components/SettingsPanel'
import { WorkspaceBoard } from './components/WorkspaceBoard'
import { WorkspaceSidebar } from './components/WorkspaceSidebar'
import { SurfaceToolDock } from './components/SurfaceToolDock'
import { WorkspaceWorkbench } from './components/WorkspaceWorkbench'
import { useAppStore } from './store'

export function App() {
  const [settingsRoute, setSettingsRoute] = useState<{ section: SettingsSectionId } | null>(null)
  const initialize = useAppStore((state) => state.initialize)
  const loading = useAppStore((state) => state.loading)
  const error = useAppStore((state) => state.error)
  const config = useAppStore((state) => state.config)
  const activeWorkspaceId = useAppStore((state) => state.activeWorkspaceId)
  const mainSurface = useAppStore((state) => state.mainSurface)
  const toolsOpen = useAppStore((state) => state.toolsOpen)
  const toolDockWidth = useAppStore((state) => state.toolDockWidth)
  const setMainSurface = useAppStore((state) => state.setMainSurface)
  const toggleTools = useAppStore((state) => state.toggleTools)
  const setToolDockWidth = useAppStore((state) => state.setToolDockWidth)
  const workspace = config?.workspaces.find((item) => item.id === activeWorkspaceId)
  const project = projectWorkspaces(config?.workspaces ?? []).find((candidate) =>
    candidate.workspaces.some((item) => item.id === activeWorkspaceId)
  )
  const toolsAvailable = mainSurface === 'board' || Boolean(workspace)
  const toolsVisible = toolsAvailable && toolsOpen
  const { containerRef, isResizing, onResizeStart } = useSidebarResize<HTMLDivElement>({
    isOpen: toolsVisible,
    width: toolDockWidth,
    minWidth: TOOL_DOCK_MIN_WIDTH,
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

  if (loading) {
    return (
      <div className="boot">
        <span className="brand-mark"><BrandIcon size={18} /></span>
        <strong>Starting AgentMux</strong>
        <span>Connecting to tmux runtime…</span>
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
    <div className="app-shell">
      <WorkspaceSidebar
        onOpenSettings={() => setSettingsRoute({ section: 'general' })}
      />
      <main className="main-shell">
        <header className="topbar">
          <div className="topbar__leading">
            <button
              className={`icon-button topbar-tools-button ${toolsOpen ? 'topbar-tools-button--active' : ''}`}
              aria-label={`${toolsOpen ? 'Hide' : 'Show'} ${mainSurface === 'board' ? 'board' : 'workspace'} tools`}
              title={`${toolsOpen ? 'Hide' : 'Show'} ${mainSurface === 'board' ? 'board' : 'workspace'} tools`}
              aria-pressed={toolsOpen}
              data-surface-tools-toggle
              disabled={!toolsAvailable}
              onClick={toggleTools}
            >
              {toolsOpen ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}
            </button>
            <div className="breadcrumbs">
              <strong>{mainSurface === 'board' ? 'Board' : (workspace?.name ?? 'Workspace')}</strong>
              {mainSurface === 'board' && project
                ? <><span>/</span><span>{project.name}</span></>
                : workspace ? <><span>/</span><span>{workspace.branch ?? workspace.path}</span></> : null}
              {(mainSurface === 'board' ? project?.hostId : workspace?.hostId) !== 'local' ? (
                <span className="host-pill"><RadioTower size={11} /> {mainSurface === 'board' ? project?.hostId : workspace?.hostId}</span>
              ) : null}
            </div>
          </div>
          <div className="topbar__actions">
            <div className="surface-switch" role="group" aria-label="Main view">
              <button className={mainSurface === 'workbench' ? 'selected' : ''} onClick={() => setMainSurface('workbench')}><SquareTerminal size={13} /> Workspace</button>
              <button className={mainSurface === 'board' ? 'selected' : ''} onClick={() => setMainSurface('board')}><LayoutDashboard size={13} /> Board</button>
            </div>
          </div>
        </header>
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
                  aria-valuemin={TOOL_DOCK_MIN_WIDTH}
                  aria-valuemax={TOOL_DOCK_MAX_WIDTH}
                  aria-valuenow={toolDockWidth}
                  tabIndex={0}
                  onMouseDown={onResizeStart}
                  onKeyDown={(event) => {
                    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
                    event.preventDefault()
                    setToolDockWidth(
                      toolDockWidth + (event.key === 'ArrowRight' ? 16 : -16)
                    )
                  }}
                />
              </div>
            ) : null}
            <section className="workspace-main-surface">
              {mainSurface === 'board'
                ? <WorkspaceBoard />
                : workspace ? <WorkspaceWorkbench workspaceId={workspace.id} /> : null}
            </section>
          </div>
        )}
        {error ? <div className="error-toast"><AlertTriangle size={14} /><span>{error}</span></div> : null}
      </main>
    </div>
  )
}
