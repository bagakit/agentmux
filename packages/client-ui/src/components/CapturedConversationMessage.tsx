import type { ConversationRecord } from '../lib/conversation-records.js'
import { COLLECTED_REPLY_TITLE, describeCapturedConversationSource } from '../lib/conversation-sources.js'
import { ConversationSourceLabels } from './ConversationSourceLabels.js'
import type { AgentTimelineItem } from '@agentmux/core'
import { ConversationMessage, type ConversationMessageProps } from './ConversationMessage.js'
import { conversationA2ANotificationId, conversationItemRef } from '@agentmux/core/conversation'
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { conversationReplyPreview } from '../lib/conversation-reply-preview.js'
import { formatClock } from '../lib/conversation-time.js'
import { SemanticIcon } from '../theme/icons.js'
import { conversationMessageSourceKey } from '../lib/conversation-message-location.js'
import { ConversationSubmissionFacts, ConversationSubmissionSummary, conversationSubmissionPreview } from './ConversationSubmissionMetadata.js'
import { ConversationMessageDisclosure } from './ConversationMessageDisclosure.js'
export type SubmissionDisclosure = { compact: boolean; reading?: boolean; open?: boolean; onOpenChange(open: boolean): void }
/** Exact captured record metadata. A failed native reader cannot hide a confirmed Hook reply. */
export function CapturedConversationMessage({ item, record, replyObservation, submissionDisclosure, ...props }: Omit<ConversationMessageProps, 'content' | 'messageId' | 'createdAt' | 'status'> & {
  item: AgentTimelineItem
  record?: ConversationRecord
  /** Local reading role only; never asserts native coverage or a record join. */
  replyObservation?: { compact: boolean }
  /** A feed reading choice, not an association or adoption fact. Omitted in explicit original details. */
  submissionDisclosure?: SubmissionDisclosure
}) {
  const source = describeCapturedConversationSource(item.source)
  const itemRef = record ? conversationItemRef(record) : conversationItemRef({ agentSessionId: item.agentSessionId, ...(props.executionHostId ? { executionHostId: props.executionHostId } : {}), source: { kind: 'captured', recordId: item.id } })
  const submission = Boolean(submissionDisclosure && record?.original.kind === 'captured' && record.role === 'message' && item.kind === 'user_message' && item.source === 'user')
  const originalSubmission = submission ? record?.records?.find(source => source.original.item === item) : undefined
  const a2aNotificationId = conversationA2ANotificationId({ original: { kind: 'captured', item } })
  const input = record?.input ?? item
  const message = <ConversationMessage {...props} expandedContent sources={record?.sources ?? props.sources} {...(record?.role === 'observation' ? { recordedIdentity: true } : {})} {...(record?.event && !submission ? { conversationEvent: record.event } : {})} {...(itemRef ? { itemRef } : {})} {...(record?.input ? { inputSource: record.input.source, publicContent: record.input.publicContent } : {})} messageId={record?.input?.id ?? item.id} content={record?.contentParts ?? item.content ?? ''} status={item.inputSubmission ? item.status : record?.input?.deliveryStatus ?? item.status} createdAt={item.createdAt}
    {...(input.inputContext ? { inputContext: input.inputContext, inputContextSource: input.inputContextSource } : {})}
    a2aNotificationId={a2aNotificationId} notificationRecords={record?.records} contentBoundary={a2aNotificationId ? 'wire' : item.kind === 'user_message' && input.publicContent === 'confirmed' ? 'body' : props.contentBoundary ?? 'wire'}
    messageDetails={<>{originalSubmission ? <ConversationSubmissionFacts record={originalSubmission} /> : <dl className="conversation-input-details__facts">
      <dt>记录方式</dt><dd>{source.label}</dd>
      <dt>来源说明</dt><dd>{source.description}</dd>
      <dt>原来源类型</dt><dd><code>{item.source}</code></dd>
      {record?.role === 'observation' && record.author?.kind === 'unknown' ? <><dt>回复作者</dt><dd>原事件未记录回复作者；所属会话不单独证明正文作者。</dd></> : null}
      <dt>Captured record</dt><dd><code>{item.id}</code></dd>
      <dt>Session</dt><dd><code>{item.agentSessionId}</code></dd>
      {item.eventName ? <><dt>原事件</dt><dd>{item.eventName}</dd></> : null}
    </dl>}{props.messageDetails}</>} />
  if (submission && record && submissionDisclosure) {
    return <div className="conversation-submission-record" data-submission-id={item.id}
      data-conversation-event-id={record.event?.id} data-conversation-event-revision={record.event?.revision}
      data-conversation-role={record.role} data-conversation-author={JSON.stringify(record.author)}
      data-conversation-item-ref={itemRef ? JSON.stringify(itemRef) : undefined}
      data-message-source-key={conversationMessageSourceKey(item.agentSessionId, { kind: 'captured', recordId: item.id })} tabIndex={-1}>
      <ConversationMessageDisclosure preview={conversationSubmissionPreview(record.content ?? '')} reveal={props.located === true}
        expanded={!submissionDisclosure.compact} {...(submissionDisclosure.open === undefined ? {} : { open: submissionDisclosure.open })}
        onOpenChange={submissionDisclosure.onOpenChange}
        summary={<>{originalSubmission ? <ConversationSubmissionSummary record={originalSubmission} renderClock={props.timeFormatter ?? formatClock} /> : null}
          {submissionDisclosure.reading ? <span className="conversation-submission-record__reading" role="status" aria-label="正在读取对应来源"><SemanticIcon name="status.loading" animation="spin" size={12} aria-hidden="true" /></span> : null}</>}>
        {message}
      </ConversationMessageDisclosure>
    </div>
  }
  return <ReplyObservation key={JSON.stringify([item.agentSessionId, item.source, item.id])} item={item} active={props.active !== false} observation={record?.role === 'observation' || Boolean(replyObservation)} compact={replyObservation?.compact ?? record?.role === 'observation'} reveal={props.located === true} sources={record?.sources}>{message}</ReplyObservation>
}

