import type { ConversationRecord } from '../lib/conversation-records.js'
import { ConversationSourceLabels } from './ConversationSourceLabels.js'
import type { AgentTimelineItem } from '@agentmux/core'
import { ConversationMessage, type ConversationMessageProps } from './ConversationMessage.js'
import { conversationItemRef } from '@agentmux/core/conversation'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { RecordedToolRow } from './WorkflowObservation.js'
import { describeActivityRecordTime } from '../lib/activity-record-time.js'
import { SemanticIcon } from '../theme/icons.js'
import { conversationMessageSourceKey } from '../lib/conversation-message-location.js'
/** Exact captured record metadata. A failed native reader cannot hide a confirmed Hook reply. */
export function CapturedConversationMessage({ item, record, replyObservation, ...props }: Omit<ConversationMessageProps, 'content' | 'messageId' | 'createdAt' | 'status'> & {
  item: AgentTimelineItem
  record?: ConversationRecord
  /** Local reading role only; never asserts native coverage or a record join. */
  replyObservation?: { compact: boolean }
}) {
  const itemRef = record ? conversationItemRef(record) : conversationItemRef({ agentSessionId: item.agentSessionId, ...(props.executionHostId ? { executionHostId: props.executionHostId } : {}), source: { kind: 'captured', recordId: item.id } })
  const message = <ConversationMessage {...props} sources={record?.sources ?? props.sources} {...(record?.role === 'observation' ? { recordedIdentity: true } : {})} {...(record?.event ? { conversationEvent: record.event } : {})} {...(itemRef ? { itemRef } : {})} {...(record?.input ? { inputSource: record.input.source, publicContent: record.input.publicContent } : {})} messageId={record?.input?.id ?? item.id} content={record?.contentParts ?? item.content ?? ''} status={record?.input?.deliveryStatus ?? item.status} createdAt={item.createdAt}
    messageDetails={<><dl className="conversation-input-details__facts">
      <dt>Record source</dt><dd>{item.source}</dd>
      <dt>Captured record</dt><dd><code>{item.id}</code></dd>
      <dt>Session</dt><dd><code>{item.agentSessionId}</code></dd>
      {item.eventName ? <><dt>Recorded event</dt><dd>{item.eventName}</dd></> : null}
    </dl>{props.messageDetails}</>} />
  return <ReplyObservation key={JSON.stringify([item.agentSessionId, item.source, item.id])} item={item} observation={Boolean(replyObservation)} compact={replyObservation?.compact ?? false} reveal={props.located === true} sources={record?.sources?.main}>{message}</ReplyObservation>
}

function ReplyObservation({ item, observation, compact, reveal, children, sources }: { item: AgentTimelineItem; observation: boolean; compact: boolean; reveal: boolean; children: ReactNode; sources?: import('../lib/conversation-sources.js').ConversationSourceDisplay | undefined }) {
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
  const preview = (item.content ?? '').replace(/\s+/gu, ' ').trim().slice(0, 180)
  return <div className={observation ? 'conversation-reply-observation' : undefined} data-captured-reply-observation={observation ? item.id : undefined} tabIndex={-1}
    data-message-source-key={observation ? conversationMessageSourceKey(item.agentSessionId, { kind: 'captured', recordId: item.id }) : undefined}>
    {observation ? <RecordedToolRow className="log-row" observation={{ id: item.id, title: '回复观察', source: sources ? <ConversationSourceLabels sources={sources} /> : item.source, persistentSource: true, status: item.status,
      recordedTime: describeActivityRecordTime(item.createdAt, item.createdAt, Number.NaN) }}
      icon={<SemanticIcon name="conversation.assistant-message" size={12} />} expanded={expanded} controls={bodyId}
      onToggle={() => { setChoice(!expanded); if (!expanded) setReadOnce(true) }} /> : null}
    {!expanded && preview ? <p className="conversation-reply-observation__preview">{preview}</p> : null}
    <div ref={body} id={bodyId} hidden={!expanded} inert={!expanded}>{expanded || readOnce ? children : null}</div>
  </div>
}
