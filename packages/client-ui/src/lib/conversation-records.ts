import type { AgentConversationRecord } from '@agentmux/core'
import type { ConversationProjectionInput } from '@agentmux/core/conversation'
import { projectConversationReading as projectCoreReading, projectConversationWindow as projectCoreWindow, type ConversationWindowSnapshot } from '@agentmux/core/conversation'
import { speakerOfUserMessage, type ConversationSpeaker } from './conversation-speaker.js'
import { conversationSourcePresenter, type ConversationSources } from './conversation-sources.js'
import { describeConversationInputSource } from './conversation-input-source.js'

export type ConversationRecordSource = AgentConversationRecord['source']
export type ConversationRecord = AgentConversationRecord & { speaker?: ConversationSpeaker; presentationKey?: string; sources?: ConversationSources; coverage?: import('@agentmux/core/conversation').ConversationTimeline['coverage'] }

/** The Core owns source-qualified records; this adapter only supplies client speaker presentation. */
export function projectConversationReading(input: ConversationProjectionInput) {
  const reading = projectCoreReading({ ...input, executionHostId: undefined, ...(input.executionHostId ? { routeHostId: input.executionHostId } : {}) })
  return describeReading(reading)
}

export function projectConversationWindow(snapshot: ConversationWindowSnapshot) {
  return describeConversationWindow(projectCoreWindow(snapshot))
}

/** Add client presentation to the exact Core reading already accepted by its owner. */
export function describeConversationWindow(reading: ReturnType<typeof projectCoreWindow>) {
  return { ...reading, ...describeReading(reading) }
}

function describeReading(reading: ReturnType<typeof projectCoreReading>) {
  const presentSources = conversationSourcePresenter(reading.timeline)
  const describe = (record: AgentConversationRecord): ConversationRecord => {
    const speaker = record.author?.kind === 'system' ? { role: 'system' as const, id: record.author.providerId ?? 'agentmux' }
      : record.author ? speakerOfUserMessage({ author: record.author }) : undefined
    return { ...record, ...(record.original.kind === 'deferred' ? {} : { sources: presentSources(record) }), coverage: reading.timeline.coverage, ...(speaker ? { speaker } : {}) }
  }
  return { timeline: reading.timeline, records: reading.records.map(describe), originalRecords: reading.originalRecords.map(describe), inputs: reading.inputs }
}

export function projectConversationRecords(input: ConversationProjectionInput): ConversationRecord[] {
  return projectConversationReading(input).records
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
