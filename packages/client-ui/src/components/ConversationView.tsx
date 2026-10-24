import { ConversationRetainedDetails } from './ConversationRetainedDetails.js'
import { NativeProcessStep } from './NativeProcessObservation.js'
import { DeferredConversationProcess } from './DeferredConversationProcess.js'
import type { ConversationProcessDetailReader } from '../lib/read-conversation-process-detail.js'
import { projectConversationWindow } from '../lib/conversation-records.js'
import { ConversationBodyWorkContext } from './ConversationProgressiveBody.js'
import { ConversationReadingCommit } from './ConversationReadingCommit.js'
import type { ConversationReadingGeometry } from '../lib/conversation-body-work.js'
import { ConversationCoverage } from './ConversationCoverage.js'
import { CapturedProcessRecord } from './CapturedProcessRecord.js'
import { ConversationOriginalRecords, ConversationOriginalRecordContent } from './ConversationOriginalRecords.js'
import { useConversationRecordLayout, type ConversationPresentationPort } from '../lib/use-conversation-record-layout.js'
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
import { conversationA2ANotificationId, conversationItemRef, type ConversationItemRef } from '@agentmux/core/conversation'

type ReadingProps = Pick<ConversationMessageProps,
  'sourceLabelsInDetails' | 'detailsOnlyMetadata' | 'active' | 'showInputSource' | 'executionHostId' | 'workspaceRoot' | 'homeDir' | 'openWorkspaceFile' | 'readPastedImage' | 'readHistoryResource' | 'openHttpLink' | 'onSelectAnnotation' | 'expandedTraces' | 'onToggleTrace' | 'traceDisclosure'>

/** Existing Reader facts only. Unknown/newly selected source scopes stay static. */
export type ConversationReadActivity = {
  loading: boolean
  sourceRead: ConversationSourceRead | null
}

