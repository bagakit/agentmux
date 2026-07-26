import type { LaunchOption, LaunchOptionSelection } from './agent-launch-option.js'

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

/**
 * The single risk vocabulary the three sealed control surfaces share — launch options, live permission
 * options, and posture modes all rank one choice's danger with these exact three values, and every
 * renderer surfaces them the same way: a restrained dot, never a stroke or fill. One identity in one
 * place — a launch choice, a permission row, and a posture mode that read as equally dangerous carry the
 * same token, so the ranking cannot drift between the three. The tuple is the SSOT: {@link RiskTier}
 * derives from it and a runtime validator (agent-session-store) reuses it to fail-close on foreign data,
 * so the type and the on-disk whitelist cannot fall out of step.
 */
export const RISK_TIERS = ['safe', 'caution', 'danger'] as const
export type RiskTier = (typeof RISK_TIERS)[number]

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
  | {
      kind: 'render-then-submit'
      /** Exact transport bytes written before submit. */
      payload: string
      /** Logical text the Provider TUI renders after consuming transport control bytes. */
      renderedText: string
      submit: string
    }

export type AgentHookStrategy =
  | { kind: 'none' }
  // `explicit-managed`: AgentMux writes and owns the provider's hook config (codex/claude/antigravity).
  // `unmanaged`: the provider emits native hooks AgentMux understands, but its config lives on a surface
  // AgentMux does not install into yet (pi's TypeScript extension) — so hooks only fire if the user
  // wires them by hand. Distinct from `none`, which means the provider has no hooks.
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
  /**
   * The DESCRIBE half of the sealed launch-option contract: pure serializable controls the renderer can
   * draw with no knowledge of the provider. Empty for a provider that declares no option, so the UI
   * renders nothing — absence hides the control rather than disabling it. The argv each choice
   * contributes never crosses IPC; it stays core-side (see agent-launch-option.ts).
   */
  launchOptions: LaunchOption[]
  /**
   * The DESCRIBE half of the sealed posture contract: a live, mid-session security-posture control the
   * composer draws, or absent. Present only for a Provider whose posture is ADDRESSABLE in-band — each mode
   * SET by a distinct keystroke over the existing PTY-input transport. Absent (the common case) for a
   * Provider that has no in-band posture affordance, or only a blind cycle it cannot address to a specific
   * mode, so the composer renders nothing. The keystroke each mode contributes never crosses IPC; it stays
   * core-side (see agent-interaction.ts).
   */
  postureControl?: AgentPostureControl
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

