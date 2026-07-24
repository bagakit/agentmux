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

/**
 * The final AgentMux runtime never infers semantic activity from terminal bytes.
 * Each public event names the owner that actually observed the fact.
 */
export type AgentMuxEvidenceSource =
  | 'terminal-output'
  | 'daemon-process'
  | 'native-hook'
  | 'acp'
  | 'user'

export type AgentMuxRunRef = {
  sessionId: string
  incarnationId: string
}

export type AgentMuxEvidence = {
  source: AgentMuxEvidenceSource
  observedAt: number
  daemonSession?: AgentMuxRunRef
  outputSequence?: {
    start: number
    end: number
  }
  hookReceiptId?: string
  acpSessionId?: string
}

export type AgentPromptDelivery = 'positional-argv' | 'hermes-query'

export type AgentReadySignal = {
  kind: 'foreground-process'
  expectedProcess: string
}

export type AgentHookStrategy =
  | { kind: 'none' }
  | { kind: 'native'; installation: 'explicit-managed' }

export type AgentResumeStrategy =
  | { kind: 'none' }
  | { kind: 'provider-native'; locator: 'session-id' | 'transcript-path' }

export type AgentAcpStrategy =
  | { kind: 'none' }
  | { kind: 'adapter' }

export type AgentCapabilities = {
  terminal: true
  hookEvents: boolean
  permission: 'none' | 'observe' | 'respond'
  providerResume: boolean
  acp: boolean
}

export type AgentCatalogEntry = {
  id: AgentId
  label: string
  executable: string
  expectedProcess: string
  promptDelivery: AgentPromptDelivery
  readySignal: AgentReadySignal
  hookStrategy: AgentHookStrategy
  resumeStrategy: AgentResumeStrategy
  acpStrategy: AgentAcpStrategy
  capabilities: AgentCapabilities
}

export type AgentCapabilitySnapshot = {
  agentId: AgentId
  executable: string
  installed: boolean
  capabilities: AgentCapabilities
}

export type AgentNativeSessionHandle =
  | {
      kind: 'provider'
      providerId: AgentId
      sessionId: string
      transcriptPath?: string
    }
  | {
      kind: 'acp'
      adapterId: string
      sessionId: string
    }

export type AgentHookReceipt = {
  id: string
  agentId: AgentId
  semanticSessionId: string
  daemonSession: AgentMuxRunRef
  eventName: string
  observedAt: number
}

export type AgentMuxSemanticSession = {
  kind: 'agent'
  semanticSessionId: string
  agentId: AgentId
  hostId: string
  workspacePath: string
  daemonSession: AgentMuxRunRef
  outputCursor: number
  createdAt: number
  updatedAt: number
  nativeHandle?: AgentNativeSessionHandle
  hookReceipt?: AgentHookReceipt
}

/** This is the complete persistent semantic record. It deliberately has no PTY,
 * process, replay, terminal snapshot, or output byte field. */
export type AgentMuxStoredSemanticSession = AgentMuxSemanticSession

export type AgentMuxPermissionOption = {
  id: string
  label: string
  kind: 'allow-once' | 'allow-always' | 'reject-once' | 'reject-always'
}

export type AgentMuxPermissionRequest = {
  id: string
  semanticSessionId: string
  title: string
  options: AgentMuxPermissionOption[]
  toolName?: string
  toolInput?: string
  evidence: AgentMuxEvidence
}

export type AgentMuxPermissionDecision =
  | { outcome: 'selected'; optionId: string }
  | { outcome: 'cancelled' }

export type AgentMuxAcpEvent =
  | {
      type: 'status'
      state: AgentSemanticState
      detail?: string
    }
  | {
      type: 'activity'
      kind: AgentActivityKind
      title: string
      content?: string
      toolName?: string
      toolInput?: string
    }
  | {
      type: 'native-session'
      sessionId: string
    }
  | {
      type: 'permission'
      requestId: string
      title: string
      options: AgentMuxPermissionOption[]
      toolName?: string
      toolInput?: string
    }

export type AgentMuxClientEvent =
  | {
      type: 'terminal-output'
      semanticSessionId?: string
      daemonSession: AgentMuxRunRef
      data: string
      evidence: AgentMuxEvidence
    }
  | {
      type: 'process-state'
      semanticSessionId?: string
      daemonSession: AgentMuxRunRef
      state: 'running' | 'exited' | 'lost'
      pid: number
      exitCode?: number
      exitSignal?: number
      evidence: AgentMuxEvidence
    }
  | {
      type: 'semantic-status'
      semanticSessionId: string
      state: AgentSemanticState
      detail?: string
      evidence: AgentMuxEvidence
    }
  | {
      type: 'semantic-activity'
      semanticSessionId: string
      activity: Omit<AgentActivity, 'sessionId' | 'source'>
      evidence: AgentMuxEvidence
    }
  | {
      type: 'permission'
      request: AgentMuxPermissionRequest
    }
  | {
      type: 'semantic-session'
      session: AgentMuxSemanticSession
    }
  | {
      type: 'semantic-error'
      semanticSessionId?: string
      code: string
      message: string
      evidence: AgentMuxEvidence
    }

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

export type AgentProviderResumeContext = {
  workspacePath: string
  nativeHandle: AgentNativeSessionHandle
  args: readonly string[]
  env: Readonly<Record<string, string>>
  commandOverride?: string
}

export type NativeHookEnvelope = {
  semanticSessionId: string
  daemonSessionId: string
  incarnationId: string
  agentId: AgentId
  eventName?: string
  payload?: Record<string, unknown>
}

export type NormalizedHookEvent = {
  semanticSessionId: string
  daemonSession: AgentMuxRunRef
  agentId: AgentId
  eventName: string
  semanticState: AgentSemanticState
  status: AgentStatus
  activities: AgentActivity[]
  nativeHandle?: AgentNativeSessionHandle
}

export type RuntimeSnapshot = {
  sessions: SessionSnapshot[]
  activities: Record<string, AgentActivity[]>
}
