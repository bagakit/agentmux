import type { ConversationRecordProvenance } from './conversation-stream.js'

export type AgentConversationRecordSource =
  | (AgentSessionHistorySource & { kind: 'native'; recordId: string })
  | { kind: 'captured'; recordId: string }

/** A reference to the original Session, never a new conversation lifecycle. */
export type ConversationRef = { hostId: string; agentSessionId: string }

/** Exact original record within its Session and source; never a body or display position. */
export type ConversationItemRef = ConversationRef & { source: AgentConversationRecordSource }

/** Provider-owned content purpose, never audience or sending authority. Missing means unconfirmed. */
export type AgentSessionHistoryContentEligibility = 'public' | 'private' | 'unconfirmed'
export type AgentSessionHistoryContentPart = (
  | { kind: 'text'; text: string;
      /** Provider-owned reading span in the original text, using UTF-16 indices. Copy keeps text complete. */
      readingRange?: { start: number; end: number } }
  | { kind: 'resource'; resourceType: 'image' | 'audio' | 'file' | 'other' | 'text'; reference: string; label?: string;
      /** Exact serialized semantic part, retained at the original source and read in bounded fragments. */
      content?: { encoding: 'json-utf8'; kind: 'text' | 'reasoning' | 'tool-call' | 'tool-result' | 'resource'; byteLength: number; sha256: string } }
  | { kind: 'reasoning'; text: string; signature?: string; redacted?: boolean }
  | { kind: 'tool-call'; name: string; input: string; callId?: string }
  | { kind: 'tool-result'; output: string; name?: string; callId?: string; failed?: boolean }
) & {
  contentEligibility?: AgentSessionHistoryContentEligibility
  /** Original tool/reasoning purpose when projection has a text or resource shape. Not sharing authority. */
  contentRole?: 'tool' | 'reasoning'
}

export type AgentSessionHistorySource = { providerId: string; nativeSessionId: string }

/** A Provider-recorded assistant phase, not reasoning or task-completion authority. */
export type AgentSessionHistoryMessagePhase = 'progress' | 'final'

/** Native collaboration references are read-only locators, never AgentMux Session or Run IDs. */
export type AgentSessionHistoryCollaboration =
  | {
      kind: 'message'
      /** The native conversation scopes these actor names; they are not AgentMux Session IDs. */
      source: AgentSessionHistorySource
      sender?: string
      recipient?: string
    }
  | {
      kind: 'operation'
      operation?: 'spawn' | 'send-input' | 'send-message' | 'followup' | 'wait' | 'resume' | 'interrupt' | 'close' | 'list'
      status?: 'running' | 'completed' | 'failed' | 'interrupted'
      sender?: AgentSessionHistorySource
      receivers: AgentSessionHistorySource[]
      prompt?: string
      /** Last recorded target states; independent of this operation and current Runtime state. */
      agentStates: {
        source: AgentSessionHistorySource
        state?: 'pending' | 'running' | 'completed' | 'failed' | 'interrupted' | 'stopped' | 'not-found'
        message?: string
      }[]
    }
  | {
      kind: 'agent-activity'
      event: 'started' | 'interacted' | 'interrupted' | 'completed'
      agent: AgentSessionHistorySource
      /** Native logical path, not an execution directory or filesystem authority. */
      path?: string
    }

/** Structured native asynchronous questions; absence of an answer is not pending authority. */
export type AgentSessionHistoryQuestion = {
  /** Provider-owned opaque identity; clients must never construct or parse it. */
  id: string
  prompt: string
  options: Array<{ id: string; label: string }>
  acceptsText: boolean
}

export type AgentSessionHistoryQuestionRequest = {
  delivery: 'async'
  questions: AgentSessionHistoryQuestion[]
}

/** A native user record's exact reply reference; its original contentParts remain untouched. */
export type AgentSessionHistoryQuestionAnswer = {
  questionId: string
  answer: string
  /** Question text carried by this native reply, not current pending or authenticated question authority. */
  prompt?: string
}

/** Provider-reported token counts; missing counts stay absent and are never estimated or summed. */
export type AgentSessionHistoryTokenUsage = {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cachedInputTokens?: number
  reasoningOutputTokens?: number
}

/** Read-only facts on the original native record, never Runtime or input authority. */
export type AgentSessionHistoryMetrics = {
  /** turn requires the original item's exact turnId; response is scoped to the original record. */
  scope: 'turn' | 'response'
  /** Native wall-clock elapsed milliseconds, not inference time or a locally started timer. */
  durationMs?: number
  usage?: AgentSessionHistoryTokenUsage
}

/** A result of the original native turn, never current activity or task acceptance. */
export type AgentTurnOutcome =
  | { status: 'completed' | 'interrupted' }
  | { status: 'failed'; failure: AgentFailure }

export type AgentSessionHistoryItem = {
  id: string
  /** Read-only typed source relationships, interpreted at the original Provider boundary. */
  conversation?: ConversationRecordProvenance
  conversationDiagnostic?: { code: string; message: string; original?: unknown }
  turnId?: string
  /** System messages describe read-only native history; they grant no input, identity or permission authority. */
  kind: 'user-message' | 'assistant-message' | 'system-message' | 'activity'
  /** Provider-confirmed machine-event purpose for reading only; not current state or input authority. */
  recordPurpose?: 'system-event'
  messagePhase?: AgentSessionHistoryMessagePhase
  questionRequest?: AgentSessionHistoryQuestionRequest
  questionAnswers?: AgentSessionHistoryQuestionAnswer[]
  /** A local native question/answer reading projection diagnostic; original speech and adjacent history stay readable. */
  questionDiagnostic?: { code: string; message: string }
  /** Qualified by this original item, native source and turnId. */
  turnOutcome?: AgentTurnOutcome
  turnOutcomeDiagnostic?: { code: string; message: string }
  metrics?: AgentSessionHistoryMetrics
  /** Optional metrics unavailable; original content, identity and reading remain available. */
  metricsDiagnostic?: { code: string; message: string }
  /** Original contentParts remain complete and copyable alongside this optional summary. */
  collaboration?: AgentSessionHistoryCollaboration
  title?: string
  contentParts: AgentSessionHistoryContentPart[]
  startedAt?: number
  completedAt?: number
}

