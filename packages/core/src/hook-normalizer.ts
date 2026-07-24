import { randomUUID } from 'node:crypto'
import type {
  AgentActivity,
  AgentId,
  AgentSemanticState,
  AgentStatus,
  NativeHookEnvelope,
  NormalizedHookEvent
} from './types.js'

function stringField(payload: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = payload[name]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function eventState(agentId: AgentId, eventName: string, payload: Record<string, unknown>): AgentSemanticState {
  const toolName = stringField(payload, 'tool_name', 'toolName', 'name')?.toLowerCase()
  if (agentId === 'claude') {
    if (eventName === 'PermissionRequest' || (eventName === 'PreToolUse' && toolName === 'askuserquestion')) return 'waiting'
    if (['Stop', 'StopFailure'].includes(eventName)) return 'done'
    if (['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PreCompact'].includes(eventName)) return 'working'
  }
  if (agentId === 'codex') {
    if (eventName === 'PermissionRequest' || (eventName === 'PreToolUse' && ['request_user_input', 'askuserquestion'].includes(toolName ?? ''))) return 'waiting'
    if (eventName === 'Stop') return 'done'
    if (['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStart'].includes(eventName)) return 'working'
  }
  if (agentId === 'pi') {
    if (['tool_call', 'tool_execution_start'].includes(eventName) && ['ask_user_question', 'askuserquestion'].includes(toolName ?? '')) return 'blocked'
    if (['agent_end', 'agent_settled'].includes(eventName)) return 'done'
    if (['before_agent_start', 'agent_start', 'tool_call', 'tool_execution_start', 'tool_execution_end', 'message_end'].includes(eventName)) return 'working'
  }
  if (agentId === 'hermes') {
    if (eventName === 'pre_approval_request') return 'waiting'
    if (['post_llm_call', 'on_session_end', 'on_session_finalize', 'on_session_reset'].includes(eventName)) return 'done'
    if (['on_session_start', 'pre_llm_call', 'pre_tool_call', 'post_tool_call', 'post_approval_response'].includes(eventName)) return 'working'
  }
  return 'unknown'
}

function activity(
  sessionId: string,
  kind: AgentActivity['kind'],
  title: string,
  eventName: string,
  fields: Partial<Omit<AgentActivity, 'id' | 'sessionId' | 'kind' | 'source' | 'createdAt' | 'title'>> = {}
): AgentActivity {
  return {
    id: randomUUID(),
    sessionId,
    kind,
    source: 'native-hook',
    createdAt: Date.now(),
    title,
    eventName,
    ...fields
  }
}

function buildActivities(
  envelope: NativeHookEnvelope,
  eventName: string,
  payload: Record<string, unknown>,
  state: AgentSemanticState
): AgentActivity[] {
  const prompt = stringField(payload, 'prompt', 'user_prompt', 'userPrompt', 'user_message')
  const assistant = stringField(
    payload,
    'last_assistant_message',
    'lastAssistantMessage',
    'assistant_response',
    'text'
  )
  const toolName = stringField(payload, 'tool_name', 'toolName', 'name')
  const rawToolInput = payload.tool_input ?? payload.toolInput ?? payload.args ?? payload.input
  const toolInput =
    typeof rawToolInput === 'string'
      ? rawToolInput
      : rawToolInput === undefined
        ? undefined
        : JSON.stringify(rawToolInput)
  const activities: AgentActivity[] = []
  if (prompt) activities.push(activity(envelope.sessionId, 'prompt', 'Prompt received', eventName, { content: prompt }))
  if (toolName) {
    activities.push(
      activity(envelope.sessionId, state === 'waiting' || state === 'blocked' ? 'permission' : 'tool', toolName, eventName, {
        toolName,
        ...(toolInput ? { toolInput } : {})
      })
    )
  }
  if (assistant) activities.push(activity(envelope.sessionId, 'assistant', 'Assistant response', eventName, { content: assistant }))
  if (activities.length === 0) {
    activities.push(activity(envelope.sessionId, 'lifecycle', eventName, eventName))
  }
  return activities
}

export function normalizeNativeHook(envelope: NativeHookEnvelope): NormalizedHookEvent {
  const payload = envelope.payload ?? {}
  const eventName = envelope.eventName ?? stringField(payload, 'hook_event_name', 'hookEventName') ?? 'unknown'
  const semanticState = eventState(envelope.agentId, eventName, payload)
  const status: AgentStatus = {
    state: semanticState === 'unknown' ? 'running' : semanticState,
    source: 'native-hook',
    observedAt: Date.now(),
    detail: eventName
  }
  return {
    sessionId: envelope.sessionId,
    agentId: envelope.agentId,
    eventName,
    semanticState,
    status,
    activities: buildActivities(envelope, eventName, payload, semanticState)
  }
}
