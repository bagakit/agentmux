import type { AgentTimelineItem } from './types.js'
import { interpretRecordedToolEdit } from '@agentmux/providers/recorded-tool-edit'

/** Original requested edits, not proof that the tool applied them. */
export type ConversationToolEdit = {
  filePath?: string
  edits: readonly { before?: string; after: string }[]
}

/** Use only the Provider recorded for this exact input field. Raw input remains authoritative. */
export function capturedToolEdit(item: AgentTimelineItem): ConversationToolEdit | null {
  if (item.kind !== 'tool_call' || item.toolName === undefined || item.toolInput === undefined) return null
  const inputs = item.conversation?.invocations?.filter(part => part.selector.kind === 'captured-field' && part.selector.field === 'toolInput') ?? []
  if (inputs.length !== 1) return null
  return interpretRecordedToolEdit(inputs[0]!.invocation.source.providerId, item.toolName, item.toolInput)
}
