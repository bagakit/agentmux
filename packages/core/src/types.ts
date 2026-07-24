export type BuiltInAgentId = 'codex' | 'claude' | 'traex' | 'hermes' | 'pi'
export type AgentId = BuiltInAgentId | (string & {})

export type ExecutionHostKind = 'local' | 'ssh'

export type AgentProcessState = 'starting' | 'running' | 'exited' | 'unknown'

export type AgentSemanticState =
  | 'unknown'
  | 'working'
  | 'waiting'
  | 'blocked'
  | 'done'
  | 'error'

export type AgentDisplayState =
  | 'starting'
  | 'running'
  | 'disconnected'
  | 'working'
  | 'waiting'
  | 'blocked'
  | 'done'
  | 'exited'
  | 'error'

export type AgentEvidenceSource = 'native-hook' | 'tmux' | 'output' | 'user'

export type AgentStatus = {
  state: AgentDisplayState
  source: AgentEvidenceSource
  observedAt: number
  detail?: string
  exitCode?: number
}

export type AgentActivityKind =
  | 'prompt'
  | 'assistant'
  | 'tool'
  | 'permission'
  | 'lifecycle'

export type AgentActivity = {
  id: string
  sessionId: string
  kind: AgentActivityKind
  source: AgentEvidenceSource
  createdAt: number
  title: string
  content?: string
  toolName?: string
  toolInput?: string
  eventName?: string
}

type SessionSnapshotBase = {
  id: string
  tmuxSession: string
  hostId: string
  workspacePath: string
  label: string
  createdAt: number
  updatedAt: number
  processState: AgentProcessState
  status: AgentStatus
  terminalSnapshot: string
  panePid?: number
  paneCommand?: string
}

export type SessionSnapshot = SessionSnapshotBase & (
  | { kind: 'agent'; agentId: AgentId }
  | { kind: 'terminal'; agentId: null }
)

export type RuntimeEvent =
  | { type: 'session'; session: SessionSnapshot }
  | { type: 'status'; sessionId: string; status: AgentStatus }
  | { type: 'terminal'; sessionId: string; snapshot: string; observedAt: number }
  | { type: 'activity'; sessionId: string; activity: AgentActivity }
  | { type: 'removed'; sessionId: string }

type SessionLaunchRequestBase = {
  hostId?: string
  workspacePath: string
  sessionId?: string
  label?: string
  cols?: number
  rows?: number
}

export type SessionLaunchRequest = SessionLaunchRequestBase & (
  | {
      kind: 'agent'
      agentId: AgentId
      prompt?: string
      args?: readonly string[]
      env?: Readonly<Record<string, string>>
      commandOverride?: string
    }
  | {
      kind: 'terminal'
    }
)

export type AgentLaunchPlan = {
  command: string
  args: string[]
  env: Record<string, string>
}

export type AgentProviderLaunchContext = {
  workspacePath: string
  prompt: string
  args: readonly string[]
  env: Readonly<Record<string, string>>
  commandOverride?: string
}

export type NativeHookEnvelope = {
  sessionId: string
  agentId: AgentId
  eventName?: string
  payload?: Record<string, unknown>
}

export type NormalizedHookEvent = {
  sessionId: string
  agentId: AgentId
  eventName: string
  semanticState: AgentSemanticState
  status: AgentStatus
  activities: AgentActivity[]
}

export type RuntimeSnapshot = {
  sessions: SessionSnapshot[]
  activities: Record<string, AgentActivity[]>
}