function ReplyObservation({ item, active, observation, compact, reveal, children, sources }: { item: AgentTimelineItem; active: boolean; observation: boolean; compact: boolean; reveal: boolean; children: ReactNode; sources?: import('../lib/conversation-sources.js').ConversationSources | undefined }) {
  const [choice, setChoice] = useState<boolean>()
  const [readOnce, setReadOnce] = useState(!compact)
  const [, selectionChanged] = useState(0)
  const body = useRef<HTMLDivElement>(null)
  const bodyId = useId()
  useEffect(() => { if (reveal) { setChoice(true); setReadOnce(true) } }, [reveal])
  const document = body.current?.ownerDocument
  const selection = document?.defaultView?.getSelection()
  let selected = false
  if (selection && !selection.isCollapsed && selection.rangeCount && body.current) {
    try { selected = selection.getRangeAt(0).intersectsNode(body.current) } catch { selected = true }
  }
  const expanded = !observation || (choice ?? (!compact || selected))
  useEffect(() => {
    if (!selected || !document) return
    const update = () => selectionChanged(value => value + 1)
    document.addEventListener('selectionchange', update)
    return () => document.removeEventListener('selectionchange', update)
  }, [selected, document])
  const heldPreview = useRef('')
  const preview = useMemo(() => active && observation ? conversationReplyPreview(item.content ?? '') : heldPreview.current, [active, observation, item.content])
  useEffect(() => { if (active) heldPreview.current = preview }, [active, preview])
  return <div className={observation ? 'conversation-reply-observation' : undefined} data-captured-reply-observation={observation ? item.id : undefined} tabIndex={-1}
    data-message-source-key={observation ? conversationMessageSourceKey(item.agentSessionId, { kind: 'captured', recordId: item.id }) : undefined}>
    {observation ? <div className="conversation-reply-observation__controls">
      <button type="button" className="conversation-reply-observation__toggle" aria-expanded={expanded} aria-controls={bodyId}
        aria-label={expanded ? '收起采集内容' : '展开采集内容'} onClick={() => { setChoice(!expanded); if (!expanded) setReadOnce(true) }}>
        <SemanticIcon name="navigation.disclosure" size={12} aria-hidden="true" />
        {expanded ? '收起原文' : <ConversationSourceLabels sources={sources?.main} observation={sources?.collectedReply ?? COLLECTED_REPLY_TITLE} />}
        {!expanded ? <><time>{formatClock(item.createdAt)}</time>{preview ? <span className="conversation-reply-observation__preview">{preview}</span> : null}</> : null}
      </button>
      {!expanded && item.status !== 'complete' ? <span role="status" data-status={item.status}>{item.status === 'failed' ? '记录失败' : '记录中'}</span> : null}
    </div> : null}
    <div ref={body} id={bodyId} hidden={!expanded} inert={!expanded}>{expanded || readOnce ? children : null}</div>
  </div>
}
