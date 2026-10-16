import { ConversationCoverage } from './ConversationCoverage.js'
import { CapturedProcessRecord } from './CapturedProcessRecord.js'
import { ConversationOriginalRecords } from './ConversationOriginalRecords.js'
import { useConversationRecordLayout } from '../lib/use-conversation-record-layout.js'
import type { AgentCapabilities, AgentMuxRunRef, AgentSessionHistorySource, AgentSessionHistoryItem, AgentSessionHistoryPage, AgentTimelineSnapshot } from '@agentmux/core'
import type { ConversationRecord } from '../lib/conversation-records.js'
import { memo, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ConversationReplySource } from '@agentmux/core/prompt-reaction'
import { buildNativeContinuationPrompt } from '../lib/native-continuation.js'
import { type DescribeSpeaker } from '../lib/conversation-speaker.js'
import { CapturedConversationMessage, type SubmissionDisclosure } from './CapturedConversationMessage.js'
import { ConversationToolPayload } from './ConversationToolPayload.js'
import { ConversationMessage, type ConversationMessageProps } from './ConversationMessage.js'
import { ConversationRecordSequence, type ConversationProcessProps, type ConversationProcessRenderer, type ConversationRecordRenderer, type ConversationRecordBoundary, type ConversationRecordInsertion } from './ConversationRecordSequence.js'
import { conversationMessageSourceKey } from '../lib/conversation-message-location.js'
import { AgentAsyncQuestionCard, type QuestionNoticeRenderer } from './AgentAsyncQuestionCard.js'
import type { ConversationQuestionInput, ConversationQuestionTarget, QuestionReplyState } from '../lib/conversation-question-reply.js'
import { projectConversationQuestions } from '@agentmux/core/conversation'
import type { ConversationSourceRead } from '../lib/use-conversation-view.js'
import { completedNativeReply } from '../lib/conversation-files.js'
import { conversationItemRef, conversationRecordId, type ConversationItemRef } from '@agentmux/core/conversation'

type ReadingProps = Pick<ConversationMessageProps,
  'active' | 'showInputSource' | 'executionHostId' | 'workspaceRoot' | 'homeDir' | 'openWorkspaceFile' | 'readPastedImage' | 'readHistoryResource' | 'openHttpLink' | 'onSelectAnnotation' | 'expandedTraces' | 'onToggleTrace' | 'traceDisclosure'>

/** Existing Reader facts only. Unknown/newly selected source scopes stay static. */
export type ConversationReadActivity = {
  loading: boolean
  sourceRead: ConversationSourceRead | null
}

type Props = ReadingProps & {
  readActivity?: ConversationReadActivity
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
  page?: AgentSessionHistoryPage | null
  timeline?: AgentTimelineSnapshot | undefined
  records: readonly ConversationRecord[]
  originalRecords?: readonly ConversationRecord[]
  coverage?: import('@agentmux/core/conversation').ConversationTimeline['coverage']
  onLocateRecord?: import('react').ComponentProps<typeof ConversationCoverage>['onLocate']
  renderCapturedRecord?: (record: ConversationRecord, disclosure?: ConversationProcessProps['disclosure'], submissionDisclosure?: SubmissionDisclosure) => ReactNode
  /** Original reader failure retains the full submitted input; does not change input qualification. */
  expandSubmissions?: boolean
  /** Already accepted same-source facts; does not change this page or acquire read demand. */
  questionAnswerContext?: AgentSessionHistoryPage | null
  sessionId: string
  describeSpeaker?: DescribeSpeaker
  onContinue?: (prompt: string) => void
  locatedMessageKey?: string | null
  recordBoundary?: ConversationRecordBoundary
  renderProcess?: ConversationProcessRenderer
  renderRecordActions?: (reference: ConversationItemRef, active: boolean, routeHostId?: string) => ReactNode
  renderMessageActions?: (source: ConversationReplySource) => ReactNode
  /** Hosts may retain an existing annotation/disclosure identity without replacing presentation. */
  messageIdForRecord?: (item: AgentSessionHistoryItem) => string
  showSource?: boolean
  insertions?: readonly ConversationRecordInsertion[]
}

