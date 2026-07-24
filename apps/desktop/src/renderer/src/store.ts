import { create } from 'zustand'
import type {
  AgentActivity,
  AgentRuntimeEvent,
  AgentSessionSnapshot,
  AppConfig,
  FileDocument
} from '../../shared/contracts'
import { api } from './lib/api'

type ViewMode = 'terminal' | 'conversation'
type MainSurface = 'workbench' | 'board'

type AppState = {
  config: AppConfig | null
  sessions: AgentSessionSnapshot[]
  activities: Record<string, AgentActivity[]>
  activeWorkspaceId: string | null
  activeSessionId: string | null
  files: string[]
  activeDocument: FileDocument | null
  documentDirty: boolean
  viewMode: ViewMode
  mainSurface: MainSurface
  loading: boolean
  error: string | null
  initialize(): Promise<() => void>
  selectWorkspace(id: string): Promise<void>
  selectSession(id: string): void
  startNewSession(): void
  setViewMode(mode: ViewMode): void
  setMainSurface(surface: MainSurface): void
  openFile(path: string): Promise<void>
  updateDocument(content: string): void
  saveDocument(): Promise<void>
  launch(agentId: string, prompt: string): Promise<void>
  send(text: string): Promise<void>
  interrupt(): Promise<void>
  stopSession(): Promise<void>
  applyEvent(event: AgentRuntimeEvent): void
  setConfig(config: AppConfig): void
  reportError(error: unknown): void
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const useAppStore = create<AppState>((set, get) => ({
  config: null,
  sessions: [],
  activities: {},
  activeWorkspaceId: null,
  activeSessionId: null,
  files: [],
  activeDocument: null,
  documentDirty: false,
  viewMode: 'terminal',
  mainSurface: 'workbench',
  loading: true,
  error: null,
  async initialize() {
    try {
      const [config, snapshot] = await Promise.all([api.config.get(), api.agents.snapshot()])
      const firstWorkspace = config.workspaces[0]?.id ?? null
      const firstSession = snapshot.sessions.find((item) => {
        const workspace = config.workspaces.find((entry) => entry.id === firstWorkspace)
        return workspace && item.hostId === workspace.hostId && item.workspacePath === workspace.path
      })
      set({
        config,
        sessions: snapshot.sessions,
        activities: snapshot.activities,
        activeWorkspaceId: firstWorkspace,
        activeSessionId: firstSession?.id ?? snapshot.sessions[0]?.id ?? null,
        loading: false
      })
      if (firstWorkspace) await get().selectWorkspace(firstWorkspace)
      return api.agents.onEvent((event) => get().applyEvent(event))
    } catch (error) {
      set({ loading: false, error: message(error) })
      return () => {}
    }
  },
  async selectWorkspace(id) {
    set({
      activeWorkspaceId: id,
      activeDocument: null,
      documentDirty: false,
      viewMode: 'terminal',
      mainSurface: 'workbench',
      error: null
    })
    try {
      const files = await api.files.list(id)
      const config = get().config
      const workspace = config?.workspaces.find((item) => item.id === id)
      const session = get().sessions.find(
        (item) => workspace && item.hostId === workspace.hostId && item.workspacePath === workspace.path
      )
      set({ files, activeSessionId: session?.id ?? null })
    } catch (error) {
      get().reportError(error)
    }
  },
  selectSession(id) {
    set({ activeSessionId: id, mainSurface: 'workbench' })
  },
  startNewSession() {
    set({ activeSessionId: null, viewMode: 'terminal', mainSurface: 'workbench' })
  },
  setViewMode(viewMode) {
    set({ viewMode })
  },
  setMainSurface(mainSurface) {
    set({ mainSurface })
  },
  async openFile(path) {
    const workspaceId = get().activeWorkspaceId
    if (!workspaceId) return
    try {
      const activeDocument = await api.files.read(workspaceId, path)
      set({ activeDocument, documentDirty: false })
    } catch (error) {
      get().reportError(error)
    }
  },
  updateDocument(content) {
    const current = get().activeDocument
    if (current) set({ activeDocument: { ...current, content }, documentDirty: true })
  },
  async saveDocument() {
    const workspaceId = get().activeWorkspaceId
    const document = get().activeDocument
    if (!workspaceId || !document) return
    try {
      await api.files.write(workspaceId, document)
      set({ documentDirty: false })
    } catch (error) {
      get().reportError(error)
    }
  },
  async launch(agentId, prompt) {
    const state = get()
    const workspace = state.config?.workspaces.find((item) => item.id === state.activeWorkspaceId)
    if (!workspace) throw new Error('Select a workspace first')
    try {
      const session = await api.agents.launch({
        agentId,
        hostId: workspace.hostId,
        workspacePath: workspace.path,
        prompt,
        label: `${agentId} · ${workspace.name}`
      })
      set({ activeSessionId: session.id, viewMode: 'terminal' })
    } catch (error) {
      get().reportError(error)
    }
  },
  async send(text) {
    const sessionId = get().activeSessionId
    if (!sessionId || !text.trim()) return
    try {
      await api.agents.send(sessionId, text.trim(), true)
    } catch (error) {
      get().reportError(error)
    }
  },
  async interrupt() {
    const id = get().activeSessionId
    if (id) await api.agents.interrupt(id).catch((error) => get().reportError(error))
  },
  async stopSession() {
    const id = get().activeSessionId
    if (!id) return
    await api.agents.stop(id).catch((error) => get().reportError(error))
  },
  applyEvent(event) {
    if (event.type === 'session') {
      set((state) => ({
        sessions: [...state.sessions.filter((item) => item.id !== event.session.id), event.session]
      }))
    } else if (event.type === 'status') {
      set((state) => ({
        sessions: state.sessions.map((item) =>
          item.id === event.sessionId ? { ...item, status: event.status, updatedAt: event.status.observedAt } : item
        )
      }))
    } else if (event.type === 'terminal') {
      set((state) => ({
        sessions: state.sessions.map((item) =>
          item.id === event.sessionId ? { ...item, terminalSnapshot: event.snapshot, updatedAt: event.observedAt } : item
        )
      }))
    } else if (event.type === 'activity') {
      set((state) => ({
        activities: {
          ...state.activities,
          [event.sessionId]: [...(state.activities[event.sessionId] ?? []), event.activity]
        }
      }))
    } else {
      set((state) => ({
        sessions: state.sessions.filter((item) => item.id !== event.sessionId),
        activeSessionId: state.activeSessionId === event.sessionId ? null : state.activeSessionId
      }))
    }
  },
  setConfig(config) {
    set({ config })
  },
  reportError(error) {
    set({ error: message(error) })
  }
}))
