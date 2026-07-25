export type BuiltInAgentProviderId =
  | 'codex'
  | 'claude'
  | 'traex'
  | 'hermes'
  | 'pi'
  | 'grok'
  | 'gemini'
  | 'antigravity'
  | 'cursor'
export type AgentProviderId = BuiltInAgentProviderId | (string & {})

export type AgentExecutorId = string

/** A user-facing launch configuration backed by one Provider implementation. */
export type AgentExecutorConfig = {
  label: string
  providerId: AgentProviderId
  command: string
  args: string[]
  env: Record<string, string>
  injectAgentMuxGuide: boolean
}

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
  platform: string
  arch: string
  supported: boolean
  ctxmux: {
    version: string
    protocolVersion: number
    sourceCommit: string
    artifactPlatform: string
    ready: boolean
    capabilities: {
      transport: 'local-unix'
      orderedOutputBytes: true
      boundedReplay: true
      recoverableInput: true
      resize: true
      interrupt: true
      completeStop: true
    }
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
  providerId: AgentProviderId | null
  executorId: AgentExecutorId | null
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
  acpAdapterId?: string
  acpSessionId?: string
}

export type AgentPromptDelivery = 'positional-argv' | 'hermes-query' | 'flag-prompt-interactive'

export type AgentReadySignal = {
  kind: 'foreground-process'
  expectedProcess: string
}

export type AgentTerminalHandshake = {
  query: string
  response: string
}

export type AgentTerminalPromptRenderMatcher = {
  frameStart: string
  activeComposer: string
  frameEnd: string
}

export type AgentPromptInputPlan =
  | { kind: 'single-phase'; data: string }
  | { kind: 'render-then-submit'; payload: string; submit: string }

export type AgentHookStrategy =
  | { kind: 'none' }
  // `explicit-managed`: AgentMux writes and owns the provider's hook config (codex/claude/antigravity).
  // `unmanaged`: the provider emits native hooks AgentMux understands, but its config lives on a surface
  // AgentMux does not install into yet (hermes' YAML plugin, pi's TypeScript extension) — so hooks only
  // fire if the user wires them by hand. Distinct from `none`, which means the provider has no hooks.
  | { kind: 'native'; installation: 'explicit-managed' | 'unmanaged' }

export type AgentResumeStrategy =
  | { kind: 'none' }
  | { kind: 'provider-native'; locator: 'session-id' | 'transcript-path' }

export type AgentAcpStrategy =
  | { kind: 'none' }
  | { kind: 'adapter' }

export type AgentCapabilities = {
  terminal: true
  hookEvents: boolean
  timeline: 'unavailable' | 'complete-events' | 'streaming'
  permission: 'none' | 'observe' | 'respond'
  providerResume: boolean
  acp: boolean
  replyCorrelation: 'none' | 'native-turn-id' | 'acp-turn-id'
}

export type AgentCatalogEntry = {
  id: AgentProviderId
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
  providerId: AgentProviderId
  executable: string
  installed: boolean
  capabilities: AgentCapabilities
}

export type AgentNativeSessionHandle =
  | {
      kind: 'provider'
      providerId: AgentProviderId
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
  providerId: AgentProviderId
  agentSessionId: string
  run: AgentMuxRunRef
  eventName: string
  observedAt: number
  outputCursorBytes?: number
}

export type AgentTerminalStopReceiptState = {
  id: string
  run: AgentMuxRunRef
  outputCursorBytes: number
  readyThroughByte?: number
  consumedBySubmissionId?: string
}

export type AgentMuxAgentSession = {
  kind: 'agent'
  agentSessionId: string
  providerId: AgentProviderId
  executorId: AgentExecutorId
  hostId: string
  workspacePath: string
  run: AgentMuxRunRef
  retiredRuns: AgentMuxRunRef[]
  outputCursorBytes: number
  createdAt: number
  updatedAt: number
  terminalHandshake?: AgentTerminalHandshakeState
  terminalStopReceipt?: AgentTerminalStopReceiptState
  terminalPromptSubmission?: AgentTerminalPromptSubmissionState
  nativeHandle?: AgentNativeSessionHandle
  hookReceipt?: AgentHookReceipt
}

export type AgentTerminalHandshakeState = {
  run: AgentMuxRunRef
  operationId: string
  inputByteRange: {
    startByte: number
    endByte: number
  }
  acknowledged: boolean
}

export type AgentTerminalInputPhaseState = {
  operationId: string
  inputByteRange: {
    startByte: number
    endByte: number
  }
  acknowledged: boolean
}

export type AgentTerminalPromptSubmissionState = {
  run: AgentMuxRunRef
  submissionId: string
  promptDigest: string
  stopReceiptId: string
  stopOutputCursorBytes: number
  readyThroughByte: number
  outputCursorBytes: number
  payload: AgentTerminalInputPhaseState
  submit: AgentTerminalInputPhaseState
}

/** This is the complete persistent semantic/control record. It deliberately has no
 * PTY, process, replay, terminal snapshot, or terminal output bytes. */
export type AgentMuxStoredAgentSession = AgentMuxAgentSession & {
  hookBindingId: string
  hookToken: string
}

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
      operation: 'append'
      activityId: string
      kind: AgentTimelineItemKind
      status: AgentTimelineItemStatus
      title: string
      content?: string
      toolName?: string
      toolInput?: string
    }
  | {
      type: 'activity'
      operation: 'update'
      activityId: string
      status?: AgentTimelineItemStatus
      title?: string
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
      interruptionReason?: string
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
      type: 'agent-timeline'
      agentSessionId: string
      revision: number
      mutation: AgentTimelineMutation
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

export type AgentTimelineItemKind =
  | 'user_message'
  | 'assistant_message'
  | 'tool_call'
  | 'permission'
  | 'lifecycle'

export type AgentTimelineItemStatus = 'streaming' | 'complete' | 'failed'

export type AgentTimelineItem = {
  id: string
  agentSessionId: string
  kind: AgentTimelineItemKind
  status: AgentTimelineItemStatus
  source: AgentMuxEvidenceSource
  createdAt: number
  updatedAt: number
  title: string
  content?: string
  toolName?: string
  toolInput?: string
  eventName?: string
}

export type AgentTimelineMutation =
  | {
      type: 'append'
      agentSessionId: string
      item: AgentTimelineItem
    }
  | {
      type: 'update'
      agentSessionId: string
      itemId: string
      updatedAt: number
      status?: AgentTimelineItemStatus
      title?: string
      content?: string
      toolName?: string
      toolInput?: string
      eventName?: string
    }

export type AgentTimelineSnapshot = {
  agentSessionId: string
  revision: number
  items: AgentTimelineItem[]
}

export type AgentTimelineCommit = {
  agentSessionId: string
  revision: number
  changed: boolean
  mutation: AgentTimelineMutation
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
  /** Omitted for continuity recovery that must not invent a user message. */
  prompt?: string
  args: readonly string[]
  env: Readonly<Record<string, string>>
  commandOverride?: string
}

export type NativeHookEnvelope = {
  receiptId: string
  agentSessionId: string
  runId: string
  providerId: AgentProviderId
  eventName?: string
  payload?: Record<string, unknown>
}

export type NormalizedHookEvent = {
  agentSessionId: string
  run: AgentMuxRunRef
  providerId: AgentProviderId
  eventName: string
  semanticState: AgentSemanticState
  status: AgentStatus
  timeline: AgentTimelineMutation[]
  nativeHandle?: AgentNativeSessionHandle
}
