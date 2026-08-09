import {
  AlertTriangle,
  LoaderCircle
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { RuntimeOwnershipNotice } from './components/RuntimeOwnershipNotice'
import { ShellEnvironmentNotice } from './components/ShellEnvironmentNotice'
import { BrandIcon } from './components/BrandIcon'
import { useAgentAttentionNotifications } from './hooks/useAgentAttentionNotifications'
import { useAgentStatusDecay } from './lib/agent-status-decay'
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
import { ShortcutsCheatSheet } from './components/ShortcutsCheatSheet'
import { isEditableChordTarget, windowShortcutHandlers } from './lib/workbench-shortcuts'
import { routeWindowShortcut } from './lib/shortcut-registry'
import { SurfaceSwitch, TopRowLeadingChrome } from './components/TopRowChrome'
import { BoardRowsProvider } from './hooks/useBoardRows'
import { WorkspaceBoard } from './components/WorkspaceBoard'
import { ProjectRail } from './components/ProjectRail'
import { SurfaceToolDock } from './components/SurfaceToolDock'
import { TransientErrorNotice } from './components/TransientErrorNotice'
import { WorkspaceWorkbench } from './components/WorkspaceWorkbench'
import { api } from './lib/api'
import { useAppStore } from './store'
import { observeRejectedFileExplorerDirectoryLoads } from './components/file-tree/file-explorer-report-probe'
import { isMacPlatform } from './lib/host-platform'
import { applyAppAppearance } from './lib/app-appearance'
import {
  TerminalParkingProvider,
  useTerminalColdParking
} from './lib/terminal-cold-parking-coordinator'
import {
  SurfaceMemoryBudgetProvider,
  useSurfaceMemoryBudget
} from './lib/surface-memory-budget-coordinator'

export function App() {
  const [settingsRoute, setSettingsRoute] = useState<{ section: SettingsSectionId } | null>(null)
  const [windowResizeActive, setWindowResizeActive] = useState(false)
  const [quickSwitchOpen, setQuickSwitchOpen] = useState(false)
  const [shortcutsHelpOpen, setShortcutsHelpOpen] = useState(false)
  const initialize = useAppStore((state) => state.initialize)
  const loading = useAppStore((state) => state.loading)
  const error = useAppStore((state) => state.error)
  const lastError = useAppStore((state) => state.lastError)
  const errorDismissed = useAppStore((state) => state.errorDismissed)
  const dismissError = useAppStore((state) => state.dismissError)
  const reopenError = useAppStore((state) => state.reopenError)
  const config = useAppStore((state) => state.config)
  const activeWorkspaceId = useAppStore((state) => state.activeWorkspaceId)
  const layouts = useAppStore((state) => state.layouts ?? {})
  const mainSurface = useAppStore((state) => state.mainSurface)
  const projectRailOpen = useAppStore((state) => state.projectRailOpen)
  const toolsOpen = useAppStore((state) => state.toolsOpen)
  const toolDockWidth = useAppStore((state) => state.toolDockWidth)
  const setToolDockWidth = useAppStore((state) => state.setToolDockWidth)
  const workspace = config?.workspaces.find((item) => item.id === activeWorkspaceId)
  useEffect(() => applyAppAppearance(config?.appearance.appAppearance), [config?.appearance.appAppearance])
  const selectWorkspace = useAppStore((state) => state.selectWorkspace)
  const fileEditingProbe = typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('agentmux-file-editing-report') === '1'
  useEffect(() => {
    if (!fileEditingProbe) return
    let total = 0
    const byWorkspace: Record<string, number> = {}
    const rejectedDirectoryLoads: Array<{
      workspaceId: string
      path: string
      epoch: number
      operationId: number
      kind: 'rejected'
      observedAt: number
    }> = []
    const publish = () => {
      document.documentElement.dataset.fileEditingExplorerEvidence = JSON.stringify({
        mountId: 'app', total, byWorkspace, rejectedDirectoryLoads
      })
    }
    const unsubscribeStore = useAppStore.subscribe((state, previous) => {
      if (state.fileExplorerStates === previous.fileExplorerStates) return
      total += 1
      for (const id of new Set([...Object.keys(state.fileExplorerStates), ...Object.keys(previous.fileExplorerStates)])) {
        if (state.fileExplorerStates[id] !== previous.fileExplorerStates[id]) byWorkspace[id] = (byWorkspace[id] ?? 0) + 1
      }
      publish()
    })
    const unsubscribeRejectedLoads = observeRejectedFileExplorerDirectoryLoads((receipt) => {
      rejectedDirectoryLoads.push(receipt)
      publish()
    })
    publish()
    return () => { unsubscribeStore(); unsubscribeRejectedLoads() }
  }, [fileEditingProbe])
  // A Workbench is a window-owned surface, not a route component. Keep only Workspaces the user has
  // a persisted surface for (plus the active one during its first layout frame) mounted: switching
  // back then changes visibility instead of destroying SessionPane/xterm/ctxmux attachments, while an
  // untouched configured project does not allocate a hidden launcher/editor/browser tree at startup.
  const mountedWorkspaces = config?.workspaces.filter((candidate) => (
    fileEditingProbe || candidate.id === activeWorkspaceId || layouts[candidate.id]?.groups.some((group) => group.tabOrder.length > 0)
  )) ?? []
  const toolsAvailable = mainSurface === 'board' || Boolean(workspace)
  const toolsVisible = toolsAvailable && toolsOpen
  const toolDockMinimumWidth = getToolDockMinimumWidth(projectRailOpen)
  const renderedToolDockWidth = getRenderedToolDockWidth(toolDockWidth, projectRailOpen)
  // MERGE：workbench + workspace 时顶行下沉进 pane（root tabbar / chromeline），
  // 主区不再占用独立 topbar 行；Board 与欢迎页仍走顶栏。
  const mergedTopRow = mainSurface === 'workbench' && Boolean(workspace)
  const workbenchVisible = mainSurface === 'workbench' && !settingsRoute
  const terminalParkingMeasurement = typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).has('agentmux-resource-probe')
  const parkedTerminalRegionIds = useTerminalColdParking({
    workbenchVisible,
    measurementActive: terminalParkingMeasurement
  })
  const surfaceMemoryBudget = useSurfaceMemoryBudget({
    workbenchVisible,
    measurementActive: terminalParkingMeasurement
  })
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
      else {
        dispose = value
        const updateToken = new URLSearchParams(window.location.search).get('renderer-update')
        if (updateToken) void api.ui.rendererUpdateReady(updateToken)
      }
    })
    return () => {
      cancelled = true
      dispose()
    }
  }, [initialize])

  useEffect(() => api.ui.onWindowResize(({ active }) => setWindowResizeActive(active)), [])

  // Background Agents announce themselves: a completion, a request, or a failure the user is not looking
  // at raises a native notification that routes back to that Session.
  useAgentAttentionNotifications()

  // 掉了 hook 流的 `working` 会永远转圈——这个 hook 让无新证据的非终态衰减为中性态，圈就此停下。
  useAgentStatusDecay()

  // The window's global keyboard router. One capture-phase keydown listener owns every window-scope
  // binding — the quick switcher and the workbench actions — so there is exactly one place the focused
  // xterm textarea is beaten to the keystroke. The whole decision (match the chord against the registry,
  // gate on the editable-target fact, dispatch to the id's handler, report whether it was consumed) lives
  // in the pure routeWindowShortcut + windowShortcutHandlers, read against a fresh Store snapshot each
  // keypress; this shell has NO branches of its own — it derives the editable fact, calls the router, and
  // preventDefaults iff a binding consumed the key. (Cmd+W reaches us rather than closing the native
  // window because the main process installs a menu binding no Cmd+W — a renderer preventDefault cannot
  // cancel a native menu accelerator. See main/application-menu.ts.)
  useEffect(() => {
    const isMac = isMacPlatform()
    const onKeyDown = (event: KeyboardEvent): void => {
      // 在编辑控件或终端/TUI 里输入时，带 `not-in-editable` 门的绑定（Cmd+D 分屏、Cmd+W 关格）先放行；
      // 全局导航（quick switch）不带门，照常触发。终端焦点不再被工作台快捷键抢走——capture 仍只负责把
      // 未被作用域门挡住的全局动作路由到正确 owner。判定是纯函数，这里只把 DOM 事实（标签名、contentEditable、是否在 .xterm
      // 子树内）折成一个布尔喂进去。
      const target = event.target
      const editableTarget = target instanceof HTMLElement && isEditableChordTarget({
        tagName: target.tagName,
        isContentEditable: target.isContentEditable,
        insideTerminal: target.closest('.xterm') !== null
      })
      const handlers = windowShortcutHandlers(useAppStore.getState(), {
        toggleQuickSwitch: () => setQuickSwitchOpen((current) => !current),
        toggleShortcutsHelp: () => setShortcutsHelpOpen((current) => !current)
      })
      if (routeWindowShortcut(event, isMac, editableTarget, handlers)) event.preventDefault()
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

  return (
    <>
      <TerminalParkingProvider parkedRegionIds={parkedTerminalRegionIds}>
      <SurfaceMemoryBudgetProvider state={surfaceMemoryBudget}>
      <BoardRowsProvider enabled={mainSurface === 'board' && !settingsRoute}>
      <div
        className={`app-shell ${projectRailOpen ? '' : 'app-shell--project-rail-collapsed'}`}
        aria-hidden={settingsRoute ? true : undefined}
        inert={Boolean(settingsRoute)}
      >
      {projectRailOpen ? (
        <ProjectRail
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
              {mainSurface === 'board' ? <WorkspaceBoard /> : null}
              {workspace ? (
                <div
                  className={`workspace-workbench-registry ${workbenchVisible ? '' : 'workspace-workbench-registry--parked'}`}
                  aria-hidden={!workbenchVisible}
                  inert={!workbenchVisible}
                >
                  {mountedWorkspaces.map((candidate) => {
                    const visible = workbenchVisible && candidate.id === activeWorkspaceId
                    return (
                      <div
                        key={candidate.id}
                        className={`workspace-workbench-slot ${visible ? '' : 'workspace-workbench-slot--parked'}`}
                        data-workspace-id={candidate.id}
                        data-visible={visible ? 'true' : 'false'}
                        aria-hidden={!visible}
                        inert={!visible}
                      >
                        <WorkspaceWorkbench
                          workspaceId={candidate.id}
                          visible={visible}
                          interactiveResize={windowResizeActive || isResizing}
                        />
                      </div>
                    )
                  })}
                </div>
              ) : null}
            </section>
          </div>
        )}
        <div className="main-shell__notices">
          <ShellEnvironmentNotice />
          <RuntimeOwnershipNotice />
          <TransientErrorNotice
            error={error}
            dismissed={errorDismissed}
            lastError={lastError}
            onDismiss={dismissError}
            onReopen={reopenError}
          />
        </div>
      </main>
      <AgentStatusBar />
      <QuickSwitcher open={quickSwitchOpen} onClose={() => setQuickSwitchOpen(false)} />
      <ShortcutsCheatSheet
        open={shortcutsHelpOpen}
        onClose={() => setShortcutsHelpOpen(false)}
        isMac={isMacPlatform()}
      />
      </div>
      </BoardRowsProvider>
      </SurfaceMemoryBudgetProvider>
      </TerminalParkingProvider>
      {settingsRoute ? (
        <SettingsPanel
          initialSection={settingsRoute.section}
          onClose={() => setSettingsRoute(null)}
        />
      ) : null}
    </>
  )
}
