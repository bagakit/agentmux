import { describeError } from './error-presentation.js'
import type { ClientDeliveryLog } from './delivery-diagnostics.js'
import { readAgentPromptPreparationWait } from '@agentmux/core/prompt-preparation'

export type MessageDeliveryDiagnostic = {
  error: unknown
  errorCode?: string | undefined
  logId?: string | undefined
  log?: ClientDeliveryLog | undefined
  preparationReason?: 'context-compaction' | 'native-busy' | undefined
  /** Facts about the original operation take precedence over this attempt's zero-byte refusal. */
  inputUnconfirmed?: boolean | undefined
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
  const unknown = input.inputUnconfirmed || control?.disposition === 'unknown' ||
    typeof control?.confirmedInputBytes === 'number' && control.confirmedInputBytes > 0
  const noInput = !unknown && control?.disposition === 'not_applied' && control.confirmedInputBytes === 0
  const reason = input.preparationReason ?? readAgentPromptPreparationWait(failure)?.reason
  if (code === 'AGENT_PROMPT_CONDITION_CHANGED') return { kind: 'condition-changed', title: '发送条件已变化',
    state: '本次尝试未写入输入；原消息此前的投递结果仍需核对。',
    action: '请先查看 Agent 回复。可将原文移至草稿，核对后作为新消息发送；原记录会保留。' }
  if (unknown) return { kind: 'unknown', title: '发送结果待核实',
    state: '这条消息此前是否已输入仍待核实，原消息和操作会保留。',
    action: '先查看原对话与投递记录，避免重复发送。' }
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

function diagnosticJSON(value: unknown): string {
  const seen = new WeakSet<object>()
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item !== 'object' || item === null) return typeof item === 'bigint' ? String(item) : item
    if (seen.has(item)) return '[circular reference]'
    seen.add(item)
    if (item instanceof Error) return Object.fromEntries(Object.getOwnPropertyNames(item).map(key => [key, (item as unknown as Record<string, unknown>)[key]]))
    return item
  }, 2) ?? String(value)
}

/** Entire received error and existing journal; no display-length clipping or second diagnostic owner. */
export function messageDeliveryDiagnosticReport(input: MessageDeliveryDiagnostic): string {
  const presented = describeError(input.error)
  const summary = presentMessageDeliveryFailure(input)
  return ['AgentMux Message Tool 诊断', summary.title, summary.state, summary.action,
    ...(input.logId ? [`logid: ${input.logId}`] : []),
    ...(input.errorCode ?? presented.code ? [`code: ${input.errorCode ?? presented.code}`] : []),
    '', '原始错误（完整）', presented.raw,
    ...(presented.detail ? ['', '原始 detail（完整）', presented.detail] : []),
    ...(typeof input.error === 'object' && input.error !== null ? ['', '原始结构化错误', diagnosticJSON(input.error)] : []),
    ...(input.log ? ['', '原投递诊断记录', diagnosticJSON(input.log)] : []),
    ...(input.inputUnconfirmed ? ['', '原操作输入结果：仍待核实；本次拒绝不能代签此前没有输入。'] : [])].join('\n')
}
