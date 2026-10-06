import { describeError } from './error-presentation.js'
import type { ClientDeliveryLog } from './delivery-diagnostics.js'
import { readAgentPromptPreparationWait } from '@agentmux/core/prompt-preparation'
import type { AgentInputSubmissionReceipt, AgentInputWaitStopReceipt } from '@agentmux/core'

export type MessageDeliveryDiagnostic = {
  error: unknown
  errorCode?: string | undefined
  logId?: string | undefined
  log?: ClientDeliveryLog | undefined
  preparationReason?: 'context-compaction' | 'native-busy' | undefined
  /** Facts about the original operation take precedence over this attempt's zero-byte refusal. */
  inputUnconfirmed?: boolean | undefined
  /** Original Core receipts; an error or a waiting phase cannot stand in for these facts. */
  inputReceipt?: AgentInputSubmissionReceipt | undefined
  inputStopReceipt?: AgentInputWaitStopReceipt | undefined
  context?: 'delivery' | 'tool' | undefined
}

function fields(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

/** Presentation only: no input admission, error-string protocol interpretation or replay decision. */
export function presentMessageDeliveryFailure(input: MessageDeliveryDiagnostic) {
  const presented = describeError(input.error)
  const failure = input.log?.record.error ?? fields(input.error)
  const code = input.errorCode ?? (typeof failure?.code === 'string' ? failure.code : presented.code)
  const control = fields(failure?.controlFailure)
  const receipt = input.inputReceipt
  // A terminal original-owner receipt resolves prior uncertainty. The old error remains in the report.
  if (receipt?.status === 'terminal-confirmed') return { kind: 'terminal-confirmed', title: '终端输入已确认',
    state: '原终端已确认输入字节；Native 是否采用尚未确认。这不是任务完成回执。', action: '请在原对话或终端查看 Agent 后续处理。' }
  if (receipt?.status === 'admitted') return { kind: 'admitted', title: '输入已确认',
    state: '原消息已由 Native 接纳；这不是 Agent 完成任务的回执。', action: '可在原对话查看 Agent 回复。' }
  if (receipt?.status === 'not-applied') return { kind: 'not-applied', title: '原输入未接纳',
    state: 'Core 已确认这条原输入未被接纳，原消息与回执保留。', action: '需要替换时，创建一条明确的新消息。' }
  const stop = input.inputStopReceipt
  const key = receipt?.ref.key, stoppedKey = stop?.ref.key
  const stopped = stop?.outcome === 'stopped-before-dispatch' && receipt && stop.ref.waitGeneration === receipt.ref.waitGeneration &&
    stoppedKey?.kind === key?.kind && stoppedKey?.agentSessionId === key?.agentSessionId && stoppedKey?.expectedRun.runId === key?.expectedRun.runId &&
    (key?.kind === 'prompt' ? stoppedKey?.kind === 'prompt' && stoppedKey.submissionId === key.submissionId
      : key?.kind === 'message' && stoppedKey?.kind === 'message' && stoppedKey.messageId === key.messageId)
  if (stopped && receipt.admission === null && receipt.control.state !== 'dispatch-authorized') return { kind: 'stopped', title: '已停止等待',
    state: 'Core 已确认停止这一代等待，原消息保留。', action: '再次发送会重新确认这条原消息。' }
  const unknown = input.inputUnconfirmed || control?.disposition === 'unknown' ||
    typeof control?.confirmedInputBytes === 'number' && control.confirmedInputBytes > 0 ||
    receipt?.status === 'unknown' || receipt && (receipt.admission !== null || receipt.control.state === 'dispatch-authorized')
  const noInput = !unknown && control?.disposition === 'not_applied' && control.confirmedInputBytes === 0
  const reason = input.preparationReason ?? readAgentPromptPreparationWait(failure)?.reason
  if (code === 'AGENT_PROMPT_CONDITION_CHANGED') return { kind: 'condition-changed', title: '发送条件已变化',
    state: '本次尝试未写入输入；原消息此前的投递结果仍需核对。',
    action: '请先查看 Agent 回复。可将原文移至草稿，核对后作为新消息发送；原记录会保留。' }
  if (unknown) return { kind: 'unknown', title: '发送结果待核实',
    state: '这条消息此前是否已输入仍待核实，原消息和操作会保留。',
    action: '先查看原对话与投递记录，避免重复发送。' }
  if (receipt) {
    if (receipt.status === 'stopped' || stopped) return { kind: 'stopped', title: '已停止等待',
      state: 'Core 已确认停止这一代等待，原消息保留。', action: '再次发送会重新确认这条原消息。' }
    if (receipt.status === 'waiting' && receipt.control.state === 'enabled' && receipt.admission === null) {
      const wait = receipt.control.waiting
      return { kind: 'saved-waiting', title: wait?.phase === 'runtime' ? '已保存 · 等待连接' : '已保存 · 等待确认',
        state: wait?.phase === 'observer' ? '本次观察已结束，原消息仍由 Core 保存。'
          : wait?.phase === 'authorization' ? '原消息已保存；需要原作者的当前授权才能继续确认。'
          : wait?.phase === 'runtime' ? '原消息已保存；原 Runtime 连接恢复后继续确认这条消息。'
          : '原消息已保存，输入环境尚未确认。完整原因保留在详情中。',
        action: wait?.wake === 'runtime-restored' ? '可停止这一代等待。' : '可继续确认原环境，或停止这一代等待。' }
    }
  }
  if (reason && noInput) return { kind: 'waiting',
    title: reason === 'context-compaction' ? '正在整理上下文' : 'Agent 暂时忙碌',
    state: '本次尝试尚未写入输入，原消息已保留。', action: '稍后重试这条原消息。' }
  if (code === 'AGENT_PROMPT_PREPARATION_FAILED') return { kind: 'preparation', title: '本次准备未完成',
    state: noInput ? '本次尝试尚未写入输入，原消息已保留。' : '准备步骤没有确认完成；输入结果仍待核实。',
    action: noInput ? '可以重试这条原消息，或查看原终端。' : '先查看原对话与投递记录，再决定是否重试。' }
  // Short authored messages remain useful. A serialized diagnostic stays in full in the report.
  const readable = presented.message.length <= 180 && !/[\n\r{}]/u.test(presented.message) && !/^\s*\[/u.test(presented.message)
  return { kind: noInput ? 'failed' : 'unknown', title: input.context === 'tool' ? '操作未完成' : '发送未完成',
    compactCause: readable ? presented.message : undefined,
    state: readable ? presented.message : '未能确认这次操作的结果，完整原因保留在技术详情中。',
    action: input.context === 'tool' ? '草稿已保留，可以重试此操作。' : noInput ? '原消息已保留，可以重试。' : '输入结果未知，请先核对原对话与投递记录。' }
}

function diagnosticJSON(value: unknown, space = 2): string {
  const ancestors: object[] = [], errors = new WeakMap<object, Record<string, unknown>>()
  return JSON.stringify(value, function (_key, item: unknown) {
    if (typeof item !== 'object' || item === null) return typeof item === 'bigint' ? String(item) : item
    if (item instanceof Error || typeof DOMException !== 'undefined' && item instanceof DOMException) {
      let view = errors.get(item)
      if (!view) { view = Object.fromEntries([...new Set(['name', 'message', ...Object.getOwnPropertyNames(item)])].map(key => [key, (item as unknown as Record<string, unknown>)[key]])); errors.set(item, view) }
      item = view
    }
    while (ancestors.length && ancestors.at(-1) !== this) ancestors.pop()
    if (ancestors.includes(item as object)) return '[circular reference]'
    ancestors.push(item as object)
    return item
  }, space) ?? String(value)
}

/** A readable projection of received facts, never an admission or retry decision. */
export function messageDeliveryDiagnosticReport(input: MessageDeliveryDiagnostic): string {
  const summary = presentMessageDeliveryFailure(input), receipt = input.inputReceipt
  const error = fields(input.error), wait = receipt?.control.waiting
  const brief = (value: unknown, limit = 180) => {
    const text = typeof value === 'string' ? value : diagnosticJSON(value, 0)
    return text.length > limit ? `${text.slice(0, limit)}…（其余见完整资料）` : text
  }
  const lines = ['AgentMux Message Tool 诊断', `${summary.title} · ${summary.state}`, summary.action,
    `原输入: ${receipt ? JSON.stringify(receipt.ref.key) : '未知（未收到 Core 输入回执）'}`,
    `等待代次: ${receipt?.ref.waitGeneration ?? '未知'}`,
    `Core: ${receipt ? `status=${receipt.status}; persistence=${receipt.persistence}; control=${receipt.control.state}; observation=${receipt.observation}` : '未知'}`,
    `admission: ${receipt ? receipt.admission === null ? 'null（本回执无输入记录，不代签此前未输入）' : '收到原输入记录（实际层次见 status，完整字段见资料）' : '未知'}`]
  const dispatch = receipt?.admission?.admission
  if (dispatch) lines.push(`admission.admission: ${JSON.stringify({ transport: dispatch.transport,
    nativeOutcome: dispatch.native?.outcome, acknowledged: dispatch.acknowledged, notApplied: dispatch.notApplied,
    uncertainTurn: dispatch.uncertainTurn, startByte: dispatch.startByte, endByte: dispatch.endByte })}`)

  if (wait) lines.push(`等待（inputReceipt.control.waiting）: phase=${wait.phase}; reason=${wait.reason}; wake=${wait.wake}${'mechanism' in wait && wait.mechanism ? `; mechanism=${wait.mechanism}` : ''}${'observation' in wait && wait.observation?.phase ? `; observation.phase=${wait.observation.phase}（观察位置）` : ''}`)
  if (input.inputStopReceipt) lines.push(`停止回执: ${JSON.stringify(input.inputStopReceipt)}`)
  if (input.inputUnconfirmed) lines.push('此前客户端输入标记: 待核实；当前结论见上述 Core 回执。')
  if (input.errorCode && !error?.code) lines.push(`errorCode: ${input.errorCode}`)
  if (error?.controlFailure) lines.push(`本次 error.controlFailure: ${JSON.stringify(error.controlFailure)}`)
  const seen = new Set<object>()
  let cause: unknown = input.error, source = 'error'
  for (let depth = 0; depth < 3 && cause !== undefined; depth++) {
    const record = fields(cause)
    if (record && seen.has(record)) { lines.push(`${source}: [circular reference]`); break }
    if (record) seen.add(record)
    lines.push(`${source}: ${brief(record ? { name: record.name, code: depth === 0 ? input.errorCode ?? record.code : record.code, message: record.message, truncated: record.truncated } : cause, 360)}`)
    // Opaque detail is evidence, not a parsed protocol or an inferred root cause.
    if (record?.detail !== undefined) lines.push(`${source}.detail（收到的原因字段）: ${brief(record.detail, 800)}`)
    cause = record?.cause; source += '.cause'
    if (depth === 2 && cause !== undefined) lines.push('更深原因链见完整资料。')
  }
  const waitingFailure = wait?.phase === 'native-environment' ? wait.observation?.failure : wait?.failure
  if (waitingFailure && waitingFailure !== input.error) {
    const source = wait?.phase === 'native-environment' ? 'inputReceipt.control.waiting.observation.failure' : 'inputReceipt.control.waiting.failure'
    lines.push(`${source}: ${brief({ name: waitingFailure.name, code: waitingFailure.code, message: waitingFailure.message, truncated: waitingFailure.truncated }, 360)}`)
    if (waitingFailure.detail) lines.push(`${source}.detail（收到的原因字段）: ${brief(waitingFailure.detail, 800)}`)
    if (waitingFailure.controlFailure) lines.push(`${source}.controlFailure: ${JSON.stringify(waitingFailure.controlFailure)}`)
  }
  if (input.log) lines.push(`日志来源: ${JSON.stringify({ owner: input.log.owner, localSaved: input.log.localSaved,
    hostId: input.log.record.hostId, agentSessionId: input.log.record.agentSessionId, expectedRunId: input.log.record.expectedRunId,
    operationId: input.log.record.operationId, afterSubmissionId: input.log.record.afterSubmissionId,
    remoteAvailability: input.log.remote?.availability, remotePersistence: input.log.remote?.persistence })}`)
  if (input.log?.record.error) {
    lines.push(`log.record.error（日志来源）: ${brief({ name: input.log.record.error.name, code: input.log.record.error.code, message: input.log.record.error.message, truncated: input.log.record.error.truncated }, 360)}`)
    if (input.log.record.error.detail) lines.push(`log.record.error.detail（收到的原因字段）: ${brief(input.log.record.error.detail, 800)}`)
    if (input.log.record.error.controlFailure) lines.push(`log.record.error.controlFailure: ${JSON.stringify(input.log.record.error.controlFailure)}`)
  }
  const ids = [...new Set([input.logId, typeof error?.logId === 'string' ? error.logId : undefined,
    input.log?.record.logId, input.log?.record.coreLogId].filter(Boolean))]
  if (ids.length) lines.push(`logid: ${ids.join(', ')}`)
  return lines.join('\n')
}

/** One received snapshot. Upstream truncation remains visible; omitted bytes cannot be recreated. */
export function messageDeliveryDiagnosticExport(input: MessageDeliveryDiagnostic): string {
  const wait = input.inputReceipt?.control.waiting
  const original = wait?.phase === 'native-environment' ? wait.observation?.failure : wait?.failure
  // Only the exact same object has a source reference. Equal text/code never merges sources.
  const error = original !== undefined && input.error === original ? { sourceRef: wait?.phase === 'native-environment'
    ? 'inputReceipt.control.waiting.observation.failure' : 'inputReceipt.control.waiting.failure' } : input.error
  return diagnosticJSON({ scope: '实际收到的诊断资料；上游 truncated 标记保留，不代表恢复被上游省略的原文。',
    ...input, error })
}
