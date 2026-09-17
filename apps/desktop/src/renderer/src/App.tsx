import { ExecutorIdentityContext } from './components/AgentAvatar'
import { SettingsNavigation } from './components/SettingsNavigation'
import { useCallback, useEffect, useState } from 'react'
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
import { GlobalSystemNotices } from './components/GlobalSystemNotices'
import { AgentStatusBar } from './components/AgentStatusBar'
import { WindowUtilityBar } from './components/WindowUtilityBar'
import { WindowOverlayHost } from './components/WindowOverlayHost'
import { QuickSwitcher } from './components/QuickSwitcher'
import { ShortcutsCheatSheet } from './components/ShortcutsCheatSheet'
import { isEditableChordTarget, windowShortcutHandlers } from './lib/workbench-shortcuts'
import { routeWindowShortcut } from './lib/shortcut-registry'
import { SurfaceSwitch, TopRowLeadingChrome } from './components/TopRowChrome'
import { BoardRowsProvider } from './hooks/useBoardRows'
import { GlobalBoardSurface } from './components/GlobalBoardSurface'
import { GlobalFocusSurface } from './components/GlobalFocusSurface'
import { GlobalSurveySurface } from './components/GlobalSurveySurface'
import { PmoTeamsTopicFloatingPanel } from './components/PmoTeamsTopicFloatingPanel'
import { ProjectRail } from './components/ProjectRail'
import { SurfaceToolDock } from './components/SurfaceToolDock'
import { TransientErrorNotice } from './components/TransientErrorNotice'
import { WorkspaceWorkbench } from './components/WorkspaceWorkbench'
import { executionFocusSessionId } from './lib/agent-focus'
import { tabForFocusedSession } from './lib/focus-tab-projection'
import { api } from './lib/api'
import { useAppStore } from './store'
import { observeRejectedFileExplorerDirectoryLoads } from './components/file-tree/file-explorer-report-probe'
import { isMacPlatform } from './lib/host-platform'
import { applyAppAppearance } from './lib/app-appearance'
import { observeOverlays } from './lib/native-surface-overlay'
import {
  TerminalParkingProvider,
  useTerminalColdParking
} from './lib/terminal-cold-parking-coordinator'
import {
  SurfaceMemoryBudgetProvider,
  useSurfaceMemoryBudget
} from './lib/surface-memory-budget-coordinator'
import { WorkflowComponentGallery } from './components/WorkflowComponentGallery'
import { FullPageLoadingSurface } from './components/FullPageLoadingSurface'
import { beginRendererStartup, startupProgressDetail } from './lib/startup-progress'

export function App() {
  const workflowComponentGallery = typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('agentmux-component-gallery') === '1'
  if (workflowComponentGallery) return <WorkflowComponentGallery />
  return <DesktopApp />
}

