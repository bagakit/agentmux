import type {
  AgentDisplayState,
  AgentId,
  AgentMuxClientEvent,
  AgentMuxEvidenceSource,
  AgentMuxRunDataEvent,
  AgentMuxRunRef,
  AgentMuxRunReplayGap,
  AgentMuxRunState,
  AgentMuxViewFocusTarget
} from '@agentmux/core'

export type LocalHostConfig = {
  id: 'local'
  kind: 'local'
  label: string
}

export type SshHostConfig = {
  id: string
  kind: 'ssh'
  label: string
  hostname: string
  user?: string
  port?: number
  identityFile?: string
}

export type HostConfig = LocalHostConfig | SshHostConfig

export type AgentConfig = {
  command: string
  args: string[]
  env: Record<string, string>
}

export type WorkspaceRecord = {
  id: string
  name: string
  hostId: string
  path: string
  kind: 'folder' | 'worktree'
  repoPath?: string
  branch?: string
}

export type TerminalThemeId = 'graphite' | 'catppuccin-mocha'

export type AppearanceConfig = {
  terminalTheme: TerminalThemeId
}

export type AppConfig = {
  version: 4
  hosts: HostConfig[]
  agents: Record<string, AgentConfig>
  workspaces: WorkspaceRecord[]
  appearance: AppearanceConfig
}

export type FileDocument = {
  path: string
  content: string
}

export type WorkspaceDirectoryEntry = {
  name: string
  path: string
  isDirectory: boolean
  isSymlink: boolean
}

export type CreateWorkspacePathInput = {
  path: string
  kind: 'file' | 'directory'
}

export type RenameWorkspacePathInput = {
  path: string
  nextPath: string
}

export type CreateWorkspaceInput = {
  hostId: string
  path: string
  name?: string
}

export type CreateWorktreeForBranchInput = {
  workspaceId: string
  branch: string
  path: string
}

export type WorkspaceBranchRecord = {
  name: string
  worktreePath: string | null
  workspaceId: string | null
  isCurrent: boolean
}

export type WorkspaceBranchesSnapshot =
  | {
      kind: 'git-repository'
      hostId: string
      repoPath: string
      branches: WorkspaceBranchRecord[]
    }
  | {
      kind: 'not-a-git-repository'
      hostId: string
      workspacePath: string
    }

export type WorkspaceSelectionResult = {
  config: AppConfig
  workspace: WorkspaceRecord
}

export type AgentLaunchInput = {
  agentId: AgentId
  hostId: string
  workspacePath: string
  agentSessionId?: string
  createOperationId?: string
  prompt?: string
  cols?: number
  rows?: number
}

export type TerminalLaunchInput = {
  hostId: string
  workspacePath: string
  createOperationId?: string
  cols?: number
  rows?: number
}

export type AgentSessionControl = {
  kind: 'agent'
  hostId: string
  agentSessionId: string
  run: AgentMuxRunRef
}

export type TerminalSessionControl = {
  kind: 'terminal'
  hostId: string
  runId: string
  run: AgentMuxRunRef
}

export type SessionControl = AgentSessionControl | TerminalSessionControl

export type SessionStatus = {
  state: AgentDisplayState
  source: AgentMuxEvidenceSource
  observedAt: number
  detail?: string
  exitCode?: number
}

type SessionSnapshotBase = {
  id: string
  hostId: string
  workspacePath: string
  label: string
  createdAt: number
  updatedAt: number
  processState: AgentMuxRunState
  status: SessionStatus
  latestOutputBytes: number
}

export type SessionSnapshot = SessionSnapshotBase & (
  | { kind: 'agent'; agentId: AgentId; control: AgentSessionControl }
  | { kind: 'terminal'; agentId: null; control: TerminalSessionControl }
)

export type AgentActivity = {
  id: string
  sessionId: string
  kind: 'prompt' | 'assistant' | 'tool' | 'permission' | 'lifecycle'
  source: AgentMuxEvidenceSource
  createdAt: number
  title: string
  content?: string
  toolName?: string
  toolInput?: string
  eventName?: string
}

export type RuntimeEvent = {
  type: 'core'
  hostId: string
  event: AgentMuxClientEvent
}