export type AgentFailure = {
  /** Provider-normalized safe summary; raw message has no external sharing qualification. */
  publicMessage?: string
  code: string
  message: string
  nativeCode?: string
  httpStatusCode?: number
  recovery: string
  nativeTurnId: string
}

export type AgentMuxEvidenceSource =
  | 'terminal-output'
  | 'run-process'
  | 'native-hook'
  | 'native-transcript'
  | 'acp'
  | 'user'
  | 'agentmux'

export type AgentTimelineItemKind =
  | 'system_message'
  | 'user_message'
  | 'assistant_message'
  | 'tool_call'
  | 'permission'
  | 'lifecycle'

/** Original captured fields that affect event interpretation. Hosts may retain additional fields. */
export type ConversationCapturedItem = {
  /** Original typed provenance, never reconstructed from display text or opaque item IDs. */
  conversation?: ConversationRecordProvenance
  conversationDiagnostic?: { code: string; message: string; original?: unknown }
  kind: AgentTimelineItemKind
  source: AgentMuxEvidenceSource
  createdAt: number
  /** Original Core notification identity, distinct from the referenced A2A messages. */
  a2aNotificationId?: string
  /** Input supplied by another Agent, attributed by the trusted host. */
  authorAgentSessionId?: string
  /** Explicit manual origin attributed by trusted host. */
  authorHuman?: boolean
  authorExternal?: AgentExternalMessageAuthor | AgentExternalConversationAuthor
  content?: string
  /** Original saved or submitted Input identity; attribution or opaque IDs never reconstruct it. */
  inputRef?: AgentPromptInputKey
  toolInput?: string
  /** The capture owner bounds this text and marks truncation. Absence represents an unobserved result. */
  toolOutput?: string
}

export type ConnectionApplication = { domain: string; appId: string; /** Original authenticated service instance, when the protocol scopes an account to one. */ issuer?: string }
export type ConnectionActor = { application: ConnectionApplication; idType: string; userId: string }

/** Original semantic owners, never an endpoint, credential or reusable input grant. */
export type AgentExternalAuthoritySource = { hostingRuntimeId: string; executionRuntimeId: string }

/** Recorded external attribution, never a serialized authorization or a local human identity. */
export type AgentExternalMessageAuthor = {
  kind: 'external'
  connectionId: string
  actor: ConnectionActor
  externalConversationId: string
  externalMessageId: string
  bindingId: string
  bindingRevision: number
  grantId: string
  grantRevision: number
  /** Absence is the original room reference; application grants have an explicit source. */
  grantSource?: 'application'
  authoritySource?: AgentExternalAuthoritySource
}

/** Original platform attribution. Recording a message grants no execution permission. */
export type AgentExternalConversationAuthor = Omit<AgentExternalMessageAuthor, 'grantId' | 'grantRevision' | 'grantSource'>

export type AgentSessionUserMessageAuthor =
  | AgentExternalMessageAuthor
  | AgentExternalConversationAuthor
  | { kind: 'human' }
  | { kind: 'agent'; agentSessionId: string }
  | { kind: 'unknown' }

/** Recorded attribution only. Neither a credential nor a content-sharing boundary. */
export function recordedConversationAuthor(item: Pick<ConversationCapturedItem, 'authorAgentSessionId' | 'authorExternal' | 'authorHuman'>): AgentSessionUserMessageAuthor {
  if (item.authorAgentSessionId !== undefined) return { kind: 'agent', agentSessionId: item.authorAgentSessionId }
  if (item.authorExternal !== undefined) return item.authorExternal
  if (item.authorHuman === true) return { kind: 'human' }
  return { kind: 'unknown' }
}

/** Source-qualified reading identity; no physical request record or pending authority is implied. */
export type ConversationQuestionIdentity = {
  hostId: string
  agentSessionId: string
  source: AgentSessionHistorySource
  questionId: string
}
export function conversationQuestionIdentity(scope: { hostId?: string | undefined; agentSessionId: string; source: AgentSessionHistorySource }, questionId: string): ConversationQuestionIdentity | null {
  return scope.hostId ? { hostId: scope.hostId, agentSessionId: scope.agentSessionId, source: scope.source, questionId } : null
}

export type AgentPromptInputKey = (
  | { kind: 'prompt'; agentSessionId: string; expectedRun: { runId: string }; submissionId: string }
  | { kind: 'message'; agentSessionId: string; expectedRun: { runId: string }; messageId: string }
) & { /** A Core-owned delivery attempt; the original logical producer identity is unchanged. */ attemptId?: string }

export function agentPromptInputId(key: AgentPromptInputKey): string {
  return key.attemptId ?? agentPromptLogicalInputId(key)
}
export function agentPromptLogicalInputId(key: AgentPromptInputKey): string {
  return key.kind === 'prompt' ? key.submissionId : key.messageId
}
