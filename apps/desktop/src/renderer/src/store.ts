import { create } from 'zustand'
import type {
  AgentActivity,
  AgentDetection,
  AppConfig,
  BrowserEvent,
  CreateWorkspacePathInput,
  FileDocument,
  HostConfig,
  HostCheckResult,
  RuntimeEvent,
  SessionSnapshot,
  WorkspaceSelectionResult
} from '../../shared/contracts'
import { api } from './lib/api'
import {
  activateTab as activateLayoutTab,
  addTab,
  createWorkspaceLayout,
  findGroup,
  focusGroup,
  moveTab as moveLayoutTab,
  removeTab as removeLayoutTab,
  setSplitRatio,
  splitTab as splitLayoutTab,
  type SplitDirection,
  type WorkspaceLayout
} from './lib/workbench-layout'
import { reduceBrowserEvent } from './lib/browser-state'
import {
  reduceDocumentContent,
  reduceDocumentSaved,
  reduceFileDelete,
  reduceFileOpened,
  reduceFileRename
} from './lib/file-workbench-state'
import { reduceRuntimeEvent, type SessionViewMode } from './lib/session-state'
import {
  TOOL_DOCK_DEFAULT_WIDTH,
  clampToolDockWidth,
  type BoardTool,
  type LauncherView,
  type WorkspaceTool
} from './lib/surface-tool-dock'
import {
  createInitialWorkbench,
  documentKey,
  paneForTab,
  sessionTabId,
  tabStillOpen,
  workspaceForSession,
  type AgentWorkbenchTab,
  type BrowserWorkbenchTab,
  type LauncherWorkbenchTab,
  type TerminalWorkbenchTab,
  type WorkbenchTab
} from './lib/workbench-tabs'

type ViewMode = SessionViewMode
export type MainSurface = 'workbench' | 'board'
export type AsyncCheckState = 'idle' | 'checking' | 'ready' | 'missing' | 'error'
export type AgentDetectionState = {
  state: AsyncCheckState
  result?: AgentDetection
  detail?: string
  observedAt?: number
}
export type HostCheckState = {
  state: Exclude<AsyncCheckState, 'missing'>
  result?: HostCheckResult
  detail?: string
  observedAt?: number
}

