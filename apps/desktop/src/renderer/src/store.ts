import { create } from 'zustand'
import type {
  AgentActivity,
  AgentDetection,
  AppConfig,
  BrowserEvent,
  CreateWorkspacePathInput,
  DesktopViewFocusResult,
  DesktopViewFocusTarget,
  FileDocument,
  HostConfig,
  HostCheckResult,
  RuntimeEvent,
  SessionSnapshot,
  WorkspaceSelectionResult
} from '../../shared/contracts'
import { api } from './lib/api'
import { rendererResourceOwnerCounts } from './lib/resource-owner-counts'
import { terminalResourceOwnerCounts } from './lib/terminal-resource-owners'
import { resolveWorkbenchViewFocus } from './lib/view-focus'
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
  reduceDocumentRead,
  reduceDocumentReloaded,
  reduceDocumentSaving,
  reduceDocumentWriteError,
  reduceDocumentWritten,
  reduceFileClosed,
  reduceFileDelete,
  reduceFileOpened,
  reduceFileRename,
  type FileDocumentIssue
} from './lib/file-workbench-state'
import {
  ownsSessionLaunch,
  reduceRuntimeEvent,
  reduceSessionLaunchAttached,
  reduceSessionLaunchFailed,
  type SessionViewMode
} from './lib/session-state'
import {
  TOOL_DOCK_DEFAULT_WIDTH,
  clampToolDockWidth,
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
import { isPathWithinSubtree, remapPathWithinSubtree } from './lib/workspace-paths'

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
  documentGenerations: Record<string, number>
  documentObservationGenerations: Record<string, number>
  documentIssues: Record<string, FileDocumentIssue | undefined>
  savingDocuments: Record<string, boolean>
  lastActiveFileByWorkspace: Record<string, string | undefined>
  tabs: Record<string, WorkbenchTab>
  layouts: Record<string, WorkspaceLayout>
  viewModes: Record<string, ViewMode>
  agentDetections: Record<string, AgentDetectionState>
  hostChecks: Record<string, HostCheckState>
  mainSurface: MainSurface
  toolsOpen: boolean
  workspaceTool: WorkspaceTool
  toolDockWidth: number
  loading: boolean
  error: string | null
  initialize(): Promise<() => void>
  selectWorkspace(id: string): Promise<void>
  activateWorkspaceSelection(result: WorkspaceSelectionResult): void
  focusPane(workspaceId: string, paneId: string): void
  activateTab(workspaceId: string, paneId: string, tabId: string): void
  focusView(target: DesktopViewFocusTarget): DesktopViewFocusResult
  selectSession(id: string, paneId?: string): void
  openLauncher(paneId?: string, view?: LauncherView): void
  setLauncherView(tabId: string, view: LauncherView): void
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
  overwriteDocument(tabId: string): Promise<void>
  reloadDocument(tabId: string): Promise<void>
  refreshDocument(workspaceId: string, path: string): Promise<void>
  launchBoardAgent(workspaceId: string, agentId: string, prompt: string): Promise<void>
  launchAgent(agentId: string, prompt: string, paneId: string, launcherTabId?: string): Promise<void>
  launchTerminal(paneId: string, launcherTabId?: string, workspacePath?: string): Promise<void>
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
const fileDocumentLifetimes = new Map<string, number>()
const fileReadRequestIds = new Map<string, number>()
const fileReadInFlightCounts = new Map<string, number>()
const fileInvalidationSequences = new Map<string, number>()
const fileSaveTails = new Map<string, Promise<void>>()
const fileOpenRequests = new Map<string, Promise<boolean>>()
let runtimeSubscriptionCount = 0

function documentLifetime(key: string): number {
  return fileDocumentLifetimes.get(key) ?? 0
}

function advanceDocumentLifetime(key: string): number {
  const lifetime = documentLifetime(key) + 1
  fileDocumentLifetimes.set(key, lifetime)
  fileReadRequestIds.set(key, (fileReadRequestIds.get(key) ?? 0) + 1)
  return lifetime
}

if (typeof window !== 'undefined') {
  window.addEventListener('agentmux:resource-owner-counts', (event) => {
    const target = event as CustomEvent<Record<string, number | boolean>>
    const resourceWindow = window as typeof window & { __agentmuxMonacoModelCount?: () => number }
    Object.assign(target.detail, rendererResourceOwnerCounts({
      documentCount: Object.keys(useAppStore.getState().documents).length,
      runtimeSubscriptionCount,
      terminalOwners: terminalResourceOwnerCounts(),
      ...(resourceWindow.__agentmuxMonacoModelCount
        ? { monacoModelCount: resourceWindow.__agentmuxMonacoModelCount }
        : {})
    }))
    target.detail.observed = true
  })
}

function newPaneId(): string {
  return `pane-${crypto.randomUUID()}`
}

function newLauncherTab(workspaceId: string, view: LauncherView = 'picker'): LauncherWorkbenchTab {
  return { id: `launcher:${crypto.randomUUID()}`, kind: 'launcher', workspaceId, view }
}

async function refreshFileDocument(
  workspaceId: string,
  path: string,
  expectedLifetime = documentLifetime(documentKey(workspaceId, path))
): Promise<void> {
  const key = documentKey(workspaceId, path)
  if (documentLifetime(key) !== expectedLifetime || !useAppStore.getState().documents[key]) return
  const requestId = (fileReadRequestIds.get(key) ?? 0) + 1
  fileReadRequestIds.set(key, requestId)
  fileReadInFlightCounts.set(key, (fileReadInFlightCounts.get(key) ?? 0) + 1)
  try {
    let result
    try {
      result = await api.files.read(workspaceId, path)
    } catch (error) {
      result = {
        status: 'error' as const,
        code: typeof error === 'object' && error !== null && 'code' in error
          ? String(error.code)
          : 'WORKSPACE_FILE_READ_FAILED',
        message: message(error)
      }
    }
    if (documentLifetime(key) !== expectedLifetime || fileReadRequestIds.get(key) !== requestId) return
    useAppStore.setState((state) => reduceDocumentRead(state, workspaceId, path, result))
  } finally {
    const remaining = (fileReadInFlightCounts.get(key) ?? 1) - 1
    if (remaining === 0) fileReadInFlightCounts.delete(key)
    else fileReadInFlightCounts.set(key, remaining)
  }
}

async function enqueueFileSave(tabId: string, overwrite: boolean): Promise<void> {
  const initialTab = useAppStore.getState().tabs[tabId]
  if (initialTab?.kind !== 'file') return
  const key = documentKey(initialTab.workspaceId, initialTab.path)
  const previous = fileSaveTails.get(key) ?? Promise.resolve()
  const operation = previous.catch(() => {}).then(async () => {
    const state = useAppStore.getState()
    const tab = state.tabs[tabId]
    if (tab?.kind !== 'file') return
    const currentKey = documentKey(tab.workspaceId, tab.path)
    const document = state.documents[currentKey]
    const issue = state.documentIssues[currentKey]
    if (!document) return
    const hasOverwriteConflict = overwrite && (issue?.kind === 'changed' || issue?.kind === 'deleted')
    if (!state.dirtyDocuments[currentKey] && !hasOverwriteConflict) return
    if (!overwrite && (issue?.kind === 'changed' || issue?.kind === 'deleted' || issue?.kind === 'read-error')) {
      return
    }
    if (overwrite && issue?.kind !== 'changed' && issue?.kind !== 'deleted') return
    const generation = state.documentGenerations[currentKey] ?? 0
    const observationGeneration = state.documentObservationGenerations[currentKey] ?? 0
    const savedLifetime = documentLifetime(currentKey)
    let expectedRevision: string | null = document.revision
    if (overwrite) {
      if (issue?.kind === 'changed') expectedRevision = issue.observed.revision
      else if (issue?.kind === 'deleted') expectedRevision = null
      else return
    }
    useAppStore.setState((current) => reduceDocumentSaving(
      current,
      tab.workspaceId,
      tab.path,
      true
    ))
    let result
    try {
      result = await api.files.write(tab.workspaceId, {
        path: tab.path,
        content: document.content,
        expectedRevision
      })
    } catch (error) {
      result = {
        status: 'error' as const,
        code: typeof error === 'object' && error !== null && 'code' in error
          ? String(error.code)
          : 'WORKSPACE_FILE_WRITE_FAILED',
        message: message(error)
      }
    }
    if (documentLifetime(currentKey) !== savedLifetime || !useAppStore.getState().documents[currentKey]) return
    if (result.status === 'written') {
      const receiptState = useAppStore.getState()
      const receiptIssue = receiptState.documentIssues[currentKey]
      const hasObservedDiskFact =
        receiptIssue?.kind === 'changed' ||
        receiptIssue?.kind === 'deleted' ||
        receiptIssue?.kind === 'read-error'
      const needsReconciliation =
        (fileReadInFlightCounts.get(currentKey) ?? 0) > 0 ||
        ((receiptState.documentObservationGenerations[currentKey] ?? 0) !== observationGeneration &&
          !hasObservedDiskFact)
      fileReadRequestIds.set(currentKey, (fileReadRequestIds.get(currentKey) ?? 0) + 1)
      useAppStore.setState((current) => reduceDocumentWritten(
        current,
        tab.workspaceId,
        tab.path,
        generation,
        result.revision,
        expectedRevision,
        observationGeneration
      ))
      if (needsReconciliation) await refreshFileDocument(tab.workspaceId, tab.path, savedLifetime)
      return
    }
    if (result.status === 'error') {
      useAppStore.setState((current) => reduceDocumentWriteError(
        current,
        tab.workspaceId,
        tab.path,
        result.code,
        result.message
      ))
      return
    }
    useAppStore.setState((current) => reduceDocumentSaving(
      current,
      tab.workspaceId,
      tab.path,
      false
    ))
    await refreshFileDocument(tab.workspaceId, tab.path, savedLifetime)
  })
  const tail = operation.then(() => {}, () => {})
  fileSaveTails.set(key, tail)
  try {
    await operation
  } finally {
    if (fileSaveTails.get(key) === tail) fileSaveTails.delete(key)
  }
}

export const useAppStore = create<AppState>((set, get) => ({
  config: null,
  sessions: [],
  activities: {},
  activeWorkspaceId: null,
  documents: {},
  dirtyDocuments: {},
  documentGenerations: {},
  documentObservationGenerations: {},
  documentIssues: {},
  savingDocuments: {},
  lastActiveFileByWorkspace: {},
  tabs: {},
  layouts: {},
  viewModes: {},
  agentDetections: {},
  hostChecks: {},
  mainSurface: 'workbench',
  toolsOpen: true,
  workspaceTool: 'files-branches',
  toolDockWidth: TOOL_DOCK_DEFAULT_WIDTH,
  loading: true,
  error: null,
  async initialize() {
    const pendingSessionEvents: RuntimeEvent[] = []
    const pendingBrowserEvents: BrowserEvent[] = []
    let booting = true
    const disposeSessions = api.sessions.onEvent((event) => {
      if (booting) {
        if (event.event.type !== 'terminal-output') {
          pendingSessionEvents.push(event)
          if (pendingSessionEvents.length > 256) pendingSessionEvents.shift()
        }
        return
      }
      get().applyEvent(event)
    })
    const disposeBrowsers = api.browser.onEvent((event) => {
      if (booting) {
        pendingBrowserEvents.push(event)
        if (pendingBrowserEvents.length > 256) pendingBrowserEvents.shift()
      }
      else get().applyBrowserEvent(event)
    })
    const disposeViewFocus = api.views.onFocusRequest((target) => get().focusView(target))
    const disposeFileInvalidations = api.files.onInvalidated((event) => {
      const key = documentKey(event.workspaceId, event.path)
      fileInvalidationSequences.set(key, (fileInvalidationSequences.get(key) ?? 0) + 1)
      void get().refreshDocument(event.workspaceId, event.path)
    })
    runtimeSubscriptionCount += 4
    const disposeRuntimeSubscriptions = (): void => {
      if (runtimeSubscriptionCount === 0) return
      runtimeSubscriptionCount -= 4
      disposeSessions()
      disposeBrowsers()
      disposeViewFocus()
      disposeFileInvalidations()
    }
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
      booting = false
      for (const event of pendingSessionEvents) get().applyEvent(event)
      for (const event of pendingBrowserEvents) get().applyBrowserEvent(event)
      return () => {
        disposeRuntimeSubscriptions()
      }
    } catch (error) {
      booting = false
      disposeRuntimeSubscriptions()
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
  focusView(target) {
    const state = get()
    const resolved = resolveWorkbenchViewFocus({
      sessions: state.sessions,
      tabs: state.tabs,
      layouts: state.layouts,
      target
    })
    const layout = state.layouts[resolved.workspaceId]!
    set({
      activeWorkspaceId: resolved.workspaceId,
      mainSurface: 'workbench',
      layouts: {
        ...state.layouts,
        [resolved.workspaceId]: activateLayoutTab(layout, resolved.paneId, resolved.viewId)
      }
    })
    return resolved
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
  setLauncherView(tabId, view) {
    set((state) => {
      const tab = state.tabs[tabId]
      return tab?.kind === 'launcher'
        ? { tabs: { ...state.tabs, [tabId]: { ...tab, view } } }
        : state
    })
  },
  async closeTab(workspaceId, paneId, tabId) {
    const tab = get().tabs[tabId]
    if (tab?.kind === 'file') {
      const key = documentKey(tab.workspaceId, tab.path)
      set((state) => {
        const next = reduceFileClosed(state, workspaceId, paneId, tabId)
        if (state.documents[key] && !next.documents[key]) advanceDocumentLifetime(key)
        return next
      })
      if (!get().documents[key]) {
        await api.files.unobserve(tab.workspaceId, tab.path)
      }
      return
    }
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
      const existing = get().documents[key]
      if (existing) {
        set((state) => reduceFileOpened(state, workspaceId, path, existing, paneId))
        return
      }
      while (!get().documents[key]) {
        let request = fileOpenRequests.get(key)
        const joinedRequest = Boolean(request)
        if (!request) {
          const openedLifetime = advanceDocumentLifetime(key)
          request = Promise.resolve().then(async () => {
            try {
              const invalidationSequence = fileInvalidationSequences.get(key) ?? 0
              await api.files.observe(workspaceId, path)
              const result = await api.files.read(workspaceId, path)
              if (result.status !== 'read') {
                await api.files.unobserve(workspaceId, path)
                throw new Error(result.status === 'deleted'
                  ? `File was deleted: ${path}`
                  : result.message)
              }
              if (documentLifetime(key) !== openedLifetime) {
                await api.files.unobserve(workspaceId, path)
                return false
              }
              set((state) => reduceFileOpened(state, workspaceId, path, result.document, paneId))
              if (fileOpenRequests.get(key) === request) fileOpenRequests.delete(key)
              if ((fileInvalidationSequences.get(key) ?? 0) !== invalidationSequence) {
                await refreshFileDocument(workspaceId, path, openedLifetime)
              }
              return true
            } catch (error) {
              get().reportError(error)
              return false
            } finally {
              if (fileOpenRequests.get(key) === request) fileOpenRequests.delete(key)
            }
          })
          fileOpenRequests.set(key, request)
        }
        const opened = await request
        if (!opened || get().documents[key]) return
        if (!joinedRequest) return
      }
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
    const observedPaths = Object.keys(get().documents).flatMap((key) => {
      const prefix = `${workspaceId}\0`
      if (!key.startsWith(prefix)) return []
      const documentPath = key.slice(prefix.length)
      return isPathWithinSubtree(documentPath, path) ? [documentPath] : []
    })
    try {
      await api.files.rename(workspaceId, { path, nextPath })
      set((state) => reduceFileRename(state, workspaceId, path, nextPath))
      for (const observedPath of observedPaths) {
        const renamedPath = remapPathWithinSubtree(observedPath, path, nextPath)
        await api.files.unobserve(workspaceId, observedPath)
        await api.files.observe(workspaceId, renamedPath)
        await get().refreshDocument(workspaceId, renamedPath)
      }
    } catch (error) {
      get().reportError(error)
      throw error
    }
  },
  async deletePath(path) {
    const workspaceId = get().activeWorkspaceId
    if (!workspaceId) throw new Error('Select a workspace first')
    const observedPaths = Object.keys(get().documents).flatMap((key) => {
      const prefix = `${workspaceId}\0`
      if (!key.startsWith(prefix)) return []
      const documentPath = key.slice(prefix.length)
      return isPathWithinSubtree(documentPath, path) ? [documentPath] : []
    })
    try {
      await api.files.delete(workspaceId, path)
      set((state) => reduceFileDelete(state, workspaceId, path))
      await Promise.all(observedPaths.map(async (observedPath) => {
        await api.files.unobserve(workspaceId, observedPath)
      }))
    } catch (error) {
      get().reportError(error)
      throw error
    }
  },
  updateDocument(tabId, content) {
    set((state) => reduceDocumentContent(state, tabId, content))
  },
  async saveDocument(tabId) {
    await enqueueFileSave(tabId, false)
  },
  async overwriteDocument(tabId) {
    await enqueueFileSave(tabId, true)
  },
  async reloadDocument(tabId) {
    const tab = get().tabs[tabId]
    if (tab?.kind !== 'file') return
    const key = documentKey(tab.workspaceId, tab.path)
    const issue = get().documentIssues[key]
    if (issue?.kind === 'changed') {
      set((state) => reduceDocumentReloaded(state, tab.workspaceId, tab.path, issue.observed))
      return
    }
    if (issue?.kind === 'deleted') {
      set((state) => reduceFileDelete(state, tab.workspaceId, tab.path))
      await api.files.unobserve(tab.workspaceId, tab.path)
      return
    }
    await get().refreshDocument(tab.workspaceId, tab.path)
  },
  async refreshDocument(workspaceId, path) {
    await refreshFileDocument(workspaceId, path)
  },
  async launchBoardAgent(workspaceId, agentId, prompt) {
    await get().selectWorkspace(workspaceId)
    set({ mainSurface: 'board' })
    const layout = get().layouts[workspaceId]
    if (!layout) throw new Error('Workspace layout is unavailable')
    await get().launchAgent(agentId, prompt, layout.activeGroupId)
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
        agentSessionId: sessionId,
        createOperationId: crypto.randomUUID()
      })
      if (!ownsSessionLaunch(get().tabs[tabId], 'agent', sessionId)) {
        await api.sessions.stop(session.control).catch((cleanupError) => {
          if (get().sessions.some((item) => item.id === session.id)) get().reportError(cleanupError)
        })
        return
      }
      set((current) => reduceSessionLaunchAttached(current, tabId, session))
    } catch (error) {
      if (!ownsSessionLaunch(get().tabs[tabId], 'agent', sessionId)) return
      set((current) => reduceSessionLaunchFailed(current, tabId, 'agent', sessionId, 'agent'))
      get().reportError(error)
      throw error
    }
  },
  async launchTerminal(paneId, launcherTabId, workspacePath) {
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
        workspacePath: workspacePath ?? workspace.path,
        createOperationId: crypto.randomUUID()
      })
      if (!ownsSessionLaunch(get().tabs[tabId], 'terminal', sessionId)) {
        await api.sessions.stop(session.control).catch((cleanupError) => {
          if (get().sessions.some((item) => item.id === session.id)) get().reportError(cleanupError)
        })
        return
      }
      set((current) => {
        const tab = current.tabs[tabId]
        if (!ownsSessionLaunch(tab, 'terminal', sessionId) || tab?.kind !== 'terminal') return current
        return reduceSessionLaunchAttached({
          ...current,
          tabs: {
            ...current.tabs,
            [tabId]: { ...tab, sessionId: session.id }
          }
        }, tabId, session)
      })
    } catch (error) {
      if (!ownsSessionLaunch(get().tabs[tabId], 'terminal', sessionId)) return
      set((current) => reduceSessionLaunchFailed(current, tabId, 'terminal', sessionId, 'picker'))
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
      if (get().tabs[tabId]?.kind !== 'launcher') {
        await api.browser.close(browser.id)
        return
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
    const session = get().sessions.find((item) => item.id === sessionId)
    if (!session || session.kind !== 'agent') return
    try {
      await api.sessions.submitPrompt(session.control, text)
    } catch (error) {
      get().reportError(error)
      throw error
    }
  },
  async interrupt(sessionId) {
    const session = get().sessions.find((item) => item.id === sessionId)
    if (session) await api.sessions.interrupt(session.control).catch((error) => get().reportError(error))
  },
  async refreshSession(sessionId) {
    const current = get().sessions.find((item) => item.id === sessionId)
    if (!current) return
    try {
      const session = await api.sessions.refresh(current.control)
      set((state) => ({
        sessions: [...state.sessions.filter((item) => item.id !== session.id), session]
      }))
    } catch (error) {
      get().reportError(error)
    }
  },
  async stopSession(sessionId) {
    const session = get().sessions.find((item) => item.id === sessionId)
    if (session) await api.sessions.stop(session.control).catch((error) => get().reportError(error))
  },
  applyEvent(event) {
    set((state) => reduceRuntimeEvent(state, event))
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
