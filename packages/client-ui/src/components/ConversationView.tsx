import type { AgentCapabilities, AgentMuxRunRef, AgentSessionHistorySource, AgentSessionHistoryItem, AgentSessionHistoryPage } from '@agentmux/core'
import { projectConversationRecords } from '../lib/conversation-records.js'
import { memo, useMemo, type ReactNode } from 'react'
import type { ConversationReplySource } from '@agentmux/core/prompt-reaction'
import { buildNativeContinuationPrompt } from '../lib/native-continuation.js'
import { type DescribeSpeaker } from '../lib/conversation-speaker.js'
import { ConversationMessage, type ConversationMessageProps } from './ConversationMessage.js'
import { ConversationRecordSequence, type ConversationProcessRenderer, type ConversationRecordRenderer, type ConversationRecordBoundary } from './ConversationRecordSequence.js'
import { conversationMessageSourceKey } from '../lib/conversation-message-location.js'
import { AgentAsyncQuestionCard, type QuestionNoticeRenderer } from './AgentAsyncQuestionCard.js'
import type { ConversationQuestionInput, ConversationQuestionTarget, QuestionReplyState } from '../lib/conversation-question-reply.js'
import { projectConversationQuestions } from '@agentmux/core/conversation'
import { completedNativeReply } from '../lib/conversation-files.js'
import { conversationItemRef } from '@agentmux/core/conversation'

type ReadingProps = Pick<ConversationMessageProps,
  'showInputSource' | 'executionHostId' | 'workspaceRoot' | 'homeDir' | 'openWorkspaceFile' | 'readPastedImage' | 'readHistoryResource' | 'openHttpLink' | 'onSelectAnnotation' | 'expandedTraces' | 'onToggleTrace'>

type Props = ReadingProps & {
  questionReplyRoute?: AgentCapabilities['asyncQuestionReply']
  questionTerminalTarget?: { source: AgentSessionHistorySource; run: AgentMuxRunRef } | undefined
  /** Changes reset only transient card actions; drafts remain in the host's original owner. */
  questionDraftNotice?: string | undefined
  questionReplyContext?: string
  onOpenQuestionTerminal?: () => void
  questionReplyState?: (target: ConversationQuestionTarget) => QuestionReplyState | undefined
  questionReplyDraft?: (target: ConversationQuestionTarget) => ConversationQuestionInput['answers'] | undefined
  onQuestionDraftChange?: (target: ConversationQuestionTarget, answers: ConversationQuestionInput['answers']) => void
  renderQuestionNotice?: QuestionNoticeRenderer
  page: AgentSessionHistoryPage
  /** Already accepted same-source facts; does not change this page or acquire read demand. */
  questionAnswerContext?: AgentSessionHistoryPage | null
  sessionId: string
  describeSpeaker?: DescribeSpeaker
  onContinue?: (prompt: string) => void
  locatedMessageKey?: string | null
  recordBoundary?: ConversationRecordBoundary
  renderProcess?: ConversationProcessRenderer
  renderMessageActions?: (source: ConversationReplySource) => ReactNode
  /** Hosts may retain an existing annotation/disclosure identity without replacing presentation. */
  messageIdForRecord?: (item: AgentSessionHistoryItem) => string
  showSource?: boolean
}