type AppState = {
  config: AppConfig | null
  sessions: SessionSnapshot[]
  activities: Record<string, AgentActivity[]>
  activeWorkspaceId: string | null
  documents: Record<string, FileDocument>
  dirtyDocuments: Record<string, boolean>
  lastActiveFileByWorkspace: Record<string, string | undefined>
  tabs: Record<string, WorkbenchTab>
  layouts: Record<string, WorkspaceLayout>
  viewModes: Record<string, ViewMode>
  agentDetections: Record<string, AgentDetectionState>
  hostChecks: Record<string, HostCheckState>
  mainSurface: MainSurface
  toolsOpen: boolean
  workspaceTool: WorkspaceTool
  boardTool: BoardTool
  toolDockWidth: number
  loading: boolean
  error: string | null
  initialize(): Promise<() => void>
  selectWorkspace(id: string): Promise<void>
  activateWorkspaceSelection(result: WorkspaceSelectionResult): void
  focusPane(workspaceId: string, paneId: string): void
  activateTab(workspaceId: string, paneId: string, tabId: string): void
  selectSession(id: string, paneId?: string): void
  openLauncher(paneId?: string, view?: LauncherView): void
  closeTab(workspaceId: string, paneId: string, tabId: string): Promise<void>
  moveTab(
    workspaceId: string,
    tabId: string,
    sourcePaneId: string,
    targetPaneId: string,
    targetIndex: number
  ): void
  splitTab(
    workspaceId: string,
    tabId: string,
    sourcePaneId: string,
    targetPaneId: string,
    direction: SplitDirection
  ): void
  updateSplitRatio(workspaceId: string, nodePath: string, ratio: number): void
  setViewMode(sessionId: string, mode: ViewMode): void
  setMainSurface(surface: MainSurface): void
  setWorkspaceTool(tool: WorkspaceTool): void
  setBoardTool(tool: BoardTool): void
  toggleTools(): void
  setToolDockWidth(width: number): void
  detectAgents(hostId: string): Promise<void>
  checkHost(host: HostConfig): Promise<void>
  openFile(path: string, paneId?: string): Promise<void>
  createPath(input: CreateWorkspacePathInput): Promise<void>
  renamePath(path: string, nextPath: string): Promise<void>
  deletePath(path: string): Promise<void>
  updateDocument(tabId: string, content: string): void
  saveDocument(tabId: string): Promise<void>
  launchAgent(agentId: string, prompt: string, paneId: string, launcherTabId?: string): Promise<void>
  launchTerminal(paneId: string, launcherTabId?: string): Promise<void>
  createBrowser(paneId: string, launcherTabId?: string): Promise<void>
  applyBrowserEvent(event: BrowserEvent): void
  send(sessionId: string, text: string): Promise<void>
  interrupt(sessionId: string): Promise<void>
  refreshSession(sessionId: string): Promise<void>
  stopSession(sessionId: string): Promise<void>
  applyEvent(event: RuntimeEvent): void
  setConfig(config: AppConfig): void
  reportError(error: unknown): void
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function agentDetectionKey(hostId: string, agentId: string): string {
  return `${hostId}\0${agentId}`
}

const detectionRequestIds = new Map<string, number>()
const hostCheckRequestIds = new Map<string, number>()

function newPaneId(): string {
  return `pane-${crypto.randomUUID()}`
}

function newLauncherTab(workspaceId: string, view: LauncherView = 'picker'): LauncherWorkbenchTab {
  return { id: `launcher:${crypto.randomUUID()}`, kind: 'launcher', workspaceId, view }
}

export const useAppStore = create<AppState>((set, get) => ({
  config: null,
  sessions: [],
  activities: {},
  activeWorkspaceId: null,
  documents: {},
  dirtyDocuments: {},
  lastActiveFileByWorkspace: {},
  tabs: {},
  layouts: {},
  viewModes: {},
  agentDetections: {},
  hostChecks: {},
  mainSurface: 'workbench',
  toolsOpen: true,
  workspaceTool: 'files-branches',
  boardTool: 'branch-lanes',
  toolDockWidth: TOOL_DOCK_DEFAULT_WIDTH,
  loading: true,
  error: null,
  async initialize() {
    try {
      const [config, snapshot] = await Promise.all([api.config.get(), api.sessions.snapshot()])
      const firstWorkspace = config.workspaces[0]?.id ?? null
      const workbench = createInitialWorkbench(config, snapshot.sessions, newPaneId)
      set({
        config,
        sessions: snapshot.sessions,
        activities: snapshot.activities,
        activeWorkspaceId: firstWorkspace,
        tabs: workbench.tabs,
        layouts: workbench.layouts,
        loading: false
      })
      if (firstWorkspace) await get().selectWorkspace(firstWorkspace)
      const disposeSessions = api.sessions.onEvent((event) => get().applyEvent(event))
      const disposeBrowsers = api.browser.onEvent((event) => get().applyBrowserEvent(event))
      return () => {
        disposeSessions()
        disposeBrowsers()
      }
    } catch (error) {
      set({ loading: false, error: message(error) })
      return () => {}
    }
  },
  async selectWorkspace(id) {
    set({ activeWorkspaceId: id, mainSurface: 'workbench', error: null })
    const state = get()
    if (!state.layouts[id]) {
      const sessionTabIds = state.sessions.flatMap((session) => {
        const workspace = state.config?.workspaces.find((candidate) => candidate.id === id)
        return workspace &&
          session.hostId === workspace.hostId &&
          session.workspacePath === workspace.path
          ? [sessionTabId(session.id)]
          : []
      })
      set((current) => ({
        layouts: { ...current.layouts, [id]: createWorkspaceLayout(newPaneId(), sessionTabIds) }
      }))
    }
  },
  activateWorkspaceSelection(result) {
    const workspace = result.workspace
    set((state) => {
      const existingLayout = state.layouts[workspace.id]
      const tabs = { ...state.tabs }
      const sessionTabIds = state.sessions.flatMap((session) => {
        if (session.hostId !== workspace.hostId || session.workspacePath !== workspace.path) return []
        const tab: AgentWorkbenchTab | TerminalWorkbenchTab = {
          id: sessionTabId(session.id),
          kind: session.kind,
          phase: 'attached',
          workspaceId: workspace.id,
          sessionId: session.id
        }
        tabs[tab.id] = tab
        return [tab.id]
      })
      return {
        config: result.config,
        activeWorkspaceId: workspace.id,
        mainSurface: 'workbench',
        error: null,
        tabs,
        layouts: existingLayout
          ? state.layouts
          : { ...state.layouts, [workspace.id]: createWorkspaceLayout(newPaneId(), sessionTabIds) }
      }
    })
  },
  focusPane(workspaceId, paneId) {
    const layout = get().layouts[workspaceId]
    if (!layout || !findGroup(layout, paneId)) return
    set((state) => ({
      layouts: { ...state.layouts, [workspaceId]: focusGroup(layout, paneId) }
    }))
  },
  activateTab(workspaceId, paneId, tabId) {
    const layout = get().layouts[workspaceId]
    if (!layout) return
    const tab = get().tabs[tabId]
    set((state) => ({
      layouts: {
        ...state.layouts,
        [workspaceId]: activateLayoutTab(layout, paneId, tabId)
      },
      ...(tab?.kind === 'file'
        ? { lastActiveFileByWorkspace: { ...state.lastActiveFileByWorkspace, [workspaceId]: tab.path } }
        : {})
    }))
  },
  selectSession(id, paneId) {
    const session = get().sessions.find((candidate) => candidate.id === id)
    const workspace = session ? workspaceForSession(get().config, session) : null
    if (!session || !workspace) return
    const existingTab = Object.values(get().tabs).find(
      (tab) => (tab.kind === 'agent' || tab.kind === 'terminal') && tab.sessionId === id
    )
    const tabId = existingTab?.id ?? sessionTabId(id)
    const layout = get().layouts[workspace.id] ?? createWorkspaceLayout(newPaneId())
    const existingPaneId = paneForTab(layout, tabId)
    const targetPaneId = existingPaneId ?? paneId ?? layout.activeGroupId
    const tab: AgentWorkbenchTab | TerminalWorkbenchTab = {
      id: tabId,
      kind: session.kind,
      phase: 'attached',
      workspaceId: workspace.id,
      sessionId: id
    }
    set((state) => ({
      activeWorkspaceId: workspace.id,
      mainSurface: 'workbench',
      tabs: { ...state.tabs, [tab.id]: tab },
      layouts: {
        ...state.layouts,
        [workspace.id]: existingPaneId
          ? activateLayoutTab(layout, targetPaneId, tabId)
          : addTab(layout, targetPaneId, tabId)
      }
    }))
  },
  openLauncher(paneId, view = 'picker') {
    const workspaceId = get().activeWorkspaceId
    const layout = workspaceId ? get().layouts[workspaceId] : undefined
    if (!workspaceId || !layout) return
    const targetPaneId = paneId ?? layout.activeGroupId
    const tab = newLauncherTab(workspaceId, view)
    set((state) => ({
      mainSurface: 'workbench',
      tabs: { ...state.tabs, [tab.id]: tab },
      layouts: { ...state.layouts, [workspaceId]: addTab(layout, targetPaneId, tab.id) }
    }))
  },
  async closeTab(workspaceId, paneId, tabId) {
    const tab = get().tabs[tabId]
    if (tab?.kind === 'browser') {
      try {
        await api.browser.close(tab.browserId)
      } catch (error) {
        get().reportError(error)
        return
      }
    }
    const layout = get().layouts[workspaceId]
    if (!layout) return
    const layouts = { ...get().layouts, [workspaceId]: removeLayoutTab(layout, paneId, tabId) }
    const tabs = { ...get().tabs }
    if (!tabStillOpen(layouts, tabId)) delete tabs[tabId]
    set({ layouts, tabs })
  },
  moveTab(workspaceId, tabId, sourcePaneId, targetPaneId, targetIndex) {
    const layout = get().layouts[workspaceId]
    if (!layout) return
    set((state) => ({
      layouts: {
        ...state.layouts,
        [workspaceId]: moveLayoutTab(layout, tabId, sourcePaneId, targetPaneId, targetIndex)
      }
    }))
  },
  splitTab(workspaceId, tabId, sourcePaneId, targetPaneId, direction) {
    const layout = get().layouts[workspaceId]
    if (!layout) return
    set((state) => ({
      layouts: {
        ...state.layouts,
        [workspaceId]: splitLayoutTab(
          layout,
          tabId,
          sourcePaneId,
          targetPaneId,
          direction,
          newPaneId()
        )
      }
    }))
  },
  updateSplitRatio(workspaceId, nodePath, ratio) {
    const layout = get().layouts[workspaceId]
    if (!layout) return
    set((state) => ({
      layouts: {
        ...state.layouts,
        [workspaceId]: setSplitRatio(layout, nodePath, ratio)
      }
    }))
  },
  setViewMode(sessionId, mode) {
    set((state) => ({ viewModes: { ...state.viewModes, [sessionId]: mode } }))
  },
  setMainSurface(mainSurface) {
    set({ mainSurface })
  },
  setWorkspaceTool(workspaceTool) {
    set({ workspaceTool, toolsOpen: true, mainSurface: 'workbench' })
  },
  setBoardTool(boardTool) {
    set({ boardTool, toolsOpen: true, mainSurface: 'board' })
  },
  toggleTools() {
    set((state) => ({ toolsOpen: !state.toolsOpen }))
  },
  setToolDockWidth(toolDockWidth) {
    set({ toolDockWidth: clampToolDockWidth(toolDockWidth) })
  },
  async detectAgents(hostId) {
    const agentIds = Object.keys(get().config?.agents ?? {})
    if (agentIds.length === 0) return
    if (agentIds.some((agentId) => get().agentDetections[agentDetectionKey(hostId, agentId)]?.state === 'checking')) return
    const requestId = (detectionRequestIds.get(hostId) ?? 0) + 1
    detectionRequestIds.set(hostId, requestId)
    set((state) => ({
      agentDetections: {
        ...state.agentDetections,
        ...Object.fromEntries(
          agentIds.map((agentId) => [agentDetectionKey(hostId, agentId), { state: 'checking' } satisfies AgentDetectionState])
        )
      }
    }))
    await Promise.all(
      agentIds.map(async (agentId) => {
        try {
          const result = await api.agents.detect(agentId, hostId)
          if (detectionRequestIds.get(hostId) !== requestId) return
          set((state) => ({
            agentDetections: {
              ...state.agentDetections,
              [agentDetectionKey(hostId, agentId)]: {
                state: result.installed ? 'ready' : 'missing',
                result,
                observedAt: Date.now()
              }
            }
          }))
        } catch (error) {
          if (detectionRequestIds.get(hostId) !== requestId) return
          set((state) => ({
            agentDetections: {
              ...state.agentDetections,
              [agentDetectionKey(hostId, agentId)]: {
                state: 'error',
                detail: message(error),
                observedAt: Date.now()
              }
            }
          }))
        }
      })
    )
  },
  async checkHost(host) {
    const requestId = (hostCheckRequestIds.get(host.id) ?? 0) + 1
    hostCheckRequestIds.set(host.id, requestId)
    set((state) => ({
      hostChecks: { ...state.hostChecks, [host.id]: { state: 'checking' } }
    }))
    try {
      const result = await api.hosts.check(host)
      if (hostCheckRequestIds.get(host.id) !== requestId) return
      set((state) => ({
        hostChecks: {
          ...state.hostChecks,
          [host.id]: {
            state: result.ok ? 'ready' : 'error',
            result,
            detail: result.detail,
            observedAt: Date.now()
          }
        }
      }))
    } catch (error) {
      if (hostCheckRequestIds.get(host.id) !== requestId) return
      set((state) => ({
        hostChecks: {
          ...state.hostChecks,
          [host.id]: { state: 'error', detail: message(error), observedAt: Date.now() }
        }
      }))
    }
  },
  async openFile(path, paneId) {
    const workspaceId = get().activeWorkspaceId
    const layout = workspaceId ? get().layouts[workspaceId] : undefined
    if (!workspaceId || !layout) return
    const key = documentKey(workspaceId, path)
    try {
      const document = get().documents[key] ?? (await api.files.read(workspaceId, path))
      set((state) => reduceFileOpened(state, workspaceId, path, document, paneId))
    } catch (error) {
      get().reportError(error)
    }
  },
  async createPath(input) {
    const workspaceId = get().activeWorkspaceId
    if (!workspaceId) throw new Error('Select a workspace first')
    try {
      await api.files.create(workspaceId, input)
    } catch (error) {
      get().reportError(error)
      throw error
    }
  },
  async renamePath(path, nextPath) {
    const workspaceId = get().activeWorkspaceId
    if (!workspaceId) throw new Error('Select a workspace first')
    try {
      await api.files.rename(workspaceId, { path, nextPath })
      set((state) => reduceFileRename(state, workspaceId, path, nextPath))
    } catch (error) {
      get().reportError(error)
      throw error
    }
  },
  async deletePath(path) {
    const workspaceId = get().activeWorkspaceId
    if (!workspaceId) throw new Error('Select a workspace first')
    try {
      await api.files.delete(workspaceId, path)
      set((state) => reduceFileDelete(state, workspaceId, path))
    } catch (error) {
      get().reportError(error)
      throw error
    }
  },
  updateDocument(tabId, content) {
    set((state) => reduceDocumentContent(state, tabId, content))
  },
  async saveDocument(tabId) {
    const tab = get().tabs[tabId]
    if (tab?.kind !== 'file') return
    const key = documentKey(tab.workspaceId, tab.path)
    const document = get().documents[key]
    if (!document) return
    try {
      await api.files.write(tab.workspaceId, document)
      set((state) => reduceDocumentSaved(state, tab.workspaceId, tab.path))
    } catch (error) {
      get().reportError(error)
    }
  },
  async launchAgent(agentId, prompt, paneId, launcherTabId) {
    const state = get()
    const launcher = launcherTabId ? state.tabs[launcherTabId] : undefined
    const workspaceId = launcher?.workspaceId ?? state.activeWorkspaceId
    const workspace = state.config?.workspaces.find((item) => item.id === workspaceId)
    if (!workspace) throw new Error('Select a workspace first')
    const layout = state.layouts[workspace.id]
    if (!layout) throw new Error('Workspace layout is unavailable')
    const tabId = launcherTabId ?? newLauncherTab(workspace.id).id
    const sessionId = crypto.randomUUID()
    const pendingTab: AgentWorkbenchTab = {
      id: tabId,
      kind: 'agent',
      phase: 'launching',
      workspaceId: workspace.id,
      sessionId
    }
    set((current) => ({
      tabs: { ...current.tabs, [tabId]: pendingTab },
      layouts: {
        ...current.layouts,
        [workspace.id]: launcherTabId ? layout : addTab(layout, paneId, tabId)
      }
    }))
    try {
      const session = await api.sessions.launchAgent({
        agentId,
        hostId: workspace.hostId,
        workspacePath: workspace.path,
        prompt,
        sessionId,
        label: `${agentId} · ${workspace.name}`
      })
      set((current) => {
        const projected = reduceRuntimeEvent(current, { type: 'session', session })
        return {
          ...projected,
          tabs: projected.tabs[tabId]?.kind === 'agent' && projected.tabs[tabId].sessionId === session.id
            ? { ...projected.tabs, [tabId]: { ...projected.tabs[tabId], phase: 'attached' } }
            : projected.tabs,
          viewModes: { ...current.viewModes, [session.id]: 'terminal' }
        }
      })
    } catch (error) {
      set((current) => ({
        tabs: current.tabs[tabId]?.kind === 'agent' && current.tabs[tabId].sessionId === sessionId
          ? { ...current.tabs, [tabId]: { id: tabId, kind: 'launcher', workspaceId: workspace.id, view: 'agent' } }
          : current.tabs
      }))
      get().reportError(error)
      throw error
    }
  },
  async launchTerminal(paneId, launcherTabId) {
    const state = get()
    const launcher = launcherTabId ? state.tabs[launcherTabId] : undefined
    const workspaceId = launcher?.workspaceId ?? state.activeWorkspaceId
    const workspace = state.config?.workspaces.find((item) => item.id === workspaceId)
    if (!workspace) throw new Error('Select a workspace first')
    const layout = state.layouts[workspace.id]
    if (!layout) throw new Error('Workspace layout is unavailable')
    const tabId = launcherTabId ?? newLauncherTab(workspace.id).id
    const sessionId = crypto.randomUUID()
    const pendingTab: TerminalWorkbenchTab = {
      id: tabId,
      kind: 'terminal',
      phase: 'launching',
      workspaceId: workspace.id,
      sessionId
    }
    set((current) => ({
      tabs: { ...current.tabs, [tabId]: pendingTab },
      layouts: {
        ...current.layouts,
        [workspace.id]: launcherTabId ? layout : addTab(layout, paneId, tabId)
      }
    }))
    try {
      const session = await api.sessions.launchTerminal({
        hostId: workspace.hostId,
        workspacePath: workspace.path,
        sessionId,
        label: `Terminal · ${workspace.name}`
      })
      set((current) => {
        const projected = reduceRuntimeEvent(current, { type: 'session', session })
        return {
          ...projected,
          tabs: projected.tabs[tabId]?.kind === 'terminal' && projected.tabs[tabId].sessionId === session.id
            ? { ...projected.tabs, [tabId]: { ...projected.tabs[tabId], phase: 'attached' } }
            : projected.tabs
        }
      })
    } catch (error) {
      set((current) => ({
        tabs: current.tabs[tabId]?.kind === 'terminal' && current.tabs[tabId].sessionId === sessionId
          ? { ...current.tabs, [tabId]: { id: tabId, kind: 'launcher', workspaceId: workspace.id, view: 'picker' } }
          : current.tabs
      }))
      get().reportError(error)
      throw error
    }
  },
  async createBrowser(paneId, launcherTabId) {
    const state = get()
    const launcher = launcherTabId ? state.tabs[launcherTabId] : undefined
    const workspaceId = launcher?.workspaceId ?? state.activeWorkspaceId
    if (!workspaceId) throw new Error('Select a workspace first')
    const layout = state.layouts[workspaceId]
    if (!layout) throw new Error('Workspace layout is unavailable')
    const tabId = launcherTabId ?? newLauncherTab(workspaceId).id
    if (!launcherTabId) {
      const launcherTab: LauncherWorkbenchTab = { id: tabId, kind: 'launcher', workspaceId, view: 'picker' }
      set((current) => ({
        tabs: { ...current.tabs, [tabId]: launcherTab },
        layouts: { ...current.layouts, [workspaceId]: addTab(layout, paneId, tabId) }
      }))
    }
    try {
      const browser = await api.browser.create(tabId, 'about:blank')
      const tab: BrowserWorkbenchTab = {
        ...browser,
        id: tabId,
        kind: 'browser',
        workspaceId,
        browserId: browser.id
      }
      set((current) => ({ tabs: { ...current.tabs, [tabId]: tab } }))
    } catch (error) {
      get().reportError(error)
      throw error
    }
  },
  applyBrowserEvent(event) {
    set((state) => reduceBrowserEvent(state, event))
  },
  async send(sessionId, text) {
    if (!text.trim()) return
    try {
      await api.sessions.send(sessionId, text.trim(), true)
    } catch (error) {
      get().reportError(error)
    }
  },
  async interrupt(sessionId) {
    await api.sessions.interrupt(sessionId).catch((error) => get().reportError(error))
  },
  async refreshSession(sessionId) {
    try {
      const session = await api.sessions.refresh(sessionId)
      set((state) => reduceRuntimeEvent(state, { type: 'session', session }))
    } catch (error) {
      get().reportError(error)
    }
  },
  async stopSession(sessionId) {
    await api.sessions.stop(sessionId).catch((error) => get().reportError(error))
  },
  applyEvent(event) {
    if (event.type === 'session') {
      const workspace = workspaceForSession(get().config, event.session)
      const hasTab = Object.values(get().tabs).some(
        (tab) => (tab.kind === 'agent' || tab.kind === 'terminal') && tab.sessionId === event.session.id
      )
      set((state) => reduceRuntimeEvent(state, event))
      if (workspace && !hasTab) get().selectSession(event.session.id)
    } else {
      set((state) => reduceRuntimeEvent(state, event))
    }
  },
  setConfig(config) {
    detectionRequestIds.clear()
    hostCheckRequestIds.clear()
    set({ config, agentDetections: {}, hostChecks: {} })
  },
  reportError(error) {
    set({ error: message(error) })
  }
}))
