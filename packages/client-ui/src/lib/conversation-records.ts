import type { AgentConversationRecord, AgentSessionHistoryPage, AgentTimelineSnapshot } from '@agentmux/core'
import { projectConversationRecords as projectCoreRecords } from '@agentmux/core/conversation'
import { speakerOfUserMessage, type ConversationSpeaker } from './conversation-speaker.js'
import { describeConversationInputSource } from './conversation-input-source.js'

export type ConversationRecordSource = AgentConversationRecord['source']
export type ConversationRecord = AgentConversationRecord & { speaker?: ConversationSpeaker }

/** The Core owns source-qualified records; this adapter only supplies client speaker presentation. */
export function projectConversationRecords(input: {
  agentSessionId: string
  executionHostId?: string | undefined
  historyPage?: AgentSessionHistoryPage | undefined
  timeline?: AgentTimelineSnapshot | undefined
}): ConversationRecord[] {
  return projectCoreRecords(input).map(record => {
    const speaker = record.input ? speakerOfUserMessage(record.input)
      : record.author?.kind === 'agent' ? { role: 'agent' as const, id: record.author.agentSessionId }
      : record.author?.kind === 'system' ? { role: 'system' as const, id: record.author.providerId } : undefined
    return { ...record, ...(speaker ? { speaker } : {}) }
  })
}

export function describeConversationRecordSource(record: ConversationRecord): { caption: string; title: string } {
  const inputOrigin = record.input ? describeConversationInputSource(record.input.source) : undefined
  if (record.source.kind === 'native') {
    const origin = inputOrigin ?? describeConversationInputSource(record.source)
    return { caption: origin.caption,
      title: `Native record ${record.source.recordId}\nProvider: ${record.source.providerId}\nNative session: ${record.source.nativeSessionId}\n${origin.title}` }
  }
  const item = record.original.kind === 'captured' ? record.original.item : undefined
  const recordTitle = `Captured record ${record.rawId}\nSession: ${record.agentSessionId}${item ? `\nSource: ${item.source}${item.sourceChannel ? `\nChannel: ${item.sourceChannel}` : ''}` : ''}`
  return inputOrigin ? { caption: inputOrigin.caption, title: `${recordTitle}\n${inputOrigin.title}` }
    : { caption: 'Captured record', title: recordTitle }
}
