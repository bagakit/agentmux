import type { ConversationProcessMember } from '@agentmux/client-ui/components/ConversationRecordSequence'

/** Read the original published source references; accepted IDs remain opaque. */
export function processNativeRecordIds(node: Element): string[] {
  const members = JSON.parse(node.getAttribute('data-conversation-process-members') ?? '[]') as ConversationProcessMember[]
  return members.flatMap(member => member.sources.flatMap(reference => reference.source.kind === 'native' ? [reference.source.recordId] : []))
}