function DesktopApp() {
  const [settingsRoute, setSettingsRoute] = useState<{ section: SettingsSectionId; executorId?: string | undefined } | null>(null)
  const openSettings = (section: SettingsSectionId, executorId?: string): void => setSettingsRoute({ section, executorId })
  const [windowResizeActive, setWindowResizeActive] = useState(false)
  const [quickSwitchOpen, setQuickSwitchOpen] = useState(false)
  const [shortcutsHelpOpen, setShortcutsHelpOpen] = useState(false)
  const initialize = useAppStore((state) => state.initialize)
  const loading = useAppStore((state) => state.loading)
  const startupProgress = useAppStore((state) => state.startupProgress)
  const error = useAppStore((state) => state.error)
  const lastError = useAppStore((state) => state.lastError)
  const errorDismissed = useAppStore((state) => state.errorDismissed)
  const errorNoticeKind = useAppStore((state) => state.errorNoticeContext?.kind ?? 'indeterminate')
  const dismissError = useAppStore((state) => state.dismissError)
  const reopenError = useAppStore((state) => state.reopenError)
  const config = useAppStore((state) => state.config)
  const sessions = useAppStore((state) => state.sessions)
  const activeWorkspaceId = useAppStore((state) => state.activeWorkspaceId)
  const layouts = useAppStore((state) => state.layouts)
  const tabs = useAppStore((state) => state.tabs)
  const agentFocus = useAppStore((state) => state.agentFocus)
  const mainSurface = useAppStore((state) => state.mainSurface)
  const projectRailOpen = useAppStore((state) => state.projectRailOpen)
  const globalSurfaceOwnsProjectRail = mainSurface === 'board' || mainSurface === 'agents' || mainSurface === 'survey'
  const toolsOpen = useAppStore((state) => state.toolsOpen)
  const toolDockWidth = useAppStore((state) => state.toolDockWidth)
  const setToolDockWidth = useAppStore((state) => state.setToolDockWidth)
  const acquireNativeSurfaceOverlay = useAppStore((state) => state.acquireNativeSurfaceOverlay)
  const releaseNativeSurfaceOverlay = useAppStore((state) => state.releaseNativeSurfaceOverlay)
  const onAgentPanelVisibilityChange = useCallback((visible: boolean) => {
    if (visible) acquireNativeSurfaceOverlay()
    else releaseNativeSurfaceOverlay()
  }, [acquireNativeSurfaceOverlay, releaseNativeSurfaceOverlay])
  // 浮层 vs 原生视图的那条**唯一**订阅点。窗口级原生视图合成在所有 renderer 像素之上，所以任何
  // 画在 DOM 里的浮层都会被它盖住——与 z-index 无关。判据取 Radix 自己的 DOM 协议（portal 到
  // React 根之外 + data-state=open），一次覆盖全仓 21 个 Root，新加的自动覆盖；判定在
  // lib/native-surface-overlay.ts 里，这里只负责订阅与投递。
  const setPortalOverlayCount = useAppStore((state) => state.setPortalOverlayCount)
  useEffect(
    () => observeOverlays(document.body, setPortalOverlayCount, MutationObserver),
    [setPortalOverlayCount]
  )
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
  const focusSessionId = mainSurface === 'agents' ? executionFocusSessionId(agentFocus) : null
  const focusTab = tabForFocusedSession(tabs, focusSessionId)
  // A Workbench is a window-owned surface, not a route component. Keep only Workspaces the user has
  // a persisted surface for (plus the active one during its first layout frame) mounted: switching
  // back then changes visibility instead of destroying SessionPane/xterm/ctxmux attachments, while an
  // untouched configured workspace does not allocate a hidden launcher/editor/browser tree at startup.
  // Scratch is a real wiki-first workspace with Topic Tabs and Regions, so it follows the same
  // registry rule as a project instead of being filtered out after a Topic click.
  const mountedWorkspaces = config?.workspaces.filter((candidate) => (
    fileEditingProbe || candidate.id === activeWorkspaceId || candidate.id === focusTab?.workspaceId || layouts[candidate.id]?.groups.some((group) => group.tabOrder.length > 0)
  )) ?? []
  const toolsAvailable = mainSurface === 'board' || (mainSurface === 'workbench' && Boolean(workspace))
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
    workbenchVisible: workbenchVisible || Boolean(focusTab),
    measurementActive: terminalParkingMeasurement
  })
  const surfaceMemoryBudget = useSurfaceMemoryBudget({
    workbenchVisible: workbenchVisible || Boolean(focusTab),
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

  // rendererUpdateReady is reported from inside beginRendererStartup below — it fires
  // announceReady before awaiting initialize(), so a mounted interface is announced ready even
  // while workspace recovery is still running (the intent 1b4fdabb landed). A separate useEffect
  // here that also called rendererUpdateReady doubled the report; `ready` was called twice with
  // the same token and the handshake test caught it. Route through beginRendererStartup only.

  useEffect(() => {
    let cancelled = false
    let dispose = () => {}
    const updateToken = new URLSearchParams(window.location.search).get('renderer-update')
    void beginRendererStartup(
      initialize,
      updateToken ? () => api.ui.rendererUpdateReady(updateToken) : undefined,
      (error) => useAppStore.getState().reportError(error)
    ).then((value) => {
      if (cancelled) value()
      else dispose = value
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
    return <FullPageLoadingSurface scope="app" phase="loading" eyebrow="AgentMux startup" title="Restoring your workspace" detail={startupProgressDetail(startupProgress)} />
  }

  if (!config && error) {
    return <FullPageLoadingSurface scope="app" phase="failed" eyebrow="AgentMux startup" title="Runtime connection failed" detail={error} actions={<button className="small-button" onClick={() => window.location.reload()}>Retry startup</button>} />
  }

  return (
    <SettingsNavigation.Provider value={{ open: openSettings }}>
    <ExecutorIdentityContext.Provider value={{ config, sessions, onPanelVisibilityChange: onAgentPanelVisibilityChange }}>
      <TerminalParkingProvider parkedRegionIds={parkedTerminalRegionIds}>
      <SurfaceMemoryBudgetProvider state={surfaceMemoryBudget}>
      <BoardRowsProvider enabled={mainSurface === 'board' && !settingsRoute}>
      <div
        className={`app-shell ${globalSurfaceOwnsProjectRail || !projectRailOpen ? 'app-shell--project-rail-collapsed' : ''}`}
        aria-hidden={settingsRoute ? true : undefined}
        inert={Boolean(settingsRoute)}
      >
      {!globalSurfaceOwnsProjectRail && projectRailOpen ? (
        <ProjectRail />
      ) : globalSurfaceOwnsProjectRail ? null : (
        null
      )}
      <main className={`main-shell ${mergedTopRow ? 'main-shell--merged' : ''}`}>
        {!mergedTopRow ? (
          <header className="topbar">
            <TopRowLeadingChrome />
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
              {mainSurface === 'survey' ? <GlobalSurveySurface /> : null}
              {mainSurface === 'agents' ? <GlobalFocusSurface /> : null}
              {mainSurface === 'board' ? <GlobalBoardSurface /> : null}
              {config && (workspace || focusTab) ? (
                <div
                  className={`workspace-workbench-registry ${workbenchVisible || focusTab ? '' : 'workspace-workbench-registry--parked'}`}
                  aria-hidden={!workbenchVisible && !focusTab}
                  inert={!workbenchVisible && !focusTab}
                  >
                  {mountedWorkspaces.map((candidate) => {
                    const visible = workbenchVisible && candidate.id === activeWorkspaceId
                    const focusVisible = Boolean(focusTab && focusTab.workspaceId === candidate.id)
                    const mounted = visible || focusVisible
                    return (
                      <div
                        key={candidate.id}
                        className={`workspace-workbench-slot ${mounted ? '' : 'workspace-workbench-slot--parked'}`}
                        data-workspace-id={candidate.id}
                        data-visible={mounted ? 'true' : 'false'}
                        aria-hidden={!mounted}
                        inert={!mounted}
                      >
                        <WorkspaceWorkbench
                          workspaceId={candidate.id}
                          visible={mounted}
                          focusTabId={focusVisible && focusTab ? focusTab.id : null}
                          focusPortalTargetId={focusVisible ? 'focus-workspace-slot' : null}
                          interactiveResize={windowResizeActive || isResizing}
                        />
                      </div>
                    )
                  })}
                </div>
              ) : null}
              <PmoTeamsTopicFloatingPanel />
            </section>
          </div>
        )}
        <div className="main-shell__notices">
          <TransientErrorNotice
            error={error}
            dismissed={errorDismissed}
            lastError={lastError}
            kind={errorNoticeKind}
            onDismiss={dismissError}
            onReopen={reopenError}
          />
        </div>
      </main>
      <footer className="window-status-bar">
        <div className="window-status-bar__surface-switch"><SurfaceSwitch /></div>
        <div className="window-status-bar__status"><AgentStatusBar /></div>
        <div className="window-status-bar__right">
          <GlobalSystemNotices />
          <WindowUtilityBar onOpenSettings={openSettings} />
        </div>
      </footer>
      <QuickSwitcher open={quickSwitchOpen} onClose={() => setQuickSwitchOpen(false)} />
      <ShortcutsCheatSheet
        open={shortcutsHelpOpen}
        onClose={() => setShortcutsHelpOpen(false)}
        isMac={isMacPlatform()}
      />
      </div>
      <WindowOverlayHost />
      </BoardRowsProvider>
      </SurfaceMemoryBudgetProvider>
      </TerminalParkingProvider>
      {settingsRoute ? (
        <SettingsPanel
          initialSection={settingsRoute.section}
          executorId={settingsRoute.executorId}
          onClose={() => setSettingsRoute(null)}
        />
      ) : null}
    </ExecutorIdentityContext.Provider>
    </SettingsNavigation.Provider>
  )
}