/** Continuous source-order reading over the committed page; no reader or independent body cache. */
export const ConversationView = memo(function ConversationView({
  page, timeline, records: acceptedRecords, originalRecords: acceptedOriginals, coverage, onLocateRecord, renderCapturedRecord, expandSubmissions = false, readActivity, questionAnswerContext, sessionId, describeSpeaker, onContinue, locatedMessageKey, renderProcess, recordBoundary, renderMessageActions, renderRecordActions, messageIdForRecord, showSource = false, insertions, questionReplyRoute, questionTerminalTarget, questionReplyContext, questionDraftNotice, onOpenQuestionTerminal, questionReplyState, questionReplyDraft, onQuestionDraftChange, renderQuestionNotice, ...reading
}: Props) {
  const projection = useMemo(() => ({ records: acceptedRecords, originalRecords: acceptedOriginals ?? acceptedRecords,
    coverage: coverage ?? acceptedRecords[0]?.coverage ?? [] }), [acceptedRecords, acceptedOriginals, coverage])
  const layout = useConversationRecordLayout(projection.records, projection.originalRecords, JSON.stringify([reading.executionHostId, sessionId, timeline?.stream?.epoch]))
  const describedRecords = layout.records
  const choiceScope = JSON.stringify([reading.executionHostId, sessionId, timeline?.stream?.epoch])
  // Only local disclosure choices survive coalescence; no message or relation facts are retained here.
  const [submissionChoices, setSubmissionChoices] = useState<{ scope: string; values: ReadonlyMap<string, boolean> }>({ scope: choiceScope, values: new Map() })
  const choices = submissionChoices.scope === choiceScope ? submissionChoices.values : new Map<string, boolean>()
  useEffect(() => {
    const retained = new Set(projection.originalRecords.flatMap(record => record.records?.map(source => source.id) ?? [record.id]))
    setSubmissionChoices(previous => {
      if (previous.scope !== choiceScope) return { scope: choiceScope, values: new Map() }
      if ([...previous.values.keys()].every(id => retained.has(id))) return previous
      return { scope: choiceScope, values: new Map([...previous.values].filter(([id]) => retained.has(id))) }
    })
  }, [choiceScope, projection.originalRecords])
  const expandedSubmissions = useMemo(() => new Set([...choices].filter(([, open]) => open).map(([id]) => id)), [choices])
  // A protected original keeps the source facts of its displayed frame.
  const sourceCoverage = describedRecords[0]?.coverage ?? projection.coverage
  const unavailable = sourceCoverage.some(row => row.source.kind === 'native' && (row.current === 'unavailable' || row.current === 'unsupported'))
  const unreadRecords = new Set(sourceCoverage.flatMap(row => row.gaps.flatMap(gap => gap.record &&
    (gap.code === 'CONVERSATION_ANCHOR_UNREAD' || gap.code === 'CONVERSATION_OBSERVED_TARGET_UNREAD') ? [conversationRecordId(gap.record)] : [])))
  if (page && page.agentSessionId !== sessionId) return null
  if (describedRecords.length === 0 && !insertions?.length && projection.coverage.length === 0) return null
  const descriptions = new Map(describedRecords.filter(record => record.original.kind === 'native').map(record => [record.rawId, record]))
  const originals = new Map(layout.originalRecords.map(record => [record.records![0]!.id, record]))
  const questions = new Map((page ? projectConversationQuestions({ agentSessionId: sessionId, executionHostId: reading.executionHostId, historyPage: page ?? undefined, answerContext: questionAnswerContext }) : [])
    .map(question => [question.recordId, question]))
  const locatedRecord = locatedMessageKey ? describedRecords.find(record => conversationMessageSourceKey(sessionId, record.source) === locatedMessageKey
    || record.records?.some(source => originals.has(source.id) && conversationMessageSourceKey(sessionId, originals.get(source.id)!.source) === locatedMessageKey)) : undefined
  const nativeRecords = describedRecords.flatMap(record => record.original.kind === 'native' ? [record.original.item] : [])
  const capturedInsertions: ConversationRecordInsertion[] = []
  let beforeRecordId: string | undefined
  for (let index = describedRecords.length - 1; index >= 0; index--) {
    const record = describedRecords[index]!
    if (record.original.kind === 'native') { beforeRecordId = record.rawId; continue }
    capturedInsertions.push({ key: record.presentationKey ?? record.id, ...(beforeRecordId === undefined ? {} : { beforeRecordId }),
      role: record.role === 'process' ? 'process' : 'message', recordIds: [record.rawId],
      content: disclosure => <div data-conversation-layout-key={record.presentationKey ?? record.id}>{renderCaptured(record, disclosure, true)}{renderOriginals(record)}</div> })
  }
  capturedInsertions.reverse()
  const orderedInsertions = [...(insertions ?? []), ...capturedInsertions]

  function renderCaptured(record: ConversationRecord, disclosure?: ConversationProcessProps['disclosure'], feed = false): ReactNode {
    const keys = new Set([record.event?.anchorId, ...(record.records?.map(source => source.id) ?? [])])
    const unread = [...keys].some(key => key !== undefined && unreadRecords.has(key))
    const choiceKey = record.records?.find(source => source.original.item === record.original.item)?.id ?? record.id
    const target = record.sources?.unreadSubmissionTarget
    const request = readActivity?.sourceRead
    const targetUnavailable = (record.coverage ?? projection.coverage).some(row => row.source.kind === 'native'
      && target?.source.kind === 'native' && row.source.providerId === target.source.providerId && row.source.nativeSessionId === target.source.nativeSessionId
      && (row.current === 'unavailable' || row.current === 'unsupported'))
    // A native-looking canonical ID may still render its captured contribution.
    // Only a known exact target and an in-flight read of its original scope move.
    const readingSubmission = Boolean(target && target.source.kind === 'native' && request && readActivity?.loading && reading.active !== false
      && record.original.kind === 'captured' && record.original.item.status !== 'failed' && !targetUnavailable
      && target.hostId === record.sourceHostId && target.agentSessionId === request.reference.agentSessionId
      && request.reference.hostId === (record.executionHostId ?? record.sourceHostId)
      && request.nativeSource.providerId === target.source.providerId && request.nativeSource.nativeSessionId === target.source.nativeSessionId)
    const submissionDisclosure: SubmissionDisclosure | undefined = feed ? {
      reading: readingSubmission,
      compact: Boolean(page?.items.length) && !expandSubmissions && !unavailable && !unread,
      ...(choices.has(choiceKey) ? { open: choices.get(choiceKey)! } : {}),
      onOpenChange: open => setSubmissionChoices(previous => {
        const values = previous.scope === choiceScope ? previous.values : new Map<string, boolean>()
        if (values.get(choiceKey) === open && previous.scope === choiceScope) return previous
        return { scope: choiceScope, values: new Map(values).set(choiceKey, open) }
      })
    } : undefined
    return renderCapturedRecord ? renderCapturedRecord(record, disclosure, submissionDisclosure) : record.role === 'process' || record.role === 'interaction'
      ? <CapturedProcessRecord record={record} {...(disclosure ? { disclosure } : {})} located={locatedMessageKey === conversationMessageSourceKey(sessionId, record.source)} /> : <CapturedConversationMessage
        item={record.original.kind === 'captured' ? record.original.item : neverCaptured()} record={record}
        {...(submissionDisclosure ? { submissionDisclosure } : {})}
        {...(record.role === 'observation' ? { replyObservation: { compact: true } } : {})}
        {...(record.input ? { inputSource: record.input.source, publicContent: record.input.publicContent } : {})}
        {...(record.speaker ? { speaker: record.speaker } : {})}
        {...(describeSpeaker ? { describeSpeaker } : {})} conversationSessionId={sessionId}
        located={locatedMessageKey === conversationMessageSourceKey(sessionId, record.source)}
        {...reading}
        messageDetails={<>{record.original.kind === 'captured' ? [record.original.item.toolInput, record.original.item.toolOutput].map((text, index) => text === undefined ? null : <details key={index}><summary>{index ? 'Original tool output' : 'Original tool input'}</summary><ConversationToolPayload text={text} identity={record.original.item} sourceIdentity={record.original.item} copyLabel={index ? 'Copy tool output' : 'Copy tool input'} /></details>) : null}</>} />
  }
  function renderOriginals(record: ConversationRecord): ReactNode {
    const contributors = record.records?.filter(source => source.original.item !== record.original.item).flatMap(source => originals.has(source.id) ? [originals.get(source.id)!] : []) ?? []
    return contributors.length ? <ConversationOriginalRecords records={contributors} expandedRecords={expandedSubmissions} renderRecord={renderOriginal} sessionId={sessionId} {...(locatedMessageKey === undefined ? {} : { locatedMessageKey })} /> : null
  }
  function renderOriginal(record: ConversationRecord): ReactNode {
    return record.original.kind === 'native' ? renderNativeRecord(record.original.item, undefined, record) : renderCaptured(record)
  }
  const renderRecord: ConversationRecordRenderer = (item, wrapBody) => renderNativeRecord(item, wrapBody)
  function renderNativeRecord(item: AgentSessionHistoryItem, wrapBody?: (body: ReactNode) => ReactNode, original?: ConversationRecord): ReactNode {
      if (!page) return null
      const record = original ?? descriptions.get(item.id)!
      const recordId = record.id
      const question = questions.get(item.id)
      const questionAttempt = question && questionReplyState && question.turnId ? questionReplyState({ source: question.source, turnId: question.turnId, recordId: question.recordId }) : undefined
      const terminalCurrent = Boolean(question && questionTerminalTarget && question.source.providerId === questionTerminalTarget.source.providerId
        && question.source.nativeSessionId === questionTerminalTarget.source.nativeSessionId
        && (!questionAttempt?.original || questionAttempt.original.input.expectedRun.runId === questionTerminalTarget.run.runId))
      const user = record.input
      const itemRef = conversationItemRef(record)
      const speaker = record.role === 'process' ? undefined : record.speaker
      const described = speaker && item.kind !== 'system-message' ? describeSpeaker?.(speaker) : undefined
      const body = <ConversationMessage sources={record.sources} {...(record.event ? { conversationEvent: record.event } : {})} messageId={messageIdForRecord?.(item) ?? user?.id ?? recordId} conversationSessionId={sessionId}
          {...(completedNativeReply(item) ? { status: 'complete' } : {})}
          {...(itemRef ? { itemRef } : {})}
          located={locatedMessageKey === conversationMessageSourceKey(sessionId, record.source)}
          {...(item.kind === 'system-message' ? { recordTitle: `${page.source.providerId} · ${item.title ?? 'System record'}` }
            : user && item.title ? { recordTitle: item.title } : {})}
          nativeResourceRecord={{ source: page.source, recordId: item.id, ...(item.turnId === undefined ? {} : { turnId: item.turnId }) }}
          content={record.contentParts} {...(item.questionAnswers ? { questionAnswers: item.questionAnswers } : {})} {...(item.messagePhase ? { messagePhase: item.messagePhase } : {})} {...(user ? { inputSource: user.source, publicContent: user.publicContent } : {})}
          {...(speaker ? { speaker } : {})}
          name={item.kind === 'system-message' ? page.source.providerId : described?.name ?? (user ? 'Input' : speaker ? 'Assistant' : recordTitle(item))}
          providerId={described?.providerId ?? page.source.providerId}
          {...(describeSpeaker ? { describeSpeaker } : {})}
          {...(item.startedAt === undefined ? {} : { createdAt: item.startedAt })}
          {...(user && onContinue ? { onContinue: () => onContinue(buildNativeContinuationPrompt(page, item)) } : {})}
          messageActions={<>{itemRef && renderRecordActions?.(itemRef, reading.active !== false, record.executionHostId)}{item.kind === 'assistant-message' && renderMessageActions?.({ kind: 'native', agentSessionId: sessionId,
              providerId: page.source.providerId, nativeSessionId: page.source.nativeSessionId, recordId: item.id })}</>}
          {...reading} />
      return <div key={recordId} data-conversation-layout-key={record.presentationKey ?? record.id} className="conversation-native-thread__record" data-native-source={JSON.stringify([page.source.providerId, page.source.nativeSessionId])} data-native-record-id={item.id}>
        {wrapBody ? wrapBody(body) : body}
        {question ? <AgentAsyncQuestionCard key={JSON.stringify([sessionId, recordId, reading.executionHostId, questionReplyContext])} request={question.request} recordedAnswers={question.recordedAnswers} terminalCurrent={terminalCurrent}
          {...(questionDraftNotice ? { draftNotice: questionDraftNotice } : {})}
          {...(questionReplyRoute ? { replyRoute: questionReplyRoute } : {})}
          {...(onOpenQuestionTerminal ? { onOpenTerminal: onOpenQuestionTerminal } : {})}
          {...(questionAttempt ? { attempt: questionAttempt } : {})}
          {...(questionReplyDraft && question.turnId ? { draftAnswers: questionReplyDraft({ source: question.source, turnId: question.turnId, recordId: question.recordId }) } : {})}
          {...(onQuestionDraftChange && question.turnId ? { onDraftChange: selected => onQuestionDraftChange({ source: question.source, turnId: question.turnId!, recordId: question.recordId }, selected) } : {})}
          {...(renderQuestionNotice ? { renderNotice: renderQuestionNotice } : {})} /> : null}
        {!original ? renderOriginals(record) : null}
        {item.questionDiagnostic ? renderQuestionNotice ? renderQuestionNotice(item.questionDiagnostic)
          : <p className="agent-interaction__error" role="status">{item.questionDiagnostic.message}</p> : null}
      </div>

  }
  return <section ref={layout.root} className="conversation-native-thread" aria-label="Conversation"
    data-native-provider={page?.source.providerId} data-native-source={orderedInsertions.length || !page ? undefined : JSON.stringify([page.source.providerId, page.source.nativeSessionId])}>
    <ConversationCoverage coverage={projection.coverage} {...(onLocateRecord ? { onLocate: onLocateRecord } : {})} />
    {layout.held ? <p className="conversation-metrics__notice" role="status">保留选区，取消选择后更新已确认的消息关系。</p> : null}
    {showSource && page ? <div className="conversation-native-thread__source" title={`Native session ${page.source.nativeSessionId}`}>
      <span>{page.source.providerId} · Native conversation</span>
      <span>{describedRecords.length} {describedRecords.length === 1 ? 'record' : 'records'} · Current window</span>
    </div> : null}
    <ConversationRecordSequence items={nativeRecords}
      sourceKey={JSON.stringify([reading.executionHostId, sessionId, page?.sourceHostId, page?.source.providerId, page?.source.nativeSessionId])}
      locatedNativeId={locatedRecord?.original.kind === 'native' ? locatedRecord.rawId : undefined}
      locatedInsertionKey={locatedRecord?.original.kind === 'captured' ? locatedRecord.presentationKey ?? locatedRecord.id : undefined}
      {...(page ? { nativeSourceKey: JSON.stringify([page.source.providerId, page.source.nativeSessionId]) } : {})}
      insertions={orderedInsertions}
      nativeRoles={new Map(describedRecords.filter(record => record.original.kind === 'native' && record.role).map(record => [record.rawId, record.role!]))}
      renderRecord={renderRecord} {...(renderProcess ? { renderProcess } : {})} {...(recordBoundary ? { recordBoundary } : {})} />
  </section>
})

function recordTitle(item: AgentSessionHistoryItem): string {
  return item.title ?? 'Recorded activity'
}

function neverCaptured(): never { throw new Error('Captured source renderer received a native record.') }
