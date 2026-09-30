import type { AgentSessionHistoryItem, AgentSessionHistoryPage } from '@agentmux/core'
import { projectSessionUserMessages } from '@agentmux/core/session-user-messages'
import { memo, useMemo } from 'react'
import { buildNativeContinuationPrompt } from '../lib/session-continuation'
import { speakerOfUserMessage, type DescribeSpeaker } from '../lib/conversation-speaker'
import { ConversationMessage, type ConversationMessageProps } from './ConversationMessage'

type ReadingProps = Pick<ConversationMessageProps,
  'workspaceRoot' | 'homeDir' | 'openWorkspaceFile' | 'readPastedImage' | 'openHttpLink' | 'onSelectAnnotation'>

type Props = ReadingProps & {
  page: AgentSessionHistoryPage
  sessionId: string
  describeSpeaker?: DescribeSpeaker
  onContinue?: (prompt: string) => void
}

/** Continuous source-order reading over the committed page; no reader or independent body cache. */
export const ConversationNativeThread = memo(function ConversationNativeThread({
  page, sessionId, describeSpeaker, onContinue, ...reading
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

  return <section className="conversation-native-thread" aria-label="Native conversation"
    data-native-provider={page.source.providerId}>
    <div className="conversation-native-thread__source" title={`Native session ${page.source.nativeSessionId}`}>
      <span>{page.source.providerId} · Native conversation</span>
      <span>{records.length} {records.length === 1 ? 'record' : 'records'} · Current window</span>
    </div>
    {records.map((item) => {
      const recordId = JSON.stringify(['native', page.source.providerId, page.source.nativeSessionId, item.id])
      const user = item.kind === 'user-message' ? users.get(item.id) : undefined
      const speaker = user ? speakerOfUserMessage(user)
        : item.kind === 'assistant-message' ? { role: 'agent' as const, id: sessionId } : undefined
      const described = speaker ? describeSpeaker?.(speaker) : undefined
      return <div key={recordId} className="conversation-native-thread__record" data-native-record-id={item.id}>
        <ConversationMessage messageId={user?.id ?? recordId} conversationSessionId={sessionId}
          content={item.contentParts} {...(user ? { inputSource: user.source } : {})}
          {...(speaker ? { speaker } : {})}
          name={described?.name ?? (user ? 'Input' : speaker ? 'Assistant' : recordTitle(item))}
          providerId={described?.providerId ?? page.source.providerId}
          {...(describeSpeaker ? { describeSpeaker } : {})}
          {...(item.startedAt === undefined ? {} : { createdAt: item.startedAt })}
          {...(user && onContinue ? { onContinue: () => onContinue(buildNativeContinuationPrompt(page, item)) } : {})}
          {...reading} />
      </div>
    })}
  </section>
})

function recordTitle(item: AgentSessionHistoryItem): string {
  return item.title ?? 'Recorded activity'
}