export type RuntimeSnapshot = {
  sessions: SessionSnapshot[]
  activities: Record<string, AgentActivity[]>
}

export type SessionAttachResult = {
  attachmentId: string
  session: SessionSnapshot
  replay: AgentMuxRunDataEvent[]
  gap: AgentMuxRunReplayGap | null
}

export type HostCheckResult = {
  ok: boolean
  detail: string
}

export type AgentDetection = {
  agentId: AgentId
  hostId: string
  installed: boolean
}

export type DesktopViewFocusTarget = AgentMuxViewFocusTarget

export type DesktopViewFocusResult = {
  viewId: string
  kind: 'terminal' | 'agent'
  workspaceId: string
  paneId: string
}

export type DesktopViewFocusRequest = {
  requestId: string
  target: DesktopViewFocusTarget
}

export type DesktopViewFocusResponse =
  | { requestId: string; ok: true; result: DesktopViewFocusResult }
  | { requestId: string; ok: false; code: string; message: string }

export type BrowserSnapshot = {
  id: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  error: string | null
}

export type BrowserEvent =
  | { type: 'updated'; browser: BrowserSnapshot }
  | { type: 'closed'; id: string }

export type BrowserBounds = {
  x: number
  y: number
  width: number
  height: number
}

export type AgentMuxDesktopApi = {
  config: {
    get(): Promise<AppConfig>
    save(config: AppConfig): Promise<AppConfig>
  }
  hosts: {
    check(host: HostConfig): Promise<HostCheckResult>
  }
  workspaces: {
    chooseLocalFolder(): Promise<WorkspaceRecord | null>
    add(input: CreateWorkspaceInput): Promise<WorkspaceRecord>
    listBranches(workspaceId: string): Promise<WorkspaceBranchesSnapshot>
    openBranch(workspaceId: string, branch: string): Promise<WorkspaceSelectionResult>
    createWorktreeForBranch(input: CreateWorktreeForBranchInput): Promise<WorkspaceSelectionResult>
  }
  files: {
    readDirectory(workspaceId: string, path: string): Promise<WorkspaceDirectoryEntry[]>
    read(workspaceId: string, path: string): Promise<FileDocument>
    write(workspaceId: string, document: FileDocument): Promise<void>
    create(workspaceId: string, input: CreateWorkspacePathInput): Promise<void>
    rename(workspaceId: string, input: RenameWorkspacePathInput): Promise<void>
    delete(workspaceId: string, path: string): Promise<void>
  }
  agents: {
    detect(agentId: AgentId, hostId: string): Promise<AgentDetection>
  }
  views: {
    focus(target: DesktopViewFocusTarget): Promise<DesktopViewFocusResult>
    onFocusRequest(listener: (target: DesktopViewFocusTarget) => DesktopViewFocusResult | Promise<DesktopViewFocusResult>): () => void
  }
  sessions: {
    snapshot(): Promise<RuntimeSnapshot>
    launchAgent(input: AgentLaunchInput): Promise<SessionSnapshot>
    launchTerminal(input: TerminalLaunchInput): Promise<SessionSnapshot>
    attach(session: SessionControl, afterByte?: number): Promise<SessionAttachResult>
    detach(attachmentId: string): Promise<void>
    write(session: SessionControl, data: string): Promise<void>
    submitPrompt(session: AgentSessionControl, prompt: string): Promise<void>
    acknowledge(session: SessionControl, throughByte: number): Promise<void>
    interrupt(session: SessionControl): Promise<void>
    resize(session: SessionControl, cols: number, rows: number): Promise<void>
    refresh(session: SessionControl): Promise<SessionSnapshot>
    stop(session: SessionControl): Promise<void>
    onEvent(listener: (event: RuntimeEvent) => void): () => void
  }
  browser: {
    create(id: string, url: string): Promise<BrowserSnapshot>
    navigate(id: string, url: string): Promise<BrowserSnapshot>
    back(id: string): Promise<BrowserSnapshot>
    forward(id: string): Promise<BrowserSnapshot>
    reload(id: string): Promise<BrowserSnapshot>
    setBounds(id: string, bounds: BrowserBounds | null): Promise<void>
    close(id: string): Promise<void>
    onEvent(listener: (event: BrowserEvent) => void): () => void
  }
}