/** Continuous source-order reading over the committed page; no reader or independent body cache. */
export const ConversationView = memo(function ConversationView({
  page, questionAnswerContext, sessionId, describeSpeaker, onContinue, locatedMessageKey, renderProcess, recordBoundary, renderMessageActions, messageIdForRecord, showSource = false, questionReplyRoute, questionTerminalTarget, questionReplyContext, questionDraftNotice, onOpenQuestionTerminal, questionReplyState, questionReplyDraft, onQuestionDraftChange, renderQuestionNotice, ...reading
}: Props) {
  const describedRecords = useMemo(() => projectConversationRecords({ agentSessionId: sessionId, executionHostId: reading.executionHostId, historyPage: page }),
    [page, sessionId, reading.executionHostId])
  if (page.agentSessionId !== sessionId || page.items.length === 0) return null
  const descriptions = new Map(describedRecords.map(record => [record.rawId, record]))
  const questions = new Map(projectConversationQuestions({ agentSessionId: sessionId, executionHostId: reading.executionHostId, historyPage: page, answerContext: questionAnswerContext })
    .map(question => [question.recordId, question]))
  const records = describedRecords.flatMap(record => record.original.kind === 'native' ? [record.original.item] : [])

  const renderRecord: ConversationRecordRenderer = (item, wrapBody) => {
      const record = descriptions.get(item.id)!
      const recordId = record.id
      const question = questions.get(item.id)
      const questionAttempt = question && questionReplyState && question.turnId ? questionReplyState({ source: question.source, turnId: question.turnId, recordId: question.recordId }) : undefined
      const terminalCurrent = Boolean(question && questionTerminalTarget && question.source.providerId === questionTerminalTarget.source.providerId
        && question.source.nativeSessionId === questionTerminalTarget.source.nativeSessionId
        && (!questionAttempt?.original || questionAttempt.original.input.expectedRun.runId === questionTerminalTarget.run.runId))
      const user = record.input
      const itemRef = conversationItemRef(record)
      const speaker = record.speaker
      const described = speaker && item.kind !== 'system-message' ? describeSpeaker?.(speaker) : undefined
      const body = <ConversationMessage messageId={messageIdForRecord?.(item) ?? user?.id ?? recordId} conversationSessionId={sessionId}
          {...(completedNativeReply(item) ? { status: 'complete' } : {})}
          {...(itemRef ? { itemRef } : {})}
          located={locatedMessageKey === conversationMessageSourceKey(sessionId, record.source)}
          {...(item.kind === 'system-message' ? { recordTitle: `${page.source.providerId} · ${item.title ?? 'System record'}` }
            : user && item.title ? { recordTitle: item.title } : {})}
          nativeResourceRecord={{ source: page.source, recordId: item.id, ...(item.turnId === undefined ? {} : { turnId: item.turnId }) }}
          content={record.contentParts} {...(item.questionAnswers ? { questionAnswers: item.questionAnswers } : {})} {...(item.messagePhase ? { messagePhase: item.messagePhase } : {})} {...(user ? { inputSource: user.source } : {})}
          {...(speaker ? { speaker } : {})}
          name={item.kind === 'system-message' ? page.source.providerId : described?.name ?? (user ? 'Input' : speaker ? 'Assistant' : recordTitle(item))}
          providerId={described?.providerId ?? page.source.providerId}
          {...(describeSpeaker ? { describeSpeaker } : {})}
          {...(item.startedAt === undefined ? {} : { createdAt: item.startedAt })}
          {...(user && onContinue ? { onContinue: () => onContinue(buildNativeContinuationPrompt(page, item)) } : {})}
          {...(renderMessageActions && item.kind === 'assistant-message'
            ? { messageActions: renderMessageActions({ kind: 'native', agentSessionId: sessionId,
              providerId: page.source.providerId, nativeSessionId: page.source.nativeSessionId, recordId: item.id }) } : {})}
          {...reading} />
      return <div key={recordId} className="conversation-native-thread__record" data-native-record-id={item.id}>
        {wrapBody ? wrapBody(body) : body}
        {question ? <AgentAsyncQuestionCard key={JSON.stringify([sessionId, recordId, reading.executionHostId, questionReplyContext])} request={question.request} recordedAnswers={question.recordedAnswers} terminalCurrent={terminalCurrent}
          {...(questionDraftNotice ? { draftNotice: questionDraftNotice } : {})}
          {...(questionReplyRoute ? { replyRoute: questionReplyRoute } : {})}
          {...(onOpenQuestionTerminal ? { onOpenTerminal: onOpenQuestionTerminal } : {})}
          {...(questionAttempt ? { attempt: questionAttempt } : {})}
          {...(questionReplyDraft && question.turnId ? { draftAnswers: questionReplyDraft({ source: question.source, turnId: question.turnId, recordId: question.recordId }) } : {})}
          {...(onQuestionDraftChange && question.turnId ? { onDraftChange: selected => onQuestionDraftChange({ source: question.source, turnId: question.turnId!, recordId: question.recordId }, selected) } : {})}
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
      renderRecord={renderRecord} {...(renderProcess ? { renderProcess } : {})} {...(recordBoundary ? { recordBoundary } : {})} />
  </section>
})

function recordTitle(item: AgentSessionHistoryItem): string {
  return item.title ?? 'Recorded activity'
}
