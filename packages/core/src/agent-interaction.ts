import { AgentMuxError } from './errors.js'
import type {
  AgentMuxInteractionInputPlan,
  AgentMuxInteractionRequest,
  AgentMuxInteractionResponse,
  AgentMuxQuestion,
  NativeHookEnvelope
} from './types.js'

const MAX_QUESTIONS = 1
const MAX_OPTIONS = 9
const MAX_TEXT_BYTES = 8 * 1024
const ESC = '\u001b'

export type AgentTerminalInteractionDetection = {
  questionEvents: readonly string[]
  questionTools: readonly string[]
}

export type AgentTerminalInteractionProtocol = AgentTerminalInteractionDetection & {
  planResponse(
    request: AgentMuxInteractionRequest,
    response: AgentMuxInteractionResponse
  ): AgentMuxInteractionInputPlan
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function boundedText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (!text || Buffer.byteLength(text) > MAX_TEXT_BYTES) return undefined
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if ((code <= 0x1f && code !== 0x0a && code !== 0x09) || code === 0x7f) return undefined
  }
  return text
}

function serializedInput(value: unknown): string | undefined {
  if (value === undefined) return undefined
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return Buffer.byteLength(text) <= MAX_TEXT_BYTES ? text : undefined
}

function parseQuestion(value: unknown, index: number): AgentMuxQuestion | null {
  const source = record(value)
  if (!source || source.multiSelect === true) return null
  const prompt = boundedText(source.question) ?? boundedText(source.prompt)
  const rawOptions = Array.isArray(source.options) ? source.options : []
  if (!prompt || rawOptions.length === 0 || rawOptions.length > MAX_OPTIONS) return null
  const options = rawOptions.flatMap((value, optionIndex) => {
    const source = record(value)
    const label = boundedText(typeof value === 'string' ? value : source?.label)
    if (!label) return []
    const description = boundedText(source?.description)
    return [{
      id: `option-${optionIndex + 1}`,
      label,
      ...(description ? { description } : {})
    }]
  })
  if (options.length !== rawOptions.length) return null
  const title = boundedText(source.header) ?? boundedText(source.title)
  return {
    id: `question-${index + 1}`,
    prompt,
    options,
    ...(title ? { title } : {})
  }
}

function questionRequest(
  envelope: NativeHookEnvelope,
  observedAt: number,
  rawInput: unknown
): AgentMuxInteractionRequest | undefined {
  const source = record(rawInput)
  const rawQuestions = Array.isArray(source?.questions) ? source.questions : [rawInput]
  if (rawQuestions.length === 0 || rawQuestions.length > MAX_QUESTIONS) return undefined
  const questions = rawQuestions.map(parseQuestion)
  if (questions.some((question) => question === null)) return undefined
  return {
    kind: 'question',
    id: envelope.receiptId,
    agentSessionId: envelope.agentSessionId,
    questions: questions as AgentMuxQuestion[],
    evidence: {
      source: 'native-hook',
      observedAt,
      run: { runId: envelope.runId },
      hookReceiptId: envelope.receiptId
    }
  }
}

export function normalizeTerminalInteraction(
  envelope: NativeHookEnvelope,
  observedAt: number,
  protocol: AgentTerminalInteractionDetection
): AgentMuxInteractionRequest | undefined {
  const payload = envelope.payload ?? {}
  const eventName = envelope.eventName
    ?? boundedText(payload.hook_event_name)
    ?? boundedText(payload.hookEventName)
  const toolName = boundedText(payload.tool_name) ?? boundedText(payload.toolName)
  if (
    eventName &&
    protocol.questionEvents.includes(eventName) &&
    toolName &&
    protocol.questionTools.includes(toolName.toLowerCase())
  ) {
    return questionRequest(
      envelope,
      observedAt,
      payload.tool_input ?? payload.toolInput ?? payload.input
    )
  }
  if (eventName === 'PermissionRequest') {
    const toolInput = serializedInput(payload.tool_input ?? payload.toolInput)
    return {
      kind: 'permission',
      id: envelope.receiptId,
      agentSessionId: envelope.agentSessionId,
      title: toolName ? `Allow ${toolName}?` : 'Allow this action?',
      options: [
        { id: 'allow-once', label: 'Allow', kind: 'allow-once' },
        { id: 'reject-once', label: 'Deny', kind: 'reject-once' }
      ],
      ...(toolName ? { toolName } : {}),
      ...(toolInput ? { toolInput } : {}),
      evidence: {
        source: 'native-hook',
        observedAt,
        run: { runId: envelope.runId },
        hookReceiptId: envelope.receiptId
      }
    }
  }
  return undefined
}

