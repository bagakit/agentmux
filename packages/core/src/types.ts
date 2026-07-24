export type BuiltInAgentId = 'codex' | 'claude' | 'traex' | 'hermes' | 'pi'
export type AgentId = BuiltInAgentId | (string & {})

export type ExecutionHostKind = 'local' | 'ssh'

export type AgentMuxRuntimeIdentity = {
  hostId: string
  buildIdentity: string
  protocolVersion: number
  processId: number | null
  instanceId: string
}

export type AgentMuxRuntimeDiagnostics = {
  nodeVersion: string
  platform: NodeJS.Platform
  arch: string
  supported: boolean
  ctxmux: {
    version: string
    protocolVersion: number
    sourceCommit: string
    artifactPlatform: string
    ready: boolean
  }
}

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

/**
 * The final AgentMux runtime never infers semantic activity from terminal bytes.
 * Each public event names the owner that actually observed the fact.
 */
export type AgentMuxEvidenceSource =
  | 'terminal-output'
  | 'run-process'
  | 'native-hook'
  | 'acp'
  | 'user'

export type AgentMuxRunState = 'running' | 'exited' | 'interrupted'

export type AgentMuxRunRef = {
  runId: string
}

export type AgentMuxRun = AgentMuxRunRef & {
  kind: 'terminal' | 'agent'
  agentId: AgentId | null
  agentSessionId: string | null
  workspacePath: string
  pid: number | null
  state: AgentMuxRunState
  cols: number
  rows: number
  observedAt: number
  latestOutputBytes: number
  acceptedInputBytes: number
  exitCode?: number
  exitSignal?: string
  interruptionReason?: string
}

export type AgentMuxRunDataEvent = AgentMuxRunRef & {
  type: 'data'
  startByte: number
  endByte: number
  data: string
}

export type AgentMuxRunExitEvent = AgentMuxRunRef & {
  type: 'exit'
  pid: number | null
  exitCode: number
  exitSignal?: string
  observedAt: number
}

export type AgentMuxRunReplayGap = {
  requestedAfterByte: number
  firstAvailableByte: number
}

export type AgentMuxRunAttachment = {
  run: AgentMuxRun
  replay: AgentMuxRunDataEvent[]
  gap: AgentMuxRunReplayGap | null
}

export type AgentMuxRunInputOperation = {
  ownerInstanceId: string
  operationId: string
  expectedByte: number
  data: string
}

export type AgentMuxRunInputAck = AgentMuxRunRef & {
  appliedByteRange: {
    startByte: number
    endByte: number
  }
  acceptedThroughByte: number
}

export type AgentMuxRunOutputAck = AgentMuxRunRef & {
  acknowledgedThroughByte: number
}

export type AgentMuxRunAppliedSize = AgentMuxRunRef & {
  cols: number
  rows: number
}

export type AgentMuxEvidence = {
  source: AgentMuxEvidenceSource
  observedAt: number
  run?: AgentMuxRunRef
  outputByteRange?: {
    startByte: number
    endByte: number
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
  replyCorrelation: 'none' | 'native-turn-id' | 'acp-turn-id'
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
  agentSessionId: string
  run: AgentMuxRunRef
  eventName: string
  observedAt: number
}

export type AgentMuxAgentSession = {
  kind: 'agent'
  agentSessionId: string
  agentId: AgentId
  hostId: string
  workspacePath: string
  run: AgentMuxRunRef
  outputCursorBytes: number
  createdAt: number
  updatedAt: number
  nativeHandle?: AgentNativeSessionHandle
  hookReceipt?: AgentHookReceipt
}

/** This is the complete persistent semantic record. It deliberately has no PTY,
 * process, replay, terminal snapshot, or output byte field. */
export type AgentMuxStoredAgentSession = AgentMuxAgentSession

export type AgentMuxPermissionOption = {
  id: string
  label: string
  kind: 'allow-once' | 'allow-always' | 'reject-once' | 'reject-always'
}

export type AgentMuxPermissionRequest = {
  id: string
  agentSessionId: string
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
      agentSessionId?: string
      run: AgentMuxRunRef
      data: string
      evidence: AgentMuxEvidence
    }
  | {
      type: 'process-state'
      agentSessionId?: string
      run: AgentMuxRunRef
      state: AgentMuxRunState
      pid: number | null
      exitCode?: number
      exitSignal?: string
      evidence: AgentMuxEvidence
    }
  | {
      type: 'agent-status'
      agentSessionId: string
      state: AgentSemanticState
      detail?: string
      evidence: AgentMuxEvidence
    }
  | {
      type: 'agent-activity'
      agentSessionId: string
      activity: Omit<AgentActivity, 'sessionId' | 'source'>
      evidence: AgentMuxEvidence
    }
  | {
      type: 'permission'
      request: AgentMuxPermissionRequest
    }
  | {
      type: 'agent-session'
      session: AgentMuxAgentSession
    }
  | {
      type: 'run-removed'
      agentSessionId?: string
      run: AgentMuxRunRef
      evidence: AgentMuxEvidence
    }
  | {
      type: 'agent-error'
      agentSessionId?: string
      code: string
      message: string
      evidence: AgentMuxEvidence
    }

export type AgentStatus = {
  state: AgentDisplayState
  source: AgentMuxEvidenceSource
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
  source: AgentMuxEvidenceSource
  createdAt: number
  title: string
  content?: string
  toolName?: string
  toolInput?: string
  eventName?: string
}

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
  agentSessionId: string
  runId: string
  agentId: AgentId
  eventName?: string
  payload?: Record<string, unknown>
}

export type NormalizedHookEvent = {
  agentSessionId: string
  run: AgentMuxRunRef
  agentId: AgentId
  eventName: string
  semanticState: AgentSemanticState
  status: AgentStatus
  activities: AgentActivity[]
  nativeHandle?: AgentNativeSessionHandle
}
