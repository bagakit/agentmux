import type {
  AgentActivity,
  AgentId,
  RuntimeEvent,
  RuntimeSnapshot,
  SessionLaunchRequest,
  SessionSnapshot
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

export type AppConfig = {
  version: 1
  hosts: HostConfig[]
  agents: Record<string, AgentConfig>
  workspaces: WorkspaceRecord[]
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

export type WorkspaceBranchesSnapshot = {
  hostId: string
  repoPath: string
  branches: WorkspaceBranchRecord[]
}

export type WorkspaceSelectionResult = {
  config: AppConfig
  workspace: WorkspaceRecord
}

export type AgentLaunchInput = Omit<
  Extract<SessionLaunchRequest, { kind: 'agent' }>,
  'kind' | 'args' | 'env' | 'commandOverride'
>

export type TerminalLaunchInput = Omit<
  Extract<SessionLaunchRequest, { kind: 'terminal' }>,
  'kind'
>

export type HostCheckResult = {
  ok: boolean
  detail: string
}

export type AgentDetection = {
  agentId: AgentId
  hostId: string
  installed: boolean
}

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
  sessions: {
    snapshot(): Promise<RuntimeSnapshot>
    launchAgent(input: AgentLaunchInput): Promise<SessionSnapshot>
    launchTerminal(input: TerminalLaunchInput): Promise<SessionSnapshot>
    send(sessionId: string, text: string, submit?: boolean): Promise<void>
    interrupt(sessionId: string): Promise<void>
    resize(sessionId: string, cols: number, rows: number): Promise<void>
    refresh(sessionId: string): Promise<SessionSnapshot>
    stop(sessionId: string): Promise<void>
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

export type { AgentActivity, RuntimeEvent, RuntimeSnapshot, SessionSnapshot }