type Props = ReadingProps & {
  presentation?: ConversationPresentationPort
  readingGeometry?: ConversationReadingGeometry
  readActivity?: ConversationReadActivity
  readProcessDetail?: ConversationProcessDetailReader
  questionReplyRoute?: AgentCapabilities['asyncQuestionReply']
  questionReplyTarget?: { source: AgentSessionHistorySource; run: AgentMuxRunRef } | undefined
  /** Changes reset only transient card actions; drafts remain in the host's original owner. */
  questionDraftNotice?: string | undefined
  questionReplyContext?: string
  onOpenQuestionTerminal?: () => void
  questionReplyState?: (target: ConversationQuestionTarget) => QuestionReplyState | undefined
  questionReplyDraft?: (target: ConversationQuestionTarget) => ConversationQuestionInput['answers'] | undefined
  onQuestionDraftChange?: (target: ConversationQuestionTarget, answers: ConversationQuestionInput['answers']) => void
  onQuestionReply?: (input: ConversationQuestionInput) => Promise<void>
  renderQuestionNotice?: QuestionNoticeRenderer
  page?: AgentSessionHistoryPage | null
  timeline?: AgentTimelineSnapshot | undefined
  records: readonly ConversationRecord[]
  originalRecords?: readonly ConversationRecord[]
  coverageSummary?: string
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
  presentation, readingGeometry, readProcessDetail, page: acceptedPage, timeline, records: acceptedRecords, originalRecords: acceptedOriginals, coverage, coverageSummary, onLocateRecord, renderCapturedRecord, expandSubmissions = false, readActivity, questionAnswerContext, sessionId, describeSpeaker, onContinue, locatedMessageKey, renderProcess, recordBoundary: acceptedBoundary, renderMessageActions, renderRecordActions, messageIdForRecord, showSource = false, insertions: acceptedInsertions, questionReplyRoute, questionReplyTarget, questionReplyContext, questionDraftNotice, onOpenQuestionTerminal, questionReplyState, questionReplyDraft, onQuestionDraftChange, onQuestionReply, renderQuestionNotice, ...reading
}: Props) {
  const frame = useMemo(() => ({ records: acceptedRecords, originalRecords: acceptedOriginals ?? acceptedRecords,
    coverage: coverage ?? acceptedRecords[0]?.coverage ?? [], page: acceptedPage, recordBoundary: acceptedBoundary, insertions: acceptedInsertions }),
    [acceptedRecords, acceptedOriginals, coverage, acceptedPage, acceptedBoundary, acceptedInsertions])
  const sourceKey = JSON.stringify([reading.executionHostId, sessionId, timeline?.stream?.epoch])
  const boundaryRecord = acceptedRecords.find(record => record.source.kind === 'native' && record.rawId === acceptedBoundary?.beforeRecordId)
  const layout = useConversationRecordLayout(frame, sourceKey, { ...(boundaryRecord ? { beforeRecordId: boundaryRecord.presentationKey ?? boundaryRecord.id } : {}),
    ...(acceptedInsertions ? { anchors: acceptedInsertions } : {}), active: reading.active !== false, ...(readingGeometry ? { geometry: readingGeometry } : {}), ...(presentation ? { presentation, intent: presentation.intent } : {}) })
  const bodyScope = useMemo(() => ({ work: layout.bodyWork, active: reading.active !== false }), [layout.bodyWork, reading.active])
  const { records: describedRecords, page, recordBoundary, insertions } = layout
  const projection = layout
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
  function setSubmissionChoice(id: string, open: boolean): void {
    setSubmissionChoices(previous => {
      const values = previous.scope === choiceScope ? previous.values : new Map<string, boolean>()
      if (values.get(id) === open && previous.scope === choiceScope) return previous
      return { scope: choiceScope, values: new Map(values).set(id, open) }
    })
  }
  if (page && page.agentSessionId !== sessionId) return null
  if (describedRecords.length === 0 && !insertions?.length && projection.coverage.length === 0) return null
  const originals = new Map(layout.originalRecords.map(record => [record.records![0]!.id, record]))
  const continuedProgress = new Set<string>()
  let previousProgress: { author: string; turn?: string } | undefined
  for (const record of describedRecords) {
    const item = record.original.kind === 'native' ? record.original.item : undefined
    if (record.role === 'process' || record.role === 'observation') {
      if (previousProgress?.turn && item?.turnId && previousProgress.turn !== item.turnId) previousProgress = undefined
      continue
    }
    const author = record.author?.kind === 'agent' ? record.author.agentSessionId : undefined
    if (item?.messagePhase !== 'progress' || !author) { previousProgress = undefined; continue }
    const turn = item.turnId ?? (previousProgress?.author === author ? previousProgress.turn : undefined)
    if (previousProgress?.author === author && !(previousProgress.turn && turn && previousProgress.turn !== turn)) continuedProgress.add(record.id)
    previousProgress = { author, ...(turn ? { turn } : {}) }
  }
  const questions = new Map((page ? projectConversationQuestions({ agentSessionId: sessionId, executionHostId: reading.executionHostId, historyPage: page ?? undefined, answerContext: questionAnswerContext }) : [])
    .map(question => [question.recordId, question]))
  const locatedRecord = locatedMessageKey ? describedRecords.find(record => conversationMessageSourceKey(sessionId, record.source) === locatedMessageKey
    || record.deferred?.records.some(source => conversationMessageSourceKey(sessionId, source.reference!.source) === locatedMessageKey)
    || record.records?.some(source => originals.has(source.id) && conversationMessageSourceKey(sessionId, originals.get(source.id)!.source) === locatedMessageKey)) : undefined
  function renderCaptured(record: ConversationRecord, canonicalDisclosure?: ConversationProcessProps['disclosure'], feed = false): ReactNode {
    // Source leaves keep their raw payload API; all stored choices use the canonical key.
    const key = record.presentationKey ?? record.id
    const value = canonicalDisclosure?.steps.get(key)
    const disclosure = canonicalDisclosure ? { ...canonicalDisclosure, steps: new Map(value === undefined ? [] : [[record.rawId, value]]),
      onStepExpandedChange: (_id: string, open: boolean) => canonicalDisclosure.onStepExpandedChange(key, open),
      onStepsPresented: () => canonicalDisclosure.onStepsPresented?.([key]) } : undefined
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
      compact: !expandSubmissions,
      ...(choices.has(choiceKey) ? { open: choices.get(choiceKey)! } : {}),
      onOpenChange: open => setSubmissionChoice(choiceKey, open)
    } : undefined
    return renderCapturedRecord ? renderCapturedRecord(record, disclosure, submissionDisclosure) : record.role === 'process' || record.role === 'interaction'
      ? <CapturedProcessRecord record={record} {...(reading.workspaceRoot ? { workspaceRoot: reading.workspaceRoot } : {})} {...(disclosure ? { disclosure } : {})} located={locatedMessageKey === conversationMessageSourceKey(sessionId, record.source)} /> : <CapturedConversationMessage
        item={record.original.kind === 'captured' ? record.original.item : neverCaptured()} record={record}
        {...(submissionDisclosure ? { submissionDisclosure } : {})}
        {...(record.role === 'observation' ? { replyObservation: { compact: true } } : {})}
        {...(record.input ? { inputSource: record.input.source, publicContent: record.input.publicContent } : {})}
        {...(record.speaker ? { speaker: record.speaker } : {})}
        {...(describeSpeaker ? { describeSpeaker } : {})} conversationSessionId={sessionId}
        located={locatedMessageKey === conversationMessageSourceKey(sessionId, record.source)}
        locatedSourceKey={locatedMessageKey}
        {...reading}
        messageDetails={<CapturedToolDetails record={record} />} />
  }
  function renderOriginals(record: ConversationRecord): ReactNode {
    if (conversationA2ANotificationId(record)) return null // Notification evidence reads raw contributors inside its one disclosure.
    const contributors = record.records?.filter(source => source.original.item !== record.original.item).flatMap(source => {
      const original = originals.get(source.id)
      if (!original) return []
      const submission = record.sources?.submissions?.some(item => item.id === source.id)
      // The native card already exposes this original through its send receipt.
      // Existing choices and exact source locators retain their own opened surface.
      return !submission || choices.has(source.id) || locatedMessageKey === conversationMessageSourceKey(sessionId, original.source) ? [original] : []
    }) ?? []
    return contributors.length ? <ConversationOriginalRecords records={contributors} expandedRecords={expandedSubmissions} onOpenChange={setSubmissionChoice} renderRecord={renderOriginal} sessionId={sessionId} {...(locatedMessageKey === undefined ? {} : { locatedMessageKey })} /> : null
  }
  function renderOriginal(record: ConversationRecord): ReactNode {
    return record.original.kind === 'native' ? renderNativeRecord(record.original.item, undefined, record) : renderCaptured(record)
  }
  const renderRecord: ConversationRecordRenderer = (record, wrapBody, disclosure) => record.original.kind === 'deferred'
    ? <DeferredConversationProcess key={JSON.stringify([record.executionHostId, record.sourceHostId, record.deferred!.records.map(source => [source.id, source.revision])])}
        record={record} {...(readProcessDetail ? { readDetail: readProcessDetail } : {})} active={reading.active !== false}
        located={locatedMessageKey === conversationMessageSourceKey(sessionId, record.source) || record.deferred!.records.some(source => conversationMessageSourceKey(sessionId, source.reference!.source) === locatedMessageKey)} {...(disclosure ? { disclosure } : {})}
        renderDetail={snapshot => {
          const detail = projectConversationWindow(snapshot)
          return detail.records.map(original => original.original.kind === 'native'
            ? renderNativeRecord(original.original.item, body => <NativeProcessStep item={original.original.kind === 'native' ? original.original.item : neverCaptured()} bodyOnly>{body}</NativeProcessStep>, original, undefined, detail.historyPage)
            : <CapturedProcessRecord key={original.id} record={original} bodyOnly {...(reading.workspaceRoot ? { workspaceRoot: reading.workspaceRoot } : {})} />)
        }} />
    : record.original.kind === 'native'
    ? renderNativeRecord(record.original.item, wrapBody, undefined, record)
    : <div data-conversation-layout-key={record.presentationKey ?? record.id}>{renderCaptured(record, disclosure, true)}{renderOriginals(record)}</div>
  function renderNativeRecord(item: AgentSessionHistoryItem, wrapBody?: (body: ReactNode) => ReactNode, original?: ConversationRecord, canonical?: ConversationRecord, detailPage = page): ReactNode {
      const page = detailPage
      if (!page) return null
      const record = original ?? canonical!
      const recordId = record.id
      const question = questions.get(item.id)
      const questionAttempt = question && questionReplyState && question.turnId ? questionReplyState({ source: question.source, turnId: question.turnId, recordId: question.recordId }) : undefined
      const replyTargetCurrent = Boolean(question && questionReplyTarget && question.source.providerId === questionReplyTarget.source.providerId
        && question.source.nativeSessionId === questionReplyTarget.source.nativeSessionId
        && (!questionAttempt?.original || questionAttempt.original.input.expectedRun.runId === questionReplyTarget.run.runId))
      const user = record.input
      const itemRef = conversationItemRef(record)
      const collaboration = item.collaboration?.kind === 'message' ? item.collaboration : undefined
      // A native actor is scoped to its Provider conversation, never an AgentMux SID.
      const speaker = record.role === 'process' || collaboration ? undefined : record.speaker
      const a2aNotificationId = conversationA2ANotificationId(record)
      const described = speaker && item.kind !== 'system-message' && !a2aNotificationId ? describeSpeaker?.(speaker) : undefined
      const body = <ConversationMessage sources={record.sources} {...(record.event ? { conversationEvent: record.event } : {})} messageId={messageIdForRecord?.(item) ?? user?.id ?? recordId} conversationSessionId={sessionId}
          {...(collaboration ? { compact: true, recordedIdentity: true, nativeCollaboration: collaboration,
            messageDetails: <dl className="conversation-input-details__facts">
              <dt>原生来源</dt><dd>{collaboration.source.providerId} · <code>{collaboration.source.nativeSessionId}</code></dd>
              <dt>原生发送者</dt><dd>{collaboration.sender ?? '未记录'}</dd>
              <dt>原生接收者</dt><dd>{collaboration.recipient ?? '未记录'}</dd>
              <dt>身份范围</dt><dd>原生会话中的参与者，不代表 AgentMux Session 身份或当前投递状态。</dd>
            </dl> } : {})}
          continuation={!original && continuedProgress.has(record.id) && locatedMessageKey !== conversationMessageSourceKey(sessionId, record.source)}
          renderSubmissionOriginal={source => { const original = originals.get(source.id); return original ? <ConversationOriginalRecordContent record={original} renderRecord={renderOriginal} /> : null }}
          {...(a2aNotificationId ? { a2aNotificationId, notificationRecords: record.records, locatedSourceKey: locatedMessageKey } : {})}
          {...(completedNativeReply(item) ? { status: 'complete' } : {})}
          {...(itemRef ? { itemRef } : {})}
          located={locatedMessageKey === conversationMessageSourceKey(sessionId, record.source)}
          {...(collaboration ? { recordTitle: `协作回报 → ${collaboration.recipient ?? '接收者未记录'}` }
            : item.kind === 'system-message' ? { recordTitle: `${page.source.providerId} · ${item.title ?? 'System record'}` }
            : user && item.title ? { recordTitle: item.title } : {})}
          nativeResourceRecord={{ source: page.source, recordId: item.id, ...(item.turnId === undefined ? {} : { turnId: item.turnId }) }}
          content={record.contentParts} {...(item.questionAnswers ? { questionAnswers: item.questionAnswers } : {})} {...(item.messagePhase ? { messagePhase: item.messagePhase } : {})} {...(user ? { inputSource: user.source, publicContent: user.publicContent, inputContext: user.inputContext, inputContextSource: user.inputContextSource } : {})}
          {...(speaker ? { speaker } : {})}
          name={collaboration ? collaboration.sender ?? '原生发送者未记录' : a2aNotificationId ? 'AgentMux' : item.kind === 'system-message' ? page.source.providerId : described?.name ?? (user ? 'Input' : speaker ? 'Assistant' : recordTitle(item))}
          providerId={described?.providerId ?? page.source.providerId}
          {...(describeSpeaker ? { describeSpeaker } : {})}
          {...(item.startedAt === undefined ? {} : { createdAt: item.startedAt })}
          {...(user && onContinue ? { onContinue: () => onContinue(buildNativeContinuationPrompt(page, item)) } : {})}
          messageActions={<>{itemRef && renderRecordActions?.(itemRef, reading.active !== false, record.executionHostId)}{item.kind === 'assistant-message' && renderMessageActions?.({ kind: 'native', agentSessionId: sessionId,
              providerId: page.source.providerId, nativeSessionId: page.source.nativeSessionId, recordId: item.id })}</>}
          {...reading} />
      return <div key={recordId} data-conversation-layout-key={record.presentationKey ?? record.id} className="conversation-native-thread__record" data-native-source={JSON.stringify([page.source.providerId, page.source.nativeSessionId])} data-native-record-id={item.id}>
        {wrapBody ? wrapBody(body) : body}
        {question ? <AgentAsyncQuestionCard key={JSON.stringify([sessionId, recordId, reading.executionHostId, questionReplyContext])} request={question.request} recordedAnswers={question.recordedAnswers} replyTargetCurrent={replyTargetCurrent}
          {...(questionDraftNotice ? { draftNotice: questionDraftNotice } : {})}
          {...(questionReplyRoute ? { replyRoute: questionReplyRoute } : {})}
          {...(onOpenQuestionTerminal ? { onOpenTerminal: onOpenQuestionTerminal } : {})}
          {...(questionAttempt ? { attempt: questionAttempt } : {})}
          {...(questionReplyDraft && question.turnId ? { draftAnswers: questionReplyDraft({ source: question.source, turnId: question.turnId, recordId: question.recordId }) } : {})}
          {...(onQuestionDraftChange && question.turnId ? { onDraftChange: selected => onQuestionDraftChange({ source: question.source, turnId: question.turnId!, recordId: question.recordId }, selected) } : {})}
          {...(onQuestionReply && question.turnId ? { onSend: answers => onQuestionReply({ source: question.source, turnId: question.turnId!, recordId: question.recordId, answers }) } : {})}
          {...(renderQuestionNotice ? { renderNotice: renderQuestionNotice } : {})} /> : null}
        {!original ? renderOriginals(record) : null}
        {item.questionDiagnostic ? renderQuestionNotice ? renderQuestionNotice(item.questionDiagnostic)
          : <p className="agent-interaction__error" role="status">{item.questionDiagnostic.message}</p> : null}
      </div>

  }
  return <ConversationBodyWorkContext.Provider value={bodyScope}><ConversationReadingCommit work={layout.bodyWork} preserve={layout.preserve}><section ref={layout.root} className="conversation-native-thread" aria-label="Conversation"
    data-native-provider={page?.source.providerId} data-native-source={describedRecords.some(record => record.original.kind === 'captured') || insertions?.length || !page ? undefined : JSON.stringify([page.source.providerId, page.source.nativeSessionId])}>
    <ConversationCoverage coverage={projection.coverage} summary={coverageSummary} {...(onLocateRecord ? { onLocate: onLocateRecord } : {})} />
    {layout.held ? <p className="conversation-metrics__notice" role="status">{layout.reason === 'anchor' ? '保留当前阅读位置，移开后更新消息。' : layout.reason === 'focus' ? '保留当前焦点，移开后更新消息。' : '保留选区，取消选择后更新已确认的消息关系。'}</p> : null}
    {showSource && page ? <div className="conversation-native-thread__source" title={`Native session ${page.source.nativeSessionId}`}>
      <span>{page.source.providerId} · Native conversation</span>
      <span>{describedRecords.length} {describedRecords.length === 1 ? 'record' : 'records'} · Current window</span>
    </div> : null}
    <ConversationRecordSequence records={describedRecords} sequence={layout.sequence} sourceKey={sourceKey}
      locatedRecordId={locatedRecord ? locatedRecord.presentationKey ?? locatedRecord.id : undefined}
      {...(page ? { nativeSourceKey: JSON.stringify([page.source.providerId, page.source.nativeSessionId]) } : {})}
      {...(insertions ? { insertions } : {})}
      renderRecord={renderRecord} {...(renderProcess ? { renderProcess } : {})} {...(recordBoundary ? { recordBoundary } : {})} />
  </section></ConversationReadingCommit></ConversationBodyWorkContext.Provider>
})

function recordTitle(item: AgentSessionHistoryItem): string {
  return item.title ?? 'Recorded activity'
}

function CapturedToolDetails({ record }: { record: ConversationRecord }) {
  const sourceKey = conversationMessageSourceKey(record.agentSessionId, record.source)
  const sourceIdentity = useMemo(() => ({}), [record.sourceHostId, sourceKey])
  if (record.original.kind !== 'captured') return null
  return <>{[record.original.item.toolInput, record.original.item.toolOutput].map((text, index) => text === undefined || text.length === 0 ? null : <ConversationRetainedDetails key={index} summary={index ? 'Original tool output' : 'Original tool input'}>{() => <ConversationToolPayload text={text} identity={sourceIdentity} sourceIdentity={sourceIdentity} copyLabel={index ? 'Copy tool output' : 'Copy tool input'} />}</ConversationRetainedDetails>)}</>
}

function neverCaptured(): never { throw new Error('Captured source renderer received a native record.') }