export type AgentTerminalPromptReadinessState = {
  source: 'initial-composer' | 'native-stop'
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
  /**
   * The chosen launch-option ids that fixed this Agent's security posture at spawn (sandbox, approval,
   * permission-mode — see agent-launch-option.ts). Persisted so a stop/resume re-resolves the SAME argv
   * the create used: the posture is fail-closed, so it must survive the Run boundary rather than silently
   * reverting to the Provider's more permissive default. Absent when the create narrowed nothing.
   */
  launchOptions?: LaunchOptionSelection
  terminalHandshake?: AgentTerminalHandshakeState
  terminalCapability?: AgentTerminalCapabilityState
  terminalPromptReadiness?: AgentTerminalPromptReadinessState
  terminalPromptSubmission?: AgentTerminalPromptSubmissionState
  semanticStatus?: AgentStatus
  pendingInteraction?: AgentMuxPendingInteraction
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

/**
 * The durable fact that the Provider terminal capability could not be verified for this exact Run.
 *
 * `unknown` is intentional: a missing capability receipt is not evidence that the Agent itself is
 * broken. `mode: 'degraded'` tells clients that Core continues to accept input using CtxMux's
 * authoritative cursor, while the optional handshake receipt remains absent. The record is cleared
 * when a later handshake is acknowledged or when the Run is replaced.
 */
export type AgentTerminalCapabilityState = {
  state: 'unknown'
  mode: 'degraded'
  reason: 'handshake-timeout'
  run: AgentMuxRunRef
  observedAt: number
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
  readinessSource: AgentTerminalPromptReadinessState['source']
  readinessId: string
  readinessOutputCursorBytes: number
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
  /** Agent 说话凭证的 sha256。raw 只在受管进程的 env 里，Core 侧只留 hash。 */
  capabilityHash?: string
}

export type AgentMuxPermissionOption = {
  id: string
  label: string
  kind: 'allow-once' | 'allow-always' | 'reject-once' | 'reject-always'
  /** DESCRIBE-half only: prose the renderer draws beneath the label. The keystroke that answers this
   * option never rides here — it stays core-side on the Provider's declaration. */
  description?: string
  /** Risk state a renderer surfaces as a restrained dot; not decoration, not a stroke. */
  tier?: RiskTier
}

/**
 * DESCRIBE half of a Provider's live posture control — pure serializable data the composer draws with no
 * provider knowledge. A `mode` is one posture the Provider can be SET to in-band; the keystroke that sets
 * it never rides here (it stays core-side on the declaration, see agent-interaction.ts). `tier` marks a
 * mode a renderer surfaces as a restrained risk dot; not decoration, not a stroke.
 */
export type AgentPostureMode = {
  id: string
  label: string
  description?: string
  tier?: RiskTier
}

/**
 * The composer-facing posture control, or absent. Present only for a Provider whose live posture is
 * ADDRESSABLE: two or more modes, each SET by a distinct in-band keystroke (a slash command, not a launch
 * flag). A Provider that has only a blind cycle it cannot read declares nothing, so the composer draws no
 * control — absence hides it rather than offering a switch that cannot honor a specific target mode.
 */
export type AgentPostureControl = {
  id: string
  label: string
  modes: AgentPostureMode[]
}

export type AgentMuxPermissionRequest = {
  kind: 'permission'
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

export type AgentMuxQuestionOption = {
  id: string
  label: string
  description?: string
}

export type AgentMuxQuestion = {
  id: string
  prompt: string
  title?: string
  options: AgentMuxQuestionOption[]
}

export type AgentMuxQuestionRequest = {
  kind: 'question'
  id: string
  agentSessionId: string
  questions: AgentMuxQuestion[]
  evidence: AgentMuxEvidence
}

export type AgentMuxInteractionRequest = AgentMuxPermissionRequest | AgentMuxQuestionRequest

export type AgentMuxQuestionAnswer = {
  questionId: string
  optionId: string
}

export type AgentMuxInteractionResponse =
  | {
      kind: 'permission'
      requestId: string
      decision: AgentMuxPermissionDecision
    }
  | {
      kind: 'question'
      requestId: string
      outcome: 'answered'
      answers: AgentMuxQuestionAnswer[]
    }
  | {
      kind: 'question'
      requestId: string
      outcome: 'cancelled'
    }

export type AgentMuxInteractionInputPlan = {
  data: string
}

/** The bytes that SET one posture mode, resolved core-side from the picked mode's declared keystroke.
 * Same shape as an interaction plan — both are keystrokes written over the PTY-input transport — but kept
 * a distinct type so the posture seam reads on its own. Never crosses IPC as bytes: the renderer sends a
 * mode id, Core resolves this. */
export type AgentPostureInputPlan = {
  data: string
}

export type AgentMuxInteractionResponseState = {
  /** Semantic response retained so a recoverable ctxmux Input can be replayed after a crash. */
  value: AgentMuxInteractionResponse
  responseDigest: string
  operationId: string
  inputByteRange: {
    startByte: number
    endByte: number
  }
  acknowledged: boolean
}

export type AgentMuxPendingInteraction = {
  request: AgentMuxInteractionRequest
  response?: AgentMuxInteractionResponseState
}

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
      type: 'interaction'
      request: AgentMuxInteractionRequest
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
  interaction?: AgentMuxInteractionRequest
  nativeHandle?: AgentNativeSessionHandle
}
