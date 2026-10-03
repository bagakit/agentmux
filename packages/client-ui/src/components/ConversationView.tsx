import type { AgentSessionHistoryItem, AgentSessionHistoryPage, AgentMuxSessionQuestionReplyInput, AgentSessionQuestionReplyReceipt } from '@agentmux/core'
import { projectConversationRecords } from '../lib/conversation-records.js'
import { memo, useMemo, type ReactNode } from 'react'
import type { ConversationReplySource } from '@agentmux/core/prompt-reaction'
import { buildNativeContinuationPrompt } from '../lib/native-continuation.js'
import { type DescribeSpeaker } from '../lib/conversation-speaker.js'
import { ConversationMessage, type ConversationMessageProps } from './ConversationMessage.js'
import { ConversationRecordSequence, type ConversationProcessRenderer, type ConversationRecordRenderer } from './ConversationRecordSequence.js'
import { conversationMessageSourceKey } from '../lib/conversation-message-location.js'
import { AgentAsyncQuestionCard, type QuestionNoticeRenderer } from './AgentAsyncQuestionCard.js'
import { completedNativeReply } from '../lib/conversation-files.js'

type ReadingProps = Pick<ConversationMessageProps,
  'showInputSource' | 'executionHostId' | 'workspaceRoot' | 'homeDir' | 'openWorkspaceFile' | 'readPastedImage' | 'openHttpLink' | 'onSelectAnnotation' | 'expandedTraces' | 'onToggleTrace'>

export type ConversationQuestionReply = (input: Pick<AgentMuxSessionQuestionReplyInput, 'source' | 'turnId' | 'recordId' | 'answers' | 'operationId'>) => Promise<AgentSessionQuestionReplyReceipt>

type Props = ReadingProps & {
  onReplyQuestion?: ConversationQuestionReply
  renderQuestionNotice?: QuestionNoticeRenderer
  page: AgentSessionHistoryPage
  sessionId: string
  describeSpeaker?: DescribeSpeaker
  onContinue?: (prompt: string) => void
  locatedMessageKey?: string | null
  renderProcess?: ConversationProcessRenderer
  renderMessageActions?: (source: ConversationReplySource) => ReactNode
  showSource?: boolean
}

/** Continuous source-order reading over the committed page; no reader or independent body cache. */
export const ConversationView = memo(function ConversationView({
  page, sessionId, describeSpeaker, onContinue, locatedMessageKey, renderProcess, renderMessageActions, showSource = false, onReplyQuestion, renderQuestionNotice, ...reading
}: Props) {
  const describedRecords = useMemo(() => projectConversationRecords({ agentSessionId: sessionId, executionHostId: reading.executionHostId, historyPage: page }),
    [page, sessionId, reading.executionHostId])
  if (page.agentSessionId !== sessionId || page.items.length === 0) return null
  const descriptions = new Map(describedRecords.map(record => [record.rawId, record]))
  const answers = new Map<string, string>()
  for (const item of page.items) if (item.kind === 'user-message') {
    for (const answer of item.questionAnswers ?? []) answers.set(answer.questionId, answer.answer)
  }
  const records = describedRecords.flatMap(record => record.original.kind === 'native' ? [record.original.item] : [])

  const renderRecord: ConversationRecordRenderer = (item, wrapBody) => {
      const record = descriptions.get(item.id)!
      const recordId = record.id
      const user = record.input
      const speaker = record.speaker
      const described = speaker ? describeSpeaker?.(speaker) : undefined
      const body = <ConversationMessage messageId={user?.id ?? recordId} conversationSessionId={sessionId}
          {...(completedNativeReply(item) ? { status: 'complete' } : {})}
          located={Boolean(user && locatedMessageKey === conversationMessageSourceKey(sessionId, user.source))}
          content={record.contentParts} {...(item.messagePhase ? { messagePhase: item.messagePhase } : {})} {...(user ? { inputSource: user.source } : {})}
          {...(speaker ? { speaker } : {})}
          name={described?.name ?? (user ? 'Input' : speaker ? 'Assistant' : recordTitle(item))}
          providerId={described?.providerId ?? page.source.providerId}
          {...(describeSpeaker ? { describeSpeaker } : {})}
          {...(item.startedAt === undefined ? {} : { createdAt: item.startedAt })}
          {...(user && onContinue ? { onContinue: () => onContinue(buildNativeContinuationPrompt(page, item)) } : {})}
          {...(renderMessageActions && item.kind === 'assistant-message' && item.messagePhase !== 'progress' && item.contentParts.some(part => part.kind === 'text' && part.text.trim())
            ? { messageActions: renderMessageActions({ kind: 'native', agentSessionId: sessionId,
              providerId: page.source.providerId, nativeSessionId: page.source.nativeSessionId, recordId: item.id }) } : {})}
          {...reading} />
      return <div key={recordId} className="conversation-native-thread__record" data-native-record-id={item.id}>
        {wrapBody ? wrapBody(body) : body}
        {item.questionRequest ? <AgentAsyncQuestionCard key={JSON.stringify([sessionId, recordId])} request={item.questionRequest} recordedAnswers={answers}
          {...(onReplyQuestion && item.turnId ? { onSubmit: (selected, operationId) => onReplyQuestion({
            source: { ...page.source }, turnId: item.turnId!, recordId: item.id, answers: selected, operationId }) } : {})}
          {...(renderQuestionNotice ? { renderNotice: renderQuestionNotice } : {})} /> : null}
        {item.questionDiagnostic ? renderQuestionNotice ? renderQuestionNotice(item.questionDiagnostic)
          : <p className="agent-interaction__error" role="status">{item.questionDiagnostic.message}</p> : null}
      </div>

  }
  return <section className="conversation-native-thread" aria-label="Conversation"
    data-native-provider={page.source.providerId} data-native-source={JSON.stringify([page.source.providerId, page.source.nativeSessionId])}>
    {showSource ? <div className="conversation-native-thread__source" title={`Native session ${page.source.nativeSessionId}`}>
      <span>{page.source.providerId} · Native conversation</span>
      <span>{records.length} {records.length === 1 ? 'record' : 'records'} · Current window</span>
    </div> : null}
    <ConversationRecordSequence items={records}
      sourceKey={JSON.stringify([sessionId, page.source.providerId, page.source.nativeSessionId])}
      renderRecord={renderRecord} {...(renderProcess ? { renderProcess } : {})} />
  </section>
})

function recordTitle(item: AgentSessionHistoryItem): string {
  return item.title ?? 'Recorded activity'
}
