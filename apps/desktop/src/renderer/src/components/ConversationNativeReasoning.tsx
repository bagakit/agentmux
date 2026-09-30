import type { AgentSessionHistoryItem, AgentSessionHistoryPage } from '@agentmux/core'
import { Brain, ChevronRight } from 'lucide-react'
import { memo, useId, useState } from 'react'
import type { DescribeSpeaker } from '../lib/conversation-speaker'
import { ConversationMessage, traceDisclosureKey, type ConversationMessageProps } from './ConversationMessage'
import { ConversationReasoningTrace } from './ConversationReasoningTrace'

type ReadingProps = Pick<ConversationMessageProps,
  'workspaceRoot' | 'homeDir' | 'openWorkspaceFile' | 'readPastedImage' | 'openHttpLink'>

type Props = ReadingProps & {
  page: AgentSessionHistoryPage
  sessionId: string
  describeSpeaker?: DescribeSpeaker
}

/** A reading surface over the already observed page; never a second reader or timeline. */
export const ConversationNativeReasoning = memo(function ConversationNativeReasoning({
  page, sessionId, describeSpeaker, ...reading
}: Props) {
  if (page.agentSessionId !== sessionId) return null
  const records = page.items.filter((item) => item.kind !== 'user-message' &&
    item.contentParts.some((part) => part.kind === 'reasoning'))
  if (records.length === 0) return null

  return <section className="conversation-native-reasoning" aria-label="Provider thinking"
    data-native-provider={page.source.providerId}>
    <div className="conversation-native-reasoning__heading">
      <Brain size={14} aria-hidden="true" />
      <h3>Provider thinking</h3>
      <span>{records.length} {records.length === 1 ? 'record' : 'records'}</span>
    </div>
    <p className="conversation-native-reasoning__source" title={`Native session ${page.source.nativeSessionId}`}>
      Recorded by {page.source.providerId}. Separate from submitted messages; full history is available in History.
    </p>
    {records.map((item) => {
      const recordId = JSON.stringify(['native', page.source.providerId, page.source.nativeSessionId, item.id])
      return <NativeReasoningRecord key={recordId} recordId={recordId} item={item}
        sessionId={sessionId} providerId={page.source.providerId}
        {...(describeSpeaker ? { describeSpeaker } : {})} {...reading} />
    })}
  </section>
})

function NativeReasoningRecord({
  item, recordId, sessionId, providerId, describeSpeaker, ...reading
}: ReadingProps & {
  item: AgentSessionHistoryItem
  recordId: string
  sessionId: string
  providerId: AgentSessionHistoryPage['source']['providerId']
  describeSpeaker?: DescribeSpeaker
}) {
  const [showTurn, setShowTurn] = useState(false)
  const [expandedTraces, setExpandedTraces] = useState<ReadonlySet<string>>(() => new Set())
  const turnId = useId()
  const toggleTrace = (traceId: string, open: boolean): void => {
    setExpandedTraces((previous) => {
      const next = new Set(previous)
      if (open) next.add(traceId)
      else next.delete(traceId)
      return next
    })
  }
  const speaker = item.kind === 'assistant-message' ? { role: 'agent' as const, id: sessionId } : undefined
  const described = speaker ? describeSpeaker?.(speaker) : undefined
  const reasoning = item.contentParts.filter((part) => part.kind === 'reasoning')

  return <div className="conversation-native-reasoning__record" data-native-record-id={item.id}>
    {showTurn ? <div id={turnId} className="conversation-native-reasoning__turn">
      <ConversationMessage messageId={recordId} conversationSessionId={sessionId}
        content={item.contentParts} expandedTraces={expandedTraces} onToggleTrace={toggleTrace}
        {...(speaker ? { speaker } : {})}
        name={described?.name ?? (speaker ? 'Assistant' : item.title ?? 'Recorded activity')}
        providerId={described?.providerId ?? providerId}
        {...(item.startedAt === undefined ? {} : { createdAt: item.startedAt })}
        {...reading} />
    </div> : <div id={turnId} className="conversation-native-reasoning__traces">
      {reasoning.map((part, occurrence) => {
        // The same part identity as the common message, including repeated reasoning.
        const traceId = traceDisclosureKey(recordId, JSON.stringify(['reasoning', null, occurrence]))
        return <ConversationReasoningTrace key={traceId} part={part} traceId={traceId}
          expanded={expandedTraces.has(traceId)} onToggle={(open) => toggleTrace(traceId, open)} {...reading} />
      })}
    </div>}
    <button type="button" className="conversation-native-reasoning__turn-toggle"
      aria-expanded={showTurn} aria-controls={turnId} title={`Native record ${item.id}`}
      onClick={() => setShowTurn((open) => !open)}>
      <ChevronRight size={12} aria-hidden="true" />{showTurn ? 'Back to thinking' : 'View recorded turn'}
    </button>
  </div>
}
