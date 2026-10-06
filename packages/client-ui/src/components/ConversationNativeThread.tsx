import type { AgentSessionHistoryItem, AgentSessionHistoryPage } from '@agentmux/core'
import { projectSessionUserMessages } from '@agentmux/core/session-user-messages'
import { memo, useMemo } from 'react'
import { buildNativeContinuationPrompt } from '../lib/native-continuation.js'
import { speakerOfUserMessage, type DescribeSpeaker } from '../lib/conversation-speaker.js'
import { ConversationMessage, type ConversationMessageProps } from './ConversationMessage.js'
import { ConversationRecordSequence, type ConversationProcessRenderer, type ConversationRecordRenderer } from './ConversationRecordSequence.js'
import { conversationMessageSourceKey } from '../lib/conversation-message-location.js'

type ReadingProps = Pick<ConversationMessageProps,
  'workspaceRoot' | 'homeDir' | 'openWorkspaceFile' | 'readPastedImage' | 'readHistoryResource' | 'openHttpLink' | 'onSelectAnnotation'>

type Props = ReadingProps & {
  page: AgentSessionHistoryPage
  sessionId: string
  describeSpeaker?: DescribeSpeaker
  onContinue?: (prompt: string) => void
  locatedMessageKey?: string | null
  renderProcess?: ConversationProcessRenderer
}

/** Continuous source-order reading over the committed page; no reader or independent body cache. */
export const ConversationNativeThread = memo(function ConversationNativeThread({
  page, sessionId, describeSpeaker, onContinue, locatedMessageKey, renderProcess, ...reading
}: Props) {
  const messages = useMemo(() => projectSessionUserMessages({ agentSessionId: sessionId, historyPage: page }),
    [page, sessionId])
  if (page.agentSessionId !== sessionId || page.items.length === 0) return null
  const users = new Map(messages.map((message) => [message.rawId, message]))
  const seen = new Set<string>()
  const records = page.items.filter((item) => {
    if (seen.has(item.id)) return false
    seen.add(item.id)
    return true
  })

  const renderRecord: ConversationRecordRenderer = (item, wrapBody) => {
      const recordId = JSON.stringify(['native', page.source.providerId, page.source.nativeSessionId, item.id])
      const user = item.kind === 'user-message' ? users.get(item.id) : undefined
      const speaker = user ? speakerOfUserMessage(user)
        : item.kind === 'assistant-message' ? { role: 'agent' as const, id: sessionId }
        : item.kind === 'system-message' ? { role: 'system' as const, id: page.source.providerId } : undefined
      const described = speaker && item.kind !== 'system-message' ? describeSpeaker?.(speaker) : undefined
      const body = <ConversationMessage messageId={user?.id ?? recordId} conversationSessionId={sessionId}
          located={Boolean(user && locatedMessageKey === conversationMessageSourceKey(sessionId, user.source))}
          nativeResourceRecord={{ source: page.source, recordId: item.id, ...(item.turnId === undefined ? {} : { turnId: item.turnId }) }}
          content={item.contentParts} {...(item.kind === 'system-message' ? { recordTitle: `${page.source.providerId} · ${item.title ?? 'System record'}` } : {})} {...(item.messagePhase ? { messagePhase: item.messagePhase } : {})} {...(user ? { inputSource: user.source } : {})}
          {...(speaker ? { speaker } : {})}
          name={item.kind === 'system-message' ? page.source.providerId : described?.name ?? (user ? 'Input' : speaker ? 'Assistant' : recordTitle(item))}
          providerId={described?.providerId ?? page.source.providerId}
          {...(describeSpeaker ? { describeSpeaker } : {})}
          {...(item.startedAt === undefined ? {} : { createdAt: item.startedAt })}
          {...(user && onContinue ? { onContinue: () => onContinue(buildNativeContinuationPrompt(page, item)) } : {})}
          {...reading} />
      return <div key={recordId} className="conversation-native-thread__record" data-native-record-id={item.id}>
        {wrapBody ? wrapBody(body) : body}
      </div>

  }
  return <section className="conversation-native-thread" aria-label="Native conversation"
    data-native-provider={page.source.providerId} data-native-source={JSON.stringify([page.source.providerId, page.source.nativeSessionId])}>
    <div className="conversation-native-thread__source" title={`Native session ${page.source.nativeSessionId}`}>
      <span>{page.source.providerId} · Native conversation</span>
      <span>{records.length} {records.length === 1 ? 'record' : 'records'} · Current window</span>
    </div>
    <ConversationRecordSequence items={records}
      sourceKey={JSON.stringify([sessionId, page.source.providerId, page.source.nativeSessionId])}
      renderRecord={renderRecord} {...(renderProcess ? { renderProcess } : {})} />
  </section>
})

function recordTitle(item: AgentSessionHistoryItem): string {
  return item.title ?? 'Recorded activity'
}
