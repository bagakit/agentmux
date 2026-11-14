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