export function planNumberedTerminalInteractionResponse(
  request: AgentMuxInteractionRequest,
  response: AgentMuxInteractionResponse
): AgentMuxInteractionInputPlan {
  const normalized = normalizeAgentInteractionResponse(request, response)
  if (request.kind === 'permission') {
    const decision = normalized.kind === 'permission' ? normalized.decision : null
    if (!decision) {
      throw new AgentMuxError('Permission response kind is invalid.', 'INVALID_AGENT_INTERACTION_RESPONSE')
    }
    if (decision.outcome === 'cancelled') return { data: ESC }
    const option = request.options.find((candidate) => candidate.id === decision.optionId)
    return { data: option!.kind.startsWith('allow-') ? '1' : ESC }
  }
  if (normalized.kind !== 'question') {
    throw new AgentMuxError('Question response kind is invalid.', 'INVALID_AGENT_INTERACTION_RESPONSE')
  }
  if (normalized.outcome === 'cancelled') return { data: ESC }
  const question = request.questions[0]!
  const answer = normalized.answers[0]!
  const optionIndex = question.options.findIndex((candidate) => candidate.id === answer.optionId)
  return { data: String(optionIndex + 1) }
}

export function normalizeAgentInteractionResponse(
  request: AgentMuxInteractionRequest,
  response: AgentMuxInteractionResponse
): AgentMuxInteractionResponse {
  if (request.id !== response.requestId || request.kind !== response.kind) {
    throw new AgentMuxError(
      'Agent interaction response does not match its request.',
      'INVALID_AGENT_INTERACTION_RESPONSE'
    )
  }
  if (request.kind === 'permission') {
    if (new Set(request.options.map((option) => option.id)).size !== request.options.length) {
      throw new AgentMuxError(
        'Permission request contains duplicate option identifiers.',
        'INVALID_AGENT_INTERACTION_RESPONSE'
      )
    }
    if (response.kind !== 'permission') {
      throw new AgentMuxError('Permission response kind is invalid.', 'INVALID_AGENT_INTERACTION_RESPONSE')
    }
    if (response.decision.outcome === 'cancelled') return structuredClone(response)
    if (response.decision.outcome !== 'selected') {
      throw new AgentMuxError('Permission response outcome is invalid.', 'INVALID_AGENT_INTERACTION_RESPONSE')
    }
    const optionId = response.decision.optionId
    const option = request.options.find((candidate) => candidate.id === optionId)
    if (!option) {
      throw new AgentMuxError('Permission response selected an unknown option.', 'INVALID_AGENT_INTERACTION_RESPONSE')
    }
    return structuredClone(response)
  }
  if (response.kind !== 'question') {
    throw new AgentMuxError('Question response kind is invalid.', 'INVALID_AGENT_INTERACTION_RESPONSE')
  }
  if (new Set(request.questions.map((question) => question.id)).size !== request.questions.length) {
    throw new AgentMuxError(
      'Question request contains duplicate question identifiers.',
      'INVALID_AGENT_INTERACTION_RESPONSE'
    )
  }
  if (request.questions.some((question) => (
    new Set(question.options.map((option) => option.id)).size !== question.options.length
  ))) {
    throw new AgentMuxError(
      'Question request contains duplicate option identifiers.',
      'INVALID_AGENT_INTERACTION_RESPONSE'
    )
  }
  if (response.outcome === 'cancelled') return structuredClone(response)
  if (response.outcome !== 'answered') {
    throw new AgentMuxError('Question response outcome is invalid.', 'INVALID_AGENT_INTERACTION_RESPONSE')
  }
  if (response.answers.length !== request.questions.length) {
    throw new AgentMuxError('Question response is incomplete.', 'INVALID_AGENT_INTERACTION_RESPONSE')
  }
  const answers = request.questions.map((question) => {
    const answer = response.answers.find((candidate) => candidate.questionId === question.id)
    const optionIndex = answer
      ? question.options.findIndex((candidate) => candidate.id === answer.optionId)
      : -1
    if (optionIndex < 0) {
      throw new AgentMuxError('Question response selected an unknown option.', 'INVALID_AGENT_INTERACTION_RESPONSE')
    }
    return { questionId: question.id, optionId: question.options[optionIndex]!.id }
  })
  if (new Set(response.answers.map((answer) => answer.questionId)).size !== response.answers.length) {
    throw new AgentMuxError('Question response contains duplicate answers.', 'INVALID_AGENT_INTERACTION_RESPONSE')
  }
  return { kind: 'question', requestId: request.id, outcome: 'answered', answers }
}
