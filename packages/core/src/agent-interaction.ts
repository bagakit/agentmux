import { AgentMuxError } from './errors.js'
import { resolveHookEventName } from './agent-hook-event.js'
import type {
  AgentMuxInteractionInputPlan,
  AgentMuxInteractionRequest,
  AgentMuxInteractionResponse,
  AgentMuxPermissionOption,
  AgentMuxQuestion,
  AgentPostureControl,
  AgentPostureInputPlan,
  AgentPostureMode,
  NativeHookEnvelope
} from './types.js'

const MAX_QUESTIONS = 1
const MAX_OPTIONS = 9
const MAX_TEXT_BYTES = 8 * 1024
const ESC = '\u001b'

export type AgentTerminalInteractionDetection = {
  questionEvents: readonly string[]
  questionTools: readonly string[]
  permissionOptions: readonly TerminalPermissionOption[]
}

/**
 * The permission analogue of a {@link LaunchOptionChoiceDeclaration}: the DESCRIBE half
 * ({@link AgentMuxPermissionOption} — id/label/kind/description/tier, which crosses IPC and the renderer
 * draws) fused with the CONTRIBUTE half (`input`, the exact PTY keystroke that selects this row in the
 * Provider's own live numbered prompt). The keystroke never crosses IPC; it is resolved core-side at
 * reply time, so the reply always sends the byte the picked option declares — never a fixed '1'.
 */
export type TerminalPermissionOption = AgentMuxPermissionOption & {
  readonly input: string
}

/**
 * The posture analogue of a {@link TerminalPermissionOption}: the DESCRIBE half ({@link AgentPostureMode} —
 * id/label/description/tier, which crosses IPC and the composer draws) fused with the CONTRIBUTE half
 * (`input`, the exact PTY keystroke that SETS this posture in the Provider's own in-band control). The
 * keystroke never crosses IPC; it is resolved core-side when the composer sends a mode id, so the switch
 * always writes the byte the picked mode declares.
 */
export type PostureModeDeclaration = AgentPostureMode & {
  readonly input: string
}

/**
 * SSOT posture declaration: the DESCRIBE-half control label fused with its CONTRIBUTE-half modes. Declared
 * next to a Provider's interaction protocol; {@link createPostureControl} splits it into the catalog's
 * pure {@link AgentPostureControl} and a core-side resolver.
 */
export type PostureControlDeclaration = {
  readonly id: string
  readonly label: string
  readonly modes: readonly PostureModeDeclaration[]
}

/**
 * A Provider's resolved posture control: the DESCRIBE half the catalog carries ({@link AgentPostureControl})
 * beside a `planSet` that closes over the declared keystrokes, so setting a mode writes the byte that mode
 * declares — never a blind cycle.
 */
export type AgentPostureProtocol = {
  readonly control: AgentPostureControl
  planSet(modeId: string): AgentPostureInputPlan
}

/**
 * Fail closed on a malformed posture declaration, mirroring {@link validatePermissionOptions}. The core
 * discipline lives here: a posture control must offer at least TWO modes, each with a NON-EMPTY, DISTINCT
 * keystroke. This is what makes a control honest — a Provider whose only affordance is a blind cycle
 * (one keystroke advancing through states it cannot read) cannot express two distinct set-keystrokes, so it
 * structurally cannot declare a control that claims to set a specific target mode. Unique ids and non-empty
 * labels round out what the composer needs to draw and the switch needs to honor.
 */
export function validatePostureControl(declaration: PostureControlDeclaration): void {
  if (!declaration.id.trim() || !declaration.label.trim()) {
    throw new AgentMuxError('A posture control must carry a non-empty id and label.', 'INVALID_POSTURE_CONTROL')
  }
  if (declaration.modes.length < 2) {
    throw new AgentMuxError(
      'A posture control must declare at least two addressable modes; a single blind cycle is not a control.',
      'INVALID_POSTURE_CONTROL'
    )
  }
  const ids = new Set<string>()
  const inputs = new Set<string>()
  for (const mode of declaration.modes) {
    if (!mode.id.trim() || !mode.label.trim() || !mode.input) {
      throw new AgentMuxError(
        'A posture mode must carry a non-empty id, label, and input.',
        'INVALID_POSTURE_CONTROL'
      )
    }
    if (ids.has(mode.id)) {
      throw new AgentMuxError(`Duplicate posture mode id '${mode.id}'.`, 'INVALID_POSTURE_CONTROL')
    }
    if (inputs.has(mode.input)) {
      throw new AgentMuxError(
        `Posture modes '${declaration.id}' share a keystroke; a mode that cannot be set apart from another is not addressable.`,
        'INVALID_POSTURE_CONTROL'
      )
    }
    ids.add(mode.id)
    inputs.add(mode.input)
  }
}

/**
 * Build a Provider's posture protocol from its SSOT declaration. Validates at construction (fails closed the
 * way {@link createNumberedTerminalInteractionProtocol} does), projects the DESCRIBE half into the catalog's
 * pure {@link AgentPostureControl} (dropping every keystroke), and returns a `planSet` that CLOSES OVER the
 * declared keystrokes so setting a mode resolves that mode's byte core-side.
 */
