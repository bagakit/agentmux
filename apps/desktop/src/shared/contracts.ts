import type {
  AgentActivity,
  AgentId,
  AgentLaunchRequest,
  AgentRuntimeEvent,
  AgentSessionSnapshot,
  RuntimeSnapshot
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

export type CreateWorkspaceInput = {
  hostId: string
  path: string
  name?: string
}

export type CreateWorktreeInput = {
  hostId: string
  repoPath: string
  path: string
  branch: string
  baseRef: string
  name?: string
}

export type AgentLaunchInput = Omit<AgentLaunchRequest, 'args' | 'env' | 'commandOverride'>

export type HostCheckResult = {
  ok: boolean
  detail: string
}

export type AgentDetection = {
  agentId: AgentId
  hostId: string
  installed: boolean
}

export type AgentMuxDesktopApi = {
  config: {
    get(): Promise<AppConfig>
    save(config: AppConfig): Promise<AppConfig>
  }
  hosts: {
    check(hostId: string): Promise<HostCheckResult>
  }
  workspaces: {
    chooseLocalFolder(): Promise<WorkspaceRecord | null>
    add(input: CreateWorkspaceInput): Promise<WorkspaceRecord>
    createWorktree(input: CreateWorktreeInput): Promise<WorkspaceRecord>
  }
  files: {
    list(workspaceId: string): Promise<string[]>
    read(workspaceId: string, path: string): Promise<FileDocument>
    write(workspaceId: string, document: FileDocument): Promise<void>
  }
  agents: {
    snapshot(): Promise<RuntimeSnapshot>
    detect(agentId: AgentId, hostId: string): Promise<AgentDetection>
    launch(input: AgentLaunchInput): Promise<AgentSessionSnapshot>
    send(sessionId: string, text: string, submit?: boolean): Promise<void>
    interrupt(sessionId: string): Promise<void>
    resize(sessionId: string, cols: number, rows: number): Promise<void>
    stop(sessionId: string): Promise<void>
    onEvent(listener: (event: AgentRuntimeEvent) => void): () => void
  }
}

export type { AgentActivity, AgentRuntimeEvent, AgentSessionSnapshot, RuntimeSnapshot }
