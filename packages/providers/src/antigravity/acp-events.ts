import { acpRecord } from './acp-process.js'

// Normalize only ACP v1 facts from the original native Session.
type ChoiceKind = 'allow-once' | 'allow-always' | 'reject-once' | 'reject-always'
const permissionKinds = new Map<string, ChoiceKind>([
  ['allow_once', 'allow-once'], ['allow_always', 'allow-always'],
  ['reject_once', 'reject-once'], ['reject_always', 'reject-always']
])

const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

/** The actor retains the exact native RPC ID alongside the options until it writes the original response. */
export function readAntigravityPermission(params: unknown, sessionId: string, requestId: string) {
  const request = acpRecord(params)
  if (request?.sessionId !== sessionId || !Array.isArray(request.options) || request.options.length === 0) return null
  const tool = acpRecord(request.toolCall)
  if (!nonempty(tool?.toolCallId)) return null
  const choices: Array<{ id: string; label: string; kind: ChoiceKind }> = []
  const seen = new Set<string>()
  for (const item of request.options) {
    const option = acpRecord(item)
    const kind = typeof option?.kind === 'string' ? permissionKinds.get(option.kind) : undefined
    if (!kind || !nonempty(option?.optionId) || !nonempty(option.name) || seen.has(option.optionId)) return null
    seen.add(option.optionId)
    choices.push({ id: option.optionId, label: option.name, kind })
  }
  return { type: 'permission' as const, requestId, nativeToolCallId: tool.toolCallId,
    title: nonempty(tool.title) ? tool.title : 'Agent permission', options: choices }
}

function toolStatus(value: unknown): 'streaming' | 'complete' | 'failed' | undefined {
  switch (value) {
    case 'pending': case 'in_progress': return 'streaming'
    case 'completed': return 'complete'
    case 'failed': return 'failed'
    default: return undefined
  }
}

/** Unknown and foreign notifications grant no write, status, readiness or permission facts. */
export function readAntigravityUpdate(params: unknown, sessionId: string) {
  const notification = acpRecord(params)
  if (notification?.sessionId !== sessionId) return null
  const update = acpRecord(notification.update)
  if (!update) return null
  const content = acpRecord(update.content)
  if (update.sessionUpdate === 'agent_message_chunk' && content?.type === 'text' && typeof content.text === 'string') {
    return { kind: 'message-chunk' as const, text: content.text,
      ...(nonempty(update.messageId) ? { messageId: update.messageId } : {}) }
  }
  if ((update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') && nonempty(update.toolCallId)) {
    const status = toolStatus(update.status)
    const activityId = `tool:${update.toolCallId}`
    if (update.sessionUpdate === 'tool_call' && nonempty(update.title)) return {
      kind: 'tool-activity' as const,
      event: { type: 'activity' as const, operation: 'append' as const, activityId, kind: 'tool_call' as const,
        status: status ?? 'streaming', title: update.title }
    }
    if (update.sessionUpdate === 'tool_call_update' && (status || nonempty(update.title))) return {
      kind: 'tool-activity' as const,
      event: { type: 'activity' as const, operation: 'update' as const, activityId,
        ...(status ? { status } : {}), ...(nonempty(update.title) ? { title: update.title } : {}) }
    }
  }
  return null
}

/** ACP usage_update carries session context counts. Optional cost is billed separately. */
export function readAntigravityContextWindow(update: Record<string, unknown>) {
  const { used, size } = update
  if (typeof used !== 'number' || !Number.isSafeInteger(used) || used < 0 ||
      typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) return undefined
  return { usedTokens: used, capacityTokens: size }
}

type NativeConfigurationChoice = {
  value: string; name: string; description?: string; group?: { id: string; name: string }
}
type NativeConfigurationOption = { id: string; name: string; description?: string; category?: string } & (
  { type: 'select'; currentValue: string; choices: NativeConfigurationChoice[] } |
  { type: 'boolean'; currentValue: boolean }
)

export function readAntigravityConfiguration(value: unknown): NativeConfigurationOption[] | undefined {
  if (!Array.isArray(value) || value.length > 256) return undefined
  const options: NativeConfigurationOption[] = []
  const ids = new Set<string>()
  for (const item of value) {
    const o = acpRecord(item)
    if (!o || o.type !== 'select' && o.type !== 'boolean') continue
    if (!nonempty(o.id) || !nonempty(o.name) || ids.has(o.id)) return undefined
    ids.add(o.id)
    const fields = { id: o.id, name: o.name, ...(nonempty(o.description) ? { description: o.description } : {}),
      ...(nonempty(o.category) ? { category: o.category } : {}) }
    if (o.type === 'boolean') {
      if (typeof o.currentValue !== 'boolean' || o.options !== undefined) return undefined
      options.push({ ...fields, type: 'boolean', currentValue: o.currentValue })
      continue
    }
    if (!Array.isArray(o.options) || !nonempty(o.currentValue)) return undefined
    const groups = o.options.length && acpRecord(o.options[0])?.group !== undefined
    const choices: NativeConfigurationChoice[] = []
    const choiceIds = new Set<string>()
    for (const item of groups ? o.options : [{ options: o.options }]) {
      const group = acpRecord(item)
      if (!group || !Array.isArray(group.options) || groups && (!nonempty(group.group) || !nonempty(group.name))) return undefined
      for (const item of group.options) {
        const c = acpRecord(item)
        if (!nonempty(c?.value) || !nonempty(c.name) || c.group !== undefined || choiceIds.has(c.value) || choices.length >= 256) return undefined
        choiceIds.add(c.value)
        choices.push({ value: c.value, name: c.name, ...(nonempty(c.description) ? { description: c.description } : {}),
          ...(groups ? { group: { id: group.group as string, name: group.name as string } } : {}) })
      }
    }
    if (!choiceIds.has(o.currentValue)) return undefined
    options.push({ ...fields, type: 'select', currentValue: o.currentValue, choices })
  }
  return options
}