export function createPostureControl(declaration: PostureControlDeclaration): AgentPostureProtocol {
  validatePostureControl(declaration)
  const control: AgentPostureControl = {
    id: declaration.id,
    label: declaration.label,
    modes: declaration.modes.map((mode) => ({
      id: mode.id,
      label: mode.label,
      ...(mode.description === undefined ? {} : { description: mode.description }),
      ...(mode.tier === undefined ? {} : { tier: mode.tier })
    }))
  }
  return {
    control,
    planSet(modeId) {
      const mode = declaration.modes.find((candidate) => candidate.id === modeId)
      if (!mode) {
        throw new AgentMuxError(
          'Posture request selected a mode this Provider does not declare.',
          'INVALID_POSTURE_MODE'
        )
      }
      return { data: mode.input }
    }
  }
}

export type AgentTerminalInteractionProtocol = AgentTerminalInteractionDetection & {
  planResponse(
    request: AgentMuxInteractionRequest,
    response: AgentMuxInteractionResponse
  ): AgentMuxInteractionInputPlan
}

/**
 * Fail closed on a malformed permission declaration so a Provider can never ship a permission surface the
 * renderer cannot draw or the reply cannot honor. Mirrors {@link validateLaunchOptionDeclarations}: unique
 * ids, a non-empty keystroke on every option, and at least one allow and one reject so the card always
 * offers a real verdict either way. Called once, when a Provider's protocol is created.
 */
export function validatePermissionOptions(options: readonly TerminalPermissionOption[]): void {
  if (options.length === 0) {
    throw new AgentMuxError('A permission protocol must declare at least one option.', 'INVALID_PERMISSION_OPTION')
  }
  const seen = new Set<string>()
  let allow = 0
  let reject = 0
  for (const option of options) {
    if (!option.id.trim() || !option.label.trim() || !option.input) {
      throw new AgentMuxError(
        'A permission option must carry a non-empty id, label, and input.',
        'INVALID_PERMISSION_OPTION'
      )
    }
    if (seen.has(option.id)) {
      throw new AgentMuxError(`Duplicate permission option id '${option.id}'.`, 'INVALID_PERMISSION_OPTION')
    }
    seen.add(option.id)
    if (option.kind.startsWith('allow-')) allow += 1
    else reject += 1
  }
  if (allow === 0 || reject === 0) {
    throw new AgentMuxError(
      'A permission protocol must declare at least one allow and one reject option.',
      'INVALID_PERMISSION_OPTION'
    )
  }
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
  // 事件名按 Core 的同一份键顺序读取。此前这里只认 `hook_event_name`/`hookEventName`，漏掉裸
  // `eventName`——一个只在负载里给 `eventName` 的 Provider，它的 permission/question 提问永远
  // 检测不到。三个读取点（这里、normalizer、hook 子进程）现在共用 agent-hook-event.ts 那一份。
  const eventName = resolveHookEventName(envelope.eventName, payload)
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
      // Project the DESCRIBE half out of the Provider's declaration — never a hardcoded pair. The
      // keystroke (`input`) is intentionally dropped here: it stays core-side and is resolved at reply
      // time, so it never crosses IPC into the renderer.
      options: protocol.permissionOptions.map((option) => ({
        id: option.id,
        label: option.label,
        kind: option.kind,
        ...(option.description === undefined ? {} : { description: option.description }),
        ...(option.tier === undefined ? {} : { tier: option.tier })
      })),
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

/**
 * Build a Provider's numbered terminal-interaction protocol from its declared detection config. The
 * returned `planResponse` CLOSES OVER `permissionOptions`, so the reply resolves the picked option's
 * declared keystroke (its CONTRIBUTE half) — never a fixed '1'. Fails closed on a malformed permission
 * declaration at construction, the way {@link validateLaunchOptionDeclarations} does for launch options.
 */
export function createNumberedTerminalInteractionProtocol(
  config: AgentTerminalInteractionDetection
): AgentTerminalInteractionProtocol {
  validatePermissionOptions(config.permissionOptions)
  return {
    questionEvents: config.questionEvents,
    questionTools: config.questionTools,
    permissionOptions: config.permissionOptions,
    planResponse(request, response) {
      const normalized = normalizeAgentInteractionResponse(request, response)
      if (request.kind === 'permission') {
        const decision = normalized.kind === 'permission' ? normalized.decision : null
        if (!decision) {
          throw new AgentMuxError('Permission response kind is invalid.', 'INVALID_AGENT_INTERACTION_RESPONSE')
        }
        if (decision.outcome === 'cancelled') return { data: ESC }
        const option = config.permissionOptions.find((candidate) => candidate.id === decision.optionId)
        if (!option) {
          throw new AgentMuxError(
            'Permission response selected an option this Provider does not declare.',
            'INVALID_AGENT_INTERACTION_RESPONSE'
          )
        }
        return { data: option.input }
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
  }
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
