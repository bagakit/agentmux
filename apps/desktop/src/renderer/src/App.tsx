import { AlertTriangle, GitBranchPlus, LayoutDashboard, Plus, RadioTower, Settings2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { AgentSession } from './components/AgentSession'
import { BrandIcon } from './components/BrandIcon'
import { CreateWorktreeDialog } from './components/CreateWorktreeDialog'
import { EditorPane } from './components/EditorPane'
import { FileExplorer } from './components/FileExplorer'
import { SettingsPanel } from './components/SettingsPanel'
import { StatusDot } from './components/StatusDot'
import { WorkspaceSidebar } from './components/WorkspaceSidebar'
import { WorkspaceBoard } from './components/WorkspaceBoard'
import { useAppStore } from './store'

export function App() {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [worktreeOpen, setWorktreeOpen] = useState(false)
  const initialize = useAppStore((state) => state.initialize)
  const loading = useAppStore((state) => state.loading)
  const error = useAppStore((state) => state.error)
  const config = useAppStore((state) => state.config)
  const sessions = useAppStore((state) => state.sessions)
  const activeWorkspaceId = useAppStore((state) => state.activeWorkspaceId)
  const activeSessionId = useAppStore((state) => state.activeSessionId)
  const activeDocument = useAppStore((state) => state.activeDocument)
  const mainSurface = useAppStore((state) => state.mainSurface)
  const selectSession = useAppStore((state) => state.selectSession)
  const startNewSession = useAppStore((state) => state.startNewSession)
  const setMainSurface = useAppStore((state) => state.setMainSurface)
  const workspace = config?.workspaces.find((item) => item.id === activeWorkspaceId)
  const workspaceSessions = sessions.filter(
    (session) => workspace && session.hostId === workspace.hostId && session.workspacePath === workspace.path
  )

  useEffect(() => {
    let cancelled = false
    let dispose = () => {}
    void initialize().then((value) => {
      if (cancelled) {
        value()
        return
      }
      dispose = value
    })
    return () => {
      cancelled = true
      dispose()
    }
  }, [initialize])

  if (loading) {
    return <div className="boot"><span className="brand-mark"><BrandIcon size={18} /></span><strong>Starting AgentMux</strong><span>Connecting to tmux runtime…</span></div>
  }

  return (
    <div className="app-shell">
      <div className="window-drag-region" />
      <WorkspaceSidebar onOpenSettings={() => setSettingsOpen(true)} onCreateWorktree={() => setWorktreeOpen(true)} />
      <main className="main-shell">
        <header className="topbar">
          <div className="breadcrumbs">
            <strong>{workspace?.name ?? 'No workspace selected'}</strong>
            {workspace ? <><span>/</span><span>{workspace.branch ?? workspace.path}</span></> : null}
            {workspace?.hostId !== 'local' ? <span className="host-pill"><RadioTower size={11} /> {workspace?.hostId}</span> : null}
          </div>
          <div className="topbar__actions">
            <button className={`topbar-button ${mainSurface === 'board' ? 'topbar-button--active' : ''}`} onClick={() => setMainSurface(mainSurface === 'board' ? 'workbench' : 'board')}><LayoutDashboard size={14} /> Board</button>
            <button className="topbar-button" onClick={() => setWorktreeOpen(true)}><GitBranchPlus size={14} /> Worktree</button>
            <button className="icon-button" onClick={() => setSettingsOpen(true)}><Settings2 size={15} /></button>
          </div>
        </header>
        <div className="tabbar">
          {workspaceSessions.map((session) => (
            <button key={session.id} className={`tab ${activeSessionId === session.id ? 'tab--active' : ''}`} onClick={() => selectSession(session.id)}>
              <StatusDot status={session.status} />
              <span>{session.label}</span>
            </button>
          ))}
          {activeDocument ? <button className="tab tab--document"><span className="file-dot">T</span>{activeDocument.path.split('/').pop()}</button> : null}
          <button className="tab-add" title="Launch agent" onClick={startNewSession}><Plus size={14} /></button>
        </div>
        {mainSurface === 'board' ? (
          <WorkspaceBoard onCreateWorktree={() => setWorktreeOpen(true)} />
        ) : !workspace ? (
          <section className="welcome">
            <span className="brand-mark brand-mark--large"><BrandIcon size={34} /></span>
            <div className="eyebrow">Terminal-first agent workbench</div>
            <h1>Bring a workspace.<br />Keep the agents visible.</h1>
            <p>Add a local folder from the sidebar, or configure an SSH host and remote path.</p>
            <button className="primary-button" onClick={() => setSettingsOpen(true)}>Configure a host</button>
          </section>
        ) : (
          <div className="workbench">
            <PanelGroup key={workspace.id} direction="horizontal" autoSaveId={`agentmux-main-layout-${workspace.id}`}>
              <Panel defaultSize={16} minSize={11} maxSize={28}>
                <FileExplorer />
              </Panel>
              <PanelResizeHandle className="resize-handle" />
              <Panel defaultSize={52} minSize={30}>
                <AgentSession />
              </Panel>
              <PanelResizeHandle className="resize-handle" />
              <Panel defaultSize={32} minSize={20}>
                <EditorPane />
              </Panel>
            </PanelGroup>
          </div>
        )}
        {error ? <div className="error-toast"><AlertTriangle size={14} /><span>{error}</span></div> : null}
      </main>
      {settingsOpen ? <SettingsPanel onClose={() => setSettingsOpen(false)} /> : null}
      {worktreeOpen ? <CreateWorktreeDialog onClose={() => setWorktreeOpen(false)} /> : null}
    </div>
  )
}
